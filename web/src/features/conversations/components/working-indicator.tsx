import { useEffect, useRef } from 'react'
import type { AnimationItem } from 'lottie-web'
import { cn } from '@/shared/lib/utils'

const CAMERA_VIEW_BOX = '65 70 320 270'
const ANIMATION_PATH = '/lottie/requesting-camera.json'

type WorkingIndicatorProps = {
  label: string
  still?: boolean | undefined
}

export function WorkingIndicator({ label, still = false }: WorkingIndicatorProps) {
  return (
    <div className="inline-flex items-center gap-2 text-body-sm text-chat-muted-text" role="status">
      <CameraMascot still={still} />
      <span className={cn(!still && 'animate-pulse')}>{label}</span>
    </div>
  )
}

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

function CameraMascot({ still }: { still: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const animationRef = useRef<AnimationItem | undefined>(undefined)
  const stillRef = useRef(still)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return

    let animation: AnimationItem | undefined
    let cancelled = false

    const crop = () => host.querySelector('svg')?.setAttribute('viewBox', CAMERA_VIEW_BOX)

    void import('lottie-web/build/player/lottie_light').then(({ default: lottie }) => {
      if (cancelled) return

      animation = lottie.loadAnimation({
        autoplay: !stillRef.current && !prefersReducedMotion(),
        container: host,
        loop: true,
        path: ANIMATION_PATH,
        renderer: 'svg',
      })
      animation.addEventListener('DOMLoaded', crop)
      animationRef.current = animation
    })

    return () => {
      cancelled = true
      animation?.removeEventListener('DOMLoaded', crop)
      animation?.destroy()
      animationRef.current = undefined
    }
  }, [])

  useEffect(() => {
    stillRef.current = still
    const animation = animationRef.current
    if (animation === undefined) return
    if (still) animation.goToAndStop(0, true)
    else if (!prefersReducedMotion()) animation.play()
  }, [still])

  return (
    <div
      aria-hidden
      className={cn('size-8 shrink-0', still && 'opacity-60 grayscale')}
      ref={hostRef}
    />
  )
}
