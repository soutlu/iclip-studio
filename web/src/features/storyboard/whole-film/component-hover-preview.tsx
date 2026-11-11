import { useEffect, useRef } from 'react'
import { HOVER_CANVAS } from './hover-preview'

type PlayerElement = HTMLElement & { play: () => void }

export function ComponentHoverPreview({ srcdoc }: { srcdoc: string }) {
  const hostRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let cancelled = false
    let player: PlayerElement | null = null
    const reveal = () => {
      if (player === null) return
      player.play()
      player.classList.remove('is-pending')
    }
    void import('@hyperframes/player').then(() => {
      const host = hostRef.current
      if (cancelled || host === null) return
      player = document.createElement('hyperframes-player') as PlayerElement
      player.setAttribute('disable-click-to-play', '')
      player.setAttribute('assets-loading-ui', 'none')
      player.setAttribute('muted', '')
      player.setAttribute('loop', '')
      player.setAttribute('width', String(HOVER_CANVAS.width))
      player.setAttribute('height', String(HOVER_CANVAS.height))
      player.className = 'wf-hover-player is-pending'
      player.addEventListener('painted', reveal, { once: true })
      host.append(player)
      player.setAttribute('srcdoc', srcdoc)
    })
    return () => {
      cancelled = true
      player?.removeEventListener('painted', reveal)
      player?.remove()
    }
  }, [srcdoc])

  return <span aria-hidden className="wf-hover-slot" inert ref={hostRef} />
}
