import * as z from 'zod'

const zHttpUrl = z.url({ protocol: /^https?$/ })

const MAX_FILM_CHARS = 1_000_000

const zFilm = z.string().min(1).max(MAX_FILM_CHARS)

export const zCheckRequest = z.object({ film: zFilm })

export const zExportRequest = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  film: zFilm,
  /** 成片文件里写的素材地址 → 渲染服务去下载的地址。 */
  media: z.record(z.string(), z.object({ url: zHttpUrl })),
  upload: z.object({ url: zHttpUrl, headers: z.record(z.string(), z.string()) }),
})

export type ExportRequest = z.infer<typeof zExportRequest>

export function parseRequest<T>(
  schema: z.ZodType<T>,
  body: unknown,
): { ok: true; request: T } | { ok: false; message: string } {
  const result = schema.safeParse(body)
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

export function disallowedMediaHosts(urls: readonly string[], allowed: Set<string>): string[] {
  const rejected = urls
    .map((url) => new URL(url).host.toLowerCase())
    .filter((host) => !allowed.has(host))
  return [...new Set(rejected)]
}
