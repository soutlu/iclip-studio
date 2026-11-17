/**
 * 画面上挪、缩放、转一层时写进它所在文件的东西，写法都是引擎在预览和导出里认的：
 *
 * - 挪：SDK 的 `moveElement`（元素上的 `data-x` / `data-y`，第一次挪时 SDK 记下原来的值），运行库渲染时把差值
 *   写成元素的 `translate`，和动画、样式里原有的位移叠加。
 * - 缩放：照工作台，四角以中心等比缩放，写元素行内的 `width` / `height`（px）和让它们说了算的那几项（
 *   `box-sizing`、最小最大宽高，父元素是弹性布局时的 `flex-*`，行内元素改成行内块），中心挪回原处的那一下照挪写。
 *   不写 `scale`。
 * - 转：照工作台，写元素行内的 `rotate`；元素自己的 `transform` 以位移开头（常见的 `translate(-50%, -50%)` 居中）
 *   时，`rotate()` 插在那段位移后面，绕它在画面上的中心转。
 *
 * 工作台另外写的 `data-hf-studio-*` 标记只给它自己的复原、面板用，引擎不读，这里不写。
 */

import type { Point } from './canvas-geometry'

/** 2×2 线性变换（`DOMMatrix` 的 a、b、c、d）：把一层父元素里的像素换成画布像素。 */
export type Linear = { a: number; b: number; c: number; d: number }

const round3 = (value: number) => {
  const rounded = Math.round(value * 1000) / 1000
  return rounded === 0 ? 0 : rounded
}

/** 画布上挪了 `delta`，换成父元素里的像素（`linear` 的逆）；`linear` 退化时不挪。 */
export function toLocal(linear: Linear, delta: Point): Point {
  const { a, b, c, d } = linear
  const det = a * d - b * c
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return { x: 0, y: 0 }
  return { x: (d * delta.x - c * delta.y) / det, y: (-b * delta.x + a * delta.y) / det }
}

