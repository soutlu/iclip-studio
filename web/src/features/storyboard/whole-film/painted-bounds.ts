/**
 * 预览画面上的命中与选中框，在合成页（播放器里的同源 iframe）的文档里算。坐标都是合成页文档自己的
 * 坐标：客户端坐标减去 iframe 的位置，再除以缩放（iframe 宽 / 画布宽）。
 *
 * 「这个元素画没画东西」用 HyperFrames SDK 的墨迹判断（`elementPaintsInk`）。命中不用 SDK 预览适配器的
 * `elementAtPoint`：它不看元素画没画东西，铺满画面的透明特效宿主会接住所有点击。这里照 SDK 留给
 * 「命中规则不同的宿主」的做法，按画面上的叠放次序找第一个看得见、画了东西的元素。
 */
import { elementPaintsInk } from '@hyperframes/sdk/adapters/iframe'

type ContentWindow = Window & typeof globalThis

/** 合成页文档坐标里的一块范围 */
export type Box = { left: number; top: number; width: number; height: number }

/**
 * 元素看得见：它和整条祖先链上没有 opacity 为 0、visibility 为 hidden 或不显示的。
 * 口径同 SDK 预览适配器里的 isOpacityVisible（它没有导出），另加 visibility 与 display。
 */
export function isShown(element: Element, win: ContentWindow): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const style = win.getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    if (Number.parseFloat(style.opacity) === 0) return false
  }
  return true
}

/**
 * 叠放次序里（上面的在前）第一个看得见、在这一点上画了东西的元素；铺满画面的透明宿主、
 * 透明像素的图片都穿过去。都没有时为 null。
 */
export function painterAt(
  stack: readonly Element[],
  win: ContentWindow,
  point: { x: number; y: number },
): Element | null {
  return (
    stack.find((element) => isShown(element, win) && elementPaintsInk(element, win, point)) ?? null
  )
}

/**
 * 从元素往上找最近的、`resolve` 认得的 data-hf-id（我们写在合成页上的草稿 id 或 `caption:N`），
 * 返回它对到的东西。组件自带的 data-hf-id 认不出，跳过接着往上找。
 *
 * 不用 SDK 的 resolveNearestHfElement：它停在第一个 data-hf-id 上，组件内部自带的会截住。
 */
export function ownerOf<T>(element: Element, resolve: (hfId: string) => T | undefined) {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const hfId = node.getAttribute('data-hf-id')
    if (hfId === null) continue
    const owner = resolve(hfId)
    if (owner !== undefined) return { owner, element: node }
  }
  return undefined
}

/**
 * 点中的是哪一块：叠放次序里第一个看得见、画了东西的元素归哪一块就是哪一块；它不属于任何一块
 * （例如黑底的舞台）时没有命中，返回 null。
 */
export function hitAt<T>(
  stack: readonly Element[],
  win: ContentWindow,
  point: { x: number; y: number },
  resolve: (hfId: string) => T | undefined,
): T | null {
  const painter = painterAt(stack, win, point)
  return painter === null ? null : (ownerOf(painter, resolve)?.owner ?? null)
}

// 合成页里的组件、字幕常把根节点设成 pointer-events:none（只为播放），elementsFromPoint 会漏掉它们；
// 画面上的指针本来就进不了 iframe（播放器把它设成 pointer-events:none），查叠放次序时临时全部放开。
// 放在层里的 !important 压过页面里没分层的 !important，同 HyperFrames 运行时 picker 的做法。
const PICKABLE = '@layer iclip-canvas-pick{*{pointer-events:auto!important}}'

/** 合成页里这一点上从上到下叠着的元素（不论 pointer-events） */
export function stackAt(doc: Document, win: ContentWindow, x: number, y: number): Element[] {
  // 样式表要在 iframe 自己的环境里建，才能挂到它的文档上
  const sheet = new win.CSSStyleSheet()
  sheet.replaceSync(PICKABLE)
  doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet]
  try {
    return doc.elementsFromPoint(x, y)
  } finally {
    doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((item) => item !== sheet)
  }
}

/**
 * 这几个元素（含其中的元素）里所有看得见、画了东西的部分合起来的范围，裁在画面以内；
 * 一处也没有时为 null。铺满画面却没画东西的外层盒子不算。
 */
export function paintedBounds(
  roots: readonly Element[],
  win: ContentWindow,
  frame: { width: number; height: number },
): Box | null {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const root of roots) {
    for (const element of [root, ...root.querySelectorAll('*')]) {
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      if (!elementPaintsInk(element, win) || !isShown(element, win)) continue
      left = Math.min(left, rect.left)
      top = Math.min(top, rect.top)
      right = Math.max(right, rect.right)
      bottom = Math.max(bottom, rect.bottom)
    }
  }
  left = Math.max(left, 0)
  top = Math.max(top, 0)
  right = Math.min(right, frame.width)
  bottom = Math.min(bottom, frame.height)
  if (right <= left || bottom <= top) return null
  return { left, top, width: right - left, height: bottom - top }
}
