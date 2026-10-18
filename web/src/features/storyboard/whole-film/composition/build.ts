/**
 * 整片草稿 → HyperFrames 合成页。预览（播放器 srcdoc，页头加 `<base>` 指向组件目录）与导出
 * （渲染服务 `render/` 写进项目目录）共用这一份；纯函数，只返回字符串。
 *
 * 合成页里组件、运行时的路径都相对组件目录根；素材地址原样使用调用方给的。
 */
// 草稿类型取后端合同的生成类型；只导入类型，打包时整行去掉，render/ 用 esbuild 打包不需要解析 @/。
import type { WholeFilmDocument, WholeFilmTransition } from '@/shared/api/generated'
import type { CatalogItem, ComponentCatalog, Placement, VariableValue } from './catalog'
import { captionWords, placeCaptions, type SubtitleRecord } from './captions'
import { escapeAttribute, jsonAttribute, scriptJson, seconds } from './html'

type ComponentVariables = WholeFilmTransition['variables']

export interface CompositionMedia {
  /** 按 `sourceJobId`：成片地址。 */
  videos: Readonly<Record<string, { url: string }>>
  /** 草稿里配乐的地址；没有配乐时为 null。 */
  music: { url: string } | null
  /** 按 `sourceJobId`：这条成片的字幕记录；没有识别结果时缺省或为 null。 */
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
  /** 组件不在目录里（或已被排除）。 */
  | 'unknown-component'
  /** 组件放错了位置，例如把片头组件当转场。 */
  | 'misplaced-component'
  /** 草稿引用的成片或配乐没有给出地址。 */
  | 'missing-media'
  /** 草稿本身无法合成。 */
  | 'invalid-draft'

/** 草稿无法合成成页面；`code` 区分原因，`message` 说明是哪一项。 */
export class CompositionError extends Error {
  readonly code: CompositionErrorCode

