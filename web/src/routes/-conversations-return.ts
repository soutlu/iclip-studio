import { z } from 'zod'
import { conversationsSearchSchema, type ConversationsSearch } from './-conversations-search'

const KEY = 'cue.conversations.return'

const returnMarkSchema = z.object({
  conversationId: z.string().min(1),
  search: conversationsSearchSchema,
})

export const conversationsReturnSearch = (conversationId: string): ConversationsSearch => {
  try {
    const stored = window.sessionStorage.getItem(KEY)
    if (stored === null) return {}
    const mark = returnMarkSchema.safeParse(JSON.parse(stored))
    if (!mark.success || mark.data.conversationId !== conversationId) return {}
    return mark.data.search
  } catch {
    return {}
  }
}

export const rememberReturn = (conversationId: string, search: ConversationsSearch): void => {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify({ conversationId, search }))
  } catch {
    // 忽略浏览器禁用或写满 Web Storage 时抛出的异常。
  }
}
