/**
 * 画布移动、缩放、旋转的落盘序列化规则（预览与 `render/` 导出均由引擎直接消费）：
 *
 * 1. 普通图层（视频片段、单句字幕，写入所属文件）：
 *    - 移动：通过 SDK `moveElement` 写入 `data-x` / `data-y`（首次移动自动记录基线 `data-hf-edit-base-x/y`），运行库渲染时将差值合成为 `translate` 并与原有位移叠加。
 *    - 缩放：对齐上游 Studio，四角围绕中心等比缩放，写入行内 `width` / `height`（px）及尺寸锁定配套样式（`box-sizing`、放开最小最大宽高、弹性子项 `flex-*`、行内元素转 `inline-block`），中心回位偏移按移动写入，不写 `scale`。
 *    - 旋转：对齐上游 Studio，默认写行内 `rotate`；若元素 `transform` 以平移开头（如 `translate(-50%, -50%)` 居中），则将 `rotate()` 插入前导平移之后以保持绕视觉中心旋转。
 *
 * 2. 贴片与场景宿主（整体作为一层，仅修改主文件宿主自身行内样式，不改动组件文件）：
 *    - 移动写行内 `translate`（见 `movedTranslate`），缩放写 `scale`（见 `scaledStyles`），旋转写 `rotate`。
 *    - 不写 `data-x` / `data-y`：运行库应用 `data-x/y` 前会触发 GSAP 首次解析变换，GSAP 会将宿主原有的 `translate: -50% -50%` 折入 `transform`，导致居中百分比在导出时被重复叠加而偏移出画面。
 *    - 不改 `width` / `height`：宿主宽高代表组件的设计画布尺寸，修改宽高会裁切内部内容而非整体缩放。
 *    - 换画面尺寸时按新画面重摆（见 `refittedHostStyles`）。
 *
 * 上游 Studio 私有的 `data-hf-studio-*` 辅助属性引擎不消费，此处不写入。
 */

import type { Point } from './canvas-geometry'
import { fitScale, type Canvas } from './composition/film'

/** 2×2 线性变换矩阵（对应 `DOMMatrix` 的 `a / b / c / d`），将父元素局部坐标映射至画布像素坐标。 */
export type Linear = { a: number; b: number; c: number; d: number }

const round3 = (value: number) => {
  const rounded = Math.round(value * 1000) / 1000
  return rounded === 0 ? 0 : rounded
}

/** 将画布像素位移 `delta` 逆变换为父元素局部像素位移；矩阵奇异退化时返回零向量。 */
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

/** 在元素现有 `data-x` / `data-y` 属性值基础上累加局部像素位移 `delta`，供 `moveElement` 写入。 */
export function movedTo(attributes: Readonly<Record<string, string>>, delta: Point): Point {
  return {
    x: round3(numberOr(attributes['data-x']) + delta.x),
    y: round3(numberOr(attributes['data-y']) + delta.y),
  }
}

// 单轴位移表达式：`P%`、`Npx`、`0`，或二元 `calc(P% ± Npx)`（两项顺序不限）
const PERCENT = /^(-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)%$/i
const PIXELS = /^(-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)px$/i
const CALC = /^calc\(\s*(\S+)\s*([+-])\s*(\S+)\s*\)$/i

/** 将单轴 CSS 位移拆解为百分比与像素分量；无法归约时返回 `null`。 */
const lengthParts = (value: string): { percent: number; px: number } | null => {
  const part = (text: string) => {
    if (text === '0') return { percent: 0, px: 0 }
    const percent = PERCENT.exec(text)
    if (percent !== null) return { percent: Number(percent[1]), px: 0 }
    const px = PIXELS.exec(text)
    return px === null ? null : { percent: 0, px: Number(px[1]) }
  }
  const sum = CALC.exec(value)
  if (sum === null) return part(value)
  const first = part(sum[1] ?? '')
  const second = part(sum[3] ?? '')
  if (first === null || second === null) return null
  const sign = sum[2] === '-' ? -1 : 1
  return { percent: first.percent + sign * second.percent, px: first.px + sign * second.px }
}

/** 将百分比与像素分量合并回单轴位移字符串（单一非零项时省略 `calc()`）。 */
const lengthOf = ({ percent, px }: { percent: number; px: number }): string => {
  const pixels = round3(px)
  if (percent === 0) return `${pixels}px`
  if (pixels === 0) return `${percent}%`
  return `calc(${percent}% ${pixels < 0 ? '-' : '+'} ${Math.abs(pixels)}px)`
}

