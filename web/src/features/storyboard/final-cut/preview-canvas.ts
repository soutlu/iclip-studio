import {
  buildStableSelector,
  compositionPoint,
  elementCornerPoints,
  individualRotateDegrees,
  isCompositionHost,
  pointerTargets,
} from '@hyperframes/core/runtime/editing-port'
import {
  composeTranslate,
  EDIT_ORIGINAL_TRANSLATE_ATTR,
  readCurrentTranslate,
} from '@hyperframes/core/runtime/position-edits'
import { gsapOwns, layerAbilities, type RuntimeTimeline } from './layer-abilities'
import type { Point } from './canvas-geometry'
import { toLocal, type Linear } from './layer-edits'
import type { LayerFrame, LayerMeasure, LayerRef } from './preview-protocol'

/** 画布上的一个矩形（像素）。 */
export type Rect = { x: number; y: number; width: number; height: number }

// 预览页这边的画面编辑：认层、量层、拖动中摆层、找要改的文字。都在播放器里的 final-cut 页面上做，
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

/** final-cut 页面里最外层的根（带 `data-composition-id`）；没有时是 null。 */
const pageRoot = (page: Document): Laid | null => {
  const root = page.querySelector('[data-composition-id]')
  return isLaid(root) ? root : null
}

/** 元素挂在哪个宿主下：最近的带 `data-composition-src` 的祖先的 `data-hf-id`；在主文件里时是 null。 */
const scopeOf = (element: Element): string | null =>
  element.parentElement?.closest('[data-composition-src]')?.getAttribute('data-hf-id') ?? null

/** 一层在画面里的样子：表里的这一层在 `page` 里找到的元素，和画面里一共几个匹配。 */
const matchesOf = (page: Document, ref: LayerRef): Laid[] => {
  const base =
    ref.scope === null
      ? pageRoot(page)
      : [...page.querySelectorAll('[data-composition-src]')].find(
          (host) => host.getAttribute('data-hf-id') === ref.scope,
        )
  if (base === null || base === undefined) return []
  let found: Element[]
  try {
    found = [...base.querySelectorAll(ref.selector)]
  } catch {
    return []
  }
  return found.filter(
    (element): element is Laid => isLaid(element) && scopeOf(element) === ref.scope,
  )
}

/** 表里的一层在画面里是哪个元素：找不到、画面里的匹配数和源文件里的不一样（脚本加了）时是 null。 */
export const layerElement = (page: Document, ref: LayerRef & { count: number }): Laid | null => {
  const matches = matchesOf(page, ref)
  return matches.length === ref.count ? (matches[ref.index] ?? null) : null
}

/** 画面里的一个元素按表认成的那一层（`scope`、选择器、第几个匹配）；取不到选择器时是 null。 */
export const refOf = (page: Document, element: Laid): LayerRef | null => {
  const selector = buildStableSelector(element)
  if (selector === undefined) return null
  const scope = scopeOf(element)
  const index = matchesOf(page, { scope, selector, index: 0 }).indexOf(element)
  return index < 0 ? null : { scope, selector, index }
}

/** 画面里的一个元素挂着的宿主元素；在主文件里时是 null。 */
export const ownerOf = (element: Element): Laid | null => {
  const host = element.parentElement?.closest('[data-composition-src]') ?? null
  return isLaid(host) ? host : null
}

const IDENTITY: Linear = { a: 1, b: 0, c: 0, d: 1 }

/** 计算样式里的 `scale`（`none`、`sx`、`sx sy`、`sx sy sz`）在平面里的两个倍数；认不出时是 null。 */
const individualScale = (value: string): { x: number; y: number } | null => {
  if (value === '' || value === 'none') return { x: 1, y: 1 }
  const [x, y] = value.trim().split(/\s+/).map(Number)
  if (x === undefined || !Number.isFinite(x)) return null
  if (y === undefined) return { x, y: x }
  return Number.isFinite(y) ? { x, y } : null
}

/**
 * 元素画出来时的线性变换：它和所有祖先的 `rotate`、`scale`、`transform`，一直合到文档。运行库的
 * `readElementTransformSnapshot` 只合到最近的合成根、也不算单独写的 `scale`，而贴片宿主正是用 `scale` 缩进画面的，
 * 所以这里自己合。认不出的变换时是 null。
 */