  constructor(code: CompositionErrorCode, message: string) {
    super(message)
    this.name = 'CompositionError'
    this.code = code
  }
}

// 画面叠放次序（HyperFrames 的 data-track-index 只用于显示，叠放靠 z-index）。
const Z = { layer0: 1, overlay: 2, captions: 3, transition: 4 } as const
const TRACK = { layer0: 0, transition: 1, captions: 2, overlay: 3, music: 4 } as const

interface LayerTweenCall {
  target: string
  from: Record<string, number>
  to: Record<string, number>
  ease: string
  at: number
  duration: number
}

function lookup(catalog: ComponentCatalog, name: string, placement: Placement): CatalogItem {
  const item = catalog.items.find((candidate) => candidate.name === name)
  if (!item) throw new CompositionError('unknown-component', `组件目录里没有「${name}」`)
  if (item.placement !== placement) {
    throw new CompositionError(
      'misplaced-component',
      `组件「${name}」只能放在 ${item.placement}，不能放在 ${placement}`,
    )
  }
  return item
}

/** 组件目录里的默认值打底，草稿里的取值覆盖。 */
function variableValues(
  item: CatalogItem,
  values: ComponentVariables,
): Record<string, VariableValue> {
  const defaults = Object.fromEntries(
    item.variables.map((variable) => [variable.id, variable.default]),
  )
  return { ...defaults, ...values }
}

interface HostOptions {
  id: string
  item: CatalogItem
  startMs: number
  durationMs: number
  track: number
  z: number
  variables: Record<string, unknown>
  canvas: { width: number; height: number }
  /** 按固定尺寸设计的组件放进画面的方式：contain 完整放下，cover 铺满。 */
  fit: 'contain' | 'cover'
}

const round4 = (value: number) => String(Math.round(value * 10000) / 10000)

/** 子合成宿主；按固定尺寸设计的组件外面套一层等比缩放、居中的盒子。 */
function componentHost(options: HostOptions): string {
  const { id, item, canvas, size } = { ...options, size: options.item.size }
  const host = (extra: string) =>
    `<div id="${id}" data-composition-id="${id}"${extra}` +
    ` data-composition-src="${escapeAttribute(item.src)}"` +
    ` data-start="${seconds(options.startMs)}" data-duration="${seconds(options.durationMs)}"` +
    ` data-playback-start="0" data-track-index="${options.track}"` +
    ` data-variable-values="${jsonAttribute(options.variables)}"></div>`
  if (!size) return host(` class="fill" style="z-index:${options.z}"`)
  const pick = options.fit === 'cover' ? Math.max : Math.min
  const scale = pick(canvas.width / size.width, canvas.height / size.height)
  return (
    `<div class="fit" style="width:${size.width}px;height:${size.height}px;` +
    `transform:translate(-50%,-50%) scale(${round4(scale)});z-index:${options.z}">${host('')}</div>`
  )
}

/**
 * 转场的位置：切点在转场里的 `cutAt` 处，即从「切点 − cutAt × 时长」开始、持续组件原定时长；
 * 整个转场必须落在切点前后这两段之内（前一段的开头之后、后一段的结尾之前）。
 */
export function transitionWindow(
  draft: Pick<WholeFilmDocument, 'layer0'>,
  transition: Pick<WholeFilmTransition, 'afterClipId'>,
  spec: { cutAt: number; durationMs: number },
): { start: number; end: number; cut: number; fits: boolean } | null {
  const position = draft.layer0.findIndex((clip) => clip.id === transition.afterClipId)
  const outgoing = draft.layer0[position]
  const incoming = draft.layer0[position + 1]
  if (!outgoing || !incoming) return null
  const cut = outgoing.start + outgoing.duration
  const start = cut - spec.cutAt * spec.durationMs
  const end = start + spec.durationMs
  return {
    start,
    end,
    cut,
    fits: start >= outgoing.start && end <= incoming.start + incoming.duration,
  }
}

function transitionParts(
  transition: WholeFilmTransition,
  index: number,
  draft: WholeFilmDocument,
  catalog: ComponentCatalog,
  canvas: { width: number; height: number },
): { host: string; tweens: LayerTweenCall[]; item: CatalogItem } {
  const position = draft.layer0.findIndex((clip) => clip.id === transition.afterClipId)
  if (position < 0 || position === draft.layer0.length - 1) {
    throw new CompositionError('invalid-draft', `转场「${transition.id}」没有接在两段之间`)
  }
  const item = lookup(catalog, transition.component, 'transition')
  const spec = item.transition
  if (!spec || !item.duration) {
    throw new CompositionError('misplaced-component', `组件「${item.name}」缺少转场的接法`)
  }
  // 组件按原定时长排时间：HyperFrames 挂载时宿主的 data-duration 只决定显示多久，
  // 宿主上的 data-playback-rate 在 0.8.168 的运行时里对子合成不起作用，所以转场时长只能是原定时长。
  if (transition.duration !== Math.round(item.duration * 1000)) {
    throw new CompositionError(
      'invalid-draft',
      `转场「${transition.id}」的时长须是组件原定的 ${item.duration} 秒`,
    )
  }
  const window = transitionWindow(draft, transition, {
    cutAt: spec.cutAt,
    durationMs: transition.duration,
  })
  if (!window?.fits) {
    throw new CompositionError('invalid-draft', `转场「${transition.id}」超出了切点前后两段的范围`)
  }
  const { start: startMs, cut: cutMs } = window
  const leadMs = cutMs - startMs
  const id = `tr-${index}`
  const host = componentHost({
    id,
    item,
    startMs,
    durationMs: transition.duration,
    track: TRACK.transition,
    z: Z.transition,
    variables: variableValues(item, transition.variables),
    canvas,
    fit: 'cover',
  })
  if (spec.kind === 'overlay') return { host, tweens: [], item }
  const tweens: LayerTweenCall[] = [
    {
      target: `clip-${position}`,
      ...spec.out,
      at: startMs / 1000,
      duration: leadMs / 1000,
    },
    {
      target: `clip-${position + 1}`,
      ...spec.in,
      at: cutMs / 1000,
      duration: (transition.duration - leadMs) / 1000,
    },
  ]
  return { host, tweens, item }
}

/** 组件字体整套字形的 CSS；组件目录给组件列了字体却没有对应 CSS 是目录本身的错。 */
function fontCss(catalog: ComponentCatalog, family: string): string {
  const href = catalog.fonts[family]
  if (!href) throw new Error(`组件目录缺少字体「${family}」的 CSS`)
  return href
}

/**
 * 生成合成页。组件不在目录里、放错位置，或草稿引用的素材缺地址时抛出 {@link CompositionError}。
 */
export function buildComposition({ draft, media, catalog }: CompositionInput): Composition {
  const canvas = draft.canvas
  if (!canvas || draft.layer0.length === 0) {
    throw new CompositionError('invalid-draft', '成片里还没有画面')
  }
  const { width, height } = canvas
  const totalMs = Math.max(...draft.layer0.map((clip) => clip.start + clip.duration))
  // 页面上用到的组件，按它们的网页字体引用字体 CSS。
  const used = new Set<CatalogItem>()

  const layer0 = draft.layer0.map((clip, index) => {
    const id = `clip-${index}`
    if (clip.type === 'component') {
      const item = lookup(catalog, clip.component, clip.role)
      used.add(item)
      return componentHost({
        id,
        item,
        startMs: clip.start,
        durationMs: clip.duration,
        track: TRACK.layer0,
        z: Z.layer0,
        variables: variableValues(item, clip.variables),
        canvas,
        fit: 'contain',
      })
    }
    const source = media.videos[clip.sourceJobId]
    if (!source) throw new CompositionError('missing-media', `成片「${clip.sourceJobId}」没有地址`)
    return (
      `<video id="${id}" class="layer0" src="${escapeAttribute(source.url)}"` +
      ` data-start="${seconds(clip.start)}" data-duration="${seconds(clip.duration)}"` +
      ` data-media-start="${seconds(clip.playbackStart)}" data-track-index="${TRACK.layer0}"` +
      ` data-volume="${String(clip.volume)}" data-has-audio="true" playsinline preload="auto"></video>`
    )
  })

  const transitions = draft.transitions.map((transition, index) =>
    transitionParts(transition, index, draft, catalog, canvas),
  )
  for (const part of transitions) used.add(part.item)

  const overlays = draft.overlays.map((overlay, index) => {
    const item = lookup(catalog, overlay.component, 'overlay')
    used.add(item)
    return componentHost({
      id: `ov-${index}`,
      item,
      startMs: overlay.start,
      durationMs: overlay.duration,
      track: TRACK.overlay,
      z: Z.overlay,
      variables: variableValues(item, overlay.variables),
      canvas,
      fit: 'contain',
    })
  })

  const captionItem = lookup(catalog, draft.captions.component, 'caption')
  const words = captionWords(placeCaptions(draft, media.subtitles))
  if (words.length > 0) used.add(captionItem)
  const captions =
    words.length === 0
      ? ''
      : componentHost({
          id: 'captions',
          item: captionItem,
          startMs: 0,
          durationMs: totalMs,
          track: TRACK.captions,
          z: Z.captions,
          variables: { ...variableValues(captionItem, {}), words },
          canvas,
          fit: 'contain',
        })

  let music = ''
  if (draft.music) {
    if (!media.music)
      throw new CompositionError('missing-media', `配乐「${draft.music.jobId}」没有地址`)
    music =
      `<audio id="music" src="${escapeAttribute(media.music.url)}" data-start="0"` +
      ` data-duration="${seconds(totalMs)}" data-media-start="${seconds(draft.music.offset)}"` +
      ` data-track-index="${TRACK.music}" data-volume="${String(draft.music.volume)}"></audio>`
  }

  const families = [...new Set([...used].flatMap((item) => item.fonts))].sort()
  const fontLinks = [catalog.runtime.cjkFont, ...families.map((family) => fontCss(catalog, family))]
    .map((href) => `<link rel="stylesheet" href="${escapeAttribute(href)}">`)
    .join('\n')

  const tweens = transitions.flatMap((part) => part.tweens)
  const total = seconds(totalMs)
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${width}, height=${height}">
${fontLinks}
<script src="${escapeAttribute(catalog.runtime.gsap)}"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${width}px;height:${height}px;overflow:hidden;background:black;font-family:'Noto Sans SC',sans-serif}
#stage{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:black}
#stage .layer0{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:${Z.layer0}}
#stage .fill{position:absolute;inset:0}
#stage .fit{position:absolute;left:50%;top:50%}
</style>
</head>
<body>
<div id="stage" data-composition-id="main" data-start="0" data-duration="${total}" data-width="${width}" data-height="${height}">
${[...layer0, ...transitions.map((part) => part.host), ...overlays, captions, music].filter(Boolean).join('\n')}
</div>
<script>
window.__timelines = window.__timelines || {};
var tl = gsap.timeline({ paused: true });
${scriptJson(tweens)}.forEach(function (t) {
  tl.fromTo("#" + t.target, t.from, Object.assign({}, t.to, { duration: t.duration, ease: t.ease, immediateRender: false }), t.at);
});
tl.set({}, {}, ${total});
window.__timelines["main"] = tl;
</script>
<script src="${escapeAttribute(catalog.runtime.hyperframes)}"></script>
</body>
</html>
`
  return { html, durationMs: totalMs }
}
