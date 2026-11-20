import { cva } from 'class-variance-authority'
import { Tabs } from 'radix-ui'
import { createContext, use, type ComponentPropsWithoutRef } from 'react'
import { cn } from '@/shared/lib/utils'

export const TabsRoot = Tabs.Root
export const TabsContent = Tabs.Content

/** underline：选中格下面一道横线（默认）；segmented：凹槽里的分段胶囊，选中格浮起成白色小卡。 */
type TabsVariant = 'underline' | 'segmented'

// 样式只在 TabsList 上选一次，里面的 TabsTrigger 跟着它走
const TabsVariantContext = createContext<TabsVariant>('underline')

const listVariants = cva('flex min-w-0', {
  variants: {
    variant: {
      underline: 'items-stretch gap-1',
      segmented:
        'h-8 items-center gap-0.5 rounded-control bg-surface-container-high p-0.75 shadow-[var(--shadow-control-well),inset_0_0_0_1px_var(--color-panel-line)]',
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
  // design-allow -- Radix 用 .focus() 移动高亮，浏览器默认框会和 ui-focus 的焦点环叠一起
  'relative flex min-w-0 cursor-pointer items-center ui-focus ui-motion-s outline-none select-none hover:text-on-surface data-[state=active]:text-on-surface',
  {
    variants: {
      variant: {
        underline: [
          'rounded-xs px-2 text-body text-on-surface-variant data-[state=active]:font-medium',
          'after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-on-surface after:opacity-0 after:transition-opacity after:duration-(--dur-s) data-[state=active]:after:opacity-100',
        ],
        // 圆角比外槽小一圈：外槽圆角减去外槽内边距 3px，两层弧线同心
        segmented:
          'h-6.5 rounded-[calc(var(--radius-control)-3px)] px-3 text-label font-medium text-on-surface-muted transition-[color,background-color,box-shadow] data-[state=active]:bg-card data-[state=active]:font-semibold data-[state=active]:shadow-[var(--shadow-pill),var(--shadow-specular)]',
      },
    },
  },
)

export function TabsTrigger({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<typeof Tabs.Trigger>) {
  const variant = use(TabsVariantContext)
  return (
    <Tabs.Trigger className={cn(triggerVariants({ variant }), className)} {...props}>
      <span className="min-w-0 truncate">{children}</span>
    </Tabs.Trigger>
  )
}
