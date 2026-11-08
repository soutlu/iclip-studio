import { cn } from '@/shared/lib/utils'

export function AuthorAvatar({ name, className }: { name: string; className: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center rounded-full bg-surface-container-high text-on-surface',
        className,
      )}
    >
      {Array.from(name)[0]?.toLocaleUpperCase()}
    </span>
  )
}
