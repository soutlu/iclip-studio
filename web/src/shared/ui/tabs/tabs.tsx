import { cva } from 'class-variance-authority'
import { Tabs } from 'radix-ui'
import { createContext, use, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import { SEGMENTED_ITEM, SEGMENTED_TRACK } from '@/shared/ui/segmented'

export const TabsRoot = Tabs.Root

/**
 * 页签内容区。移除 Radix 默认的 `tabindex=0` 使容器本身不可聚焦：从页签按 Tab 时焦点直接进入内部首个交互控件，
 * 点击空白区域时也不会在整块内容区上触发焦点环。
 */
export function TabsContent(
  props: Omit<ComponentPropsWithoutRef<typeof Tabs.Content>, 'tabIndex'>,
) {
  return <Tabs.Content {...props} tabIndex={undefined} />
}

/** `underline`：选中项底部显示下划线（默认）；`segmented`：凹槽分段控件，选中项呈现浮起白卡样式。 */
type TabsVariant = 'underline' | 'segmented'

// 变体仅在 TabsList 上指定，内部 TabsTrigger 通过 Context 自动继承
const TabsVariantContext = createContext<TabsVariant>('underline')

const listVariants = cva('flex min-w-0', {
  variants: {
    variant: {
      underline: 'items-stretch gap-1',
      // 材质见 SEGMENTED_TRACK，另在槽内圈加一道细线；页签不收缩，宽度不足时在凹槽内裁切溢出部分
      segmented: [
        SEGMENTED_TRACK,
        'h-8 items-center gap-0.5 overflow-clip p-0.5 inset-ring inset-ring-panel-line',
      ],
    },
  },
})

export function TabsList({
  className,
  variant = 'underline',
  ...props
}: ComponentPropsWithoutRef<typeof Tabs.List> & { variant?: TabsVariant }) {
  return (
    <TabsVariantContext value={variant}>
      <Tabs.List className={cn(listVariants({ variant }), className)} {...props} />
    </TabsVariantContext>
  )
}

const triggerVariants = cva(
  // design-allow -- Radix 通过 .focus() 切换高亮，需屏蔽浏览器默认轮廓以免与 ui-focus 焦点环重叠
  'relative flex min-w-0 cursor-pointer items-center ui-focus ui-motion-s outline-none select-none hover:text-on-surface data-[state=active]:text-on-surface',
  {
    variants: {
      variant: {
        underline: [
          'rounded-xs px-2 text-body text-on-surface-variant data-[state=active]:font-medium',
          'after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-on-surface after:opacity-0 after:transition-opacity after:duration-(--dur-s) data-[state=active]:after:opacity-100',
        ],
        // 材质见 SEGMENTED_ITEM；外槽启用裁切，焦点环通过负偏移向内绘制
        segmented: [
          'h-7 shrink-0 px-3 transition-[color,background-color,box-shadow] [--state-focus-offset:calc(var(--state-focus-ring)*-1)]',
          SEGMENTED_ITEM,
        ],
      },
    },
  },
)

/** `leading` / `trailing` 渲染于标题前后且不参与文本截断（例如状态标记、可关闭页签的关闭图标）。 */
export function TabsTrigger({
  children,
  className,
  leading,
  trailing,
  ...props
}: ComponentPropsWithoutRef<typeof Tabs.Trigger> & { leading?: ReactNode; trailing?: ReactNode }) {
  const variant = use(TabsVariantContext)
  return (
    <Tabs.Trigger className={cn(triggerVariants({ variant }), className)} {...props}>
      {leading}
      <span className="min-w-0 truncate">{children}</span>
      {trailing}
    </Tabs.Trigger>
  )
}
