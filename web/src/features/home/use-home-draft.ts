/** 首页草稿：挂载时读一次，之后边改边存到 sessionStorage；回到首页照常恢复，发送成功后由调用方删掉。 */

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
  /** 挂载时读到的输入框内容，之后不变；附件已按公网地址重建。 */
  initialParts: readonly ComposerPart[]
  /** 当前登录人选的创作助手；没选过或是别人选的为 null。 */
  agentId: string | null
  /** 当前登录人选的合集；没选过、选了不关联或是别人选的为 null。 */
  collectionId: string | null
  chooseAgent: (id: string | null) => void
  chooseCollection: (id: string | null) => void
  /** 接输入框的 onChange：只存就绪的附件，可存的部分没变时不写。 */
  saveParts: (parts: readonly ComposerPart[]) => void
  /** 发送成功后删掉草稿；不动界面上的选择。 */
  clear: () => void
}

/** `userId` 是当前登录人，未登录或身份未定时为 undefined；选择按它记属主，换了人就不算数。 */
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
  // 正文变化频繁，只进 ref 不触发重渲染；写入时与选择拼成一整份。
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

  // 读坏的草稿换成空白，下次回到首页不再提示；固定 id 让开发模式下 effect 跑两遍也只弹一条。
  useEffect(() => {
    if (!initial.readFailed) return
    toast.error(READ_FAILED, { id: READ_FAILED })
    write(EMPTY_HOME_DRAFT)
  }, [initial.readFailed, write])

  // 选择变了才连同当前正文写一次：挂载与发送后删掉草稿都不写回。
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
      // 可存的部分没变就不写：发送成功后输入框清空也会通知一次，那时草稿已删，空内容不写回；
      // 附件还在上传时同理。
      const next = draftPartsOf(parts)
      if (JSON.stringify(next) === JSON.stringify(draftRef.current.parts)) return
      write({ ...draftRef.current, parts: next })
    },
  }
}
