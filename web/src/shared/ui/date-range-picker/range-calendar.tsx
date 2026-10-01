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
  /** 日期按钮的可访问名；各调用方按自己的日期写法给。 */
  labelDay: (date: Date) => string
  /**
   * 区间的外观由这几个修饰决定：`endpoint` 实心墨色圆，`inRange` 铺底，
   * `rangeStart` / `rangeEnd` 收圆角，`preset` 更淡的预设高亮（按钮带 `data-preset`），
   * `selected` 进 aria-selected。
   */
  modifiers: {
    endpoint?: Date[]
    inRange?: { from: Date; to: Date } | undefined
    preset?: { from: Date; to: Date } | undefined
    rangeEnd?: Date | undefined
    rangeStart?: Date | undefined
    selected?: Date | { from: Date; to: Date } | undefined
  }
  /** md 是筛选浮层的默认尺寸；sm 是更紧凑的格子，给左侧还要放预设列表的浮层。 */
  size?: RangeCalendarSize
}

/** 表头星期名，按 getDay() 取，不依赖 locale 的星期宽度。 */
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
      // 固定 280px：七列正好 40px 见方，两个月并排也放得进 sm 宽度的弹层。
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

/** 区间底色落在格子上，端点的实心圆在按钮上；预设高亮只是展示，配色比自定义区间更淡。 */
const MODIFIER_CLASS_NAMES: ModifiersClassNames = {
  inRange: 'bg-state-active',
  preset: 'bg-state-hover',
  rangeEnd: 'rounded-r-full',
  rangeStart: 'rounded-l-full',
}

const Chevron = ({ orientation }: ChevronProps) => (
  <Icon decorative name={orientation === 'left' ? 'back' : 'next'} size="md" />
)

/** 两种尺寸各一套格子与按钮；在模块里建好，渲染时组件身份不变。 */
const calendarComponents = (size: RangeCalendarSize) => {
  const { cell, button } = SIZES[size]

  /** 月首月末补位的空格子不跟着区间与预设铺底，只留格子本身的尺寸。 */
  function CalendarDay({ day: _day, modifiers, className, ...props }: DayProps) {
    const filler = modifiers['hidden'] === true || modifiers['outside'] === true
    return <td {...props} className={filler ? cell : className} />
  }

  /** 日期按钮：端点实心墨色、今天加粗、不可选的日子变淡；焦点交接沿用 DayPicker 默认按钮的做法。 */
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

/** 区间日历：两个日期筛选浮层共用的格子、端点与今天的画法，选择逻辑留给调用方。 */
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
        // 翻月按钮压在第一行的两端，两个月并排时也只有一组。
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
