/**
 * 活动卡的壳（mockup 方案 B）：无描边的柔和卡片，卡头（活动组摘要）与每一步一行由调用方放进来。
 * 底色、边与阴影用聊天域自己的 chat-soft-card 一组 token，与看板卡互不牵连。
 */

import type { ReactNode } from 'react'

export function ActivityCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-chat-soft-card-edge bg-chat-soft-card px-3.5 py-3 shadow-[var(--shadow-chat-soft-card)]">
      {children}
    </div>
  )
}
