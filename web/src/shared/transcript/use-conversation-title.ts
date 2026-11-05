import { use, useEffect, useSyncExternalStore } from 'react'
import type { TranscriptConnection } from './connection'
import { fetchConversationTitle } from './transcript.api'
import { TranscriptConnectionContext } from './transcript-context'

interface TitleRead {
  controller: AbortController
  overtaken: boolean
}

class ConversationTitles {
  private readonly titles = new Map<string, string>()
  private readonly held = new Map<string, number>()
  private readonly reads = new Map<string, TitleRead>()
  private readonly listeners = new Set<() => void>()

  constructor(connection: TranscriptConnection) {
    connection.watchSessions((update) => {
      if (update.kind === 'reconnected') {
        for (const conversationId of this.held.keys()) void this.reread(conversationId)
        return
      }
      if (update.kind !== 'title') return
      const read = this.reads.get(update.conversationId)
      if (read !== undefined) read.overtaken = true
      this.set(update.conversationId, update.title)
    })
  }

  get(conversationId: string): string | undefined {
    return this.titles.get(conversationId)
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  hold(conversationId: string): () => void {
    this.held.set(conversationId, (this.held.get(conversationId) ?? 0) + 1)
    return () => {
      const count = (this.held.get(conversationId) ?? 0) - 1
      if (count > 0) {
        this.held.set(conversationId, count)
        return
      }
      this.held.delete(conversationId)
    }
  }

  private async reread(conversationId: string): Promise<void> {
    this.reads.get(conversationId)?.controller.abort()
    const read: TitleRead = { controller: new AbortController(), overtaken: false }
    this.reads.set(conversationId, read)
    try {
      const title = await fetchConversationTitle(conversationId, read.controller.signal)
      if (this.reads.get(conversationId) === read && !read.overtaken)
        this.set(conversationId, title)
    } catch {
      if (this.reads.get(conversationId) === read)
        console.warn('补读对话标题失败', { conversationId })
    } finally {
      if (this.reads.get(conversationId) === read) this.reads.delete(conversationId)
    }
  }

  private set(conversationId: string, title: string): void {
    if (this.titles.get(conversationId) === title) return
    this.titles.set(conversationId, title)
    for (const listener of this.listeners) listener()
  }
}

const stores = new WeakMap<TranscriptConnection, ConversationTitles>()

const titlesOf = (connection: TranscriptConnection): ConversationTitles => {
  let store = stores.get(connection)
  if (store === undefined) {
    store = new ConversationTitles(connection)
    stores.set(connection, store)
  }
  return store
}

export const useConversationTitle = (conversationId: string, baseline: string): string => {
  const connection = use(TranscriptConnectionContext)
  if (connection === null) throw new Error('useConversationTitle 要在 TranscriptProvider 里用')
  const titles = titlesOf(connection)

  useEffect(() => titles.hold(conversationId), [conversationId, titles])

  return useSyncExternalStore(titles.subscribe, () => titles.get(conversationId)) ?? baseline
}
