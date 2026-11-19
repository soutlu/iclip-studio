import {
  buildStableSelector,
  compositionPoint,
  elementCornerPoints,
  individualRotateDegrees,
  isCompositionHost,
  isElementVisibleThroughAncestors,
  pointerTargets,
  snapCandidates,
} from '@hyperframes/core/runtime/editing-port'
import {
  composeTranslate,
  EDIT_ORIGINAL_TRANSLATE_ATTR,
  readCurrentTranslate,
} from '@hyperframes/core/runtime/position-edits'
import { gsapOwns, layerAbilities, type RuntimeTimeline } from './layer-abilities'
import type { Point } from './canvas-geometry'
import type { SnapRects } from './canvas-snap'
import { canvasBox, visibleFrame, type ClipBox } from './canvas-visible'
import { toLocal, type Linear } from './layer-edits'
import type { LayerFrame, LayerMeasure, LayerRef } from './preview-protocol'
import { hugRectForClipPath } from './vendor/hyperframes-studio/components/editor/domEditOverlayCrop'

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

/**
 * 画面里的一个元素（含它自己）最外层的宿主：主文件根下挂载着文件的那个元素；不在宿主里时是 null。组件里再挂的
 * 宿主不算，算到主文件里挂着它的那一个。
 */
const outermostHostOf = (element: Element): Laid | null => {
  let host: Element | null = null
  for (let node: Element | null = element; node !== null; node = node.parentElement)
    if (node.hasAttribute('data-composition-src')) host = node
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

type Corners = { nw: Point; ne: Point; se: Point; sw: Point }

/**
 * 元素边框盒的四个角在画布上的位置（相对根 `origin`）：经它和祖先的变换（运行库 `elementCornerPoints`）；认不出
 * 变换时按它的外框。
 */
const cornersOf = (view: Window, origin: DOMRect, element: Laid): Corners => {
  const matrix = paintedMatrix(view, element)
  const corners =
    matrix === null
      ? null
      : elementCornerPoints(view, element, { matrix, cs: view.getComputedStyle(element) })
  const at = (point: Point) => ({ x: point.x - origin.left, y: point.y - origin.top })
  if (corners !== null)
    return { nw: at(corners.nw), ne: at(corners.ne), se: at(corners.se), sw: at(corners.sw) }
  const box = element.getBoundingClientRect()
  return {
    nw: at({ x: box.left, y: box.top }),
    ne: at({ x: box.right, y: box.top }),
    se: at({ x: box.right, y: box.bottom }),
    sw: at({ x: box.left, y: box.bottom }),
  }
}

/** 元素在画布上的样子：四个角经它和祖先的变换（运行库 `elementCornerPoints`），换成相对根的画布像素。 */
export const frameOfElement = (page: Document, element: Laid): LayerFrame | null => {
  const view = page.defaultView
  const root = pageRoot(page)
  if (view === null || root === null) return null
  const { nw, ne, se, sw } = cornersOf(view, root.getBoundingClientRect(), element)
  return {
    cx: (nw.x + ne.x + se.x + sw.x) / 4,
    cy: (nw.y + ne.y + se.y + sw.y) / 4,
    width: Math.hypot(ne.x - nw.x, ne.y - nw.y),
    height: Math.hypot(sw.x - nw.x, sw.y - nw.y),
    angle: (Math.atan2(ne.y - nw.y, ne.x - nw.x) * 180) / Math.PI,
  }
}

/** 元素自己的 `clip-path`：先看行内写的，没有时看算出来的（照工作台 `readElementClipPath`）。 */
const ownClipPath = (view: Window, element: Laid): string =>
  element.style.getPropertyValue('clip-path').trim() ||
  view.getComputedStyle(element).clipPath.trim()

/**
 * 元素裁掉里面内容的框：`overflow-x`、`overflow-y` 不是 `visible` 的方向上，内边距盒（边框以内）在画布上的四个角；
 * 两个方向都不裁、行内元素（`overflow` 管不到）时是 null。
 */
const clipBoxOf = (view: Window, origin: DOMRect, element: Laid): ClipBox | null => {
  const style = view.getComputedStyle(element)
  const x = style.overflowX !== 'visible'
  const y = style.overflowY !== 'visible'
  if ((!x && !y) || style.display === 'inline' || style.display === 'contents') return null
  const { nw, ne, sw } = cornersOf(view, origin, element)
  const width = element.offsetWidth
  const height = element.offsetHeight
  // 元素里 (u, v) 处在画布上的位置：边框盒四个角之间按比例取
  const at = (u: number, v: number): Point => {
    const ru = width > 0 ? u / width : 0
    const rv = height > 0 ? v / height : 0
    return {
      x: nw.x + (ne.x - nw.x) * ru + (sw.x - nw.x) * rv,
      y: nw.y + (ne.y - nw.y) * ru + (sw.y - nw.y) * rv,
    }
  }
  const left = element.clientLeft
  const top = element.clientTop
  const right = left + element.clientWidth
  const bottom = top + element.clientHeight
  return { corners: [at(left, top), at(right, top), at(right, bottom), at(left, bottom)], x, y }
}

/**
 * 一层看得见的那一块（见 canvas-visible.ts）：它自己的 `inset()` 裁切，往上到 final-cut 根（含）每个 `overflow`
 * 不是 `visible` 的祖先的内边距盒，和画布。`frame` 是量出来的它在画布上的样子。
 */
const visibleOf = (
  view: Window,
  root: Laid,
  element: Laid,
  frame: LayerFrame,
): LayerFrame | null => {
  const origin = root.getBoundingClientRect()
  const clips: ClipBox[] = []
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const clip = isLaid(node) ? clipBoxOf(view, origin, node) : null
    if (clip !== null) clips.push(clip)
    if (node === root) break
  }
  const width = Number(root.getAttribute('data-width'))
  const height = Number(root.getAttribute('data-height'))
  if (width > 0 && height > 0) clips.push(canvasBox(width, height))
  return visibleFrame(
    frame,
    {
      clipPath: ownClipPath(view, element),
      scaleX: element.offsetWidth > 0 ? frame.width / element.offsetWidth : 1,
      scaleY: element.offsetHeight > 0 ? frame.height / element.offsetHeight : 1,
    },
    clips,
  )
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
 * 父元素的弹性方向，和三样能不能改（见 layer-abilities.ts）。
 */
export const measureLayer = (page: Document, element: Laid): LayerMeasure | null => {
  const view = page.defaultView as
    (Window & { __timelines?: Record<string, RuntimeTimeline> }) | null
  const frame = frameOfElement(page, element)
  const root = pageRoot(page)
  if (view === null || frame === null || root === null) return null
  const style = view.getComputedStyle(element)
  const own =
    style.transform === 'none' || style.transform === '' ? null : new DOMMatrix(style.transform)
  const parentStyle =
    element.parentElement === null ? null : view.getComputedStyle(element.parentElement)
  const flexParent = parentStyle?.display === 'flex' || parentStyle?.display === 'inline-flex'
  const abilities = layerAbilities({
    tag: element.localName,
    root: !isCompositionHost(element) && element.hasAttribute('data-composition-id'),
    locked: element.closest('[data-timeline-locked]') !== null,
    animated: {
      move: gsapOwns(element, view.__timelines, 'move'),
      resize: gsapOwns(element, view.__timelines, 'resize'),
      rotate: gsapOwns(element, view.__timelines, 'rotate'),
    },
  })
  return {
    frame,
    visible: visibleOf(view, root, element, frame),
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

/**
 * 吸附用的一个元素的框（画布像素）：外框按它自己的 `inset()` 裁切收窄（照工作台 `toVisibleOverlayRect`），裁切的
 * 像素按它画在画布上的缩放换算。
 */
const snapRectOf = (view: Window, origin: DOMRect, element: Laid): Rect => {
  const box = element.getBoundingClientRect()
  const { a, b, c, d } = paintedMatrix(view, element) ?? IDENTITY
  const scaleX = Math.hypot(a, b)
  const scaleY = scaleX > 0 ? Math.abs(a * d - b * c) / scaleX : 1
  const hugged = hugRectForClipPath(
    {
      left: box.left - origin.left,
      top: box.top - origin.top,
      width: box.width,
      height: box.height,
      editScaleX: scaleX,
      editScaleY: scaleY,
    },
    ownClipPath(view, element),
  )
  return { x: hugged.left, y: hugged.top, width: hugged.width, height: hugged.height }
}

/**
 * 挪 `moving` 这几个元素时吸附用的矩形（见 canvas-snap.ts）：它们合起来的框，和能吸过去的别的元素的框：运行库的
 * `snapCandidates`（从 final-cut 根往下，跳过宿主和它里面的、挪的这几个和它们里面的、没显示的），加上 `hosts`
 * 里显示着的、不在挪的贴片、场景宿主（宿主里面的不算）。一个都没有时是 null。
 */
export const snapRectsOf = (
  page: Document,
  moving: readonly Laid[],
  hosts: readonly Laid[],
): SnapRects | null => {
  const view = page.defaultView
  const root = pageRoot(page)
  if (view === null || root === null || moving.length === 0) return null
  const origin = root.getBoundingClientRect()
  const boxes = moving.map((element) => snapRectOf(view, origin, element))
  const left = Math.min(...boxes.map((box) => box.x))
  const top = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.width))
  const bottom = Math.max(...boxes.map((box) => box.y + box.height))
  const visible = new Map<HTMLElement, boolean>()
  const others = hosts.filter(
    (host) => !moving.includes(host) && isElementVisibleThroughAncestors(host, visible),
  )
  const targets = [
    ...snapCandidates(root, new Set<HTMLElement>(moving)).filter(isLaid),
    ...others,
  ].map((element) => snapRectOf(view, origin, element))
  return { moving: { x: left, y: top, width: right - left, height: bottom - top }, targets }
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

/** 画布上一处能选中的一个：选中的元素 `unit`，和指针下它里面最上面的那个元素 `target`（不在宿主里时就是它自己）。 */
export type PointerUnit = { unit: Laid; target: Laid }

/**
 * 画布上 `point` 处从上往下能选中的元素，每个只出现一次。先照运行库的 `pointerTargets` 找指针下的元素（跳过宿主、
 * 铺满画面的容器、空容器、不画东西的标签、作者写了不接收指针的），在 `isHost` 认的宿主里的再算成这个宿主：贴片、
 * 场景整个是一个，点中它画出来的东西才算点中它，透明的、只有铺满的底的地方点到下面。字幕宿主里的每一句各算各的。
 */
export const unitsAt = (
  page: Document,
  point: Point,
  isHost: (element: Laid) => boolean,
): PointerUnit[] => {
  const root = pageRoot(page)
  const width = Number(root?.getAttribute('data-width'))
  const height = Number(root?.getAttribute('data-height'))
  if (root === null || !(width > 0) || !(height > 0)) return []
  const at = compositionPoint(page, point.x / width, point.y / height)
  if (at === null) return []
  const { result, passThrough } = withPickableRoots(page, () => pointerTargets(page, at))
  const units: PointerUnit[] = []
  for (const target of result) {
    if (passThrough.has(target) || !isLaid(target)) continue
    const host = outermostHostOf(target)
    const unit = host !== null && isHost(host) ? host : target
    if (!units.some((each) => each.unit === unit)) units.push({ unit, target })
  }
  return units
}

/**
 * 拖动中的一层：元素、是不是贴片、场景的宿主、开始时生效的位移（拖动从它算起）和行内写的位移（摆回去用，空串是
 * 没写）、改过的那几项行内样式原来的写法、开始时在画布上的中心。
 */
export type Drafting = {
  element: Laid
  host: boolean
  translate: string
  inlineTranslate: string
  styles: Map<string, string>
  center: Point | null
}

/** 开始拖一层（`host` 是贴片、场景的宿主）：记下它现在的位移和中心。 */
export const startDraft = (page: Document, element: Laid, host: boolean): Drafting => {
  // 先让页面上的 GSAP 解析一遍这层的变换（运行库写位移前也这么做）：不然它之后头一次解析时把拖动写的
  // `translate` 折进自己的变换，位移就算了两遍。宿主不解析：动画不动宿主，解析一遍反而把它行内的
  // `translate`、`scale`、`rotate` 折进 `transform`，之后写的 `scale` 就叠了两遍（见 layer-edits.ts）
  if (!host) {
    const view = page.defaultView as
      (Window & { gsap?: { getProperty?: (target: Element, property: string) => unknown } }) | null
    view?.gsap?.getProperty?.(element, 'x')
  }
  const frame = frameOfElement(page, element)
  return {
    element,
    host,
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
 * SDK 的 `moveElement`）；不然摆回开始时的样子。宿主的位移直接写在它的 `translate` 上，不记：运行库见到这个标记
 * 而没有 `data-x` / `data-y` 时，当成挪过又撤销，把位移摆回去。
 */
export const endDraft = (draft: Drafting, keep: boolean) => {
  const { element } = draft
  if (keep) {
    if (!draft.host && !element.hasAttribute(EDIT_ORIGINAL_TRANSLATE_ATTR))
      element.setAttribute(EDIT_ORIGINAL_TRANSLATE_ATTR, draft.translate)
    return
  }
  for (const [name, value] of draft.styles) setStyle(element, name, value)
  setStyle(element, 'translate', draft.inlineTranslate)
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
