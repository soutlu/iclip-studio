import { useRef, useState } from 'react'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'

type SelectChipOption = { id: string; label: string }

type SelectChipProps = {
  /** 筛的是什么，如「曲风」「品牌」：没选时写在小块上。 */
  noun: string
  options: readonly SelectChipOption[]
  /** 选中的那项；undefined 是不按它筛。 */
  value: string | undefined
  onChange: (value: string | undefined) => void
  /** 选项排成两列（选项都很短时，如品牌）。 */
  columns?: 1 | 2
  className?: string | undefined
}

/**
 * 筛选小块：没选时是「名词 ⌄」，点开单选；选了以后变成「选中值 ×」，点值重新选，点 × 清掉。
 * 弹层里再点选中的那项也是清掉。选完弹层关上，焦点回到小块上。
 */
export function SelectChip({
  noun,
  options,
  value,
  onChange,
  columns = 1,
  className,
}: SelectChipProps) {
  const [open, setOpen] = useState(false)
  const mainRef = useRef<HTMLButtonElement>(null)
  const picked = options.find((option) => option.id === value)
  const label = picked?.label ?? noun
  return (
    <span className={cn('wf-select-chip', picked !== undefined && 'is-picked', className)}>
      <PopupRoot onOpenChange={setOpen} open={open}>
        <PopupTrigger asChild>
          <button
            aria-label={`${noun}：${label}`}
            className="wf-select-chip-main ui-focus"
            ref={mainRef}
            type="button"
          >
            <span className="wf-select-chip-label">{label}</span>
            {picked === undefined ? <Icon decorative name="final-cut-expand" size="xs" /> : null}
          </button>
        </PopupTrigger>
        <PopupSurface
          align="start"
          aria-label={`选择${noun}`}
          className="wf-menu wf-select-chip-menu"
          collisionPadding={12}
          sideOffset={6}
        >
          <div
            aria-label={noun}
            className={cn('wf-select-chip-options', columns === 2 && 'is-two-columns')}
            role="radiogroup"
          >
            {options.map((option) => {
              const selected = option.id === value
              return (
                <button
                  aria-checked={selected}
                  className="wf-select-chip-option ui-state ui-focus"
                  key={option.id}
                  onClick={() => {
                    setOpen(false)
                    onChange(selected ? undefined : option.id)
                  }}
                  role="radio"
                  type="button"
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        </PopupSurface>
      </PopupRoot>
      {picked === undefined ? null : (
        <button
          aria-label={`清除${noun}筛选`}
          className="wf-select-chip-clear ui-focus"
          onClick={() => {
            onChange(undefined)
            // × 清掉以后就不在了：焦点交给小块本身
            mainRef.current?.focus()
          }}
          type="button"
        >
          <Icon decorative name="close" size="xs" />
        </button>
      )}
    </span>
  )
}
