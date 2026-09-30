/** 活动卡的壳：一圈发丝边，每一步一行、行间发丝线；卡头（活动组摘要）与行内容由调用方放进来。 */

import type { ReactNode } from 'react'

/** 卡片裁掉溢出好让卡头底色贴合圆角；ui-focus-inline 把卡内焦点环收到控件里面，不被裁掉。 */
export function ActivityCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col divide-y-[0.5px] divide-chat-hairline overflow-hidden rounded-md border-[0.5px] border-chat-hairline ui-focus-inline">
      {children}
    </div>
  )
}

/** 卡里的一步；行间分隔由外层负责，这里只管内边距。 */
export function ActivityStep({ children }: { children: ReactNode }) {
  return <div className="px-3 py-0.5">{children}</div>
}
