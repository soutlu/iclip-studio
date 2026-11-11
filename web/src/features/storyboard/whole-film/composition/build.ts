// 仅作类型导入，编译后擦除以使 render/ 的 esbuild 打包无需解析 @/ 别名。
import type { WholeFilmDocument, WholeFilmOverlay } from '@/shared/api/generated'
import type { CatalogItem, ComponentCatalog, VariableValue } from './catalog'
import { captionWords, placeCaptions, type SubtitleRecord } from './captions'
import { cjkFontFaces } from './fonts'
import { escapeAttribute, jsonAttribute, seconds } from './html'

type ComponentVariables = WholeFilmOverlay['variables']

export const DEFAULT_CANVAS = { width: 1080, height: 1920 } as const

export interface CompositionMedia {
  videos: Readonly<Record<string, { url: string }>>
  music: { url: string } | null
  subtitles: Readonly<Record<string, SubtitleRecord | null | undefined>>
}

export interface CompositionInput {
  draft: WholeFilmDocument
  media: CompositionMedia
  catalog: ComponentCatalog
}

export interface Composition {
  html: string
  durationMs: number
}

export type CompositionErrorCode =
  'unknown-component' | 'unknown-font' | 'missing-media' | 'invalid-draft'

export class CompositionError extends Error {
  readonly code: CompositionErrorCode

  constructor(code: CompositionErrorCode, message: string) {
    super(message)
    this.name = 'CompositionError'
    this.code = code
  }
}

const Z = { layer0: 1, overlay: 2, captions: 3 } as const

export const CAPTIONS_HF_ID = 'captions'
const TRACK = { layer0: 0, captions: 2, overlay: 3, music: 4 } as const

function lookup(catalog: ComponentCatalog, name: string): CatalogItem {
  const item = catalog.items.find((candidate) => candidate.name === name)
  if (!item) throw new CompositionError('unknown-component', `组件目录里没有「${name}」`)
  return item
}

interface ComponentValues {
  variables: Record<string, VariableValue>
  font: string
}

function componentValues(
  item: CatalogItem,
  values: ComponentVariables = {},
  declaredOnly = false,
): ComponentValues {
  const declared = new Set(item.variables.map((variable) => variable.id))
  const merged: Record<string, VariableValue> = {
    ...Object.fromEntries(item.variables.map((variable) => [variable.id, variable.default])),
    ...(declaredOnly
      ? Object.fromEntries(Object.entries(values).filter(([id]) => declared.has(id)))
      : values),
  }
  const fontIds = new Set(
    item.variables.filter((variable) => variable.type === 'font').map((variable) => variable.id),
  )
  const fontId = [...fontIds][0]
  return {
    variables: Object.fromEntries(Object.entries(merged).filter(([id]) => !fontIds.has(id))),
    font: fontId === undefined ? '' : String(merged[fontId]),
  }
}

function fontVariables(family: string, cjkFamily: string): string {
  const value = `'${family}', '${cjkFamily}', sans-serif`
  return `--font-display:${value};--font-body:${value}`
}

interface HostOptions {
  id: string
  hfId: string
  placement?: Placement
  item: CatalogItem
  startMs: number
  durationMs: number
  playbackStartMs: number
  track: number
  z: number
  variables: Record<string, unknown>
  font: string
  cjkFamily: string
  canvas: { width: number; height: number }
}

type Placement = Pick<WholeFilmOverlay, 'x' | 'y' | 'scale' | 'rotation' | 'pivotX' | 'pivotY'>

const round4 = (value: number) => String(Math.round(value * 10000) / 10000)

function positionAttributes(placement: Placement): string {
  const x = placement.x ?? 0
  const y = placement.y ?? 0
  if (x === 0 && y === 0) return ''
  return ` data-x="${x}" data-y="${y}" data-hf-edit-base-x="0" data-hf-edit-base-y="0"`
}

function transformStyle(placement: Placement): string {
  const scale = placement.scale ?? 1
  const rotation = placement.rotation ?? 0
  if (scale === 1 && rotation === 0) return ''
  const px = placement.pivotX ?? 0
  const py = placement.pivotY ?? 0
  return `;rotate:${rotation}deg;scale:${scale};transform-origin:${px}px ${py}px`
}

