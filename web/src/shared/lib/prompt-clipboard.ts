import { z } from 'zod'
import { zImageContent, zTextContent, zVideoContent } from '@/shared/api/generated/zod.gen'
import type { PromptContentPart } from '@/shared/transcript/vendor'

const contentPartSchema = z.union([zTextContent, zImageContent, zVideoContent])

export const serializePromptContent = (content: readonly PromptContentPart[]): string =>
  JSON.stringify(content, null, 2)

export const parsePromptContent = (text: string): PromptContentPart[] | null => {
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(payload) || payload.length === 0) return null
  const parts: PromptContentPart[] = []
  for (const item of payload) {
    const part = contentPart(item)
    if (part === null) return null
    parts.push(part)
  }
  return parts
}

const contentPart = (raw: unknown): PromptContentPart | null => {
  if (typeof raw !== 'object' || raw === null || !('type' in raw)) return null
  const parsed = contentPartSchema.safeParse(raw)
  if (!parsed.success) return null
  const part = parsed.data
  if (part.type === 'text') return { text: part.text, type: 'text' }
  const { kind, url } = part.source
  if (kind !== 'url' || typeof url !== 'string' || url === '') return null
  return { source: { kind: 'url', url }, type: part.type }
}
