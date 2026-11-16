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

/** 一句字幕的元素：字里的换行写成 `<br>`，和 SDK 改字时一样。 */
export function captionElement(
  caption: Pick<CaptionClip, 'id' | 'start' | 'duration' | 'variable' | 'text'>,
): string {
  const text = escapeAttribute(caption.text).replaceAll('\n', '<br>')
  return (
    `<div id="${escapeAttribute(caption.id)}" data-hf-id="${escapeAttribute(caption.id)}" class="clip caption"` +
    ` data-start="${seconds(caption.start)}" data-duration="${seconds(caption.duration)}"` +
    ` data-var-text="${escapeAttribute(caption.variable)}">${text}</div>`
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
const TEXT_COLOR = '#ffffff'
// design-allow -- 字幕的描边色是作品内容
const STROKE_COLOR = '#000000'
// design-allow -- 字幕的投影色是作品内容
const SHADOW_COLOR = 'rgba(0, 0, 0, 0.45)'

/**
 * 字幕的样子：白色粗体、黑色描边（描边画在字后面）、居中，在画面 86.5% 高处，最宽 90%，字号按画面宽度算
 * （1080 宽时 56px）。字体用组件库的中文字体：主文件的字体块按字幕的字声明了它，没声明的字体导出时会去外网取。
 */
function captionStyle(canvas: Canvas, catalog: ComponentCatalog): string {
  const size = Math.round((canvas.width * 56) / 1080)
  const shadow = `0 ${Math.max(1, Math.round(size * 0.03))}px ${Math.round(size * 0.08)}px`
  return `[data-composition-id="${CAPTIONS_ID}"] .caption {
  position: absolute;
  left: 5%;
  width: 90%;
  top: 86.5%;
  transform: translateY(-50%);
  text-align: center;
  white-space: pre-line;
  color: ${TEXT_COLOR};
  font-family: '${catalog.cjk.family}', sans-serif;
  font-weight: 700;
  font-size: ${size}px;
  line-height: 1.3;
  -webkit-text-stroke: ${Math.round(size * 0.2)}px ${STROKE_COLOR};
  paint-order: stroke fill;
  text-shadow: ${shadow} ${SHADOW_COLOR};
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

/**
 * 把场景根下一个带时间的元素读成一句字幕：字取主文件根上它的变量的默认值（`texts`，变量 → 字），
 * 没有这个变量时取元素里写的字。
 */
export function captionOf(
  element: ElementView,
  timing: TimingView,
  texts: ReadonlyMap<string, string>,
): CaptionClip {
  const start = Math.round(timing.enterAt * 1000)
  const variable = element.attributes['data-var-text'] ?? ''
  return {
    kind: 'caption',
    id: element.id,
    label: VARIABLE_LABEL,
    start,
    duration: Math.round(timing.exitAt * 1000) - start,
    track: 0,
    hidden: element.attributes['data-hidden'] !== undefined,
    link: null,
    text: texts.get(variable) ?? element.text ?? '',
    variable,
  }
}

export const CAPTIONS_PROBLEM_TEXT =
  '字幕文件写法不对，字幕会显示成占位字，无法导出；请删掉字幕文件里声明的变量和字幕宿主上的取值后再导出'

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
