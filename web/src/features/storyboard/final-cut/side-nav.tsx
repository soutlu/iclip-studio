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
  /** 是否存在选中片段；为真时在「属性」页签上展示指示圆点。 */
  selection: boolean
}

/**
 * 右栏顶部导航（嵌套于 `TabsRoot` 内）：五个目录页签（双色图标与短标签）、分隔线、「属性」页签及右侧收起按钮。
 * 收起态下收缩为竖向图标轨，文字标签仅保留给读屏设备并改由 Tooltip 提示；点击任意页签均展开右栏并切换至对应页签。
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
        tip={collapsed ? '展开右栏' : '收起右栏，扩大预览区'}
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
    // 展开态下图标下方已显示文字标签，仅在收起为竖向图标轨时启用 Tooltip
    <TooltipRoot onOpenChange={setHint} open={collapsed && hint}>
      <TooltipTrigger asChild>
        <TabsTrigger
          className="wf-side-tab after:hidden"
          data-tab={tab}
          // Radix Tabs 点击当前激活页签不会触发切换，收起态下需显式触发展开
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
