import { useEffect, useRef } from 'react'
import { HOVER_CANVAS } from './hover-preview'

/** `@hyperframes/player` 注册的 `<hyperframes-player>` 元素上这里用到的那几样 */
type PlayerElement = HTMLElement & { play: () => void }

/**
 * 盖在组件卡片预览图上的播放器：静音、循环播放 srcdoc 这一页。第一帧画出来之前透明，底下的预览图
 * 照常显示；画好后开始播，播放器的 `loop` 在结尾跳回开头接着放。卸载时拆掉播放器。
 */
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

  return <span aria-hidden className="wf-hover-slot" ref={hostRef} />
}
