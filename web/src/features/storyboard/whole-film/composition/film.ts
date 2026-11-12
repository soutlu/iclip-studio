import type { ComponentCatalog } from './catalog'
import { cjkFontFaces } from './fonts'
import { escapeAttribute, jsonAttribute, seconds } from './html'

/**
 * 成片文件：一份 HTML，时间线上每个块是根下面的一个标签。
 *
 * 文件不带脚本（根上标 `data-no-timeline`）。`<head>`、根上的属性和 `<html>` 上的变量声明都由
 * 这里按块算出来，不单独保存。
 */
export interface Film {
  canvas: Canvas
  blocks: PictureBlock[]
}

export interface Canvas {
  width: number
  height: number
}

/** 画面块：一段素材片。时间都是毫秒；`src` 是素材片记录上的地址。 */
export interface PictureBlock {
  id: string
  label: string
  jobId: string
  src: string
  start: number
  duration: number
  mediaStart: number
  track: number
  volume: number
}

export interface FilmVariable {
  id: string
  type: 'string'
  label: string
  default: string
}

export const FILM_ID = 'film'
export const MAX_FILM_MS = 120_000
export const MIN_BLOCK_MS = 100
export const PICTURE_CLASS = 'clip picture'
export const SOURCE_LABEL = '素材片'

export const sourceVariableId = (jobId: string): string => `src-${jobId}`

/** 素材地址的变量：一条记录一个，默认值就是块上写的地址。 */
export function sourceVariable(jobId: string, src: string): FilmVariable {
  return { id: sourceVariableId(jobId), type: 'string', label: SOURCE_LABEL, default: src }
}

export function filmDurationMs(film: Film): number {
  return Math.max(0, ...film.blocks.map((block) => block.start + block.duration))
}

export function filmVariables(film: Film): FilmVariable[] {
  const bySource = new Map(film.blocks.map((block) => [block.jobId, block.src]))
  return [...bySource].map(([jobId, src]) => sourceVariable(jobId, src))
}

export function pictureBlock(block: PictureBlock): string {
  const id = escapeAttribute(block.id)
  return (
    `<video id="${id}" data-hf-id="${id}" class="${PICTURE_CLASS}"` +
    ` data-label="${escapeAttribute(block.label)}" src="${escapeAttribute(block.src)}"` +
    ` data-var-src="${escapeAttribute(sourceVariableId(block.jobId))}"` +
    ` data-start="${seconds(block.start)}" data-duration="${seconds(block.duration)}"` +
    ` data-media-start="${seconds(block.mediaStart)}" data-track-index="${block.track}"` +
    ` data-volume="${String(block.volume)}" data-has-audio="true" playsinline preload="auto"></video>`
  )
}

const SECONDS = /^\d+(\.\d+)?$/

/** 从块的属性读回画面块；不是 `pictureBlock` 写出来的那种块时返回 undefined。 */
export function pictureFromAttributes(
  id: string,
  attributes: Readonly<Record<string, string>>,
): PictureBlock | undefined {
  const jobId = attributes['data-var-src']?.replace(/^src-/, '')
  const { src } = attributes
  const numbers = (['data-start', 'data-duration', 'data-media-start'] as const).map((name) => {
    const value = attributes[name] ?? ''
    return SECONDS.test(value) ? Math.round(Number(value) * 1000) : undefined
  })
  const [start, duration, mediaStart] = numbers
  if (
    jobId === undefined ||
    src === undefined ||
    start === undefined ||
    duration === undefined ||
    mediaStart === undefined
  )
    return undefined
  return {
    id,
    label: attributes['data-label'] ?? '',
    jobId,
    src,
    start,
    duration,
    mediaStart,
    track: Number(attributes['data-track-index'] ?? 0),
    volume: Number(attributes['data-volume'] ?? 1),
  }
}

export function writeFilm(film: Film, catalog: ComponentCatalog): string {
  const { width, height } = film.canvas
  const variables = filmVariables(film)
  const declared =
    variables.length === 0 ? '' : ` data-composition-variables="${jsonAttribute(variables)}"`
  const body = film.blocks.map(pictureBlock).join('\n')
  return `<!doctype html>
<html${declared}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${width}, height=${height}">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${width}px;height:${height}px;overflow:hidden;background:black;font-family:'${catalog.cjk.family}',sans-serif}
#${FILM_ID}{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:black}
#${FILM_ID} .picture{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
</style>
<style>
${cjkFontFaces(catalog, '', [])}
</style>
</head>
<body>
<div id="${FILM_ID}" data-hf-id="${FILM_ID}" data-composition-id="${FILM_ID}" data-no-timeline data-start="0" data-duration="${seconds(filmDurationMs(film))}" data-width="${width}" data-height="${height}">
${body}
</div>
</body>
</html>
`
}
