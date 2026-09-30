/** 分镜工作台次级控件的唯一样式配方：顶栏、舞台与出片栏上的按钮和下拉同底同圆角；主色只留给出片按钮。 */

import { cva } from 'class-variance-authority'
import { cn } from '@/shared/lib/utils'

export const workbenchControl = cva(
  'shrink-0 ui-state rounded-sm bg-surface-container text-body-sm text-on-surface ui-focus disabled:cursor-default disabled:text-disabled-text aria-disabled:cursor-default aria-disabled:text-disabled-text',
  {
    variants: {
      /** field 是原生下拉（右侧留给箭头），label 是带字的按钮，icon 是方形图标按钮。 */
      shape: {
        field: 'pr-6 pl-2.5',
        label: 'inline-flex cursor-pointer items-center gap-1 px-2.5 tabular-nums',
        icon: 'inline-grid cursor-pointer place-items-center',
      },
      /** md 32px 是常规档；sm 28px 只给压在画面上的计数这类小件。 */
      size: { md: '', sm: '' },
    },
    compoundVariants: [
      { shape: ['field', 'label'], size: 'md', class: 'h-8' },
      { shape: ['field', 'label'], size: 'sm', class: 'h-7' },
      { shape: 'icon', size: 'md', class: 'size-8' },
      { shape: 'icon', size: 'sm', class: 'size-7' },
    ],
    defaultVariants: { size: 'md' },
  },
)

/** 舞台操作行的带字按钮（StageAction 与操作行里的下载按钮）：文字包在带 `STAGE_ACTION_TEXT` 的 span 里，
 * 操作行窄时由 storyboard.css 收起文字、按钮收成方形。 */
export const stageActionClass = cn(workbenchControl({ shape: 'label' }), 'storyboard-action')
export const STAGE_ACTION_TEXT = 'storyboard-action-text'
