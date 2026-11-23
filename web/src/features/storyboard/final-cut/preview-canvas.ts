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

/** 画布像素矩形。 */
export type Rect = { x: number; y: number; width: number; height: number }

// 预览页内的画布编辑支撑：图层定位、几何测量、拖拽草稿渲染与原地改字定位。
// 操作对象位于播放器内部 iframe 文档，跨文档不共享 HTMLElement 构造器，统一通过属性特征判断。

type Laid = HTMLElement

const isLaid = (element: Element | null): element is Laid =>
  element !== null && 'offsetWidth' in element && 'style' in element

/** 在 final-cut 文档中查找 `data-hf-id` 为 `id` 的布局元素；不存在时返回 `null`。 */
export const elementOf = (page: Document, id: string): Laid | null => {
  const element = page.querySelector(`[data-hf-id="${CSS.escape(id)}"]`)
  return isLaid(element) ? element : null
}

/** 向上查找最外层的 final-cut 合成根（带 `data-composition-id`）。 */
const filmRoot = (element: Element): Element | null => {
  let root: Element | null = null
  for (let node: Element | null = element.parentElement; node !== null; node = node.parentElement)
    if (node.hasAttribute('data-composition-id')) root = node
  return root
}

/** 获取文档最外层的合成根元素（带 `data-composition-id`）；不存在时返回 `null`。 */
const pageRoot = (page: Document): Laid | null => {
  const root = page.querySelector('[data-composition-id]')
  return isLaid(root) ? root : null
}

/** 查找元素所属的最近挂载宿主 `data-hf-id`（带 `data-composition-src` 的最近祖先；位于主文件顶层时为 `null`）。 */
const scopeOf = (element: Element): string | null =>
  element.parentElement?.closest('[data-composition-src]')?.getAttribute('data-hf-id') ?? null

/** 在指定作用域内查找与 `ref` 选择器匹配且直接归属该作用域的全部布局元素。 */
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

/** 按图层表引用定位预览 DOM 元素；未找到或页面同名匹配数与源文件 `count` 不一致（脚本动态增删）时返回 `null`。 */
export const layerElement = (page: Document, ref: LayerRef & { count: number }): Laid | null => {
  const matches = matchesOf(page, ref)
  return matches.length === ref.count ? (matches[ref.index] ?? null) : null
}

/** 反查预览 DOM 元素对应的图层定位标识（`scope`、`selector`、`index`）；无法生成稳定选择器时返回 `null`。 */
export const refOf = (page: Document, element: Laid): LayerRef | null => {
  const selector = buildStableSelector(element)
  if (selector === undefined) return null
  const scope = scopeOf(element)
  const index = matchesOf(page, { scope, selector, index: 0 }).indexOf(element)
  return index < 0 ? null : { scope, selector, index }
}

/**
 * 查找元素（含自身）所属的主文件最外层挂载宿主（忽略组件内部嵌套挂载的子宿主）；不在任何宿主下时返回 `null`。
 */
const outermostHostOf = (element: Element): Laid | null => {
  let host: Element | null = null
  for (let node: Element | null = element; node !== null; node = node.parentElement)
    if (node.hasAttribute('data-composition-src')) host = node
  return isLaid(host) ? host : null
}

const IDENTITY: Linear = { a: 1, b: 0, c: 0, d: 1 }

/** 解析计算样式中的独立 `scale`（`none`、`sx`、`sx sy`、`sx sy sz`）为平面缩放因子；无法解析时返回 `null`。 */
const individualScale = (value: string): { x: number; y: number } | null => {
  if (value === '' || value === 'none') return { x: 1, y: 1 }
  const [x, y] = value.trim().split(/\s+/).map(Number)
  if (x === undefined || !Number.isFinite(x)) return null
  if (y === undefined) return { x, y: x }
  return Number.isFinite(y) ? { x, y } : null
}

