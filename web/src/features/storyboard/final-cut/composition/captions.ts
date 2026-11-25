import type { ComponentCatalog } from './catalog'
import type { Canvas, CaptionClip, ElementView, TimingView } from './film'
import { escapeAttribute, seconds } from './html'

/**
 * final-cut 的字幕：工程里一个字幕场景文件，主文件根下一个挂载它的字幕宿主。
 *
 * 场景文件用 `<template>` 包着，根下每句字幕是一个带时间的元素，字由 `data-var-text` 读主文件根
 * （`<html>` 上的 `data-composition-variables`）声明的变量，每句一个。场景自己不声明变量、宿主不给取值：
 * 两处有一处写了，主文件根上的变量就整个到不了场景，字幕显示成元素里写的字。主文件根、宿主、场景根都带
 * `data-no-timeline`。
 *
 * 样式分三层，后一层盖前一层，都是所有语言共用：
 * 1. 默认规则（见 `captionStyle`）：编辑器维护，字号、描边、投影随画面宽度重算（见 `withCaptionDefaults`）；
 * 2. 字幕样式规则（见 `CaptionStyle`、`withCaptionStyleRule`）：紧跟在默认规则后面，只写用户设过的字体、字色、字号；
 * 3. 单独设置：一句自己的字体、字色、字号写在它元素的行内样式上（见 `captionStyles`、`ownsStyle`）。
 */

/** 编辑器新建字幕场景文件时的路径（相对工程根）。 */
export const CAPTIONS_PATH = 'compositions/captions.html'

/** 字幕宿主的编号，也是场景的 `data-composition-id`。 */
export const CAPTIONS_ID = 'captions'

const SCENE_ROOT_ID = 'root'
const TRACK_KIND = 'captions'
const VARIABLE_LABEL = '字幕'

/** 宿主叠在所有片段上面：编辑器给片段写的叠放顺序是从 1 往上数的片段个数。 */
const HOST_Z = 1_000_000

/** 主文件根下的字幕宿主：`data-track-kind` 是 captions、挂载着一个文件的元素。 */
export const isCaptionsHost = (attributes: Readonly<Record<string, string>>): boolean =>
  attributes['data-track-kind'] === TRACK_KIND && attributes['data-composition-src'] !== undefined

/** 字幕宿主：铺满画面、叠在最上面，从 0 起，长 `durationMs`（final-cut 的总长）。 */
export function captionsHostElement(canvas: Canvas, durationMs: number): string {
  return (
    `<div id="${CAPTIONS_ID}" data-hf-id="${CAPTIONS_ID}" class="clip"` +
    ` style="position: absolute; inset: 0; z-index: ${HOST_Z}"` +
    ` data-start="0" data-duration="${seconds(durationMs)}" data-track-kind="${TRACK_KIND}"` +
    ` data-no-timeline data-composition-id="${CAPTIONS_ID}"` +
    ` data-composition-src="${CAPTIONS_PATH}"` +
    ` data-width="${canvas.width}" data-height="${canvas.height}"></div>`
  )
}

/**
 * 字幕属于哪个视频片段（值是视频片段的编号）：编辑器自己的约定，播放和导出不读它。识别出来的字幕带着，
 * 手动加的没有。
 */
export const CAPTION_OWNER = 'data-caption-of'

/** 一句字幕的元素：字里的换行写成 `<br>`，和 SDK 改字时一样；属于某个视频片段时带上 `data-caption-of`。 */
export function captionElement(
  caption: Pick<CaptionClip, 'id' | 'start' | 'duration' | 'variable' | 'text'> &
    Partial<Pick<CaptionClip, 'owner'>>,
): string {
  const text = escapeAttribute(caption.text).replaceAll('\n', '<br>')
  const owner =
    caption.owner === undefined || caption.owner === null
      ? ''
      : ` ${CAPTION_OWNER}="${escapeAttribute(caption.owner)}"`
  return (
    `<div id="${escapeAttribute(caption.id)}" data-hf-id="${escapeAttribute(caption.id)}" class="clip caption"` +
    ` data-start="${seconds(caption.start)}" data-duration="${seconds(caption.duration)}"` +
    ` data-var-text="${escapeAttribute(caption.variable)}"${owner}>${text}</div>`
  )
}

