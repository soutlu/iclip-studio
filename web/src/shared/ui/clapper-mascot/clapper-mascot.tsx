import { useEffect, useLayoutEffect, useRef } from 'react'
import type { AnimationItem } from 'lottie-web'
import { cn } from '@/shared/lib/utils'

const CLAPPER_VIEW_BOX = '71 65 299 275'
const ANIMATION_PATH = '/lottie/clapper-thinking.json'

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

type ClapperMascotProps = {
  still?: boolean | undefined
  className?: string | undefined
  onReady?: (() => void) | undefined
}

/** iClip 的场记板动画；`still` 时停在第一帧并变灰，画出来后调一次 `onReady`。 */
export function ClapperMascot({ still = false, className, onReady }: ClapperMascotProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const animationRef = useRef<AnimationItem | undefined>(undefined)
  const stillRef = useRef(still)
  const onReadyRef = useRef(onReady)
  useLayoutEffect(() => {
    onReadyRef.current = onReady
  })

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return

    let animation: AnimationItem | undefined
    let cancelled = false

    const drawn = () => {
      host.querySelector('svg')?.setAttribute('viewBox', CLAPPER_VIEW_BOX)
      onReadyRef.current?.()
    }

    void import('lottie-web/build/player/lottie_light').then(({ default: lottie }) => {
      if (cancelled) return

      animation = lottie.loadAnimation({
        autoplay: !stillRef.current && !prefersReducedMotion(),
        container: host,
        loop: true,
        path: ANIMATION_PATH,
        renderer: 'svg',
      })
      animation.addEventListener('DOMLoaded', drawn)
      animationRef.current = animation
    })

    return () => {
      cancelled = true
      animation?.removeEventListener('DOMLoaded', drawn)
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
      className={cn('size-8 shrink-0', still && 'opacity-60 grayscale', className)}
      ref={hostRef}
    />
  )
}
