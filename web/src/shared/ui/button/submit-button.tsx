import { useState, type ComponentProps } from 'react'
import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button } from './button'

export type SubmitPhase = 'idle' | 'sending' | 'accepted'

type SubmitButtonProps = Omit<
  ComponentProps<typeof Button>,
  'children' | 'leadingIcon' | 'loading' | 'trailingIcon' | 'variant'
> & {
  phase: SubmitPhase
  label: string
  leadingIcon: IconName
  pendingLabel?: string
  variant?: 'primary' | 'tonal'
}

const ICON_ENTER = 'animate-in duration-(--dur-s) ease-(--ease-decel) zoom-in-70 fade-in'
const LABEL_ENTER =
  'animate-in duration-(--dur-m) ease-(--ease-decel) fade-in slide-in-from-bottom-[6px]'

function PhaseIcon({
  animated,
  leadingIcon,
  phase,
}: {
  animated: boolean
  leadingIcon: IconName
  phase: SubmitPhase
}) {
  if (phase === 'sending')
    return <Icon className="animate-spin" decorative name="loading" size="md" />
  if (phase === 'accepted')
    return (
      <Icon
        className={cn('submit-button-check', animated && 'submit-button-check-draw')}
        decorative
        name="check"
        size="md"
      />
    )
  return <Icon decorative name={leadingIcon} size="md" />
}

export function SubmitButton({
  className,
  label,
  leadingIcon,
  pendingLabel = '提交中…',
  phase,
  variant = 'primary',
  ...props
}: SubmitButtonProps) {
  const [previousPhase, setPreviousPhase] = useState(phase)
  const [animated, setAnimated] = useState(false)
  if (phase !== previousPhase) {
    setPreviousPhase(phase)
    setAnimated(true)
  }
  const text = phase === 'sending' ? pendingLabel : phase === 'accepted' ? '已提交' : label

  return (
    <Button
      className={cn('submit-button', className)}
      data-phase={phase}
      data-variant={variant}
      variant={variant}
      {...props}
    >
      <span className="submit-button-stack">
        <span aria-hidden="true" className="submit-button-layer invisible">
          <Icon decorative name={leadingIcon} size="md" />
          {label}
        </span>
        <span className="submit-button-layer submit-button-current" key={phase}>
          <span className={cn('submit-button-icon', animated && ICON_ENTER)}>
            <PhaseIcon animated={animated} leadingIcon={leadingIcon} phase={phase} />
          </span>
          <span className={cn(animated && LABEL_ENTER)}>{text}</span>
        </span>
      </span>
    </Button>
  )
}
