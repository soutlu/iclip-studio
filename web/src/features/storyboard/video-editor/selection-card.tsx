import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react'
import { Icon } from '@/shared/icons'
import { IconButton } from '@/shared/ui/button'
import { placeCard } from '../editing/card-placement'

type SelectionCardProps = {
  frame: string | undefined
  title: string
  line: string
  action?: ReactNode
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
}

export function SelectionCard({
  frame,
  title,
  line,
  action,
  anchorRef,
  onClose,
}: SelectionCardProps) {
  const cardRef = useRef<HTMLElement>(null)

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
        {action}
        <IconButton label="关闭" name="close" onClick={onClose} size="sm" />
      </div>
    </section>
  )
}