function placed(options: HostOptions, placement: Placement, inner: string): string {
  return (
    `<div class="place" data-hf-id="${escapeAttribute(options.hfId)}"${positionAttributes(placement)}` +
    ` style="z-index:${options.z}${transformStyle(placement)}">${inner}</div>`
  )
}

function componentHost(options: HostOptions): string {
  const { id, item, canvas, size, placement } = { ...options, size: options.item.size }
  const fonts = options.font === '' ? '' : fontVariables(options.font, options.cjkFamily)
  const host = (extra: string, z = '') => {
    const style = [z, fonts].filter(Boolean).join(';')
    return (
      `<div id="${id}" data-composition-id="${escapeAttribute(item.name)}"${extra}` +
      (style === '' ? '' : ` style="${escapeAttribute(style)}"`) +
      ` data-composition-src="${escapeAttribute(item.src)}"` +
      ` data-start="${seconds(options.startMs)}" data-duration="${seconds(options.durationMs)}"` +
      ` data-playback-start="${seconds(options.playbackStartMs)}" data-track-index="${options.track}"` +
      ` data-variable-values="${jsonAttribute(options.variables)}"></div>`
    )
  }
  const box = (marks: string, z: string) => {
    if (!size) return host(` class="fill"${marks}`, z)
    const scale = Math.min(canvas.width / size.width, canvas.height / size.height)
    return (
      `<div class="fit"${marks} style="width:${size.width}px;height:${size.height}px;` +
      `transform:translate(-50%,-50%) scale(${round4(scale)})${z === '' ? '' : `;${z}`}">` +
      `${host('')}</div>`
    )
  }
  if (placement !== undefined) return placed(options, placement, box('', ''))
  return box(` data-hf-id="${escapeAttribute(options.hfId)}"`, `z-index:${options.z}`)
}

function fontCss(catalog: ComponentCatalog, family: string): string {
  const font = catalog.fonts[family]
  if (!font) throw new Error(`组件目录缺少字体「${family}」的 CSS`)
  return font.css
}