/**
 * 在宿主当前行内 `translate`（空串或 `none` 视作 `0`）上叠加局部像素位移 `delta`。
 * 常规百分比与像素组合归约为单层「百分比 ± 像素」，多次移动不会嵌套 `calc()`；非常规单位外包一层 `calc()`，Z 轴分量原样保留。
 */
export function movedTranslate(current: string, delta: Point): string {
  const value = current.trim()
  const [x = '0', y = '0', z] = value === '' || value === 'none' ? [] : splitTopLevel(value)
  const moved = (axis: string, by: number) => {
    const parts = lengthParts(axis)
    if (parts !== null) return lengthOf({ percent: parts.percent, px: parts.px + by })
    const step = round3(by)
    return step === 0 ? axis : `calc(${axis} ${step < 0 ? '-' : '+'} ${Math.abs(step)}px)`
  }
  return [moved(x, delta.x), moved(y, delta.y), ...(z === undefined ? [] : [z])].join(' ')
}

/** 缩放倍率保留四位小数。 */
const round4 = (value: number) => Math.round(value * 10_000) / 10_000

/**
 * 计算宿主围绕中心等比缩放 `ratio` 倍后的行内样式（SDK 驼峰属性名）：
 * 将当前行内 `scale`（空串或 `none` 按 `1` 计，非等比双值分别相乘）乘上 `ratio`。
 */
export function scaledStyles(current: string, ratio: number): Record<string, string> {
  const value = current.trim()
  const [x = 1, y = x] = (value === '' || value === 'none' ? [] : value.split(/\s+/)).map(Number)
  const sx = round4((Number.isFinite(x) ? x : 1) * ratio)
  const sy = round4((Number.isFinite(y) ? y : 1) * ratio)
  return { scale: sx === sy ? String(sx) : `${sx} ${sy}` }
}

const PIXEL_SIZE = /^(\d+(?:\.\d+)?)px$/

/** 行内宽高写成的像素尺寸；有一个没写、不是像素时是 null。 */
const pixelSizeOf = (width: string | undefined, height: string | undefined): Canvas | null => {
  const w = PIXEL_SIZE.exec(width?.trim() ?? '')
  const h = PIXEL_SIZE.exec(height?.trim() ?? '')
  return w === null || h === null ? null : { width: Number(w[1]), height: Number(h[1]) }
}

/**
 * 画面尺寸从 `before` 换成 `after` 时贴片、场景宿主要写的行内样式（SDK 驼峰属性名），`inline` 是它现在的行内样式。
 * 摆放等同按新画面新加进来（见 `itemLayout`）：宿主行内写着像素宽高时它就是条目的尺寸；没写（铺满画面）时按旧画面的
 * 尺寸算，写上居中摆放，不跟着拉成新画面的宽高。用户在画面上挪过、缩放过的保留相对画面的位置和大小：缩放倍数乘上
 * 新旧适配倍数之比，`translate` 里的像素偏移也乘上这个比，百分比不动。
 *
 * 只改写或补上属性、不去掉：去掉的属性撤销时排到行内样式的最后，文件回不到原样。所以条目和新画面一样大时也写居中
 * 摆放、缩放倍数 1，不回到铺满的写法，样子一样。
 */
export function refittedHostStyles(
  inline: Readonly<Record<string, string>>,
  before: Canvas,
  after: Canvas,
): Record<string, string> {
  const placed = pixelSizeOf(inline['width'], inline['height'])
  const size = placed ?? before
  const ratio = fitScale(size, after) / fitScale(size, before)
  const current = inline['translate']?.trim() ?? ''
  const [x = '0', y = '0', z] = current === '' || current === 'none' ? [] : splitTopLevel(current)
  const refitted = (axis: string) => {
    const parts = lengthParts(axis)
    if (parts === null) return axis
    // 铺满画面的宿主改成居中摆放：补上居中的 -50%
    return lengthOf({ percent: parts.percent - (placed === null ? 50 : 0), px: parts.px * ratio })
  }
  return {
    ...(placed === null
      ? { left: '50%', top: '50%', width: `${size.width}px`, height: `${size.height}px` }
      : {}),
    translate: [refitted(x), refitted(y), ...(z === undefined ? [] : [z])].join(' '),
    ...scaledStyles(inline['scale'] ?? '', ratio),
  }
}

/** 布局尺寸四舍五入取整，下限为 `1`（对齐上游 Studio `roundToLayoutSize`）。 */
export const layoutSize = (size: { width: number; height: number }) => ({
  width: Math.max(1, Math.round(size.width)),
  height: Math.max(1, Math.round(size.height)),
})

