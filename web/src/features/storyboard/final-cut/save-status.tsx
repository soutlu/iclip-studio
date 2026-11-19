import { Icon, type IconName } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { TooltipContent, TooltipRoot, TooltipTrigger } from '@/shared/ui/tooltip'
import type { SaveState } from './use-film-session'

const look = (save: SaveState): { icon: IconName; text: string } => {
  switch (save.kind) {
    case 'idle':
      return { icon: 'final-cut-saved', text: '已自动保存' }
    case 'saving':
      return { icon: 'spinner', text: '正在保存…' }
    case 'failed':
      return { icon: 'warning', text: save.message }
  }
}

/**
 * 工作台顶栏上 final-cut 的保存状态：只是一个图标，悬停说明。保存失败时的「重新保存」仍在时间线下面的提示条里。
 */
export function SaveStatus({ save }: { save: SaveState }) {
  const { icon, text } = look(save)
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>
        <span aria-label={text} className="wf-save-status" data-save={save.kind} role="status">
          <Icon
            className={cn(save.kind === 'saving' && 'animate-spin')}
            decorative
            name={icon}
            size="lg"
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{text}</TooltipContent>
    </TooltipRoot>
  )
}