/**
 * 累乘元素及其全部祖先的 `rotate`、`scale`、`transform` 得到完整的 2D 变换矩阵。
 * 运行库自带的 `readElementTransformSnapshot` 仅向上合成到最近合成根且忽略独立 `scale` 属性，
 * 而贴片宿主依赖独立 `scale` 适配画幅，因此在此从文档根完整合成；遇到无法解析的变换时返回 `null`。
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
    // CSS 规范顺序：同一元素依次应用独立 rotate → scale → transform
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
 * 计算元素边框盒四角在画布坐标系下的位置（相对于合成根 `origin`）：
 * 优先使用累积变换矩阵经运行库 `elementCornerPoints` 精确投影，无法解析变换时回退取 `getBoundingClientRect()`。
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

/** 测量元素在画布上的完整旋转框（中心坐标、宽高与旋转角，画布像素）。 */
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

/** 读取元素自身的 `clip-path`（优先行内样式，回退计算样式，对齐上游 Studio `readElementClipPath`）。 */
const ownClipPath = (view: Window, element: Laid): string =>
  element.style.getPropertyValue('clip-path').trim() ||
  view.getComputedStyle(element).clipPath.trim()

/**
 * 提取元素的溢出裁剪框：在 `overflow-x` / `overflow-y` 非 `visible` 的轴向上计算内边距盒（padding box）四角画布坐标；
 * 双向均不裁剪，或为 `overflow` 不生效的 `inline` / `contents` 元素时返回 `null`。
 */
