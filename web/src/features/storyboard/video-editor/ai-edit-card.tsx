/** AI 改段的弹出卡：选中视频段时盖在舞台上，水平对准时间线上的选区，底边小尖角指向它；画面不为它让位。
 *
 * 一拖、一播就收成画面底部的小胶囊，停下后点胶囊或那段再展开。卡与胶囊是同一个元素，切换时从原来的
 * 大小变过去。没提交的要求由调用方以 React 状态持有：收起时输入框卸载，展开时从状态装回来。
 * 上传归共享输入框自己管、随它卸载而断，所以还没传完（或传失败）的参考图留不下来：收起时报出张数，
 * 由调用方在卡里说出来。 */

import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import {
  Composer,
  type ComposerHandle,
  type ComposerPart,
  type ComposerSubmission,
} from '@/shared/ui/composer'
import { imageSlotsOf } from '../edit-prompt'
import { MAX_EDIT_REFERENCES } from '../generation-limits'
import { placeCard } from './card-placement'
import './ai-edit-card.css'

/** 卡此刻的位置与大小，切换外形时从它变过去。编辑器播放时每帧都重渲染，这里只读几何、不读样式。 */
type Box = { width: number; height: number; left: number }

const measure = (card: HTMLElement): Box => ({
  width: card.offsetWidth,
  height: card.offsetHeight,
  left: card.offsetLeft,
})

/** 卡头与胶囊上的一帧；截不到图时露出中性底色。 */
function Thumb({ src, className }: { src: string | undefined; className: string }) {
  const [failed, setFailed] = useState<string>()
  return src === undefined || failed === src ? (
    <span aria-hidden="true" className={cn(className, 'is-empty')} />
  ) : (
    <img alt="" className={className} draggable={false} onError={() => setFailed(src)} src={src} />
  )
}

type CardComposerProps = {
  draft: readonly ComposerPart[]
  onDraftChange: (parts: readonly ComposerPart[]) => void
  /** 卸载（卡收起或收走）时正文里还有几张图没传好，没有留进草稿；没有就不调。 */
  onUploadsDropped: (count: number) => void
  /** 挂载后把光标放进输入框：从胶囊点开的。只在挂载时读。 */
  focusInput: boolean
  onInputFocused: () => void
  submitDisabled: boolean
  sending: boolean
  onSubmit: (submission: ComposerSubmission) => void
  modelPicker: ReactNode
}

/** 卡里的输入框：挂载时装回没提交的要求，之后每次变化把就绪的部分交回去。 */
function CardComposer({
  draft,
  onDraftChange,
  onUploadsDropped,
  focusInput,
  onInputFocused,
  submitDisabled,
  sending,
  onSubmit,
  modelPicker,
}: CardComposerProps) {
  const composerRef = useRef<ComposerHandle>(null)
  const { data: user } = useUser()
  const [initial] = useState(draft)
  const [focusOnMount] = useState(focusInput)
  // 正文里此刻的全部内容（含上传中的图），算参考图还能加几张。
  const [parts, setParts] = useState<readonly ComposerPart[]>(draft)
  // 同一份内容给卸载时清点用：清理函数里读不到最新的 state。
  const partsRef = useRef<readonly ComposerPart[]>(draft)
  const focused = useEffectEvent(onInputFocused)
  const dropped = useEffectEvent(onUploadsDropped)

  useEffect(
    () => () => {
      const unsaved = partsRef.current.filter(
        (part) => part.kind === 'media' && part.media.status !== 'ready',
      ).length
      if (unsaved > 0) dropped(unsaved)
    },
    [],
  )

  useEffect(() => {
    const composer = composerRef.current
    if (composer === null) return
    if (initial.length > 0)
      composer.restore({
        media: initial.flatMap((part) => (part.kind === 'media' ? [part.media] : [])),
        parts: initial,
        text: '',
      })
    if (focusOnMount) {
      composer.focus()
      focused()
    }
  }, [initial, focusOnMount])

  const remaining = () =>
    MAX_EDIT_REFERENCES - new Set(imageSlotsOf(parts).map((slot) => slot.key)).size

  return (
    <Composer
      accept="image"
      ariaLabel="修改要求"
      attachmentLimit={{
        notice: (dropped) => `参考图最多 ${MAX_EDIT_REFERENCES} 张，这次有 ${dropped} 张没有添加`,
        remaining,
      }}
      attachmentsEnabled={hasPermission(user, PERMISSION.uploadsWrite)}
      className="video-editor-card-composer"
      dropScope="card"
      onChange={(next) => {
        setParts(next)
        partsRef.current = next
        onDraftChange(next.filter((part) => part.kind !== 'media' || part.media.status === 'ready'))
      }}
      onSubmit={onSubmit}
      placeholder="描述这段想怎么改，可以粘贴或拖入参考图"
      ref={composerRef}
      sending={sending}
      submitAction={{
        disabled: submitDisabled,
        emphasis: 'primary',
        icon: 'video',
        label: '生成视频',
        pendingLabel: '提交中…',
      }}
      trailing={modelPicker}
    />
  )
}

