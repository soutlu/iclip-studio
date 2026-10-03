import { IconButton } from '@/shared/ui/button'
import { useCopyFeedback } from '@/shared/ui/copy-feedback'

export function CopyButton({ label = '复制', text }: { text: string; label?: string }) {
  const { copied, copy } = useCopyFeedback()

  return (
    <IconButton
      className="text-chat-muted-text"
      label={label}
      name={copied ? 'check' : 'copy'}
      onClick={() => void copy(text)}
      size="xs"
      tooltip={copied ? '已复制' : undefined}
      variant="standard"
    />
  )
}