export function buildComposition({ draft, media, catalog }: CompositionInput): Composition {
  if (draft.layer0.length === 0) {
    throw new CompositionError('invalid-draft', '成片里还没有画面')
  }
  const canvas = draft.canvas ?? DEFAULT_CANVAS
  const { width, height } = canvas
  const cjkFamily = catalog.cjk.family
  const totalMs = Math.max(
    ...[...draft.layer0, ...draft.overlays].map((clip) => clip.start + clip.duration),
  )
  const used = new Set<CatalogItem>()
  const chosenFonts = new Set<string>()
  const valuesOf = (
    item: CatalogItem,
    values: ComponentVariables | undefined,
    declaredOnly = false,
  ): ComponentValues => {
    const result = componentValues(item, values, declaredOnly)
    if (result.font !== '') {
      if (!Object.hasOwn(catalog.fonts, result.font))
        throw new CompositionError('unknown-font', `组件目录里没有字体「${result.font}」`)
      chosenFonts.add(result.font)
    }
    return result
  }

  const layer0 = draft.layer0.map((clip, index) => {
    const id = `clip-${index}`
    if (clip.type === 'component') {
      const item = lookup(catalog, clip.component)
      used.add(item)
      return componentHost({
        id,
        hfId: clip.id,
        item,
        startMs: clip.start,
        durationMs: clip.duration,
        playbackStartMs: clip.playbackStart,
        track: TRACK.layer0,
        z: Z.layer0,
        ...valuesOf(item, clip.variables),
        cjkFamily,
        canvas,
      })
    }
    const source = media.videos[clip.sourceJobId]
    if (!source)
      throw new CompositionError('missing-media', `素材片「${clip.sourceJobId}」没有地址`)
    return (
      `<video id="${id}" class="layer0" data-hf-id="${escapeAttribute(clip.id)}"` +
      ` src="${escapeAttribute(source.url)}"` +
      ` data-start="${seconds(clip.start)}" data-duration="${seconds(clip.duration)}"` +
      ` data-media-start="${seconds(clip.playbackStart)}" data-track-index="${TRACK.layer0}"` +
      ` data-volume="${String(clip.volume)}" data-has-audio="true" playsinline preload="auto"></video>`
    )
  })

  const overlays = draft.overlays.map((overlay, index) => {
    const item = lookup(catalog, overlay.component)
    used.add(item)
    return componentHost({
      id: `ov-${index}`,
      hfId: overlay.id,
      placement: overlay,
      item,
      startMs: overlay.start,
      durationMs: overlay.duration,
      playbackStartMs: overlay.playbackStart,
      track: TRACK.overlay,
      z: overlay.zIndex,
      ...valuesOf(item, overlay.variables),
      cjkFamily,
      canvas,
    })
  })

  const overlayLayer =
    overlays.length === 0 ? '' : `<div class="overlays">\n${overlays.join('\n')}\n</div>`

  const captionItem = lookup(catalog, draft.captions.component)
  const words = draft.captions.hidden ? [] : captionWords(placeCaptions(draft, media.subtitles))
  let captions = ''
  if (words.length > 0) {
    used.add(captionItem)
    const values = valuesOf(captionItem, draft.captions.variables, true)
    captions = componentHost({
      id: 'captions',
      hfId: CAPTIONS_HF_ID,
      placement: draft.captions,
      item: captionItem,
      startMs: 0,
      durationMs: totalMs,
      playbackStartMs: 0,
      track: TRACK.captions,
      z: Z.captions,
      variables: { ...values.variables, words },
      font: values.font,
      cjkFamily,
      canvas,
    })
  }

  let music = ''
  if (draft.music) {
    if (!media.music)
      throw new CompositionError('missing-media', `配乐「${draft.music.jobId}」没有地址`)
    music =
      `<audio id="music" src="${escapeAttribute(media.music.url)}" data-start="0"` +
      ` data-duration="${seconds(totalMs)}" data-media-start="${seconds(draft.music.offset)}"` +
      ` data-track-index="${TRACK.music}" data-volume="${String(draft.music.volume)}"></audio>`
  }

  const families = [...new Set([...[...used].flatMap((item) => item.fonts), ...chosenFonts])].sort()
  const body = [...layer0, overlayLayer, captions, music].filter(Boolean).join('\n')
  // 0.9.31 起运行时会把声明的字体全部加载完才跑组件脚本，所以只声明成片和所用组件里出现的字
  const shown = body + [...used].map((item) => item.chars).join('')
  const cjkFaces = cjkFontFaces(catalog, shown, families)
  const fontLinks = families
    .map(
      (family) => `<link rel="stylesheet" href="${escapeAttribute(fontCss(catalog, family))}">\n`,
    )
    .join('')

  const total = seconds(totalMs)
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${width}, height=${height}">
${fontLinks}<script src="${escapeAttribute(catalog.runtime.gsap)}"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${width}px;height:${height}px;overflow:hidden;background:black;font-family:'${cjkFamily}',sans-serif}
#stage{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:black}
#stage .layer0{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:${Z.layer0}}
#stage .fill{position:absolute;inset:0;width:100%!important;height:100%!important}
#stage .fit{position:absolute;left:50%;top:50%}
#stage .place{position:absolute;inset:0}
#stage .overlays{position:absolute;inset:0;z-index:${Z.overlay}}
</style>
<style>
${cjkFaces}
</style>
</head>
<body>
<div id="stage" data-composition-id="main" data-start="0" data-duration="${total}" data-width="${width}" data-height="${height}">
${body}
</div>
<script>
window.__timelines = window.__timelines || {};
var tl = gsap.timeline({ paused: true });
tl.set({}, {}, ${total});
window.__timelines["main"] = tl;
</script>
<script src="${escapeAttribute(catalog.runtime.hyperframes)}"></script>
</body>
</html>
`
  return { html, durationMs: totalMs }
}