type AiEditCardProps = {
  /** 展开成卡；否则收成胶囊。 */
  open: boolean
  onExpand: () => void
  onCollapse: () => void
  /** 时间线上的选区外框，卡对准它的中线；拖着段时它不在，卡留在原处。 */
  anchorRef: RefObject<HTMLElement | null>
  /** 选中的是哪几段，如「第 2–3 段」。 */
  positions: string
  /** 卡头副标题：能交给 AI 时是区间与做法，不能时是原因。 */
  detail: string
  /** 这几段的首帧与末帧截图；截不了帧时没有。 */
  frames: { first: string | undefined; last: string | undefined }
  /** 没提交的要求，只含文字与传好的参考图。 */
  draft: readonly ComposerPart[]
  onDraftChange: (parts: readonly ComposerPart[]) => void
  /** 收起或收走时有几张参考图还没传好、没能留下。 */
  onUploadsDropped: (count: number) => void
  /** 能不能生成：选区能交给 AI、有模型、没在提交。 */
  canGenerate: boolean
  generating: boolean
  onGenerate: (submission: ComposerSubmission) => void
  /** 卡底的模型选择。 */
  modelPicker: ReactNode
  /** 卡里要让人看到的错误：提交失败、模型清单读不到。 */
  alerts: ReactNode
}

