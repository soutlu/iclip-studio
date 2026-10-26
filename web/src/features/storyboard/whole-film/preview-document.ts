/**
 * 预览用的合成页：草稿用合成构建（与导出同一份）生成页面，页头加 `<base>` 指向本站的组件目录，
 * 交给播放器的 srcdoc。
 */

import {
  buildComposition,
  CompositionError,
  type CompositionErrorCode,
  type CompositionMedia,
} from './composition/build'
import type { SubtitleRecord } from './composition/captions'
import type { ComponentCatalog } from './composition/catalog'
import { escapeAttribute } from './composition/html'
import type { WholeFilmDraft } from './editing/draft'

/** 组件库这一版在站点上的位置（/hyperframes/<version>/） */
export const componentBaseHref = (origin: string, catalog: ComponentCatalog) =>
  `${origin}/hyperframes/${catalog.version}/`

/** 在合成页的 `<head>` 后面插入 `<base href>`，页里相对组件目录的路径就从那里取 */
export const withBaseHref = (html: string, baseHref: string): string => {
  const head = /<head[^>]*>/i.exec(html)
  if (head === null) throw new Error('合成页没有 <head>')
  const at = head.index + head[0].length
  return `${html.slice(0, at)}\n<base href="${escapeAttribute(baseHref)}">${html.slice(at)}`
}

type MediaSources = {
  /** 素材片的地址（按 sourceJobId）；读不到时为 undefined */
  videoUrl: (sourceJobId: string) => string | undefined
  musicUrl: string | undefined
  /** 每条素材片用的字幕记录：识别完成的记录里最晚建的那条，与导出取的同一条 */
  subtitles: Readonly<Record<string, SubtitleRecord | null | undefined>>
}

/** 草稿引用到的素材地址；读不到地址的不放进去，合成时按缺素材处理 */
export const compositionMedia = (
  draft: WholeFilmDraft,
  { videoUrl, musicUrl, subtitles }: MediaSources,
): CompositionMedia => {
  const videos: Record<string, { url: string }> = {}
  for (const clip of draft.layer0) {
    if (clip.type !== 'video') continue
    const url = videoUrl(clip.sourceJobId)
    if (url !== undefined) videos[clip.sourceJobId] = { url }
  }
  return {
    videos,
    music: draft.music === null || musicUrl === undefined ? null : { url: musicUrl },
    subtitles,
  }
}

export type PreviewState =
  { kind: 'ready'; html: string; durationMs: number } | { kind: 'blocked'; message: string }

const EMPTY_TEXT = '成片里还没有画面；加入视频或组件后可以在这里预览'

const BLOCKED_TEXT: Record<CompositionErrorCode, string> = {
  'unknown-component': '成片里有组件库里没有的组件，暂时无法预览；请删掉它或换一个组件',
  'unknown-font': '成片里有组件库里没有的字体，暂时无法预览；请给用到它的组件或字幕换一个字体',
  'missing-media': '有素材还没读到地址，暂时无法预览；请稍后再试',
  'invalid-draft': EMPTY_TEXT,
}

/** 生成预览页；画面轨还是空的、或草稿合成不了时给出原因（一句话，不带组件 id） */
export const previewState = (
  draft: WholeFilmDraft,
  media: CompositionMedia,
  catalog: ComponentCatalog,
  origin: string,
): PreviewState => {
  if (draft.layer0.length === 0) return { kind: 'blocked', message: EMPTY_TEXT }
  try {
    const { html, durationMs } = buildComposition({ draft, media, catalog })
    return {
      kind: 'ready',
      html: withBaseHref(html, componentBaseHref(origin, catalog)),
      durationMs,
    }
  } catch (error) {
    if (error instanceof CompositionError)
      return { kind: 'blocked', message: BLOCKED_TEXT[error.code] }
    throw error
  }
}
