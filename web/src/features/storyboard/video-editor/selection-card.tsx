import { useEffect, useEffectEvent, useLayoutEffect, useRef, type RefObject } from 'react'
import { Icon } from '@/shared/icons'
import { IconButton } from '@/shared/ui/button'
import { placeCard } from '../editing/card-placement'

type SelectionCardProps = {
  /** 左边那一帧；没有画面（在跑的编辑片段）时为 undefined，放生成图标。 */
  frame: string | undefined
  title: string
  line: string
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
}

/** 选中草稿里一块、或编辑轨上在跑的那条时弹出的小卡：一帧、标题、说明一行与关闭。 */
export function SelectionCard({ frame, title, line, anchorRef, onClose }: SelectionCardProps) {
  const cardRef = useRef<HTMLElement>(null)

  // 横向对准选中描边的中点，尖角指向它；同 AI 改段卡的摆法。
  const place = useEffectEvent(() => {
    const card = cardRef.current
    const stage = card?.offsetParent
    const anchor = anchorRef.current
    if (card === null || !(stage instanceof HTMLElement) || anchor === null) return
    const stageBounds = stage.getBoundingClientRect()
    const anchorBounds = anchor.getBoundingClientRect()
    const { left, notch } = placeCard(
      stage.clientWidth,
      anchorBounds.left + anchorBounds.width / 2 - stageBounds.left,
      card.offsetWidth,
    )
    card.style.left = `${left}px`
    card.style.setProperty('--card-notch', `${notch}px`)
  })
  useLayoutEffect(() => place())
  useEffect(() => {
    const card = cardRef.current
    const stage = card?.offsetParent
    const observer = new ResizeObserver(() => place())
    if (stage instanceof HTMLElement) observer.observe(stage)
    window.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', place, true)
    }
  }, [])

  return (
    <section
      aria-label={title}
      className="video-editor-card video-editor-small-card animate-in duration-(--dur-m) ease-(--ease-decel) fade-in motion-reduce:animate-none"
      ref={cardRef}
    >
      <div className="video-editor-card-head">
        {frame === undefined ? (
          <span className="video-editor-small-card-icon">
            <Icon decorative name="sparkles" size="sm" />
          </span>
        ) : (
          <img alt="" className="video-editor-card-frame" draggable={false} src={frame} />
        )}
        <div className="video-editor-card-title">
          <p>{title}</p>
          <p>{line}</p>
        </div>
        <IconButton label="关闭" name="close" onClick={onClose} size="sm" />
      </div>
    </section>
  )
}
