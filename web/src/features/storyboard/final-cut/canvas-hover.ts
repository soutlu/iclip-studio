import type { Frame, Point } from './canvas-geometry'
import type { CanvasLayer } from './canvas-layers'
import { drawnFrame } from './canvas-visible'
import type { PickedLayer } from './preview-player'

/**
 * 指针停着的地方框哪一层：它画出来的框（看得见的那一块，见 canvas-visible.ts）、属于哪个片段，是不是脚本生成的层（表里没有），能不能原地改字。
 */
export type Hover = { frame: Frame; clip: string; generated: boolean; text: boolean }

type Judge = (layer: CanvasLayer) => boolean

/**
 * 指针停在画面上这一处时框哪一层，就是点下去会选中的那一层（规则同点选时）：`stack` 是预览页答复的指针下的层，
 * 从上往下；宿主跳过。最上面一层是 `winsOnTop` 的（字幕的一句）、它还没框着时，点一下选中的是它，框它；不然指针下
 * 有已经框着的层（`selected`，表里的 key）时点下去还是它，不再框；最上面是脚本生成的层时框它；不然框最上面那一层。
 * 指针下没有能选中的层时是 null。`isText` 判断一层能不能原地改字。
 */
export function hoverOf(
  stack: readonly PickedLayer[],
  layers: readonly CanvasLayer[],
  selected: ReadonlySet<string>,
  { isText, winsOnTop }: { isText: Judge; winsOnTop: Judge },
): Hover | null {
  const known = stack.flatMap((item) => {
    const layer = layers[item.layer]
    return item.layer < 0 || layer === undefined || layer.host ? [] : [{ ...item, layer }]
  })
  const [first] = known
  const onTop = first !== undefined && winsOnTop(first.layer) && !selected.has(first.layer.key)
  if (!onTop && known.some(({ layer }) => selected.has(layer.key))) return null
  const [top] = stack
  const owner = top === undefined ? undefined : layers[top.owner]
  if (top !== undefined && top.layer < 0 && owner !== undefined)
    return { frame: drawnFrame(top.measure), clip: owner.clip, generated: true, text: false }
  const [hit] = known
  if (hit === undefined) return null
  return {
    frame: drawnFrame(hit.measure),
    clip: hit.layer.clip,
    generated: false,
    text: isText(hit.layer),
  }
}

/** 悬停时问预览页的那个问题：`move` 报指针挪到的点，`stop` 不再问、还没回来的答复也不要。 */
export type HoverProbe = { move: (point: Point) => void; stop: () => void }

/**
 * 悬停时问预览页「这一点下面是哪一层」，不每次挪动都问：每 `interval` 毫秒最多问一次，这中间挪到的点只问最后
 * 一个。答复回来交给 `answer`；比已经交出去的答复问得早的、`stop` 以前问的，都不要。
 */
export function hoverProbe<T>(
  ask: (point: Point) => Promise<T>,
  answer: (result: T) => void,
  interval: number,
): HoverProbe {
  let asked = Number.NEGATIVE_INFINITY
  let pending: Point | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let seq = 0
  let answered = 0
  let stopped = 0
  const send = (point: Point) => {
    asked = Date.now()
    seq += 1
    const mine = seq
    void ask(point).then((result) => {
      if (mine <= answered || mine <= stopped) return
      answered = mine
      answer(result)
    })
  }
  return {
    move: (point) => {
      pending = point
      if (timer !== null) return
      const wait = asked + interval - Date.now()
      if (wait <= 0) {
        pending = null
        send(point)
        return
      }
      timer = setTimeout(() => {
        timer = null
        const next = pending
        pending = null
        if (next !== null) send(next)
      }, wait)
    },
    stop: () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      pending = null
      stopped = seq
    },
  }
}
