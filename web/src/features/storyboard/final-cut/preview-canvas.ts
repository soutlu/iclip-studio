import type { ClipBox, Point, Rect } from './canvas-geometry'

// 预览页这边的画面编辑：量片段的布局框、拖动中摆片段、找要改的文字。都在播放器里的 final-cut 页面上做，
// 这个页面在另一个文档里，元素不是本页的 HTMLElement，按特性判断。

type Laid = HTMLElement

const isLaid = (element: Element | null): element is Laid =>
  element !== null && 'offsetWidth' in element && 'style' in element

/** final-cut 页面里编号是 `id` 的元素；没有时是 null。 */
export const elementOf = (page: Document, id: string): Laid | null => {
  const element = page.querySelector(`[data-hf-id="${CSS.escape(id)}"]`)
  return isLaid(element) ? element : null
}

/** 最外层的 final-cut 根（带 `data-composition-id`）。 */
const filmRoot = (element: Element): Element | null => {
  let root: Element | null = null
  for (let node: Element | null = element.parentElement; node !== null; node = node.parentElement)
    if (node.hasAttribute('data-composition-id')) root = node
  return root
}

/** 视频按 `object-fit: contain` 放进 `width` × `height` 的框时有画面的部分；读不出视频尺寸时是整个框。 */
const containedIn = (video: HTMLVideoElement, width: number, height: number): Rect => {
  const view = video.ownerDocument.defaultView
  const style = view?.getComputedStyle(video)
  const whole = { x: 0, y: 0, width, height }
  if (
    style?.objectFit !== 'contain' ||
    style.objectPosition !== '50% 50%' ||
    video.videoWidth <= 0 ||
    video.videoHeight <= 0
  )
    return whole
  const scale = Math.min(width / video.videoWidth, height / video.videoHeight)
  const shown = { width: video.videoWidth * scale, height: video.videoHeight * scale }
  return { x: (width - shown.width) / 2, y: (height - shown.height) / 2, ...shown }
}

/** 元素的布局框左上角离页面左上角多远（不算变换）。 */
const pageOffset = (element: Laid): Point => {
  let x = 0
  let y = 0
  for (let node: Element | null = element; isLaid(node); node = node.offsetParent) {
    x += node.offsetLeft
    y += node.offsetTop
  }
  return { x, y }
}

/**
 * 片段元素在画布上的布局框（相对 final-cut 根，不含行内的位移、角度和缩放：`offset*` 不算这些）；
 * 没显示（`display: none`）或者不在根下时是 null。
 */
export const clipBoxOf = (element: Laid): ClipBox | null => {
  const root = filmRoot(element)
  if (!isLaid(root) || element.offsetParent === null) return null
  const at = pageOffset(element)
  const origin = pageOffset(root)
  const x = at.x - origin.x
  const y = at.y - origin.y
  const { offsetWidth: width, offsetHeight: height } = element
  const content =
    element.tagName === 'VIDEO'
      ? containedIn(element as HTMLVideoElement, width, height)
      : { x: 0, y: 0, width, height }
  return { box: { x, y, width, height }, content }
}

/** 拖动中把元素的行内位移、角度、缩放摆成 `styles`（null 是去掉）。 */
export const poseElement = (
  element: Laid,
  styles: Record<'translate' | 'rotate' | 'scale', string | null>,
) => {
  for (const [name, value] of Object.entries(styles)) {
    if (value === null) element.style.removeProperty(name)
    else element.style.setProperty(name, value)
  }
}

/** 在画布上要改的一段文字：元素、它是 `fields` 里的第几个、框和画布上的字号。 */
export type TextSpot = { element: Laid; field: number; rect: Rect; fontSize: number }

/**
 * 片段 `host` 里画布上 `point` 处的文字字段（`data-var-text` 是 `fields` 里的一个、显示着的）；那里没有时，
 * 片段里只有一个这样的字段就是它，不然是 null。
 */
export const textSpotAt = (
  host: Laid,
  fields: readonly string[],
  point: Point,
): TextSpot | null => {
  const root = filmRoot(host)
  const origin = root?.getBoundingClientRect() ?? { left: 0, top: 0 }
  const spots = [...host.querySelectorAll('[data-var-text]')].flatMap((element) => {
    const field = fields.indexOf(element.getAttribute('data-var-text') ?? '')
    if (field < 0 || !isLaid(element)) return []
    const bounds = element.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return []
    const rect = {
      x: bounds.left - origin.left,
      y: bounds.top - origin.top,
      width: bounds.width,
      height: bounds.height,
    }
    const declared = Number.parseFloat(
      element.ownerDocument.defaultView?.getComputedStyle(element).fontSize ?? '',
    )
    // 画布上的字号算上宿主和组件里的缩放：框的高比布局高
    const zoom = element.offsetHeight > 0 ? bounds.height / element.offsetHeight : 1
    const fontSize = Number.isFinite(declared) ? declared * zoom : bounds.height
    return [{ element, field, rect, fontSize }]
  })
  const inside = spots.find(
    ({ rect }) =>
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height,
  )
  return inside ?? (spots.length === 1 ? (spots[0] ?? null) : null)
}

/** 原地改字时藏起来的那段文字，`visibility` 是它原来的行内写法。 */
export type HiddenText = { element: Laid; visibility: string }

export const hideText = (element: Laid): HiddenText => {
  const hidden = { element, visibility: element.style.getPropertyValue('visibility') }
  element.style.setProperty('visibility', 'hidden')
  return hidden
}

/** 显示回来；`text` 不是 null 时先换上这段字。 */
export const showText = ({ element, visibility }: HiddenText, text: string | null) => {
  if (text !== null) element.textContent = text
  if (visibility === '') element.style.removeProperty('visibility')
  else element.style.setProperty('visibility', visibility)
}
