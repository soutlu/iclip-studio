/** 品牌模板按正文第一段的实测画幅筛选；模板快照用于预览，当前列表决定能否再次提交。 */
import { skipToken, useQuery } from '@tanstack/react-query'
import type { BrandTemplate } from '@/shared/api/brand-templates'
import { UserFacingError } from '@/shared/api/client'
import type { FilmBrand, FilmState } from './film-draft'

export type FilmDimensions = { width: number; height: number }

export const matchesFilmRatio = (template: FilmDimensions, frame: FilmDimensions): boolean =>
  Math.abs(template.width / template.height / (frame.width / frame.height) - 1) <= 0.02 + 1e-9

export type VideoBrandTemplate = BrandTemplate & {
  kind: 'intro' | 'outro'
  width: number
  height: number
  durationMs: number
  hasAudio: boolean
}

/** 资源表允许扩展类型与空参数，只有完整的视频资源可进入时间线。 */
export const isVideoTemplate = (template: BrandTemplate): template is VideoBrandTemplate =>
  (template.kind === 'intro' || template.kind === 'outro') &&
  template.width !== null &&
  template.width > 0 &&
  template.height !== null &&
  template.height > 0 &&
  template.durationMs !== null &&
  template.durationMs > 0 &&
  template.hasAudio !== null

export const videoTemplateReason = (template: BrandTemplate): string | undefined =>
  template.disabledAt !== null
    ? '模板已停用'
    : !isVideoTemplate(template)
      ? '视频参数不完整，无法使用；请联系管理员补充'
      : undefined

export const brandOf = (template: VideoBrandTemplate): FilmBrand => ({
  templateId: template.id,
  name: template.name,
  url: template.url,
  durationMs: template.durationMs,
  width: template.width,
  height: template.height,
  hasAudio: template.hasAudio,
})

export const templateBlockedReason = (
  film: FilmState,
  templates: readonly BrandTemplate[] | undefined,
  frame: FilmDimensions | undefined,
): string | undefined => {
  for (const position of ['intro', 'outro'] as const) {
    const selected = film[position]
    if (selected == null) continue
    const label = position === 'intro' ? '片头' : '片尾'
    if (templates === undefined) return '模板信息尚未读取，暂时无法合成；请等待或重试读取'
    const current = templates.find((template) => template.id === selected.templateId)
    if (current === undefined || current.disabledAt !== null || current.kind !== position)
      return `${label}模板已停用或不可用，无法合成；请更换或删除${label}`
    if (!isVideoTemplate(current)) return `${label}视频参数不完整，无法合成；请更换或删除${label}`
    if (frame === undefined) return '正文画幅尚未读取，暂时无法核对片头片尾；请等待或重试读取'
    if (!matchesFilmRatio(current, frame))
      return `${label}与正文画幅不匹配，无法合成；请更换或删除${label}`
  }
  return undefined
}

/** 视频记录没有宽高字段，使用媒体元数据量第一段；失败明确给重试，不用请求里的比例猜测。 */
export const useFilmDimensions = (url: string | undefined) =>
  useQuery({
    queryKey: ['whole-film', 'dimensions', url],
    queryFn:
      url === undefined
        ? skipToken
        : ({ signal }) =>
            new Promise<FilmDimensions>((resolve, reject) => {
              const video = document.createElement('video')
              const cleanup = () => {
                video.onloadedmetadata = null
                video.onerror = null
                signal.removeEventListener('abort', abort)
                video.removeAttribute('src')
                video.load()
              }
              const abort = () => {
                cleanup()
                reject(new DOMException('Aborted', 'AbortError'))
              }
              video.preload = 'metadata'
              video.muted = true
              video.onloadedmetadata = () => {
                const { videoWidth: width, videoHeight: height } = video
                cleanup()
                if (width > 0 && height > 0) resolve({ width, height })
                else reject(new UserFacingError('正文画幅读取失败'))
              }
              video.onerror = () => {
                cleanup()
                reject(new UserFacingError('正文画幅读取失败'))
              }
              signal.addEventListener('abort', abort, { once: true })
              if (signal.aborted) abort()
              else video.src = url
            }),
    staleTime: Infinity,
    retry: false,
  })
