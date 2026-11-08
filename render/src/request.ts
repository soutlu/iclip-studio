import * as z from 'zod'
import { zSubtitleSentence, zWholeFilmDocument } from '../../web/src/shared/api/generated/zod.gen'

const zHttpUrl = z.url({ protocol: /^https?$/ })

export const zExportRequest = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  document: zWholeFilmDocument,
  media: z.object({
    videos: z.record(z.string(), z.object({ url: zHttpUrl })),
    music: z.object({ url: zHttpUrl }).nullable(),
    subtitles: z.record(
      z.string(),
      z.object({ subtitleJobId: z.string().min(1), sentences: z.array(zSubtitleSentence) }),
    ),
  }),
  upload: z.object({ url: zHttpUrl, headers: z.record(z.string(), z.string()) }),
})

export type ExportRequest = z.infer<typeof zExportRequest>

export function parseExportRequest(
  body: unknown,
): { ok: true; request: ExportRequest } | { ok: false; message: string } {
  const result = zExportRequest.safeParse(body)
  if (result.success) return { ok: true, request: result.data }
  const issue = result.error.issues[0]
  const path = issue?.path.join('.') || '（请求体）'
  return { ok: false, message: `${path}：${issue?.message ?? '格式不对'}` }
}

export function parseAllowedHosts(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  )
}

export function disallowedMediaHosts(request: ExportRequest, allowed: Set<string>): string[] {
  const urls = [
    ...Object.values(request.media.videos).map((video) => video.url),
    ...(request.media.music ? [request.media.music.url] : []),
  ]
  const rejected = urls
    .map((url) => new URL(url).host.toLowerCase())
    .filter((host) => !allowed.has(host))
  return [...new Set(rejected)]
}