const paintedMatrix = (view: Window, element: Laid): DOMMatrix | null => {
  const chain: Element[] = []
  for (let node: Element | null = element; node !== null; node = node.parentElement)
    chain.unshift(node)
  let matrix = new DOMMatrix()
  for (const node of chain) {
    const style = view.getComputedStyle(node)
    const scale = individualScale(style.scale)
    if (scale === null) return null
    // 同一个元素上 CSS 先 rotate、再 scale、再 transform
    matrix = matrix
      .rotate(individualRotateDegrees(style.rotate))
      .scale(scale.x, scale.y)
      .multiply(
        style.transform === '' || style.transform === 'none'
          ? new DOMMatrix()
          : new DOMMatrix(style.transform),
      )
  }
  return matrix
}

/** 元素在画布上的样子：四个角经它和祖先的变换（运行库 `elementCornerPoints`），换成相对根的画布像素。 */
export const frameOfElement = (page: Document, element: Laid): LayerFrame | null => {
  const view = page.defaultView
  const root = pageRoot(page)
  if (view === null || root === null) return null
  const matrix = paintedMatrix(view, element)
  const corners =
    matrix === null
      ? null
      : elementCornerPoints(view, element, { matrix, cs: view.getComputedStyle(element) })
  const origin = root.getBoundingClientRect()
  if (corners === null) {
    const box = element.getBoundingClientRect()
    return {
      cx: box.left + box.width / 2 - origin.left,
      cy: box.top + box.height / 2 - origin.top,
      width: box.width,
      height: box.height,
      angle: 0,
    }
  }
  const { nw, ne, se, sw } = corners
  return {
    cx: (nw.x + ne.x + se.x + sw.x) / 4 - origin.left,
    cy: (nw.y + ne.y + se.y + sw.y) / 4 - origin.top,
    width: Math.hypot(ne.x - nw.x, ne.y - nw.y),
    height: Math.hypot(sw.x - nw.x, sw.y - nw.y),
    angle: (Math.atan2(ne.y - nw.y, ne.x - nw.x) * 180) / Math.PI,
  }
}

/** 父元素里一像素在画布上的样子（父元素和祖先的变换的线性部分）。 */
const parentLinear = (page: Document, element: Laid): Linear => {
  const view = page.defaultView
  const parent = element.parentElement
  if (view === null || !isLaid(parent)) return IDENTITY
  const matrix = paintedMatrix(view, parent)
  return matrix === null ? IDENTITY : { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d }
}

/**
 * 量表里的一层：在画布上的样子、布局宽高、父元素的线性变换、自己的 `rotate`、变换里有没有位移、是不是行内元素、
 * 父元素的弹性方向，和三样能不能改（见 layer-abilities.ts；`inSource` 是表里有它、画面里的匹配数也对上）。
 */
export const measureLayer = (
  page: Document,
  element: Laid,
  inSource: boolean,
): LayerMeasure | null => {
  const view = page.defaultView as
    (Window & { __timelines?: Record<string, RuntimeTimeline> }) | null
  const frame = frameOfElement(page, element)
  if (view === null || frame === null) return null
  const style = view.getComputedStyle(element)
  const own =
    style.transform === 'none' || style.transform === '' ? null : new DOMMatrix(style.transform)
  const parentStyle =
    element.parentElement === null ? null : view.getComputedStyle(element.parentElement)
  const flexParent = parentStyle?.display === 'flex' || parentStyle?.display === 'inline-flex'
  const host = isCompositionHost(element)
  const abilities = layerAbilities({
    tag: element.localName,
    host,
    root: !host && element.hasAttribute('data-composition-id'),
    locked: element.closest('[data-timeline-locked]') !== null,
    inSource,
    animated: {
      move: gsapOwns(element, view.__timelines, 'move'),
      resize: gsapOwns(element, view.__timelines, 'resize'),
      rotate: gsapOwns(element, view.__timelines, 'rotate'),
    },
  })
  return {
    frame,
    width: element.offsetWidth,
    height: element.offsetHeight,
    parent: parentLinear(page, element),
    rotate: individualRotateDegrees(style.rotate),
    translating: own !== null && (own.m41 !== 0 || own.m42 !== 0),
    inline: style.display === 'inline',
    flex: !flexParent ? 0 : parentStyle.flexDirection.startsWith('column') ? 2 : 1,
    move: abilities.move,
    resize: abilities.resize,
    turn: abilities.rotate,
    refusal: abilities.refusal,
  }
}

