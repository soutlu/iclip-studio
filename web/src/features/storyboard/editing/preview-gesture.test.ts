import { act, renderHook } from '@testing-library/react'
import type { PointerEvent } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { usePreviewGesture, type Chain } from './preview-gesture'
import { useClickAfterDrag } from './timeline-drag'

type Block = { id: string; at: number; d: number }
type Step = { dx: number; fits: boolean; blocks: readonly Block[] }

const chain: Chain<Block> = {
  startOf: (block) => block.at,
  lengthOf: (block) => block.d,
  moved: (block, at) => ({ ...block, at }),
}

/** 指针事件：只带核心读的字段，指针捕获由一个假的按下元素承担。 */
const pointer = (clientX: number, { button = 0, clientY = 0 } = {}) =>
  ({
    pointerId: 1,
    button,
    clientX,
    clientY,
    stopPropagation: () => {},
    currentTarget: {
      setPointerCapture: () => {},
      hasPointerCapture: () => true,
      releasePointerCapture: () => {},
    },
  }) as unknown as PointerEvent<HTMLElement>

// 三块首尾相接：a 0–2、b 2–4、c 4–5（秒）；每 10px 是 0.1 秒
const A: Block = { id: 'a', at: 0, d: 2 }
const BLOCKS: readonly Block[] = [A, { id: 'b', at: 2, d: 2 }, { id: 'c', at: 4, d: 1 }]

/** 往左拖 `dx` 像素时 b 的左把手：b 变长，c 跟着往后；拖过 1.5 秒放不下。 */
const stretchB = (dx: number): Step => {
  const grow = -dx / 100
  return {
    dx,
    fits: dx > -150,
    blocks: [A, { id: 'b', at: 2, d: 2 + grow }, { id: 'c', at: 4 + grow, d: 1 }],
  }
}

const setup = () => {
  const onCommit = vi.fn()
  const onPreview = vi.fn()
  const view = renderHook(() => {
    const clicks = useClickAfterDrag()
    const gesture = usePreviewGesture<Step>({
      containerRef: { current: null },
      clicks,
      accepts: (step) => step.fits,
      onCommit,
      onPreview,
    })
    return { clicks, gesture }
  })
  const gesture = () => view.result.current.gesture
  return {
    onCommit,
    onPreview,
    gesture,
    press: (compute = stretchB) => act(() => gesture().start(pointer(0), compute)),
    pressTrim: (edge: 'start' | 'end') =>
      act(() => gesture().startTrim(pointer(0), { id: 'b', edge, end: 4 }, stretchB)),
    move: (clientX: number) => act(() => gesture().move(pointer(clientX))),
    release: () => {
      let moved = false
      act(() => {
        moved = gesture().end(pointer(0))
      })
      return moved
    },
    tookClick: () => view.result.current.clicks.take(),
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
    expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ last: stretchB(-50) }))
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
    const { gesture, move, release, onCommit } = setup()
    act(() => gesture().start(pointer(0, { button: 2 }), stretchB))
    move(-50)
    expect(gesture().preview).toBeNull()
    expect(release()).toBe(false)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('左把手：被拖的块右边沿与后面的块停在按下时的位置，左边沿跟手；时刻按显示位置换算', () => {
    const { pressTrim, move, gesture } = setup()
    pressTrim('start')
    // 往左 50px：b 变成 2–4.5、c 4.5–5.5；显示上 b 在 1.5–4、c 仍在 4
    move(-50)
    const held = gesture().hold(gesture().preview?.last.blocks ?? [], chain)
    expect(held.items).toEqual([
      { id: 'a', at: 0, d: 2 },
      { id: 'b', at: 1.5, d: 2.5 },
      { id: 'c', at: 4, d: 1 },
    ])
    expect(held.shiftAt(2)).toBe(1.5)
    expect(held.shiftAt(1)).toBe(1)
    // 拖动中给调用方的预览带着同一个摆法
    expect(gesture().preview?.hold(gesture().preview?.last.blocks ?? [], chain).items).toEqual(
      held.items,
    )
  })

  it('右把手与没在拖时都不挪显示位置', () => {
    const { pressTrim, move, gesture } = setup()
    expect(gesture().hold(BLOCKS, chain).items).toBe(BLOCKS)
    pressTrim('end')
    move(-50)
    const blocks = gesture().preview?.last.blocks ?? []
    expect(gesture().hold(blocks, chain).items).toBe(blocks)
  })
})