/** 一句字幕在主文件根上的变量声明：字就是默认值。 */
export const captionVariable = (caption: Pick<CaptionClip, 'variable' | 'text'>) => ({
  id: caption.variable,
  type: 'string' as const,
  label: VARIABLE_LABEL,
  role: 'content',
  default: caption.text,
})

// 字幕在画面里的颜色是作品内容，不是界面，不用界面的设计变量
// design-allow -- 字幕的字色是作品内容
export const CAPTION_COLOR = '#ffffff'
// design-allow -- 字幕的描边色是作品内容
const STROKE_COLOR = '#000000'
// design-allow -- 字幕的投影色是作品内容
const SHADOW_COLOR = 'rgba(0, 0, 0, 0.45)'

/** 字幕的默认字号（像素）：按画面宽度算，1080 宽时 56。 */
export const captionFontSize = (canvas: Canvas): number => Math.round((canvas.width * 56) / 1080)

/** 一句能设的字号（像素，整数）：默认字号的 0.5 倍到 2 倍。 */
export const captionFontSizeRange = (canvas: Canvas): { min: number; max: number } => {
  const size = captionFontSize(canvas)
  return { min: Math.round(size * 0.5), max: size * 2 }
}

/** 字号 `size` 下的描边和投影：粗细、偏移按字号算，字号变了要跟着变。 */
const strokeOf = (size: number) => `${Math.round(size * 0.2)}px ${STROKE_COLOR}`
const shadowOf = (size: number) =>
  `0 ${Math.max(1, Math.round(size * 0.03))}px ${Math.round(size * 0.08)}px ${SHADOW_COLOR}`

const CAPTION_RULE = `[data-composition-id="${CAPTIONS_ID}"] .caption`
const CAPTION_RULE_BODY = new RegExp(
  `(${CAPTION_RULE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{)([^}]*)\\}`,
)

/**
 * 将字幕场景文件 `scene` 中默认样式规则（见 `captionStyle`）的字号、描边与投影更新为画布 `canvas` 对应的默认值（见 `captionFontSize`）。
 * 默认字号随画布宽度等比计算，保存时重算以保证修改尺寸与撤销同步生效；单句独立设置的行内字号不受影响。
 * 原规则中未声明的属性不予补写；未匹配到标准样式规则（如手写自定义场景）时原样返回。
 */
export function withCaptionDefaults(scene: string, canvas: Canvas): string {
  const size = captionFontSize(canvas)
  const defaults: [string, string][] = [
    ['font-size', `${size}px`],
    ['-webkit-text-stroke', strokeOf(size)],
    ['text-shadow', shadowOf(size)],
  ]
  return scene.replace(CAPTION_RULE_BODY, (_, open: string, body: string) => {
    const next = defaults.reduce(
      (text, [property, value]) =>
        text.replace(new RegExp(`(^|[\\s;])${property}\\s*:[^;]*;`), `$1${property}: ${value};`),
      body,
    )
    return `${open}${next}}`
  })
}

/**
 * 字幕的样子：白色粗体、黑色描边（描边画在字后面）、居中，在画面 86.5% 高处，最宽 90%，字号见
 * `captionFontSize`。字体用组件库的中文字体：主文件的字体块按字幕的字声明了它，没声明的字体导出时会去外网取。
 */
function captionStyle(canvas: Canvas, catalog: ComponentCatalog): string {
  const size = captionFontSize(canvas)
  return `${CAPTION_RULE} {
  position: absolute;
  left: 5%;
  width: 90%;
  top: 86.5%;
  transform: translateY(-50%);
  text-align: center;
  white-space: pre-line;
  color: ${CAPTION_COLOR};
  font-family: '${catalog.cjk.family}', sans-serif;
  font-weight: 700;
  font-size: ${size}px;
  line-height: 1.3;
  -webkit-text-stroke: ${strokeOf(size)};
  paint-order: stroke fill;
  text-shadow: ${shadowOf(size)};
}`
}

