import { useId, type ReactNode } from 'react'
import { cn } from '@/shared/lib/utils'
import { Switch } from '@/shared/ui/switch'

/**
 * 「属性」页签的一组：有 `title` 时上面一行小标题（右边可放 `end`），下面是若干行；没有标题时只是靠间距分开的一组行。
 * 不画框，组与组之间靠间距分开。
 */
export function PropSection({
  title,
  end,
  children,
}: {
  title?: string
  /** 小标题右边的东西，如状态、语言小块、「归零」。 */
  end?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="wf-prop-section">
      {title === undefined ? null : (
        <div className="wf-prop-section-head">
          <h4 className="wf-prop-section-title">{title}</h4>
          {end === undefined ? null : <span className="wf-prop-section-end">{end}</span>}
        </div>
      )}
      {children}
    </section>
  )
}

/**
 * 一组里再分的一小段的标题行（如「精细调音」里的「三段均衡与升降调」）：名字在左，`end` 在右；比 `PropSection` 的
 * 小标题低一级，不是标题元素。
 */
export function PropSubhead({ title, end }: { title: ReactNode; end?: ReactNode }) {
  return (
    <div className="wf-prop-subhead">
      <span className="wf-prop-subhead-title">{title}</span>
      {end}
    </div>
  )
}

/**
 * 一行：左边名字、右边控件。名字用 `htmlFor` 指向控件，或给 `labelId` 让控件 `aria-labelledby` 它；都不给时只是文字
 * （控件自己带读屏名，如滑杆）。`stacked` 时名字一行（右边可放 `end`），控件在下面占满一行。
 */
export function PropRow({
  label,
  htmlFor,
  labelId,
  stacked = false,
  end,
  disabled = false,
  children,
}: {
  label: string
  htmlFor?: string | undefined
  labelId?: string | undefined
  stacked?: boolean
  end?: ReactNode
  /** 控件不能操作：名字跟着变淡。 */
  disabled?: boolean
  children: ReactNode
}) {
  const name =
    htmlFor === undefined ? (
      <span className="wf-prop-label" id={labelId} title={label}>
        {label}
      </span>
    ) : (
      <label className="wf-prop-label" htmlFor={htmlFor} id={labelId} title={label}>
        {label}
      </label>
    )
  return (
    <div
      className={cn('wf-prop-row', stacked && 'is-stacked')}
      data-disabled={disabled || undefined}
    >
      {stacked ? (
        <div className="wf-prop-row-head">
          {name}
          {end}
        </div>
      ) : (
        name
      )}
      {children}
    </div>
  )
}

/** 名字在左、开关在右的一行；`blockedReason` 时拨不动，悬停说明原因；`end` 放在开关左边（如「重置」）。 */
export function PropSwitch({
  label,
  checked,
  onChange,
  blockedReason,
  end,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  blockedReason?: string | undefined
  end?: ReactNode
}) {
  const id = useId()
  return (
    <div className="wf-prop-row is-switch">
      <span className="wf-prop-label" id={id} title={label}>
        {label}
      </span>
      <span className="wf-prop-row-end">
        {end}
        <Switch
          aria-labelledby={id}
          blockedReason={blockedReason}
          checked={checked}
          onCheckedChange={onChange}
        />
      </span>
    </div>
  )
}