export function AiEditCard({
  open,
  onExpand,
  onCollapse,
  anchorRef,
  positions,
  detail,
  frames,
  draft,
  onDraftChange,
  onUploadsDropped,
  canGenerate,
  generating,
  onGenerate,
  modelPicker,
  alerts,
}: AiEditCardProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const miniRef = useRef<HTMLButtonElement>(null)
  const boxRef = useRef<Box | null>(null)
  const wasOpenRef = useRef(open)
  const morphRef = useRef<Animation | null>(null)
  const [focusInput, setFocusInput] = useState(false)
  const title = `AI 改${positions}`
  const unfinished = draft.some((part) => part.kind === 'media' || part.text.trim() !== '')

  /** 按选区摆好水平位置，并记下此刻的外形。选区外框不在（拖着段）时不挪。 */
  const place = useEffectEvent(() => {
    const card = cardRef.current
    const stage = card?.offsetParent
    if (card === null || card === undefined || !(stage instanceof HTMLElement)) return
    const anchor = anchorRef.current
    if (anchor !== null) {
      const stageBounds = stage.getBoundingClientRect()
      const anchorBounds = anchor.getBoundingClientRect()
      const { left, notch } = placeCard(
        stage.clientWidth,
        anchorBounds.left + anchorBounds.width / 2 - stageBounds.left,
        card.offsetWidth,
      )
      card.style.left = `${left}px`
      card.style.setProperty('--card-notch', `${notch}px`)
    }
    boxRef.current = measure(card)
  })

  // 每次渲染后重摆（选区、外形都可能变了）；外形刚切换时从切换前的样子变过去。
  useLayoutEffect(() => {
    const card = cardRef.current
    const before = boxRef.current
    const toggled = wasOpenRef.current !== open
    wasOpenRef.current = open
    if (toggled && card !== null) {
      // 上一次变形还没走完就又切了：停掉它，从它停下时的样子（上一帧量到的）重新变。
      morphRef.current?.cancel()
      morphRef.current = null
      delete card.dataset['morphing']
    }
    place()
    if (!toggled || card === null) return
    // 收起时焦点若随输入框一起没了，交给胶囊，键盘不断。
    const active = document.activeElement
    if (!open && (active === null || active === document.body || active.contains(card)))
      miniRef.current?.focus()
    const after = boxRef.current
    if (before === null || after === null) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const style = getComputedStyle(card)
    // 卡是 20px 圆角，胶囊是半高的全圆角；圆角也跟着变，免得大卡一瞬间变成椭圆。
    const radiusOf = (box: Box, isOpen: boolean) =>
      isOpen ? style.getPropertyValue('--radius-xl') : `${box.height / 2}px`
    const frame = (box: Box, isOpen: boolean) => ({
      width: `${box.width}px`,
      height: `${box.height}px`,
      left: `${box.left}px`,
      borderRadius: radiusOf(box, isOpen),
    })
    card.dataset['morphing'] = ''
    const animation = card.animate([frame(before, !open), frame(after, open)], {
      duration: Number.parseFloat(style.getPropertyValue('--dur-m')),
      easing: style.getPropertyValue('--ease').trim(),
    })
    morphRef.current = animation
    const settle = () => {
      if (morphRef.current !== animation) return
      morphRef.current = null
      delete card.dataset['morphing']
      // 变形期间量到的是动画中的宽度；选区在这期间变了（如拖完段松手）的话，按落定的宽度重摆。
      place()
    }
    animation.finished.then(settle, settle)
  })

  // 选区外框刚挂上（第一次选中、拖完段松手）：时间线排在卡后面，上面那次重摆时它的 ref 还没接上，
  // 等这一轮提交的 ref 都接好再摆一次。
  const anchorSeenRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (anchorRef.current === anchorSeenRef.current) return
    anchorSeenRef.current = anchorRef.current
    place()
  })

  // 舞台变大小、时间线横向滚动（窄屏）时重摆。
  useEffect(() => {
    const card = cardRef.current
    const stage = card?.offsetParent
    const observer = new ResizeObserver(() => place())
    if (card !== null && card !== undefined) observer.observe(card)
    if (stage instanceof HTMLElement) observer.observe(stage)
    const onScroll = () => place()
    window.addEventListener('scroll', onScroll, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [])

  return (
    <div className="video-editor-card" data-state={open ? 'open' : 'collapsed'} ref={cardRef}>
      {open ? (
        <section
          aria-label="AI 改段"
          className="video-editor-card-body animate-in duration-(--dur-m) ease-(--ease-decel) fade-in motion-reduce:animate-none"
        >
          <div className="video-editor-card-head">
            <span className="video-editor-card-frames">
              <Thumb className="video-editor-card-frame" src={frames.first} />
              <Icon decorative name="next" size="xs" />
              <Thumb className="video-editor-card-frame" src={frames.last} />
            </span>
            <div className="video-editor-card-title">
              <p>{title}</p>
              <p>{detail}</p>
            </div>
            <IconButton label="收起" name="close" onClick={onCollapse} size="sm" />
          </div>
          <CardComposer
            draft={draft}
            focusInput={focusInput}
            modelPicker={modelPicker}
            onInputFocused={() => setFocusInput(false)}
            onDraftChange={onDraftChange}
            onUploadsDropped={onUploadsDropped}
            onSubmit={onGenerate}
            sending={generating}
            submitDisabled={!canGenerate}
          />
          {alerts}
        </section>
      ) : (
        <button
          aria-label={`展开 ${title}${unfinished ? '，写了一半' : ''}`}
          className="video-editor-card-mini animate-in ui-focus duration-(--dur-m) ease-(--ease-decel) fade-in motion-reduce:animate-none"
          onClick={() => {
            setFocusInput(true)
            onExpand()
          }}
          ref={miniRef}
          type="button"
        >
          <Thumb className="video-editor-card-mini-frame" src={frames.first} />
          <span>{title}</span>
          {unfinished ? <span className="video-editor-card-mini-note">· 写了一半</span> : null}
          <Icon decorative name="collapse" size="sm" />
        </button>
      )}
    </div>
  )
}
