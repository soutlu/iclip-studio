import * as z from 'zod'
import { EXPORT_TIERS } from '../../web/src/features/storyboard/final-cut/composition/export-resolution'

const zHttpUrl = z.url({ protocol: /^https?$/ })

/** 单个工程文件的内容长度上限（与工作区单文件 1 MB 限制一致）。 */
const MAX_FILE_CHARS = 1_048_576

const MAX_PATH_CHARS = 1024

export const zExportRequest = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  /** final-cut 工程文本文件列表，路径相对工程根目录，校验规则见 project.ts。 */
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(MAX_PATH_CHARS),
        content: z.string().max(MAX_FILE_CHARS),
      }),
    )
    .min(1),
  /** 主文件中引用的素材地址到渲染服务下载地址的映射。 */
  media: z.record(z.string(), z.object({ url: zHttpUrl })),
  /** 目标导出语言（规则见 locale.ts）；省略或为 null 时导出原文。 */
  locale: z.enum(['zh', 'en', 'de', 'es', 'fr']).nullish(),
  /** 导出分辨率档位（规则见 resolution.ts）；省略或为 null 时按画面尺寸导出。 */
  resolution: z.enum(EXPORT_TIERS).nullish(),
  upload: z.object({ url: zHttpUrl, headers: z.record(z.string(), z.string()) }),
})

export type ExportRequest = z.infer<typeof zExportRequest>

/** final-cut 支持扩展的目标语言（不含原文）。 */
export type ExportLocale = NonNullable<ExportRequest['locale']>

export function parseRequest<T>(
  schema: z.ZodType<T>,
  body: unknown,
): { ok: true; request: T } | { ok: false; message: string } {
  const result = schema.safeParse(body)
  if (result.success) return { ok: true, request: result.data }
  const issue = result.error.issues[0]
  const path = issue?.path.join('.') || '（请求体）'
  return { ok: false, message: `${path}：${issue?.message ?? '格式不正确'}` }
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
