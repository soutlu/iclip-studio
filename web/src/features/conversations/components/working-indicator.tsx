import { cn } from '@/shared/lib/utils'
import { ClapperMascot } from '@/shared/ui/clapper-mascot'

type WorkingIndicatorProps = {
  label: string
  still?: boolean | undefined
}

export function WorkingIndicator({ label, still = false }: WorkingIndicatorProps) {
  return (
    <div className="inline-flex items-center gap-2 text-body-sm text-chat-muted-text" role="status">
      <ClapperMascot still={still} />
      <span className={cn(!still && 'animate-pulse')}>{label}</span>
    </div>
  )
}
