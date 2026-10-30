import { act, fireEvent, renderHook } from '@testing-library/react'
import type { PointerEvent } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { trimSpans, usePreviewGesture, type TrimTarget } from './preview-gesture'
import { useClickAfterDrag } from './timeline-drag'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

type Block = { id: string; at: number; d: number }
type Step = { dx: number; fits: boolean; blocks: readonly Block[] }

/** 按下的元素（把手）：jsdom 没有指针捕获，给它补上。 */
const pressable = () => {
  const element = document.createElement('button')
  document.body.append(element)
  let captured = false
  return Object.assign(element, {
    setPointerCapture: () => {
      captured = true
    },
    hasPointerCapture: () => captured,
    releasePointerCapture: () => {
      captured = false
    },
  })
}

/** 按下的元素上的指针事件：只带核心读的字段。 */
const pointer = (currentTarget: HTMLElement, clientX: number, { button = 0, clientY = 0 } = {}) =>
  ({
    pointerId: 1,
    button,
    clientX,
    clientY,
    stopPropagation: () => {},
    currentTarget,
  }) as unknown as PointerEvent<HTMLElement>

// 三块首尾相接：a 0–2、b 2–4、c 4–5（秒）；每 10px 是 0.1 秒
const A: Block = { id: 'a', at: 0, d: 2 }

/** 往左拖 `dx` 像素时 b 的左把手：b 变长，c 跟着往后；拖过 1.5 秒放不下。 */
const stretchB = (dx: number): Step => {
  const grow = -dx / 100
  return {
    dx,
    fits: dx > -150,
    blocks: [A, { id: 'b', at: 2, d: 2 + grow }, { id: 'c', at: 4 + grow, d: 1 }],
  }
}

/**
 * 时间线内容层：三块各带 `data-slide`，位置（像素，每秒 100px）由 `layout` 给出；jsdom 不排版，量到的就是它。
 * `commit` 把位置换成这一步提交之后首尾相接的样子（同调用方在提交时改数据）。
 */
const timeline = () => {
  const container = document.createElement('div')
  const nodes = new Map(
    ['a', 'b', 'c'].map((id) => {
      const node = document.createElement('div')
      node.dataset['slide'] = id
      container.append(node)
      return [id, node] as const
    }),
  )
  let layout: readonly Block[] = [A, { id: 'b', at: 2, d: 2 }, { id: 'c', at: 4, d: 1 }]
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const block = layout.find((candidate) => nodes.get(candidate.id) === this)
    return block === undefined
      ? DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 40 })
      : DOMRect.fromRect({ x: block.at * 100, y: 0, width: block.d * 100, height: 40 })
  })
  const calls: { slide: string | undefined; keyframes: Keyframe[] }[] = []
  vi.spyOn(Element.prototype, 'animate').mockImplementation(function (
    this: Element,
    keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
  ) {
    calls.push({
      slide: (this as HTMLElement).dataset['slide'],
      keyframes: keyframes as Keyframe[],
    })
    return { cancel: () => {} } as unknown as Animation
  })
  return {
    container,
    calls,
    commit: (step: Step) => {
      layout = step.blocks
    },
  }
}

const setup = (view = timeline()) => {
  const onCommit = vi.fn<(step: Step) => void>(view.commit)
  const onPreview = vi.fn()
  const onEnd = vi.fn()
  const handle = pressable()
  const hook = renderHook(() => {
    const clicks = useClickAfterDrag()
    const gesture = usePreviewGesture<Step>({
      containerRef: { current: view.container },
      clicks,
      accepts: (step) => step.fits,
      onCommit,
      onPreview,
      onEnd,
    })
    return { clicks, gesture }
  })
  const gesture = () => hook.result.current.gesture
  return {
    onCommit,
    onPreview,
    onEnd,
    gesture,
    handle,
    calls: view.calls,
    press: (compute = stretchB) => act(() => gesture().start(pointer(handle, 0), compute)),
    pressTrim: (target: TrimTarget, compute: (dx: number) => Step) =>
      act(() => gesture().startTrim(pointer(handle, 0), target, compute)),
    move: (clientX: number) => act(() => gesture().move(pointer(handle, clientX))),
    release: () => {
      let moved = false
      act(() => {
        moved = gesture().end(pointer(handle, 0))
      })
      return moved
    },
    tookClick: () => hook.result.current.clicks.take(),
  }
}

