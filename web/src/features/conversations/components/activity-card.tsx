/**
 * 活动卡的壳（mockup 方案 B）：无描边的柔和卡片，卡头（活动组摘要）与每一步一行由调用方放进来。
 * 聊天域还没有软卡 token，暂用看板卡同一组：浅色白底加轻影，深色抬一档底色加极淡边。
 */

import type { ReactNode } from 'react'

export function ActivityCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashboard-card-edge bg-dashboard-card px-3.5 py-3 shadow-[var(--shadow-dashboard-card)]">
      {children}
    </div>
  )
}
