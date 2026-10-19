/**
 * 整片草稿 → HyperFrames 合成页。预览（播放器 srcdoc，页头加 `<base>` 指向组件目录）与导出
 * （渲染服务 `render/` 写进项目目录）共用这一份；纯函数，只返回字符串。
 *
 * 合成页里组件、运行时的路径都相对组件目录根；素材地址原样使用调用方给的。
 */
// 草稿类型取后端合同的生成类型；只导入类型，打包时整行去掉，render/ 用 esbuild 打包不需要解析 @/。
import type { WholeFilmDocument, WholeFilmOverlay } from '@/shared/api/generated'
import type { CatalogItem, ComponentCatalog, VariableValue } from './catalog'
import { captionWords, placeCaptions, type SubtitleRecord } from './captions'
import { escapeAttribute, jsonAttribute, seconds } from './html'

type ComponentVariables = WholeFilmOverlay['variables']

/** 草稿还没定画布（成片轨上没有视频）时的画面尺寸：竖屏 1080×1920。 */
export const DEFAULT_CANVAS = { width: 1080, height: 1920 } as const

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

// 画面叠放次序（HyperFrames 的 data-track-index 只用于显示，叠放靠 z-index）：画面 < 特效 < 字幕。
// 特效块都放在一层盒子里（自成一个叠放上下文），整层压在成片轨之上、字幕之下；层里按各自的
// zIndex 叠，相同时按草稿里的先后（页面上后写的在上），不看 track。
const Z = { layer0: 1, overlay: 2, captions: 3 } as const
const TRACK = { layer0: 0, captions: 2, overlay: 3, music: 4 } as const

function lookup(catalog: ComponentCatalog, name: string): CatalogItem {
  const item = catalog.items.find((candidate) => candidate.name === name)
  if (!item) throw new CompositionError('unknown-component', `组件目录里没有「${name}」`)
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
  /** 页面里的 DOM id。 */
  id: string
  /** 草稿里这一段、这一块的 id，写成 data-hf-id，编辑器在画面上点选时按它认出是哪一块；字幕宿主没有。 */
  hfId?: string
  item: CatalogItem
  startMs: number
  durationMs: number
  /** 从组件自己时间里的这一刻起播（左修剪过的组件片段）。 */
  playbackStartMs: number
  track: number
  z: number
  variables: Record<string, unknown>
  canvas: { width: number; height: number }
}

const round4 = (value: number) => String(Math.round(value * 10000) / 10000)

/**
 * 子合成宿主；按固定尺寸设计的组件外面套一层等比缩放、居中的盒子，整个组件完整放进画面（contain）。
 *
 * 宿主的 data-composition-id 用组件名（组件库文档里的挂载写法）：HyperFrames 只在它与组件根节点的
 * id 一致时把根节点展平进宿主，声明式绑定（data-var-*、--变量）才按宿主取到这一处的取值；
 * 同一组件挂多处时由 HyperFrames 改成各自的 `名称__hfN`。
 *
 * data-hf-id 写在最外层：铺满的写在宿主上，固定尺寸的写在缩放盒子上，画面上挪动它时偏移才是画面像素。
 */
function componentHost(options: HostOptions): string {
  const { id, item, canvas, size } = { ...options, size: options.item.size }
  const hfId = options.hfId === undefined ? '' : ` data-hf-id="${escapeAttribute(options.hfId)}"`
  const host = (extra: string) =>
    `<div id="${id}" data-composition-id="${escapeAttribute(item.name)}"${extra}` +
    ` data-composition-src="${escapeAttribute(item.src)}"` +
    ` data-start="${seconds(options.startMs)}" data-duration="${seconds(options.durationMs)}"` +
    ` data-playback-start="${seconds(options.playbackStartMs)}" data-track-index="${options.track}"` +
    ` data-variable-values="${jsonAttribute(options.variables)}"></div>`
  // 铺满的宿主由页面样式（.fill）定成画面大小：根节点写了 data-width/height 时，HyperFrames 展平时
  // 会把它写到宿主的行内样式上。
  if (!size) return host(` class="fill"${hfId} style="z-index:${options.z}"`)
  const scale = Math.min(canvas.width / size.width, canvas.height / size.height)
  return (
    `<div class="fit"${hfId} style="width:${size.width}px;height:${size.height}px;` +
    `transform:translate(-50%,-50%) scale(${round4(scale)});z-index:${options.z}">${host('')}</div>`
  )
}

/** 组件字体整套字形的 CSS；组件目录给组件列了字体却没有对应 CSS 是目录本身的错。 */
function fontCss(catalog: ComponentCatalog, family: string): string {
  const href = catalog.fonts[family]
  if (!href) throw new Error(`组件目录缺少字体「${family}」的 CSS`)
  return href
}

/**
 * 生成合成页。成片轨为空、组件不在目录里，或草稿引用的素材缺地址时抛出 {@link CompositionError}。
 *
 * 整片时长同 HyperFrames，是所有轨上内容的最远结束：特效块超出成片轨的部分叠在空画面上照样渲染，
 * 音乐也铺到那里。画布还没定（成片轨上只有组件段）时用 {@link DEFAULT_CANVAS}。
 */
export function buildComposition({ draft, media, catalog }: CompositionInput): Composition {
  if (draft.layer0.length === 0) {
    throw new CompositionError('invalid-draft', '成片里还没有画面')
  }
  const canvas = draft.canvas ?? DEFAULT_CANVAS
  const { width, height } = canvas
  const totalMs = Math.max(
    ...[...draft.layer0, ...draft.overlays].map((clip) => clip.start + clip.duration),
  )
  // 页面上用到的组件，按它们的网页字体引用字体 CSS。
  const used = new Set<CatalogItem>()

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
        variables: variableValues(item, clip.variables),
        canvas,
      })
    }
    const source = media.videos[clip.sourceJobId]
    if (!source) throw new CompositionError('missing-media', `成片「${clip.sourceJobId}」没有地址`)
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
      item,
      startMs: overlay.start,
      durationMs: overlay.duration,
      playbackStartMs: overlay.playbackStart,
      track: TRACK.overlay,
      z: overlay.zIndex,
      variables: variableValues(item, overlay.variables),
      canvas,
    })
  })

  const overlayLayer =
    overlays.length === 0 ? '' : `<div class="overlays">\n${overlays.join('\n')}\n</div>`

  const captionItem = lookup(catalog, draft.captions.component)
  // 关掉字幕同 HyperFrames 隐藏轨道：不放字幕宿主，也不引字幕组件的字体
  const words = draft.captions.hidden ? [] : captionWords(placeCaptions(draft, media.subtitles))
  if (words.length > 0) used.add(captionItem)
  const captions =
    words.length === 0
      ? ''
      : componentHost({
          id: 'captions',
          item: captionItem,
          startMs: 0,
          durationMs: totalMs,
          playbackStartMs: 0,
          track: TRACK.captions,
          z: Z.captions,
          variables: { ...variableValues(captionItem, {}), words },
          canvas,
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
#stage .fill{position:absolute;inset:0;width:100%!important;height:100%!important}
#stage .fit{position:absolute;left:50%;top:50%}
#stage .overlays{position:absolute;inset:0;z-index:${Z.overlay}}
</style>
</head>
<body>
<div id="stage" data-composition-id="main" data-start="0" data-duration="${total}" data-width="${width}" data-height="${height}">
${[...layer0, overlayLayer, captions, music].filter(Boolean).join('\n')}
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
