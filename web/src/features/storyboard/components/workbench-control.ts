import { cva } from 'class-variance-authority'

export const workbenchControl = cva(
  'shrink-0 ui-state rounded-sm bg-surface-container text-body-sm text-on-surface ui-focus disabled:cursor-default disabled:text-disabled-text aria-disabled:cursor-default aria-disabled:text-disabled-text',
  {
    variants: {
      shape: {
        label: 'inline-flex cursor-pointer items-center gap-1 px-2.5 tabular-nums',
        icon: 'inline-grid cursor-pointer place-items-center',
      },
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

export const stageActionClass = 'storyboard-stage-glass storyboard-stage-tool ui-focus'
export const STAGE_ACTION_TEXT = 'storyboard-action-text'
