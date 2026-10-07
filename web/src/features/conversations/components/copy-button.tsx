import { IconButton } from '@/shared/ui/button'
import { cn } from '@/shared/lib/utils'
import { useCopyFeedback } from '@/shared/ui/copy-feedback'

type CopyButtonProps = {
  text: string
  label?: string
  className?: string | undefined
}

export function CopyButton({ className, label = '复制', text }: CopyButtonProps) {
  const { copied, copy } = useCopyFeedback()

  return (
    <IconButton
      className={cn('text-chat-muted-text', className)}
      label={label}
      name={copied ? 'check' : 'copy'}
      onClick={() => void copy(text)}
      size="xs"
      tooltip={copied ? '已复制' : undefined}
      variant="standard"
    />
  )
}
