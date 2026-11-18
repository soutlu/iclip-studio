import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hoverOf, hoverProbe } from './canvas-hover'
import type { CanvasLayer } from './canvas-layers'
import type { PickedLayer } from './preview-player'
import type { LayerMeasure } from './preview-protocol'

const layer = (key: string, clip: string, host = false): CanvasLayer => ({
  key,
  scope: host ? null : clip,
  selector: `#${key}`,
  index: 0,
  count: 1,
  file: 'index.html',
  clip,
  host,
  locked: false,
  element: { hfId: key, tag: 'div', attributes: {} },
})

const measure = (cx: number): LayerMeasure => ({
  frame: { cx, cy: 50, width: 20, height: 10, angle: 0 },
  visible: { cx, cy: 50, width: 20, height: 10, angle: 0 },
  width: 20,
  height: 10,
  parent: { a: 1, b: 0, c: 0, d: 1 },
  rotate: 0,
  translating: false,
  inline: false,
  flex: 0,
  move: true,
  resize: true,
  turn: true,
  refusal: 0,
})

// 表：0 是贴片的宿主，1、2 是贴片里的两层，3 是视频片段
const LAYERS = [
  layer('host', 'item', true),
  layer('title', 'item'),
  layer('badge', 'item'),
  layer('video', 'video'),
]
const picked = (at: number, cx: number, owner = -1): PickedLayer => ({
  layer: at,
  owner,
  measure: measure(cx),
})
const never = () => false
const PLAIN = { isText: never, winsOnTop: never }

describe('悬停框哪一层', () => {
  it('框最上面那一层，宿主跳过', () => {
    const hover = hoverOf([picked(0, 1), picked(1, 2, 0), picked(3, 3)], LAYERS, new Set(), PLAIN)
    expect(hover).toEqual({ frame: measure(2).frame, clip: 'item', generated: false, text: false })
  })

  it('指针下有已经框着的层：点下去还是它，不框', () => {
    expect(hoverOf([picked(1, 2, 0), picked(3, 3)], LAYERS, new Set(['video']), PLAIN)).toBeNull()
  })

  it('最上面是点一下就选中它的层（字幕）：下面有框着的层也框它；它自己框着时不框', () => {
    const judges = { isText: never, winsOnTop: (each: CanvasLayer) => each.key === 'title' }
    const stack = [picked(1, 2, 0), picked(3, 3)]
    expect(hoverOf(stack, LAYERS, new Set(['video']), judges)?.frame).toEqual(measure(2).frame)
    expect(hoverOf(stack, LAYERS, new Set(['title']), judges)).toBeNull()
  })

  it('最上面是脚本生成的层：框它，算在挂着它的宿主的片段上', () => {
    expect(hoverOf([picked(-1, 7, 0), picked(3, 3)], LAYERS, new Set(), PLAIN)).toEqual({
      frame: measure(7).frame,
      clip: 'item',
      generated: true,
      text: false,
    })
  })

  it('能原地改字的层标出来；指针下没有层时不框', () => {
    const judges = { isText: (each: CanvasLayer) => each.key === 'title', winsOnTop: never }
    expect(hoverOf([picked(1, 2, 0)], LAYERS, new Set(), judges)?.text).toBe(true)
    expect(hoverOf([picked(2, 2, 0)], LAYERS, new Set(), judges)?.text).toBe(false)
    expect(hoverOf([], LAYERS, new Set(), judges)).toBeNull()
  })
})

describe('悬停时问预览页', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('隔一段时间最多问一次，中间挪到的点只问最后一个', async () => {
    const asked: number[] = []
    const answers: number[] = []
    const probe = hoverProbe(
      (point) => {
        asked.push(point.x)
        return Promise.resolve(point.x)
      },
      (x) => answers.push(x),
      80,
    )
    probe.move({ x: 1, y: 0 })
    probe.move({ x: 2, y: 0 })
    probe.move({ x: 3, y: 0 })
    expect(asked).toEqual([1])
    await vi.advanceTimersByTimeAsync(80)
    expect(asked).toEqual([1, 3])
    expect(answers).toEqual([1, 3])
  })

  it('停下以后：还没问的不问，问了还没回来的答复不要', async () => {
    let reply: (value: number) => void = () => {}
    const answers: number[] = []
    const asked: number[] = []
    const probe = hoverProbe(
      (point) => {
        asked.push(point.x)
        return new Promise<number>((resolve) => {
          reply = resolve
        })
      },
      (x) => answers.push(x),
      80,
    )
    probe.move({ x: 1, y: 0 })
    probe.move({ x: 2, y: 0 })
    probe.stop()
    reply(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(asked).toEqual([1])
    expect(answers).toEqual([])
  })
})
