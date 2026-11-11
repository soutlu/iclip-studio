import { Icon } from '@/shared/icons'

export function MediaBuffering() {
  return (
    <div
      aria-label="正在缓冲"
      className="pointer-events-none absolute inset-0 z-(--z-local-2) grid animate-in place-items-center text-on-scrim delay-300 duration-(--dur-m) fill-mode-backwards fade-in"
      role="status"
    >
      <span className="rounded-full bg-scrim/32 p-2">
        <Icon className="animate-spin" decorative name="spinner" size="xl" />
      </span>
    </div>
  )
}