const clipBoxOf = (view: Window, origin: DOMRect, element: Laid): ClipBox | null => {
  const style = view.getComputedStyle(element)
  const x = style.overflowX !== 'visible'
  const y = style.overflowY !== 'visible'
  if ((!x && !y) || style.display === 'inline' || style.display === 'contents') return null
  const { nw, ne, sw } = cornersOf(view, origin, element)
  const width = element.offsetWidth
  const height = element.offsetHeight
  // 在边框盒四角之间按局部比例线性插值求画布坐标
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
 * 计算图层的可见区域框（见 canvas-visible.ts）：综合自身 `inset()` 裁切、向上至合成根（含）的溢出裁剪祖先内边距盒及画布边界。
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

/** 提取父容器累积变换矩阵的 2×2 线性部分（将父元素局部像素映射至画布像素）。 */
const parentLinear = (page: Document, element: Laid): Linear => {
  const view = page.defaultView
  const parent = element.parentElement
  if (view === null || !isLaid(parent)) return IDENTITY
  const matrix = paintedMatrix(view, parent)
  return matrix === null ? IDENTITY : { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d }
}

/** 测量单个图层的完整几何属性、布局特征及移动/缩放/旋转可编辑状态（见 layer-abilities.ts）。 */
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
 * 计算单个元素供吸附使用的轴对齐矩形（画布像素）：将屏幕外框按元素自身 `inset()` 裁切收窄（对齐上游 Studio `toVisibleOverlayRect`）。
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
 * 收集移动 `moving` 元素时的吸附输入矩形（见 canvas-snap.ts）：
 * `moving` 为被移元素的联合外框；`targets` 由运行库 `snapCandidates`（排除组件宿主子树、被移元素与隐藏元素）加上其余可见贴片/场景宿主（`hosts`）组成。
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

// 组件根常见的 `pointer-events: none`（挂载后落在 `[data-hf-inner-root]` 上）用于播放期点穿，但会连带屏蔽子树命中检测。
// 对齐运行库 `runtime/picker.ts`：仅在执行点击拾取瞬间通过 `@layer hf-picker` 临时开启内层根与顶层合成根的指针接收，
// 拾取完毕立即移除（保留宿主自身的 `none` 透传语义）。
const PICKABLE_ROOTS = '[data-hf-inner-root],[data-composition-id]:not([data-composition-id] *)'
const PICKABLE_ROOTS_RULE = `${PICKABLE_ROOTS}{pointer-events:auto!important}`

/** 缓存每个文档对应的临时拾取样式表（不支持 `adoptedStyleSheets` 时记为 `null`）。 */
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
 * 临时放开内层根与顶层合成根的 `pointer-events` 执行 `run` 并立即还原；
 * 返回 `run` 的执行结果及原本为 `none` 的根节点集合（用于从命中结果中剔除根自身）。
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
    // 优先使用 adoptedStyleSheets，避免增删 DOM 节点触发运行库的 MutationObserver
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

/**
 * 画布单点拾取单元：`unit` 为应选中的可编辑单元（如宿主或独立层），`target` 为指针下实际命中的最顶层内部元素
 * （贴片或场景内的矢量图形可能命中 SVG 元素）。
 */
export type PointerUnit = { unit: Laid; target: Element }

/**
 * 获取画布坐标 `point` 处从上到下不重复的可选中单元列表：
 * 先通过运行库 `pointerTargets` 拾取可视元素（自动跳过宿主外壳、全屏空容器、非可视标签及显式 `pointer-events: none` 元素），
 * 若命中元素归属 `isHost` 认定的贴片/场景宿主，则收敛为该宿主整体（透明空白区域自然点穿至下方图层）；字幕宿主内的单句元素仍各自独立。
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
    if (passThrough.has(target)) continue
    const host = outermostHostOf(target)
    // 先归属至宿主再校验是否为布局元素：内部命中节点允许是 SVG 元素，最终选中的单元才须具备布局属性
    const unit: Element = host !== null && isHost(host) ? host : target
    if (!isLaid(unit)) continue
    if (!units.some((each) => each.unit === unit)) units.push({ unit, target })
  }
  return units
}

/**
 * 拖拽草稿上下文：记录目标元素、是否为贴片/场景宿主、起拖时的生效位移与原始行内 `translate`、已改行内样式备份及初始画布中心。
 */
export type Drafting = {
  element: Laid
  host: boolean
  translate: string
  inlineTranslate: string
  styles: Map<string, string>
  center: Point | null
}

/** 开启图层拖拽草稿并快照初始位移与画布中心。 */
export const startDraft = (page: Document, element: Laid, host: boolean): Drafting => {
  // 普通图层改写 `translate` 前先触发 GSAP 初始化变换缓存（与运行库一致），防止后续首次解析把草稿 `translate` 重复折算；
  // 贴片/场景宿主不受动画驱动，不能触发 GSAP 解析，否则其原有的 `translate / scale / rotate` 会被折入 `transform` 导致后续缩放翻倍（见 layer-edits.ts）。
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
 * 应用拖拽草稿：写入行内 `styles` 并在初始位移上叠加 `move`；`pin` 为真时额外补偿使图层中心回到起拖位置，返回最终局部像素位移。
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
 * 结束拖拽草稿：
 * - `keep` 为真时保留当前 DOM 样式；对普通图层记录原始 `translate` 基线属性供运行库后续按 `data-x/y` 计算（宿主直接改 `translate`，不写该基线属性，避免运行库因未见 `data-x/y` 而误将宿主还原）。
 * - `keep` 为假时还原全部修改过的行内样式。
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

/** 画布原地改字目标：文字 DOM 元素、`fields` 下标、画布外框与缩放后字号。 */
export type TextSpot = { element: Laid; field: number; rect: Rect; fontSize: number }

/**
 * 在片段 `host` 内定位坐标 `point` 处匹配 `fields` 的可见 `[data-var-text]` 文字元素（单句字幕元素本身即带 `data-var-text`）；
 * 若点击坐标未直接落入某文字框但片段内仅有唯一候选文字，则回退命中该唯一项，否则返回 `null`。
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
    // 按实际渲染高度与布局高度之比折算宿主与组件缩放后的画布字号
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

/** 原地改字期间被临时隐藏的文字节点及原行内样式备份。 */
export type HiddenText = { element: Laid; property: 'visibility' | 'opacity'; value: string }

/**
 * 临时隐藏预览中的原文字：带 `data-start` 的单句字幕由运行库按时间线控制 `visibility`，改用 `opacity: 0` 隐藏；组件内文字使用 `visibility: hidden`。
 */
export const hideText = (element: Laid): HiddenText => {
  const property = element.hasAttribute('data-start') ? 'opacity' : 'visibility'
  const hidden = { element, property, value: element.style.getPropertyValue(property) } as const
  element.style.setProperty(property, property === 'opacity' ? '0' : 'hidden')
  return hidden
}

/** 恢复被隐藏的文字节点；传入非空 `text` 时同步写入新文本内容。 */
export const showText = ({ element, property, value }: HiddenText, text: string | null) => {
  if (text !== null) element.textContent = text
  if (value === '') element.style.removeProperty(property)
  else element.style.setProperty(property, value)
}