// 组件根上的 `pointer-events: none`（挂载时落到它的内层根上）是给播放用的，却会传给整棵子树。照运行库取元素时的
// 做法（runtime/picker.ts）：只在点中判断的那一刻让内层根和页面最外层的根接收指针，判断完马上撤掉；宿主自己的
// none 不动，那是外层作者让它点穿。放在 `hf-picker` 层里的 !important 压过作者所有普通规则和不分层的 !important。
const PICKABLE_ROOTS = '[data-hf-inner-root],[data-composition-id]:not([data-composition-id] *)'
const PICKABLE_ROOTS_RULE = `${PICKABLE_ROOTS}{pointer-events:auto!important}`

/** 页面的那份放开规则的样式表；页面不支持 adoptedStyleSheets 时是 null。 */
const pickableSheets = new WeakMap<Document, CSSStyleSheet | null>()

const pickableSheetOf = (page: Document): CSSStyleSheet | null => {
  const cached = pickableSheets.get(page)
  if (cached !== undefined) return cached
  const view = page.defaultView
  let sheet: CSSStyleSheet | null = null
  if (view !== null && Array.isArray(page.adoptedStyleSheets) && 'CSSStyleSheet' in view) {
    sheet = new view.CSSStyleSheet()
    sheet.replaceSync(`@layer hf-picker{${PICKABLE_ROOTS_RULE}}`)
  }
  pickableSheets.set(page, sheet)
  return sheet
}

/**
 * 让组件的内层根和最外层的根临时接收指针，跑完 `run` 马上恢复；答复 `run` 的结果和原本不接收指针的那几个根
 * （它们里面的层能点中，它们自己不算）。没有要放开的根时不改样式。
 */
const withPickableRoots = <T>(
  page: Document,
  run: () => T,
): { result: T; passThrough: Set<Element> } => {
  const view = page.defaultView
  const passThrough = new Set(
    [...page.querySelectorAll(PICKABLE_ROOTS)].filter(
      (root) => view?.getComputedStyle(root).pointerEvents === 'none',
    ),
  )
  if (passThrough.size === 0) return { result: run(), passThrough }
  const sheet = pickableSheetOf(page)
  let release: () => void
  if (sheet !== null) {
    // 采用的样式表不是 DOM 节点，不会惊动运行库盯着 DOM 的观察者
    page.adoptedStyleSheets = [...page.adoptedStyleSheets, sheet]
    release = () => {
      page.adoptedStyleSheets = page.adoptedStyleSheets.filter((each) => each !== sheet)
    }
  } else {
    const style = page.createElement('style')
    style.textContent = PICKABLE_ROOTS_RULE
    ;(page.head ?? page.documentElement).appendChild(style)
    release = () => style.remove()
  }
  try {
    return { result: run(), passThrough }
  } finally {
    release()
  }
}

/** 画布上 `point` 处从上往下能选中的元素：运行库的 `pointerTargets`（跳过宿主、铺满画面的容器、空容器……）。 */
export const elementsAt = (page: Document, point: Point): Laid[] => {
  const root = pageRoot(page)
  const width = Number(root?.getAttribute('data-width'))
  const height = Number(root?.getAttribute('data-height'))
  if (root === null || !(width > 0) || !(height > 0)) return []
  const at = compositionPoint(page, point.x / width, point.y / height)
  if (at === null) return []
  const { result, passThrough } = withPickableRoots(page, () => pointerTargets(page, at))
  return result.filter((element) => !passThrough.has(element))
}

/**
 * 拖动中的一层：元素、开始时生效的位移（拖动从它算起）和行内写的位移（摆回去用，空串是没写）、改过的那几项行内
 * 样式原来的写法、开始时在画布上的中心。
 */
export type Drafting = {
  element: Laid
  translate: string
  inlineTranslate: string
  styles: Map<string, string>
  center: Point | null
}

/** 开始拖一层：记下它现在的位移和中心。 */
export const startDraft = (page: Document, element: Laid): Drafting => {
  // 先让页面上的 GSAP 解析一遍这层的变换（运行库写位移前也这么做）：不然它之后头一次解析时把拖动写的
  // `translate` 折进自己的变换，位移就算了两遍
  const view = page.defaultView as
    (Window & { gsap?: { getProperty?: (target: Element, property: string) => unknown } }) | null
  view?.gsap?.getProperty?.(element, 'x')
  const frame = frameOfElement(page, element)
  return {
    element,
    translate: readCurrentTranslate(element),
    inlineTranslate: element.style.getPropertyValue('translate'),
    styles: new Map(),
    center: frame === null ? null : { x: frame.cx, y: frame.cy },
  }
}