const numberOr = (value: string | undefined) => {
  const parsed = Number.parseFloat(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

/** 挪了父元素里的 `delta` 以后 `moveElement` 要写的 `data-x` / `data-y`：在元素现在写着的上面加。 */
export function movedTo(attributes: Readonly<Record<string, string>>, delta: Point): Point {
  return {
    x: round3(numberOr(attributes['data-x']) + delta.x),
    y: round3(numberOr(attributes['data-y']) + delta.y),
  }
}

/** 布局像素取整，最小 1（工作台 `roundToLayoutSize`）。 */
export const layoutSize = (size: { width: number; height: number }) => ({
  width: Math.max(1, Math.round(size.width)),
  height: Math.max(1, Math.round(size.height)),
})

/** 父元素的弹性方向：0 不是弹性布局，1 横排，2 竖排。 */
export type FlexDirection = 0 | 1 | 2

/**
 * 缩放写的行内样式（SDK 的属性名）：宽高写成 `size`（已取整），`box-sizing` 是 `border-box`，最小最大宽高放开；
 * 父元素是弹性布局时把主轴方向的 `flex-basis` 定成这个长度、不伸不缩；行内元素改成行内块（行内元素没有宽高）。
 * 照工作台 `manualEditsDom.ts` 的 `applyStudioBoxSizeDimensions`。
 */
export function sizeStyles(
  size: { width: number; height: number },
  flex: FlexDirection,
  inline: boolean,
): Record<string, string> {
  const styles: Record<string, string> = {
    boxSizing: 'border-box',
    width: `${size.width}px`,
    height: `${size.height}px`,
    minWidth: '0px',
    minHeight: '0px',
    maxWidth: 'none',
    maxHeight: 'none',
  }
  if (flex !== 0) {
    styles['flexBasis'] = `${flex === 2 ? size.height : size.width}px`
    styles['flexGrow'] = '0'
    styles['flexShrink'] = '0'
  }
  if (inline) styles['display'] = 'inline-block'
  return styles
}

/**
 * 转的时候写在哪：元素自己的 `rotate`（`property: 'rotate'`），或者元素的 `transform`（写在位移 `before` 后面、
 * 其余 `after` 前面）。`turn` 是它现在自己转了多少度（`rotate` 上的，或插在位移后面的那个 `rotate()`）。
 */
export type RotationTarget =
  | { property: 'rotate'; turn: number }
  | { property: 'transform'; before: string; after: string; turn: number }

const TRANSLATE = /^translate(?:3d|X|Y|Z)?\(/i
const OWN_TURN = /^rotate\(\s*(-?[\d.]+(?:e[+-]?\d+)?)deg\s*\)$/i

/** 按最外层的空白拆开（括号里的不拆），照工作台 `splitTopLevelWhitespace`。 */
export function splitTopLevel(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of value.trim()) {
    if (char === '(') depth += 1
    if (char === ')') depth = Math.max(0, depth - 1)
    if (/\s/.test(char) && depth === 0) {
      if (current !== '') parts.push(current)
      current = ''
    } else current += char
  }
  if (current !== '') parts.push(current)
  return parts
}

/**
 * 转的时候写在哪（照工作台 `rotationDraft.ts` 的 `readCssRotationTarget`）。`translating` 是元素的变换里有没有
 * 位移；有时要用它写着的 `transform`（`authored`，行内的或样式表里最后一条匹配的规则），拿不到时是 null，
 * 这一层就不在画面上转。`rotate` 是元素自己的 `rotate` 现在的度数。
 */
export function rotationTarget(
  translating: boolean,
  authored: string | undefined,
  rotate: number,
): RotationTarget | null {
  if (!translating) return { property: 'rotate', turn: rotate }
  if (authored === undefined || authored === '' || authored === 'none') return null
  const parts = splitTopLevel(authored)
  const lead = parts.findIndex((part) => !TRANSLATE.test(part))
  const split = lead < 0 ? parts.length : lead
  const rest = parts.slice(split)
  const own = OWN_TURN.exec(rest[0] ?? '')
  if (own !== null) rest.shift()
  return {
    property: 'transform',
    before: parts.slice(0, split).join(' '),
    after: rest.join(' '),
    turn: own === null ? 0 : Number(own[1]),
  }
}

/** 转到自己 `turn` 度时写的行内样式（SDK 的属性名）；行内元素改成行内块（行内元素不转）。 */
export function rotationStyles(
  target: RotationTarget,
  turn: number,
  inline: boolean,
): Record<string, string> {
  const angle = `${round3(turn)}deg`
  const styles: Record<string, string> =
    target.property === 'rotate'
      ? { rotate: angle }
      : {
          transform: [target.before, `rotate(${angle})`, target.after].filter(Boolean).join(' '),
        }
  if (inline) styles['display'] = 'inline-block'
  return styles
}

/** SDK 的属性名换成 CSS 的写法（`boxSizing` → `box-sizing`，自定义属性不变），给预览页直接摆。 */
export const cssName = (name: string): string =>
  name.startsWith('--') ? name : name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

/** 一组 SDK 属性名的样式换成 CSS 的写法。 */
export const cssStyles = (
  styles: Readonly<Record<string, string | null>>,
): Record<string, string | null> =>
  Object.fromEntries(Object.entries(styles).map(([name, value]) => [cssName(name), value]))

/**
 * 样式表 `css` 里匹配 `element` 的最后一条规则写的 `transform`（照工作台 `rotationDraft.ts` 的 `lastRuleTransform`：
 * 只按先后，不比较优先级、`!important` 和 `@media`）；没有时是 undefined。
 */
/** 元素匹不匹配选择器；选择器写法这个浏览器不认时算不匹配。 */
const matchesSelector = (element: Element, selector: string): boolean => {
  try {
    return element.matches(selector)
  } catch {
    return false
  }
}

function lastRuleTransform(element: Element, css: string): string | undefined {
  let found: string | undefined
  let sheet: CSSStyleSheet
  try {
    sheet = new CSSStyleSheet()
    sheet.replaceSync(css)
  } catch {
    return undefined
  }
  for (const rule of sheet.cssRules) {
    if (!(rule instanceof CSSStyleRule)) continue
    const declared = rule.style.getPropertyValue('transform')
    if (declared !== '' && matchesSelector(element, rule.selectorText)) found = declared
  }
  return found
}

/**
 * 文件内容 `content` 里编号是 `hfId` 的元素写着的 `transform`：行内的，没有时取文件里样式表最后一条匹配它的规则
 * 写的；都没有时是 undefined。
 */
export function authoredTransform(content: string, hfId: string): string | undefined {
  const page = new DOMParser().parseFromString(content, 'text/html')
  const scopes: ParentNode[] = [
    page,
    ...[...page.querySelectorAll('template')].map((t) => t.content),
  ]
  const element = scopes
    .flatMap((scope) => [...scope.querySelectorAll('[data-hf-id]')])
    .find((candidate) => candidate.getAttribute('data-hf-id') === hfId)
  if (element === undefined) return undefined
  const inline = (element as HTMLElement).style.getPropertyValue('transform')
  if (inline !== '') return inline
  const css = scopes
    .flatMap((scope) => [...scope.querySelectorAll('style')])
    .map((style) => style.textContent)
    .join('\n')
  return lastRuleTransform(element, css)
}
