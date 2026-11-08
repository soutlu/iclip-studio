import { createContext, use, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'

type FilterBarContextValue = {
  openFilter: string | null
  setOpen: (id: string, open: boolean) => void
  triggerRef: (id: string) => RefObject<HTMLButtonElement | null>
  close: () => void
}

const FilterBarContext = createContext<FilterBarContextValue | null>(null)

export function useFilterBar(): FilterBarContextValue {
  const context = use(FilterBarContext)
  if (context === null) throw new Error('FilterPopup 必须放在 FilterBarRoot 内')
  return context
}

export function FilterBarRoot({
  children,
  className,
}: {
  children: ReactNode
  className?: string | undefined
}) {
  const [openFilter, setOpenFilter] = useState<string | null>(null)
  const triggersRef = useRef(new Map<string, RefObject<HTMLButtonElement | null>>())

  const triggerRef = (id: string): RefObject<HTMLButtonElement | null> => {
    const existing = triggersRef.current.get(id)
    if (existing) return existing
    const createdRef: RefObject<HTMLButtonElement | null> = { current: null }
    triggersRef.current.set(id, createdRef)
    return createdRef
  }

  return (
    <FilterBarContext
      value={{
        openFilter,
        setOpen: (id, open) => {
          setOpenFilter((current) => (open ? id : current === id ? null : current))
        },
        triggerRef,
        close: () => {
          if (openFilter !== null) triggersRef.current.get(openFilter)?.current?.focus()
          setOpenFilter(null)
        },
      }}
    >
      <div className={cn('flex flex-wrap items-center', className)}>{children}</div>
    </FilterBarContext>
  )
}

type FilterPopupProps = {
  id: string
  icon: IconName
  label: string
  triggerLabel?: string | undefined
  popupLabel: string
  selected: boolean
  disabled?: boolean | undefined
  title?: string | undefined
  align?: 'start' | 'end'
  width: string
  className?: string | undefined
  children: ReactNode
}

export function FilterPopup({
  align = 'start',
  children,
  className,
  disabled,
  icon,
  id,
  label,
  popupLabel,
  selected,
  title,
  triggerLabel,
  width,
}: FilterPopupProps) {
  const { openFilter, setOpen, triggerRef } = useFilterBar()
  const open = openFilter === id

  return (
    <PopupRoot onOpenChange={(next) => setOpen(id, next)} open={open}>
      <PopupTrigger asChild>
        <button
          aria-label={triggerLabel ?? label}
          className={cn(
            'inline-flex min-w-0 ui-state cursor-pointer items-center gap-2 text-body text-on-surface ui-focus data-[state=open]:bg-state-active',
            selected && 'text-primary',
            className,
          )}
          disabled={disabled}
          ref={triggerRef(id)}
          title={title ?? label}
          type="button"
        >
          <Icon decorative name={icon} size="sm" />
          <span className="max-w-44 truncate">{label}</span>
          <Icon className="text-on-surface-variant" decorative name="expand" size="xs" />
        </button>
      </PopupTrigger>
      <PopupSurface
        align={align}
        aria-label={popupLabel}
        className={width}
        collisionPadding={12}
        showArrow
        sideOffset={6}
      >
        {open ? children : null}
      </PopupSurface>
    </PopupRoot>
  )
}
