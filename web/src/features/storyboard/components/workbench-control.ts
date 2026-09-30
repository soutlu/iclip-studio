/** 分镜工作台次级控件的样式配方：顶栏上的按钮同底同圆角，舞台上的按钮另用深色玻璃（`stageActionClass`）；主色只留给出片按钮。
 * 出片栏自有一套 36px 控件，见 storyboard.css 的出片栏一节。 */

import { cva } from 'class-variance-authority'

export const workbenchControl = cva(
  'shrink-0 ui-state rounded-sm bg-surface-container text-body-sm text-on-surface ui-focus disabled:cursor-default disabled:text-disabled-text aria-disabled:cursor-default aria-disabled:text-disabled-text',
  {
    variants: {
      /** label 是带字的按钮，icon 是方形图标按钮。 */
      shape: {
        label: 'inline-flex cursor-pointer items-center gap-1 px-2.5 tabular-nums',
        icon: 'inline-grid cursor-pointer place-items-center',
      },
      /** md 32px 是常规档；sm 28px 只给压在画面上的计数这类小件。 */
      size: { md: '', sm: '' },
    },
    compoundVariants: [
      { shape: 'label', size: 'md', class: 'h-8' },
      { shape: 'label', size: 'sm', class: 'h-7' },
      { shape: 'icon', size: 'md', class: 'size-8' },
      { shape: 'icon', size: 'sm', class: 'size-7' },
    ],
    defaultVariants: { size: 'md' },
  },
)

/** 叠在深色舞台上的玻璃按钮（StageAction、成片信息与下载按钮）：浅深主题都是深底白字。带字时文字包在带
 * `STAGE_ACTION_TEXT` 的 span 里，舞台窄时由 storyboard.css 收起文字、按钮收成方形；不带字就是方形图标按钮。 */
export const stageActionClass = 'storyboard-stage-glass storyboard-stage-tool ui-focus'
export const STAGE_ACTION_TEXT = 'storyboard-action-text'