/** 父容器弹性布局主轴方向：`0` 非弹性布局，`1` 横向，`2` 纵向。 */
export type FlexDirection = 0 | 1 | 2

/**
 * 生成普通图层缩放后的行内样式（SDK 驼峰属性名，对齐上游 Studio `manualEditsDom.ts` 的 `applyStudioBoxSizeDimensions`）：
 * 写入取整后的像素宽高与 `border-box`，解除最小最大尺寸限制；弹性子项固定主轴 `flex-basis` 并禁止伸缩；行内元素转为 `inline-block`。
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
 * 旋转写入目标：直接写独立 `rotate` 属性，或写入 `transform` 中前导平移 `before` 与后续变换 `after` 之间。
 * `turn` 为元素当前的自身旋转角度（度）。
 */
export type RotationTarget =
  | { property: 'rotate'; turn: number }
  | { property: 'transform'; before: string; after: string; turn: number }

const TRANSLATE = /^translate(?:3d|X|Y|Z)?\(/i
const OWN_TURN = /^rotate\(\s*(-?[\d.]+(?:e[+-]?\d+)?)deg\s*\)$/i

/** 按括号外层的顶层空白切分 CSS 属性值（对齐上游 Studio `splitTopLevelWhitespace`）。 */
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
 * 解析旋转应写入的样式目标（对齐上游 Studio `rotationDraft.ts` 的 `readCssRotationTarget`）：
 * `translating` 为假时直接写 `rotate`；为真时需解析源码中的 `transform`（行内或同文件 `<style>` 末条匹配规则），无法获取时返回 `null` 拒绝画布旋转。
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

/** 生成旋转至 `turn` 度时的行内样式（SDK 驼峰属性名；行内元素自动转为 `inline-block` 以使变换生效）。 */
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

/** 将 SDK 驼峰样式名转换为短横线 CSS 属性名（保留 `--` 自定义属性），供预览页直接写入 DOM。 */
export const cssName = (name: string): string =>
  name.startsWith('--') ? name : name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

/** 批量将 SDK 驼峰样式名转换为 CSS 属性名。 */
export const cssStyles = (
  styles: Readonly<Record<string, string | null>>,
): Record<string, string | null> =>
  Object.fromEntries(Object.entries(styles).map(([name, value]) => [cssName(name), value]))

/** 安全执行 `element.matches(selector)`，不支持的选择器语法按不匹配处理。 */
const matchesSelector = (element: Element, selector: string): boolean => {
  try {
    return element.matches(selector)
  } catch {
    return false
  }
}

/**
 * 读取样式表 `css` 中匹配 `element` 的最后一条规则声明的 `transform`（对齐上游 Studio `lastRuleTransform`：
 * 按源码顺序取末条，不计算选择器优先级、`!important` 或 `@media`）；无匹配时返回 `undefined`。
 */
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

/** 在 HTML 文本 `content`（含顶层文档与各 `<template>` 内容）中查找 `data-hf-id` 为 `hfId` 的元素及全部搜索作用域。 */
function elementIn(
  content: string,
  hfId: string,
): { element: HTMLElement | undefined; scopes: ParentNode[] } {
  const page = new DOMParser().parseFromString(content, 'text/html')
  const scopes: ParentNode[] = [
    page,
    ...[...page.querySelectorAll('template')].map((t) => t.content),
  ]
  const element = scopes
    .flatMap((scope) => [...scope.querySelectorAll<HTMLElement>('[data-hf-id]')])
    .find((candidate) => candidate.getAttribute('data-hf-id') === hfId)
  return { element, scopes }
}

/** 读取文件 `content` 中指定 `hfId` 元素的行内 CSS 属性值；未声明或未找到元素时返回空串。 */
export const inlineStyleOf = (content: string, hfId: string, property: string): string =>
  elementIn(content, hfId).element?.style.getPropertyValue(property) ?? ''

/**
 * 读取文件 `content` 中指定 `hfId` 元素声明的 `transform`：优先取行内样式，否则回退读取同文件 `<style>` 中最后一条匹配规则。
 */
export function authoredTransform(content: string, hfId: string): string | undefined {
  const { element, scopes } = elementIn(content, hfId)
  if (element === undefined) return undefined
  const inline = element.style.getPropertyValue('transform')
  if (inline !== '') return inline
  const css = scopes
    .flatMap((scope) => [...scope.querySelectorAll('style')])
    .map((style) => style.textContent)
    .join('\n')
  return lastRuleTransform(element, css)
}
