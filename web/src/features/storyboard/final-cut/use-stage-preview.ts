import { useMemo, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import type { Framing } from './canvas-settings'
import type { ComponentCatalog } from './component-catalog'
import type { FilmClip } from './composition/film'
import { projectFilesBase, useFinalCutPreviewTokens } from './final-cut.api'
import { translationOf, type ShownLocale } from './locales'
import { previewDocument, previewRuntimeSrc } from './preview-document'
import type { PreviewPageAddress, TextTarget } from './preview-player'
import type { LayerMeasure } from './preview-protocol'
import type { PreviewFilm } from './preview-sync'
import type { FilmView } from './use-film-session'

/** 预览里的各句字幕（见 `PreviewCaptions`）：显示的字是 `locale` 值表里的字，没翻的是原文。 */
const previewCaptionsOf = (clips: readonly FilmClip[], locale: ShownLocale) =>
  new Map(
    clips.flatMap((clip) =>
      clip.kind === 'caption'
        ? [
            [
              clip.id,
              {
                variable: clip.variable,
                text: translationOf(locale.values, clip.variable) ?? clip.text,
              },
            ] as const,
          ]
        : [],
    ),
  )

/**
 * 舞台上的预览：预览页的地址、交给预览页的工程（`film` 没存的改动也在里面，`filesRevision` 变了重新取别的工程文件），
 * 预览按它认层的层表，以及画面编辑层要量的层、量到的结果、原地改字的目标和画面参考线。
 */
export function useStagePreview(
  conversationId: string,
  film: FilmView | null,
  catalog: ComponentCatalog,
  filesRevision: number,
) {
  // 画面参考线配置：仅作用于本次编辑会话，初始全部关闭
  const [framing, setFraming] = useState<Framing>({ grid: 'off', safeArea: false })
  const preview = useFinalCutPreviewTokens(conversationId)
  const previewPage: PreviewPageAddress =
    preview.page !== undefined
      ? { kind: 'ready', origin: preview.page.origin, token: preview.page.token }
      : preview.query.isError
        ? {
            kind: 'failed',
            message: errorMessageOf(preview.query.error, '预览加载失败'),
            onRetry: () => void preview.query.refetch(),
          }
        : { kind: 'pending' }
  const tokens = preview.latest
  // 预览页拿到的就是当前的主文件和字幕场景（没存的改动也在里面），别的工程文件凭最新的令牌从预览域名取，
  // 运行库从预览域名下的组件库取，和预览页同源。怎么换到预览里（打补丁还是整份重新加载）见 previewSync
  const previewFilm = useMemo((): PreviewFilm | undefined => {
    if (film === null || film.clips.length === 0 || tokens === undefined) return undefined
    const scene = film.captionsScene
    return {
      html: previewDocument(
        film.html,
        projectFilesBase(tokens.origin, tokens.token),
        film.locale,
        scene?.content ?? null,
      ),
      runtimeSrc: previewRuntimeSrc(catalog, tokens.origin),
      revision: film.revision,
      step: film.step,
      locale: film.locale.code,
      filesRevision,
      captions:
        scene === null
          ? null
          : {
              path: scene.path,
              scene: scene.content,
              captions: previewCaptionsOf(film.clips, film.locale),
            },
    }
  }, [film, catalog, tokens, filesRevision])

  // 画面上的编辑：预览按层表认层（见 canvas-layers.ts），编辑层要量的层由它自己定
  const layerTable = useMemo(
    () =>
      (film?.layers ?? []).map(({ scope, selector, index, count, host }) => ({
        scope,
        selector,
        index,
        count,
        host,
      })),
    [film?.layers],
  )
  const [watchedLayers, setWatchedLayers] = useState<readonly number[]>([])
  const [layerMeasures, setLayerMeasures] = useState<ReadonlyMap<number, LayerMeasure>>(
    () => new Map(),
  )
  const [textTarget, setTextTarget] = useState<TextTarget | null>(null)
  return {
    framing,
    setFraming,
    previewPage,
    previewFilm,
    layerTable,
    watchedLayers,
    setWatchedLayers,
    layerMeasures,
    setLayerMeasures,
    textTarget,
    setTextTarget,
  }
}
