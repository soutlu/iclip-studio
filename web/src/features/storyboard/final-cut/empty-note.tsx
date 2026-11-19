import type { ReactNode } from 'react'
import { Icon, type IconName } from '@/shared/icons'

/** 侧栏页签里列表还空着、正在读或筛不出东西时的说明：一块浅底，上面是页签的图标，下面是这句话。 */
export function EmptyNote({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <p className="wf-empty" role="status">
      <Icon decorative name={icon} size="md" />
      <span>{children}</span>
    </p>
  )
}
