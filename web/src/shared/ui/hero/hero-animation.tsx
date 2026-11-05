import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { cn } from '@/shared/lib/utils'
import { CueMascot } from './cue-mascot'
import mascotMarkup from './cue.svg?raw'

type HeroAnimationProps = {
  className?: string
}

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

export function HeroAnimation({ className }: HeroAnimationProps) {
  const hostRef = useRef<HTMLButtonElement>(null)
  const mascotRef = useRef<CueMascot | null>(null)
  const [expanded, setExpanded] = useState(prefersReducedMotion)
  const [pinned, setPinned] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    host.innerHTML = mascotMarkup
    const svg = host.querySelector('svg')
    if (!svg) return
    const mascot = new CueMascot(svg)
    mascotRef.current = mascot
    return () => {
      mascot.destroy()
      mascotRef.current = null
      host.replaceChildren()
    }
  }, [])

  useEffect(() => {
    mascotRef.current?.setExpanded(expanded)
  }, [expanded])

  useEffect(() => {
    if (!pinned) return
    const collapseOutside = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && hostRef.current?.contains(event.target)) return
      setPinned(false)
      setExpanded(false)
    }
    document.addEventListener('pointerdown', collapseOutside)
    return () => document.removeEventListener('pointerdown', collapseOutside)
  }, [pinned])

  const hoverStart = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== 'touch') setExpanded(true)
  }
  const hoverEnd = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== 'touch' && !pinned) setExpanded(false)
  }
  const toggle = () => {
    setPinned(!pinned)
    setExpanded(!pinned)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape') {
      setPinned(false)
      setExpanded(false)
    }
  }

  return (
    <button
      ref={hostRef}
      aria-expanded={expanded}
      aria-label={expanded ? '收起鞋盒' : '展开鞋盒，展示鞋履与服装'}
      className={cn(
        'block aspect-[2/1] cursor-pointer rounded-lg text-on-surface ui-focus [&_svg]:block [&_svg]:size-full',
        className,
      )}
      onClick={toggle}
      onKeyDown={onKeyDown}
      onPointerEnter={hoverStart}
      onPointerLeave={hoverEnd}
      type="button"
    />
  )
}
