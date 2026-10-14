/** 整片编辑器里选中东西时弹在舞台上的小卡：与 AI 改段卡同位置、同外观，水平对准时间线上的选中项，
 * 底边小尖角指向它。段卡只说来源与时长；字幕卡只能改字（手动加的还能删）；音乐卡说用了哪一段与对齐结果。 */

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
import { placeCard } from '../video-editor/card-placement'

type FilmCardProps = {
  /** 时间线上选中的那一项，卡对准它的中线；不在时卡留在原处。 */
  anchorRef: RefObject<HTMLElement | null>
  /** 可访问名，也是卡的区域名。 */
  label: string
  /** 卡头左边的小画面或图标。 */
  leading: ReactNode
  title: string
  detail: string
  onClose: () => void
  children: ReactNode
}

function FilmCard({ anchorRef, label, leading, title, detail, onClose, children }: FilmCardProps) {
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

  // 每次渲染后重摆：选中项挪了（裁剪、换序、播放头带着走）都要跟上。
  useLayoutEffect(() => place())

  // 舞台变大小、时间线横向滚动（窄屏）时重摆。
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
      <div className="film-card-body">{children}</div>
    </section>
  )
}

/** 卡头那一帧；截不到图时露出中性底色。 */
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

/** 选中成片轨上的一段：第几段、出自哪一版、取了素材的哪一截。界面上不调声音。 */
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
  /** 第几段，从 1 起。 */
  position: number
  /** 出处：镜头组 2 · V3。 */
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
    >
      <p className="film-card-note">声音在合成时统一处理</p>
    </FilmCard>
  )
}

/** 选中音乐轨上的音乐：用了整首的哪一段、拍子与对齐结果；生成的能重新生成，都能删。没有音量：界面上不调声音。 */
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
  /** 上传的文件名，或「生成的音乐」。 */
  title: string
  /** 使用 a–b 秒 · 整首 x 秒。 */
  detail: string
  /** 拍子与对齐，音乐太短时另起一行。 */
  lines: readonly string[]
  /** 生成的音乐才有；正在提交时不给。 */
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

/** 选中字幕轨上的一条：只能改字；识别出的说来自哪一版的口播，手动加的另能删。 */
export function SubtitleCard({
  anchorRef,
  position,
  source,
  text,
  onText,
  onRemove,
  onClose,
}: {
  anchorRef: RefObject<HTMLElement | null>
  /** 第几条，从 1 起。 */
  position: number
  /** 识别出的：来自哪一版（镜头组 1 · V2）；手动加的没有。 */
  source: string | undefined
  text: string
  onText: (text: string) => void
  /** 手动加的才能删。 */
  onRemove: (() => void) | undefined
  onClose: () => void
}) {
  return (
    <FilmCard
      anchorRef={anchorRef}
      detail={source === undefined ? '手动添加' : `来自${source} 的口播`}
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
        className="film-card-text ui-focus"
        onChange={(event) => onText(event.target.value)}
        placeholder="输入字幕文字"
        rows={2}
        value={text}
      />
      {onRemove === undefined ? null : (
        <div className="film-card-actions">
          <Button leadingIcon="delete" onClick={onRemove} size="md" variant="ghost">
            删除
          </Button>
        </div>
      )}
    </FilmCard>
  )
}
