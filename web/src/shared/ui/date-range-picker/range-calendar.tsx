import { useEffect, useRef } from 'react'
import {
  DayPicker,
  type ChevronProps,
  type ClassNames,
  type DayButtonProps,
  type DayProps,
  type ModifiersClassNames,
  type PropsBase,
} from 'react-day-picker'
import { zhCN } from 'react-day-picker/locale'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { iconButtonVariants } from '@/shared/ui/button'

type RangeCalendarSize = 'md' | 'sm'

type RangeCalendarProps = Pick<
  PropsBase,
  | 'defaultMonth'
  | 'disabled'
  | 'endMonth'
  | 'footer'
  | 'month'
  | 'numberOfMonths'
  | 'onDayClick'
  | 'onDayMouseEnter'
  | 'onMonthChange'
  | 'showOutsideDays'
  | 'today'
> & {
  labelDay: (date: Date) => string
  modifiers: {
    endpoint?: Date[]
    inRange?: { from: Date; to: Date } | undefined
    preset?: { from: Date; to: Date } | undefined
    rangeEnd?: Date | undefined
    rangeStart?: Date | undefined
    selected?: Date | { from: Date; to: Date } | undefined
  }
  size?: RangeCalendarSize
}

const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'] as const

const monthName = (month: Date): string => `${month.getFullYear()} 年 ${month.getMonth() + 1} 月`

const SIZES: Record<
  RangeCalendarSize,
  { cell: string; button: string; classNames: Partial<ClassNames> }
> = {
  md: {
    cell: 'h-10 p-0 text-center',
    button: 'size-9',
    classNames: {
      month: 'w-70',
      month_caption: 'mb-2 flex h-(--control-height-sm) items-center justify-center',
      months: 'relative flex gap-5',
      weekday: 'py-2 text-center text-body-sm font-normal text-on-surface-muted',
    },
  },
  sm: {
    cell: 'h-8.5 p-0 text-center',
    button: 'size-8',
    classNames: {
      month: 'w-63',
      month_caption: 'mb-1 flex h-8 items-center justify-center',
      months: 'relative flex gap-6',
      weekday: 'h-7 text-center text-caption font-normal text-on-surface-muted',
    },
  },
}

const MODIFIER_CLASS_NAMES: ModifiersClassNames = {
  inRange: 'bg-state-active',
  preset: 'bg-state-hover',
  rangeEnd: 'rounded-r-full',
  rangeStart: 'rounded-l-full',
}

const Chevron = ({ orientation }: ChevronProps) => (
  <Icon decorative name={orientation === 'left' ? 'back' : 'next'} size="md" />
)

const calendarComponents = (size: RangeCalendarSize) => {
  const { cell, button } = SIZES[size]

  function CalendarDay({ day: _day, modifiers, className, ...props }: DayProps) {
    const filler = modifiers['hidden'] === true || modifiers['outside'] === true
    return <td {...props} className={filler ? cell : className} />
  }

  function CalendarDayButton({
    day: _day,
    modifiers,
    className: _className,
    ...props
  }: DayButtonProps) {
    const ref = useRef<HTMLButtonElement>(null)
    const endpoint = modifiers['endpoint'] === true
    const focused = modifiers['focused'] === true

    useEffect(() => {
      if (focused) ref.current?.focus()
    }, [focused])

    return (
      <button
        {...props}
        aria-current={modifiers['today'] === true ? 'date' : undefined}
        className={cn(
          'relative mx-auto grid ui-state cursor-pointer place-items-center rounded-full text-body tabular-nums ui-focus disabled:cursor-default disabled:opacity-35',
          button,
          endpoint ? 'bg-inverse-surface text-inverse-on-surface' : 'text-on-surface',
          modifiers['today'] === true && !endpoint && 'font-semibold',
        )}
        data-preset={modifiers['preset'] === true ? true : undefined}
        ref={ref}
      />
    )
  }

  return { Chevron, Day: CalendarDay, DayButton: CalendarDayButton }
}

const COMPONENTS = { md: calendarComponents('md'), sm: calendarComponents('sm') }

export function RangeCalendar({ labelDay, modifiers, size = 'md', ...props }: RangeCalendarProps) {
  const { cell, classNames } = SIZES[size]
  return (
    <DayPicker
      {...props}
      classNames={{
        button_next: iconButtonVariants({ size: 'sm' }),
        button_previous: iconButtonVariants({ size: 'sm' }),
        caption_label: 'text-body font-medium',
        day: cell,
        footer: 'mt-4 border-t border-chat-hairline pt-3 text-body-sm text-on-surface-variant',
        month_grid: 'w-full table-fixed border-collapse',
        nav: 'absolute inset-x-0 top-0 flex items-center justify-between',
        ...classNames,
      }}
      components={COMPONENTS[size]}
      formatters={{
        formatCaption: monthName,
        formatWeekdayName: (weekday) => WEEKDAY_NAMES[weekday.getDay()] ?? '',
      }}
      labels={{
        labelDayButton: labelDay,
        labelGrid: monthName,
        labelNext: () => '下个月',
        labelPrevious: () => '上个月',
      }}
      locale={zhCN}
      modifiers={modifiers}
      modifiersClassNames={MODIFIER_CLASS_NAMES}
      weekStartsOn={1}
    />
  )
}
