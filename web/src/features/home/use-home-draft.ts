import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComposerPart } from '@/shared/ui/composer'
import { toast } from '@/shared/ui/toast'
import {
  composerPartsOf,
  draftPartsOf,
  EMPTY_HOME_DRAFT,
  HOME_DRAFT_KEY,
  loadHomeDraft,
  type HomeDraft,
} from './home-draft'

const READ_FAILED = '首页草稿读取失败，请重新输入创作要求'
const WRITE_FAILED = '输入内容暂存失败，离开首页或登录前请先复制输入内容'
const CLEAR_FAILED = '消息已发送，首页草稿清理失败，请回到首页后清空输入框'

export type HomeDraftStore = {
  initialParts: readonly ComposerPart[]
  agentId: string | null
  collectionId: string | null
  chooseAgent: (id: string | null) => void
  chooseCollection: (id: string | null) => void
  saveParts: (parts: readonly ComposerPart[]) => void
  clear: () => void
}

export function useHomeDraft(userId: string | undefined): HomeDraftStore {
  const [initial] = useState(() => {
    try {
      return { draft: loadHomeDraft(), readFailed: false }
    } catch {
      return { draft: EMPTY_HOME_DRAFT, readFailed: true }
    }
  })
  const [initialParts] = useState(() => composerPartsOf(initial.draft.parts))
  const [agent, setAgent] = useState(initial.draft.agent)
  const [collection, setCollection] = useState(initial.draft.collection)
  const draftRef = useRef<HomeDraft>(initial.draft)
  const writeFailedRef = useRef(false)

  const write = useCallback((draft: HomeDraft) => {
    draftRef.current = draft
    try {
      sessionStorage.setItem(HOME_DRAFT_KEY, JSON.stringify(draft))
    } catch {
      if (!writeFailedRef.current) toast.error(WRITE_FAILED)
      writeFailedRef.current = true
    }
  }, [])

  useEffect(() => {
    if (!initial.readFailed) return
    toast.error(READ_FAILED, { id: READ_FAILED })
    write(EMPTY_HOME_DRAFT)
  }, [initial.readFailed, write])

  useEffect(() => {
    const current = draftRef.current
    if (current.agent === agent && current.collection === collection) return
    write({ ...current, agent, collection })
  }, [agent, collection, write])

  return {
    agentId: agent !== null && agent.ownerUserId === userId ? agent.id : null,
    chooseAgent: (id) => setAgent(id === null ? null : { id, ownerUserId: userId ?? null }),
    chooseCollection: (id) => setCollection({ id, ownerUserId: userId ?? null }),
    clear: () => {
      draftRef.current = { ...draftRef.current, parts: [] }
      try {
        sessionStorage.removeItem(HOME_DRAFT_KEY)
      } catch {
        toast.error(CLEAR_FAILED)
      }
    },
    collectionId: collection !== null && collection.ownerUserId === userId ? collection.id : null,
    initialParts,
    saveParts: (parts) => {
      const next = draftPartsOf(parts)
      if (JSON.stringify(next) === JSON.stringify(draftRef.current.parts)) return
      write({ ...draftRef.current, parts: next })
    },
  }
}
