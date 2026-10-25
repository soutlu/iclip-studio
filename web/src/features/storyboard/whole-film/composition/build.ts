/**
 * 成片草稿 → HyperFrames 合成页。预览（播放器 srcdoc，页头加 `<base>` 指向组件目录）与导出
 * （渲染服务 `render/` 写进项目目录）共用这一份；纯函数，只返回字符串。
 *
 * 合成页里组件、运行时的路径都相对组件目录根；素材地址原样使用调用方给的。
 */
// 草稿类型取后端合同的生成类型；只导入类型，打包时整行去掉，render/ 用 esbuild 打包不需要解析 @/。
import type { WholeFilmCaptions, WholeFilmDocument, WholeFilmOverlay } from '@/shared/api/generated'
import type { CatalogItem, ComponentCatalog, VariableValue } from './catalog'
import { captionWords, placeCaptions, type SubtitleRecord } from './captions'
import { escapeAttribute, jsonAttribute, seconds } from './html'

type ComponentVariables = WholeFilmOverlay['variables']

/** 草稿还没定画布（画面轨上没有视频）时的画面尺寸：竖屏 1080×1920。 */
export const DEFAULT_CANVAS = { width: 1080, height: 1920 } as const

export interface CompositionMedia {
  /** 按 `sourceJobId`：素材片地址。 */
  videos: Readonly<Record<string, { url: string }>>
  /** 草稿里配乐的地址；没有配乐时为 null。 */
  music: { url: string } | null
  /** 按 `sourceJobId`：这条素材片的字幕记录；没有识别结果时缺省或为 null。 */
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
  /** 草稿引用的素材片或配乐没有给出地址。 */
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
// 特效块都放在一层盒子里（自成一个叠放上下文），整层压在画面轨之上、字幕之下；层里按各自的
// zIndex 叠，相同时按草稿里的先后（页面上后写的在上），不看 track。
const Z = { layer0: 1, overlay: 2, captions: 3 } as const

/** 字幕外层（.place）的 data-hf-id：全部字幕在画面上整体拖动时按它找到这层；每一句另有 `caption:N` */
export const CAPTIONS_HF_ID = 'captions'
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
  /**
   * 草稿里这一段、这一块的 id，写成 data-hf-id，编辑器在画面上点选、拖动时按它认出是哪一块；
   * 字幕写 `captions`。
   */
  hfId: string
  /**
   * 特效块与字幕在画面上的位置、缩放与旋转；给了就在宿主外面包一层 {@link placed}。画面轨上的
   * 组件段没有，宿主直接写 data-hf-id 与 z-index
   */
  placement?: Placement
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

/** 草稿里特效块、字幕的位置与变换；有这些字段之前存的草稿没写，按没挪、原大、不转算 */
type Placement = Pick<WholeFilmOverlay, 'x' | 'y' | 'scale' | 'rotation' | 'pivotX' | 'pivotY'>

/** 转轴可以是 undefined 的一块：按合同的 zod 校验出来的形状 */
type LoosePivot<T> = Omit<T, 'pivotX' | 'pivotY'> & {
  pivotX?: number | null | undefined
  pivotY?: number | null | undefined
}

/** 按合同的 zod 校验出来的草稿 */
type ParsedDocument = Omit<WholeFilmDocument, 'captions' | 'overlays'> & {
  captions: LoosePivot<WholeFilmCaptions>
  overlays: LoosePivot<WholeFilmOverlay>[]
}

/**
 * 按合同的 zod 校验过的草稿 → 生成类型的草稿（{@link buildComposition} 与编辑器收的）。合同里特效块与
 * 字幕的转轴可以不写（取画面中心），zod 解析结果的类型因此带 undefined，生成的类型不带；这里补成
 * null，同服务端发出的草稿，其余原样。
 */
export function withPivots(document: ParsedDocument): WholeFilmDocument {
  const filled = <T extends LoosePivot<object>>(placed: T) => ({
    ...placed,
    pivotX: placed.pivotX ?? null,
    pivotY: placed.pivotY ?? null,
  })
  return {
    ...document,
    captions: filled(document.captions),
    overlays: document.overlays.map(filled),
  }
}

const round4 = (value: number) => String(Math.round(value * 10000) / 10000)

/**
 * 在画面上挪开的位置，写成 HyperFrames 位置编辑的属性：`data-x`/`data-y` 减去基准
 * `data-hf-edit-base-x/y`（我们的基准总是 0）就是挪开的画面像素，预览的运行时与导出时 producer
 * 注入的脚本都按它在这个元素上加一层 CSS `translate`。没挪过（都是 0）时不写，页面与有位置之前一样。
 */
function positionAttributes(placement: Placement): string {
  const x = placement.x ?? 0
  const y = placement.y ?? 0
  if (x === 0 && y === 0) return ''
  return ` data-x="${x}" data-y="${y}" data-hf-edit-base-x="0" data-hf-edit-base-y="0"`
}

/**
 * 缩放与旋转写成 CSS 的 `rotate`、`scale`，绕转轴（画面像素，没记时取画面中心）；没缩放也没旋转
 * 时不写。CSS 按 translate → rotate → scale 的次序合成这几个属性，HyperFrames 的位置是 `translate`，
 * 转轴因此是挪开之前的坐标。
 */
function transformStyle(placement: Placement, canvas: HostOptions['canvas']): string {
  const scale = placement.scale ?? 1
  const rotation = placement.rotation ?? 0
  if (scale === 1 && rotation === 0) return ''
  const px = placement.pivotX ?? canvas.width / 2
  const py = placement.pivotY ?? canvas.height / 2
  return `;rotate:${rotation}deg;scale:${scale};transform-origin:${px}px ${py}px`
}

/**
 * 铺满画面的普通 div（.place）：data-hf-id、位置（data-x/y）、缩放、旋转与叠放次序都写在这层，
 * 组件宿主本身不变换，同 HyperFrames。没缩放、没旋转时只多这一层。
 */
function placed(options: HostOptions, placement: Placement, inner: string): string {
  return (
    `<div class="place" data-hf-id="${escapeAttribute(options.hfId)}"${positionAttributes(placement)}` +
    ` style="z-index:${options.z}${transformStyle(placement, options.canvas)}">${inner}</div>`
  )
}

/**
 * 子合成宿主；按固定尺寸设计的组件外面套一层等比缩放、居中的盒子，整个组件完整放进画面（contain）。
 *
 * 宿主的 data-composition-id 用组件名（组件库文档里的挂载写法）：HyperFrames 只在它与组件根节点的
 * id 一致时把根节点展平进宿主，声明式绑定（data-var-*、--变量）才按宿主取到这一处的取值；
 * 同一组件挂多处时由 HyperFrames 改成各自的 `名称__hfN`。
 *
 * 特效块与字幕外面再包一层 {@link placed}，data-hf-id 写在那层；画面轨上的组件段写在最外层：
 * 铺满的写在宿主上，固定尺寸的写在缩放盒子上。
 */
function componentHost(options: HostOptions): string {
  const { id, item, canvas, size, placement } = { ...options, size: options.item.size }
  const host = (extra: string) =>
    `<div id="${id}" data-composition-id="${escapeAttribute(item.name)}"${extra}` +
    ` data-composition-src="${escapeAttribute(item.src)}"` +
    ` data-start="${seconds(options.startMs)}" data-duration="${seconds(options.durationMs)}"` +
    ` data-playback-start="${seconds(options.playbackStartMs)}" data-track-index="${options.track}"` +
    ` data-variable-values="${jsonAttribute(options.variables)}"></div>`
  // marks：写在最外层的 data-hf-id；z：叠放次序，接在最外层的行内样式后面
  const box = (marks: string, z: string) => {
    // 铺满的宿主由页面样式（.fill）定成画面大小：根节点写了 data-width/height 时，HyperFrames
    // 展平时会把它写到宿主的行内样式上。
    if (!size) return host(` class="fill"${marks}${z === '' ? '' : ` style="${z}"`}`)
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

/** 组件字体整套字形的 CSS；组件目录给组件列了字体却没有对应 CSS 是目录本身的错。 */
function fontCss(catalog: ComponentCatalog, family: string): string {
  const href = catalog.fonts[family]
  if (!href) throw new Error(`组件目录缺少字体「${family}」的 CSS`)
  return href
}

/**
 * 生成合成页。画面轨为空、组件不在目录里，或草稿引用的素材缺地址时抛出 {@link CompositionError}。
 *
 * 成片时长同 HyperFrames，是所有轨上内容的最远结束：特效块超出画面轨的部分叠在空画面上照样渲染，
 * 音乐也铺到那里。画布还没定（画面轨上只有组件段）时用 {@link DEFAULT_CANVAS}。
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
          hfId: CAPTIONS_HF_ID,
          placement: draft.captions,
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
  // .place 与 .fill 宿主一样是透明铺满的一层，不设 pointer-events:none：它会传给组件内容
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
#stage .place{position:absolute;inset:0}
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
