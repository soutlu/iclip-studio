import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { Icon } from '@/shared/icons'
import { Button, IconButton } from '@/shared/ui/button'
import { placeCard } from '../editing/card-placement'
import type { BrandPosition, FilmBrand } from './film-draft'
import { MAX_SUBTITLE_CHARS } from './film-limits'
import { BrandMenu, type BrandMenuProps } from './film-menus'

type FilmCardProps = {
  anchorRef: RefObject<HTMLElement | null>
  label: string
  leading: ReactNode
  title: string
  detail: string
  onClose: () => void
  children?: ReactNode
}

function FilmCard({ anchorRef, label, leading, title, detail, onClose, children }: FilmCardProps) {
  const cardRef = useRef<HTMLElement>(null)

  const place = useEffectEvent(() => {
    const card = cardRef.current
    if (card !== null && getComputedStyle(card).position === 'fixed') {
      card.style.removeProperty('left')
      card.style.removeProperty('--card-notch')
      return
    }
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
    if (card !== null) observer.observe(card)
    if (stage instanceof HTMLElement) observer.observe(stage)
    const onScroll = () => place()
    window.addEventListener('scroll', onScroll, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [])

  return (
    <section
      aria-label={label}
      className="video-editor-card film-card animate-in duration-(--dur-m) ease-(--ease-decel) fade-in motion-reduce:animate-none"
      ref={cardRef}
    >
      <div className="video-editor-card-head">
        <span className="film-card-leading">{leading}</span>
        <div className="video-editor-card-title">
          <p>{title}</p>
          <p>{detail}</p>
        </div>
        <IconButton label="关闭" name="close" onClick={onClose} size="sm" />
      </div>
      {children === undefined ? null : <div className="film-card-body">{children}</div>}
    </section>
  )
}

function Frame({ src }: { src: string | undefined }) {
  const [failed, setFailed] = useState<string>()
  return src === undefined || failed === src ? (
    <span aria-hidden="true" className="video-editor-card-frame is-empty" />
  ) : (
    <img
      alt=""
      className="video-editor-card-frame"
      draggable={false}
      onError={() => setFailed(src)}
      src={src}
    />
  )
}

export function SegmentCard({
  anchorRef,
  position,
  source,
  start,
  end,
  frame,
  onClose,
}: {
  anchorRef: RefObject<HTMLElement | null>
  position: number
  source: string
  start: number
  end: number
  frame: string | undefined
  onClose: () => void
}) {
  return (
    <FilmCard
      anchorRef={anchorRef}
      detail={`素材 ${start.toFixed(1)}–${end.toFixed(1)} 秒 · 共 ${(end - start).toFixed(1)} 秒`}
      label="选中的段"
      leading={<Frame src={frame} />}
      onClose={onClose}
      title={`第 ${position} 段 · ${source}`}
    />
  )
}

export function MusicCard({
  anchorRef,
  title,
  detail,
  lines,
  onRegenerate,
  onRemove,
  onClose,
}: {
  anchorRef: RefObject<HTMLElement | null>
  title: string
  detail: string
  lines: readonly string[]
  onRegenerate: (() => void) | undefined
  onRemove: () => void
  onClose: () => void
}) {
  return (
    <FilmCard
      anchorRef={anchorRef}
      detail={detail}
      label="选中的音乐"
      leading={
        <span className="film-card-icon">
          <Icon decorative name="music" size="sm" />
        </span>
      }
      onClose={onClose}
      title={title}
    >
      {lines.map((line) => (
        <p className="film-card-line" key={line}>
          {line}
        </p>
      ))}
      <div className="film-card-actions is-start">
        {onRegenerate === undefined ? null : (
          <Button leadingIcon="refresh" onClick={onRegenerate} size="md" variant="ghost">
            重新生成
          </Button>
        )}
        <Button leadingIcon="delete" onClick={onRemove} size="md" variant="ghost">
          删除
        </Button>
      </div>
    </FilmCard>
  )
}

export function SubtitleCard({
  anchorRef,
  position,
  origin,
  text,
  onText,
  onClose,
}: {
  anchorRef: RefObject<HTMLElement | null>
  position: number
  origin: string
  text: string
  onText: (text: string) => void
  onClose: () => void
}) {
  return (
    <FilmCard
      anchorRef={anchorRef}
      detail={origin}
      label="选中的字幕"
      leading={
        <span className="film-card-icon">
          <Icon decorative name="captions" size="sm" />
        </span>
      }
      onClose={onClose}
      title={`第 ${position} 条字幕`}
    >
      <textarea
        aria-label="字幕文字"
        className="film-card-text ui-focus ui-focus-inline"
        maxLength={MAX_SUBTITLE_CHARS}
        onChange={(event) => onText(event.target.value)}
        placeholder="输入字幕文字"
        rows={2}
        value={text}
      />
    </FilmCard>
  )
}

export function BrandCard({
  anchorRef,
  position,
  template,
  brands,
  onClose,
}: {
  anchorRef: RefObject<HTMLElement | null>
  position: BrandPosition
  template: FilmBrand
  brands: BrandMenuProps
  onClose: () => void
}) {
  const label = position === 'intro' ? '片头' : '片尾'
  return (
    <FilmCard
      anchorRef={anchorRef}
      label={`选中的${label}`}
      leading={<Icon decorative name="video" size="md" />}
      title={template.name ?? `${label}模板`}
      detail={`${label} · ${(template.durationMs / 1000).toFixed(1)} 秒 · 位置固定`}
      onClose={onClose}
    >
      <div className="film-card-actions">
        <BrandMenu brands={brands} position={position} />
        <Button
          leadingIcon="delete"
          onClick={() => brands.onRemove(position)}
          size="md"
          variant="ghost"
        >
          删除{label}
        </Button>
      </div>
    </FilmCard>
  )
}