describe('usePreviewGesture', () => {
  it('没超过拖动阈值算点按：不出预览，松手不提交、不吞 click', () => {
    const { press, move, release, gesture, onCommit, tookClick } = setup()
    press()
    move(-4)
    expect(gesture().preview).toBeNull()
    expect(release()).toBe(false)
    expect(onCommit).not.toHaveBeenCalled()
    expect(tookClick()).toBe(false)
  })

  it('超过阈值后每一步都出预览；松手只提交一次最后一步，并吞掉随后的 click', () => {
    const { press, move, release, gesture, onCommit, onPreview, tookClick } = setup()
    press()
    move(-5)
    expect(gesture().preview?.last.dx).toBe(-5)
    move(-50)
    expect(gesture().preview?.last.dx).toBe(-50)
    expect(onPreview).toHaveBeenLastCalledWith({ last: stretchB(-50), step: stretchB(-50) })
    expect(onCommit).not.toHaveBeenCalled()

    expect(release()).toBe(true)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(stretchB(-50))
    expect(gesture().preview).toBeNull()
    expect(onPreview).toHaveBeenLastCalledWith(null)
    expect(tookClick()).toBe(true)
  })

  it('放不下的一步不去：预览停在上一个放得下的一步，此刻这一步另给；松手提交放得下的那一步', () => {
    const { press, move, release, gesture, onCommit } = setup()
    press()
    move(-100)
    move(-200)
    expect(gesture().preview?.last.dx).toBe(-100)
    expect(gesture().preview?.step.dx).toBe(-200)
    release()
    expect(onCommit).toHaveBeenCalledWith(stretchB(-100))
  })

  it('一步都放不下就没有预览，松手什么都不提交', () => {
    const { press, move, release, gesture, onCommit } = setup()
    press()
    move(-200)
    expect(gesture().preview).toBeNull()
    expect(release()).toBe(true)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('取消：什么都不提交，预览回到没有；之后的松手不算', () => {
    const { press, move, release, gesture, onCommit, onPreview, tookClick } = setup()
    press()
    move(-50)
    act(() => gesture().cancel())
    expect(gesture().preview).toBeNull()
    expect(onPreview).toHaveBeenLastCalledWith(null)
    expect(release()).toBe(false)
    expect(onCommit).not.toHaveBeenCalled()
    // 拖过之后取消，随后的 click 也不算点选
    expect(tookClick()).toBe(true)
  })

  it('不是左键按下不算开始', () => {
    const { gesture, handle, move, release, onCommit } = setup()
    act(() => gesture().start(pointer(handle, 0, { button: 2 }), stretchB))
    move(-50)
    expect(gesture().preview).toBeNull()
    expect(release()).toBe(false)
    expect(onCommit).not.toHaveBeenCalled()
  })
})

describe('拖动一定会结束', () => {
  it('把手丢了指针捕获后在别处松手：按松手提交一次，预览清空', () => {
    const { press, move, gesture, handle, onCommit, onPreview, onEnd, tookClick } = setup()
    press()
    move(-50)
    // 浏览器窗口外松开等情况：把手丢了捕获，之后的松手送不到把手
    handle.releasePointerCapture(1)
    fireEvent.lostPointerCapture(handle, { pointerId: 1 })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(stretchB(-50))
    expect(gesture().preview).toBeNull()
    expect(onPreview).toHaveBeenLastCalledWith(null)
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(tookClick()).toBe(true)
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('只在 window 上收到松手（把手没收到）：提交一次，结束', () => {
    const { press, move, gesture, onCommit, onEnd } = setup()
    press()
    move(-50)
    fireEvent.pointerUp(window, { pointerId: 1 })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(stretchB(-50))
    expect(gesture().preview).toBeNull()
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('把手被移出文档（丢失捕获发到 document）：按松手提交', () => {
    const { press, move, handle, onCommit } = setup()
    press()
    move(-50)
    handle.remove()
    fireEvent.lostPointerCapture(document, { pointerId: 1 })
    expect(onCommit).toHaveBeenCalledWith(stretchB(-50))
  })

  it('别的元素丢了捕获、别的指针松手都不算', () => {
    const { press, move, gesture, onCommit } = setup()
    press()
    move(-50)
    fireEvent.lostPointerCapture(pressable(), { pointerId: 1 })
    fireEvent.pointerUp(window, { pointerId: 2 })
    expect(onCommit).not.toHaveBeenCalled()
    expect(gesture().preview?.last).toEqual(stretchB(-50))
  })

  it('pointercancel 按取消：什么都不提交，回到原样', () => {
    const { press, move, gesture, onCommit, onPreview, onEnd } = setup()
    press()
    move(-50)
    fireEvent.pointerCancel(window, { pointerId: 1 })
    expect(onCommit).not.toHaveBeenCalled()
    expect(gesture().preview).toBeNull()
    expect(onPreview).toHaveBeenLastCalledWith(null)
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('只结束一次：把手上的松手、window 上的松手与随后的丢失捕获只提交一次', () => {
    const { press, move, release, handle, onCommit, onEnd } = setup()
    press()
    move(-50)
    expect(release()).toBe(true)
    fireEvent.pointerUp(window, { pointerId: 1 })
    fireEvent.lostPointerCapture(handle, { pointerId: 1 })
    fireEvent.pointerCancel(window, { pointerId: 1 })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onEnd).toHaveBeenCalledTimes(1)
    // 结束后把手已放开指针
    expect(handle.hasPointerCapture(1)).toBe(false)
  })

  it('按下时在 window 上加的监听，结束后都拆掉', () => {
    const added = vi.spyOn(window, 'addEventListener')
    const removed = vi.spyOn(window, 'removeEventListener')
    const { press, move, release } = setup()
    const ending = ['pointerup', 'pointercancel', 'lostpointercapture']
    const types = (spy: typeof added) =>
      spy.mock.calls.map(([type]) => type).filter((type) => ending.includes(type))
    press()
    expect(types(added)).toEqual(ending)
    move(-50)
    release()
    expect(types(removed)).toEqual(ending)
  })
})

describe('修剪一串首尾相接的块：松手后滑到首尾相接的位置', () => {
  /** 往右拖 `dx` 像素时 b 的左把手（往里裁）：b 变短，c 跟着往前。 */
  const cutStart = (dx: number): Step => ({
    dx,
    fits: true,
    blocks: [A, { id: 'b', at: 2, d: 2 - dx / 100 }, { id: 'c', at: 4 - dx / 100, d: 1 }],
  })
  /** 往左拖 `dx` 像素时 b 的右把手（往里裁）：b 变短，c 跟着往前。 */
  const cutEnd = (dx: number): Step => ({
    dx,
    fits: true,
    blocks: [A, { id: 'b', at: 2, d: 2 + dx / 100 }, { id: 'c', at: 4 + dx / 100, d: 1 }],
  })
  const slides = (calls: ReturnType<typeof timeline>['calls'], slide: string) =>
    calls.filter((call) => call.slide === slide).map((call) => call.keyframes)

  it('左把手：拖动中不动画；松手提交一次，被拖的块从保留段所在的地方、后面的块从原位滑过来，前面的块不动', () => {
    const { pressTrim, move, release, onCommit, calls } = setup()
    pressTrim({ slide: 'b', edge: 'start' }, cutStart)
    move(30)
    move(50)
    expect(calls).toEqual([])
    release()
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(cutStart(50))
    // b 拖动中保留下来的是 2.5–4 秒，松手后在 2–3.5 秒；c 从 4 秒到 3.5 秒
    expect(slides(calls, 'b')).toEqual([[{ translate: '50px 0' }, { translate: '0 0' }]])
    expect(slides(calls, 'c')).toEqual([[{ translate: '50px 0' }, { translate: '0 0' }]])
    expect(slides(calls, 'a')).toEqual([])
  })

  it('左把手往外拉长：被拖的块从拉长后左边沿所在的地方滑过来', () => {
    const { pressTrim, move, release, calls } = setup()
    pressTrim({ slide: 'b', edge: 'start' }, stretchB)
    move(-50)
    release()
    // b 拖动中是 1.5–4 秒，松手后在 2–4.5 秒
    expect(slides(calls, 'b')).toEqual([[{ translate: '-50px 0' }, { translate: '0 0' }]])
    expect(slides(calls, 'c')).toEqual([[{ translate: '-50px 0' }, { translate: '0 0' }]])
  })

  it('右把手：被拖的块原地变长短，只有后面的块滑过来', () => {
    const { pressTrim, move, release, calls } = setup()
    pressTrim({ slide: 'b', edge: 'end' }, cutEnd)
    move(-50)
    expect(calls).toEqual([])
    release()
    expect(slides(calls, 'b')).toEqual([])
    expect(slides(calls, 'c')).toEqual([[{ translate: '50px 0' }, { translate: '0 0' }]])
    expect(slides(calls, 'a')).toEqual([])
  })

  it('取消、没拖动就松手、挪块（不是修剪）都不滑', () => {
    const cancelled = setup()
    cancelled.pressTrim({ slide: 'b', edge: 'start' }, cutStart)
    cancelled.move(50)
    act(() => cancelled.gesture().cancel())
    expect(cancelled.calls).toEqual([])

    const tapped = setup()
    tapped.pressTrim({ slide: 'b', edge: 'start' }, cutStart)
    tapped.release()
    expect(tapped.calls).toEqual([])

    const carried = setup()
    carried.press(cutStart)
    carried.move(50)
    carried.release()
    expect(carried.onCommit).toHaveBeenCalledTimes(1)
    expect(carried.calls).toEqual([])
  })
})

describe('trimSpans', () => {
  // 这一块在 2–4 秒（长 2 秒）
  it.each([
    ['左把手往里裁', 'start', 1.5, { at: 2, len: 2 }, { at: 2.5, len: 1.5 }, { at: 2, len: 0.5 }],
    ['左把手往外拉长', 'start', 2.5, { at: 1.5, len: 2.5 }, { at: 1.5, len: 2.5 }, undefined],
    ['右把手往里裁', 'end', 1.5, { at: 2, len: 2 }, { at: 2, len: 1.5 }, { at: 3.5, len: 0.5 }],
    ['右把手往外拉长', 'end', 2.5, { at: 2, len: 2.5 }, { at: 2, len: 2.5 }, undefined],
    ['长度没变', 'start', 2, { at: 2, len: 2 }, { at: 2, len: 2 }, undefined],
  ] as const)('%s：整块、修剪后的范围与要剪掉的段', (_, edge, next, block, kept, cut) => {
    expect(trimSpans(edge, { at: 2, len: 2 }, next)).toEqual({ block, kept, cut })
  })

  it('左把手往外拉长越过 0：整块左边钉在 0、向右变长，修剪后的范围从 0 起', () => {
    // 这一块在 0.25–2.25 秒，开头拉早 0.5 秒
    expect(trimSpans('start', { at: 0.25, len: 2 }, 2.5)).toEqual({
      block: { at: 0, len: 2.5 },
      kept: { at: 0, len: 2.5 },
      cut: undefined,
    })
  })
})
