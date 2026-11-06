export const SIDEBAR_ROW_BOX =
  'flex h-9 items-center gap-2.5 rounded-md px-2.5 text-body text-on-surface'

export const SIDEBAR_ROW_CLASS = `group ui-state cursor-pointer ${SIDEBAR_ROW_BOX}`

export const SIDEBAR_ROW_TITLE_CLASS =
  'flex min-w-0 flex-1 items-center gap-2.5 rounded-xs ui-focus'

export const SIDEBAR_ROW_ACTIVE = 'bg-state-active font-medium'

export const SIDEBAR_ROW_MENU_OPEN = 'has-data-[state=open]:bg-state-hover'

export const SIDEBAR_ROW_TRAILING_SHOWN =
  'sr-only *:last:-mr-1.25 group-hover:not-sr-only group-hover:flex group-has-focus-visible:not-sr-only group-has-focus-visible:flex group-has-data-[state=open]:not-sr-only group-has-data-[state=open]:flex touch:not-sr-only touch:flex touch:*:text-on-surface-faint'
