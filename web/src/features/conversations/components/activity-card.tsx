import type { ReactNode } from 'react'

export function ActivityCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-chat-soft-card-edge bg-chat-soft-card px-3.5 py-3 shadow-[var(--shadow-chat-soft-card)]">
      {children}
    </div>
  )
}
