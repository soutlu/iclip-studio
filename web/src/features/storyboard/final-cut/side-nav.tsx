import { useState } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { TabsList, TabsTrigger } from '@/shared/ui/tabs'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import { Tool } from './editor-toolbar'
import { CATALOG_NAV, type CatalogTab, type SideTab } from './side-tabs'

type SideNavProps = {
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  /** 时间线上已经用上的目录页签（见 `usedTabs`），右上角带圆点。 */
  used: ReadonlySet<CatalogTab>
}

/**
 * 右栏顶部导航（嵌套于 `TabsRoot` 内）：五个目录页签（双色图标与短标签）、分隔线、「属性」页签及右侧收起按钮。
 * 时间线上已经用上的目录页签右上角带圆点，读屏名后面接「，已用」。
 * 收起态下收缩为竖向图标轨，文字标签仅保留给读屏设备并改由 Tooltip 提示；点击任意页签均展开右栏并切换至对应页签。
 */
export function SideNav({ collapsed, onCollapsedChange, used }: SideNavProps) {
  const expand = () => onCollapsedChange(false)
  return (
    <div className="wf-side-nav">
      <TabsList aria-label="镜头、元素、模板、配乐、字幕和属性页签" className="wf-side-tabs">
        {CATALOG_NAV.map(({ tab, label, icon }) => (
          <NavTab
            collapsed={collapsed}
            icon={icon}
            key={tab}
            label={label}
            onExpand={expand}
            tab={tab}
            used={used.has(tab)}
          />
        ))}
        <i aria-hidden="true" className="wf-side-sep" />
        <NavTab
          collapsed={collapsed}
          icon="final-cut-properties"
          label="属性"
          onExpand={expand}
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
  used = false,
}: {
  tab: SideTab
  label: string
  icon: IconName
  collapsed: boolean
  onExpand: () => void
  used?: boolean
}) {
  const [hint, setHint] = useState(false)
  return (
    // 展开态下图标下方已显示文字标签，仅在收起为竖向图标轨时启用 Tooltip
    <TooltipRoot onOpenChange={setHint} open={collapsed && hint}>
      <TooltipTrigger asChild>
        <TabsTrigger
          aria-label={used ? `${label}，已用` : undefined}
          className="wf-side-tab after:hidden"
          data-tab={tab}
          // Radix Tabs 点击当前激活页签不会触发切换，收起态下需显式触发展开
          onClick={collapsed ? onExpand : undefined}
          value={tab}
        >
          <Icon decorative name={icon} size="md" />
          <span className={cn('wf-side-tab-label', collapsed && 'sr-only')}>{label}</span>
          {used ? <i aria-hidden="true" className="wf-side-dot" /> : null}
        </TabsTrigger>
      </TooltipTrigger>
      <TooltipContent side="left">{label}</TooltipContent>
    </TooltipRoot>
  )
}
