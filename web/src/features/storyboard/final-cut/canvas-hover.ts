import type { Frame, Point } from './canvas-geometry'
import type { CanvasLayer } from './canvas-layers'
import { drawnFrame } from './canvas-visible'
import type { PickedLayer } from './preview-player'

/** 指针悬停命中结果：可见裁剪框（见 canvas-visible.ts）、所属片段 ID 以及当前位置是否支持双击原地改字。 */
export type Hover = { frame: Frame; clip: string; text: boolean }

/**
 * 计算指针悬停处应展示的预选框（与按下时的命中规则一致）：
 * `stack` 为预览页返回的从上到下命中栈（贴片与场景整体作为一层）。
 * - 若最顶层满足 `winsOnTop`（单句字幕）且尚未选中，优先高亮该层；
 * - 否则若命中栈中已包含选中图层（`selected`），按下时仍保持原选中，不重复绘制悬停框；
 * - 否则高亮最顶层命中项（无有效命中时返回 `null`）。
 * `isText` 根据命中图层与指针下绑定的可填项标识（`field`）判断是否切换为文本输入光标。
 */
export function hoverOf(
  stack: readonly PickedLayer[],
  layers: readonly CanvasLayer[],
  selected: ReadonlySet<string>,
  {
    isText,
    winsOnTop,
  }: {
    isText: (layer: CanvasLayer, field: string | null) => boolean
    winsOnTop: (layer: CanvasLayer) => boolean
  },
): Hover | null {
  const known = stack.flatMap((item) => {
    const layer = layers[item.layer]
    return layer === undefined ? [] : [{ ...item, layer }]
  })
  const [hit] = known
  if (hit === undefined) return null
  const onTop = winsOnTop(hit.layer) && !selected.has(hit.layer.key)
  if (!onTop && known.some(({ layer }) => selected.has(layer.key))) return null
  return {
    frame: drawnFrame(hit.measure),
    clip: hit.layer.clip,
    text: isText(hit.layer, hit.field),
  }
}

/** 悬停命中探测器：`move` 上报最新指针坐标，`stop` 取消待发探测并丢弃在途响应。 */
export type HoverProbe = { move: (point: Point) => void; stop: () => void }

/**
 * 节流向预览页查询指针下的命中图层：每 `interval` 毫秒最多发起一次请求，窗口期内多次移动仅查询最后一次位置；
 * 乱序晚到的旧响应及 `stop` 调用前发出的在途响应一律丢弃。
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