/** 字幕场景文件：样式和根，根下按先后放上 `captions`（编辑器新建时是空的）。 */
export function captionsScene(
  canvas: Canvas,
  catalog: ComponentCatalog,
  captions: readonly Parameters<typeof captionElement>[0][] = [],
): string {
  const children = captions.map((caption) => `${captionElement(caption)}\n`).join('')
  return `<template>
<style>
${captionStyle(canvas, catalog)}
</style>
<div id="${SCENE_ROOT_ID}" data-hf-id="${SCENE_ROOT_ID}" data-composition-id="${CAPTIONS_ID}" data-no-timeline data-width="${canvas.width}" data-height="${canvas.height}">
${children}</div>
</template>
`
}

/** 一句字幕叫什么：就是它的字，换行和连着的空白合成一个空格；字是空的时叫「字幕」。 */
export function captionLabel(text: string): string {
  const name = text.replace(/\s+/g, ' ').trim()
  return name === '' ? VARIABLE_LABEL : name
}

/** 行内 `font-family` 里的首选字体族（去掉引号）；没写时是 null。 */
const firstFamily = (value: string | undefined): string | null => {
  const first =
    value
      ?.split(',')[0]
      ?.trim()
      .replace(/^['"]|['"]$/g, '') ?? ''
  return first === '' ? null : first
}

const PIXELS = /^(\d+)px$/

/** 行内 `font-size` 的像素数；没写、不是整数像素时是 null。 */
const pixelsOf = (value: string | undefined): number | null => {
  const matched = value === undefined ? null : PIXELS.exec(value.trim())
  return matched === null ? null : Number(matched[1])
}

/**
 * 把场景根下一个带时间的元素读成一句字幕：字取主文件根上它的变量的默认值（`texts`，变量 → 字），
 * 没有这个变量时取元素里写的字；名字见 `captionLabel`。`data-caption-of` 没写或是空的时不属于任何片段。
 * 字体是行内 `font-family` 的首选字体族，字色是行内的 `color`，字号是行内 `font-size` 的像素数，没写的是 null。
 */
export function captionOf(
  element: ElementView,
  timing: TimingView,
  texts: ReadonlyMap<string, string>,
): CaptionClip {
  const start = Math.round(timing.enterAt * 1000)
  const variable = element.attributes['data-var-text'] ?? ''
  const text = texts.get(variable) ?? element.text ?? ''
  const owner = element.attributes[CAPTION_OWNER]
  return {
    kind: 'caption',
    id: element.id,
    label: captionLabel(text),
    start,
    duration: Math.round(timing.exitAt * 1000) - start,
    track: 0,
    hidden: element.attributes['data-hidden'] !== undefined,
    link: null,
    text,
    variable,
    owner: owner === undefined || owner === '' ? null : owner,
    font: firstFamily(element.inlineStyles['fontFamily']),
    color: element.inlineStyles['color'] ?? null,
    fontSize: pixelsOf(element.inlineStyles['fontSize']),
  }
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i

/**
 * 字幕的字体族、字色和字号（像素），没设的是 null。一句字幕自己的（行内）、字幕样式规则里的都用它表示。
 */
export type CaptionStyle = Pick<CaptionClip, 'font' | 'color' | 'fontSize'>

/** 什么都没设：没有字幕样式规则，或者一句没有单独设置。 */
export const NO_CAPTION_STYLE: CaptionStyle = { font: null, color: null, fontSize: null }

/** 一句字幕开着「单独设置」：行内写了字体、字色、字号里任意一样（老工程里改过的句子也就这样算开着）。 */
export const ownsStyle = (caption: CaptionStyle): boolean =>
  caption.font !== null || caption.color !== null || caption.fontSize !== null

/**
 * `changes` 写成的样式（SDK 的属性名），不检查取值：null 是去掉。字体写成 `'<字体族>', '<中文字体族>', sans-serif`
 * （这个字体族没有的中文字形退到组件库的中文字体），字体就是中文字体族时只写它；描边和投影跟着字号一起写、一起去掉。
 */
function styleDeclarations(
  changes: Partial<CaptionStyle>,
  catalog: ComponentCatalog,
): Record<string, string | null> {
  const styles: Record<string, string | null> = {}
  const { font, color, fontSize } = changes
  if (font !== undefined)
    styles['fontFamily'] =
      font === null
        ? null
        : font === catalog.cjk.family
          ? `'${font}', sans-serif`
          : `'${font}', '${catalog.cjk.family}', sans-serif`
  if (color !== undefined) styles['color'] = color
  if (fontSize !== undefined) {
    styles['fontSize'] = fontSize === null ? null : `${fontSize}px`
    // 键名照 SDK 把属性名转成驼峰的写法，存出来才是 -webkit-text-stroke
    styles['WebkitTextStroke'] = fontSize === null ? null : strokeOf(fontSize)
    styles['textShadow'] = fontSize === null ? null : shadowOf(fontSize)
  }
  return styles
}

/**
 * 改一句字幕的样式时写到它元素上的行内样式（SDK 的属性名）：`changes` 里给了的那几样，null 是去掉。
 * 字体只能是组件库 `fonts` 里的字体族或组件库的中文字体族（写法见 `styleDeclarations`）；字色只能是 `#rrggbb`；
 * 字号是 `canvas` 上 `captionFontSizeRange` 里的整数像素，描边和投影按它一起写、一起去掉。
 *
 * @throws Error 字体不在组件库里，字色不是 `#rrggbb`，或字号不是范围里的整数
 */
export function captionStyles(
  changes: Partial<CaptionStyle>,
  catalog: ComponentCatalog,
  canvas: Canvas,
): Record<string, string | null> {
  const { font, color, fontSize } = changes
  if (
    font !== undefined &&
    font !== null &&
    font !== catalog.cjk.family &&
    !Object.hasOwn(catalog.fonts, font)
  )
    throw new Error(`组件库中不存在字体「${font}」`)
  if (color !== undefined && color !== null && !HEX_COLOR.test(color))
    throw new Error(`字幕颜色格式无效：${color}`)
  if (fontSize !== undefined && fontSize !== null) {
    const { min, max } = captionFontSizeRange(canvas)
    if (!(Number.isInteger(fontSize) && fontSize >= min && fontSize <= max))
      throw new Error(`字幕字号须为 ${min} 至 ${max} 之间的整数像素：${fontSize}`)
  }
  return styleDeclarations(changes, catalog)
}

/**
 * 一句字幕显示出来的字体族、字色和字号：这一句自己设了的（`own`）用它的，没设的用字幕样式（`style`），
 * 字幕样式也没设的用默认规则的（组件库的中文字体、白色、`captionFontSize`）。
 */
export function captionLook(
  own: CaptionStyle,
  style: CaptionStyle,
  catalog: ComponentCatalog,
  canvas: Canvas,
): { font: string; color: string; fontSize: number } {
  return {
    font: own.font ?? style.font ?? catalog.cjk.family,
    color: own.color ?? style.color ?? CAPTION_COLOR,
    fontSize: own.fontSize ?? style.fontSize ?? captionFontSize(canvas),
  }
}

/**
 * 打开一句的「单独设置」时写到它元素上的行内样式：这一刻显示的三样（见 `captionLook`，这一句还没有自己的）都写上，
 * 画面不变。字体是默认时也写明组件库的中文字体族，以后改字幕样式的字体时这一句才不跟着变。取值来自已经存着的
 * 字幕样式和默认规则，不再按现在的画面检查字号范围（改过画面尺寸时字幕样式的字号不换算，可能已在范围外）。
 */
export const ownCaptionStyles = (
  style: CaptionStyle,
  catalog: ComponentCatalog,
  canvas: Canvas,
): Record<string, string | null> =>
  styleDeclarations(captionLook(NO_CAPTION_STYLE, style, catalog, canvas), catalog)

/** 关闭一句的「单独设置」时要去掉的行内样式：字体、字色、字号和跟着字号的描边、投影。 */
export const clearedCaptionStyles = (catalog: ComponentCatalog): Record<string, null> =>
  Object.fromEntries(
    Object.keys(styleDeclarations(NO_CAPTION_STYLE, catalog)).map((name) => [name, null]),
  )

// 字幕样式规则：比默认规则多一个 .clip（每句都是带时间的元素，带着它），优先级更高、又写在默认规则后面，
// 一定盖过默认规则；选择器和默认规则不同，`withCaptionDefaults` 认不到它
const STYLE_RULE = `[data-composition-id="${CAPTIONS_ID}"] .clip.caption`
const STYLE_RULE_TEXT = new RegExp(
  `\\n?${STYLE_RULE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*\\}`,
)

/** 规则正文里属性 `property` 的值；没写时是 undefined。 */
const declared = (body: string, property: string): string | undefined =>
  new RegExp(`(?:^|[\\s;{])${property}\\s*:\\s*([^;}]*)`).exec(body)?.[1]?.trim()

/** 字幕场景文件 `scene` 里的字幕样式规则原文（不含前面的换行）；没有时是 null。 */
export const captionStyleRuleIn = (scene: string): string | null =>
  STYLE_RULE_TEXT.exec(scene)?.[0].replace(/^\n/, '') ?? null

/**
 * 字幕场景文件 `scene`（也可以只是一条字幕样式规则）里字幕样式规则设的字体族、字色、字号；没有这条规则、
 * 规则里没写的是 null。读法同一句字幕的行内样式（见 `captionOf`）。
 */
export function captionStyleOf(scene: string): CaptionStyle {
  const rule = captionStyleRuleIn(scene)
  if (rule === null) return NO_CAPTION_STYLE
  const body = rule.slice(rule.indexOf('{'))
  return {
    font: firstFamily(declared(body, 'font-family')),
    color: declared(body, 'color') ?? null,
    fontSize: pixelsOf(declared(body, 'font-size')),
  }
}

/**
 * 字幕样式 `style` 改了 `changes` 以后的字幕样式规则原文；改完一样都没设时是 null（不写这条规则）。只检查这次改的
 * （检查同 `captionStyles`），没改的照原样写；写法同行内样式（见 `styleDeclarations`），属性名换成 CSS 的写法。
 *
 * @throws Error 改的字体不在组件库里，字色不是 `#rrggbb`，或字号不是范围里的整数
 */
export function captionStyleRule(
  style: CaptionStyle,
  changes: Partial<CaptionStyle>,
  catalog: ComponentCatalog,
  canvas: Canvas,
): string | null {
  captionStyles(changes, catalog, canvas)
  const next = { ...style, ...changes }
  const lines = Object.entries(styleDeclarations(next, catalog)).flatMap(([name, value]) =>
    value === null
      ? []
      : [`  ${name.replace(/[A-Z]/g, (upper) => `-${upper.toLowerCase()}`)}: ${value};`],
  )
  return lines.length === 0 ? null : `${STYLE_RULE} {\n${lines.join('\n')}\n}`
}

/**
 * 字幕场景文件 `scene` 换上字幕样式规则 `rule`（见 `captionStyleRule`；null 是去掉这条规则）：先去掉原来的，
 * 再写在默认规则后面；没有默认规则时写在第一个 `<style>` 的末尾。场景里没有 `<style>` 时写不进去，原样返回
 * （调用方用 `captionStyleRuleIn` 核对写没写进去）。
 */
export function withCaptionStyleRule(scene: string, rule: string | null): string {
  const bare = scene.replace(STYLE_RULE_TEXT, '')
  if (rule === null) return bare
  const defaults = CAPTION_RULE_BODY.exec(bare)
  if (defaults !== null) {
    const end = defaults.index + defaults[0].length
    return `${bare.slice(0, end)}\n${rule}${bare.slice(end)}`
  }
  const close = bare.search(/<\/style\s*>/i)
  return close < 0 ? scene : `${bare.slice(0, close)}${rule}\n${bare.slice(close)}`
}

export const CAPTIONS_PROBLEM_TEXT =
  '字幕文件格式有误，字幕将显示为占位文字，无法导出；请移除字幕文件中声明的变量及字幕宿主上的取值后再导出'

const DECLARES_VARIABLES = /<[^>]*\sdata-composition-variables\s*=/i

/**
 * 字幕写法不对时的原因：场景文件 `scene` 里有元素声明了变量（根 `<div>`、`<html>` 上的都算），或者宿主
 * （属性 `host`）带了取值。这样写时主文件根上的变量到不了场景，字幕会显示成占位字。没问题时是 undefined。
 */
export function captionsProblem(
  scene: string | null,
  host: Readonly<Record<string, string>> | undefined,
): string | undefined {
  const declared = scene !== null && DECLARES_VARIABLES.test(scene)
  return declared || host?.['data-variable-values'] !== undefined
    ? CAPTIONS_PROBLEM_TEXT
    : undefined
}
