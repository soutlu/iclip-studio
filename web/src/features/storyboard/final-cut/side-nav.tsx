import { useState } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { TabsList, TabsTrigger } from '@/shared/ui/tabs'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { Tool } from './editor-toolbar'
import { CATALOG_NAV, type SideTab } from './side-tabs'

type SideNavProps = {
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  /** 有片段选中：「属性」上带一个圆点。 */
  selection: boolean
}

/**
 * 右栏顶上的导航（放在 `TabsRoot` 里）：五个目录页签是双色图标加两字短词，竖线隔开后是「属性」，最右是收起按钮。
 * 收起时整栏缩成一条竖的图标轨，短词只留给读屏，悬停给提示；点哪个页签都展开右栏并切到它。
 */
export function SideNav({ collapsed, onCollapsedChange, selection }: SideNavProps) {
  const expand = () => onCollapsedChange(false)
  return (
    <div className="wf-side-nav">
      <TabsList aria-label="镜头、贴片、场景、配乐、字幕和属性页签" className="wf-side-tabs">
        {CATALOG_NAV.map(({ tab, label, icon }) => (
          <NavTab
            collapsed={collapsed}
            icon={icon}
            key={tab}
            label={label}
            onExpand={expand}
            tab={tab}
          />
        ))}
        <i aria-hidden="true" className="wf-side-sep" />
        <NavTab
          collapsed={collapsed}
          icon="final-cut-properties"
          label="属性"
          onExpand={expand}
          selection={selection}
          tab="props"
        />
      </TabsList>
      <Tool
        className="wf-side-toggle"
        icon={collapsed ? 'final-cut-panel-open' : 'final-cut-panel-close'}
        label={collapsed ? '展开右栏' : '收起右栏'}
        onClick={() => onCollapsedChange(!collapsed)}
        tip={collapsed ? '展开右栏' : '收起右栏，预览更大'}
      />
    </div>
  )
}

function NavTab({
  tab,
  label,
  icon,
  collapsed,
  onExpand,
  selection = false,
}: {
  tab: SideTab
  label: string
  icon: IconName
  collapsed: boolean
  onExpand: () => void
  selection?: boolean
}) {
  const [hint, setHint] = useState(false)
  return (
    // 展开时短词就写在图标下面，只有收成图标轨时才给提示
    <TooltipRoot onOpenChange={setHint} open={collapsed && hint}>
      <TooltipTrigger asChild>
        <TabsTrigger
          className="wf-side-tab after:hidden"
          data-tab={tab}
          // 点当前页签不会切换，收起时也要展开
          onClick={collapsed ? onExpand : undefined}
          value={tab}
        >
          <Icon decorative name={icon} size="md" />
          <span className={cn('wf-side-tab-label', collapsed && 'sr-only')}>{label}</span>
          {selection ? (
            <i aria-hidden="true" className="wf-side-dot" data-testid="selection-dot" />
          ) : null}
        </TabsTrigger>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </TooltipRoot>
  )
}