const setStyle = (element: Laid, name: string, value: string | null) => {
  if (value === null || value === '') element.style.removeProperty(name)
  else element.style.setProperty(name, value)
}

/**
 * 拖动中摆一层：行内样式改成 `styles`，位移在开始时的上面加 `move`；`pin` 时再挪一下让中心回到开始时的地方。
 * 答复最后加的位移（父元素里的像素）。
 */
export const drawDraft = (
  page: Document,
  draft: Drafting,
  move: Point,
  styles: Readonly<Record<string, string | null>>,
  pin: boolean,
): Point => {
  const { element } = draft
  for (const [name, value] of Object.entries(styles)) {
    if (!draft.styles.has(name)) draft.styles.set(name, element.style.getPropertyValue(name))
    setStyle(element, name, value)
  }
  const place = (at: Point) =>
    element.style.setProperty(
      'translate',
      composeTranslate(draft.translate, `${at.x}px`, `${at.y}px`),
    )
  place(move)
  if (!pin || draft.center === null) return move
  const frame = frameOfElement(page, element)
  if (frame === null) return move
  const back = toLocal(parentLinear(page, element), {
    x: draft.center.x - frame.cx,
    y: draft.center.y - frame.cy,
  })
  const pinned = { x: move.x + back.x, y: move.y + back.y }
  place(pinned)
  return pinned
}

/**
 * 拖动结束。`keep` 时留着摆好的样子，并记下位移原来的写法（运行库按 `data-x` / `data-y` 摆它时从这里算起，见
 * SDK 的 `moveElement`）；不然摆回开始时的样子。
 */
export const endDraft = (draft: Drafting, keep: boolean) => {
  const { element } = draft
  if (keep) {
    if (!element.hasAttribute(EDIT_ORIGINAL_TRANSLATE_ATTR))
      element.setAttribute(EDIT_ORIGINAL_TRANSLATE_ATTR, draft.translate)
    return
  }
  for (const [name, value] of draft.styles) setStyle(element, name, value)
  setStyle(element, 'translate', draft.inlineTranslate)
}

/** 把一层的行内样式、属性改成这样（null 是去掉），用于组件文件里改了的层（见预览协议 `patch` 的 `layers`）。 */
export const writeLayer = (
  element: Laid,
  styles: Readonly<Record<string, string | null>>,
  attributes: Readonly<Record<string, string | null>>,
) => {
  for (const [name, value] of Object.entries(styles)) setStyle(element, name, value)
  for (const [name, value] of Object.entries(attributes))
    if (value === null) element.removeAttribute(name)
    else element.setAttribute(name, value)
}

/** 在画布上要改的一段文字：元素、它是 `fields` 里的第几个、框和画布上的字号。 */
export type TextSpot = { element: Laid; field: number; rect: Rect; fontSize: number }

/**
 * 片段 `host` 里画布上 `point` 处的文字字段（`data-var-text` 是 `fields` 里的一个、显示着的；一句字幕自己就是
 * 这样的字段）；那里没有时，片段里只有一个这样的字段就是它，不然是 null。
 */
export const textSpotAt = (
  host: Laid,
  fields: readonly string[],
  point: Point,
): TextSpot | null => {
  const root = filmRoot(host)
  const origin = root?.getBoundingClientRect() ?? { left: 0, top: 0 }
  const candidates = host.matches('[data-var-text]')
    ? [host]
    : [...host.querySelectorAll('[data-var-text]')]
  const spots = candidates.flatMap((element) => {
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

/** 原地改字时藏起来的那段文字：藏的时候改的样式 `property`，和它原来的行内写法 `value`。 */
export type HiddenText = { element: Laid; property: 'visibility' | 'opacity'; value: string }

/**
 * 藏起一段文字。一句字幕自己是带时间的片段，运行库按时间改它行内的 `visibility`，所以它用 `opacity` 藏；
 * 组件里的文字用 `visibility`。
 */
export const hideText = (element: Laid): HiddenText => {
  const property = element.hasAttribute('data-start') ? 'opacity' : 'visibility'
  const hidden = { element, property, value: element.style.getPropertyValue(property) } as const
  element.style.setProperty(property, property === 'opacity' ? '0' : 'hidden')
  return hidden
}

/** 显示回来；`text` 不是 null 时先换上这段字。 */
export const showText = ({ element, property, value }: HiddenText, text: string | null) => {
  if (text !== null) element.textContent = text
  if (value === '') element.style.removeProperty(property)
  else element.style.setProperty(property, value)
}
