import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { IconButton } from '@/shared/ui/button'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import {
  Composer,
  readyAttachment,
  type ComposerAttachmentPreviewOf,
  type ComposerHandle,
  type ComposerMention,
  type ComposerPart,
  type ComposerSubmission,
} from '@/shared/ui/composer'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { MAX_FIRST_FRAMES } from '../edit-prompt'
import { editMentionItems, type EditMentionItem } from '../image-edit/edit-mention-items'
import { EditMentionMenu } from '../image-edit/edit-mention-menu'
import { placeCard } from '../editing/card-placement'
import {
  referenceImageCountOf,
  type ClipGenerationBlock,
  type ClipGenerationMode,
} from './clip-generation'
import './ai-edit-card.css'

type Box = { width: number; height: number; left: number }

const measure = (card: HTMLElement): Box => ({
  width: card.offsetWidth,
  height: card.offsetHeight,
  left: card.offsetLeft,
})

function Thumb({ src, className }: { src: string | undefined; className: string }) {
  const [failed, setFailed] = useState<string>()
  return src === undefined || failed === src ? (
    <span aria-hidden="true" className={cn(className, 'is-empty')} />
  ) : (
    <img alt="" className={className} draggable={false} onError={() => setFailed(src)} src={src} />
  )
}

type DraftChange = (parts: readonly ComposerPart[]) => void

type GenerationBlockOf = (referenceImageCount: number) => ClipGenerationBlock | undefined

type CardComposerProps = {
  draft: readonly ComposerPart[]
  onDraftChange: DraftChange
  onUploadsDropped: (count: number) => void
  appending: readonly string[]
  onAppended: () => void
  focusInput: boolean
  onInputFocused: () => void
  submitDisabled: boolean
  sending: boolean
  onSubmit: (submission: ComposerSubmission) => void
  modelPicker: ReactNode
  durationControl: ReactNode
  mode: ClipGenerationMode
  onModeChange: (mode: ClipGenerationMode) => void
  firstFrameReferenceUrl: string | undefined
  referenceLimit: number | undefined
  generationBlockOf: GenerationBlockOf
  attachmentPreview?: ComposerAttachmentPreviewOf | undefined
}

const restoreInto = (composer: ComposerHandle, parts: readonly ComposerPart[]) =>
  composer.restore({
    media: parts.flatMap((part) => (part.kind === 'media' ? [part.media] : [])),
    parts,
    text: '',
  })

function CardComposer({
  draft,
  onDraftChange,
  onUploadsDropped,
  appending,
  onAppended,
  focusInput,
  onInputFocused,
  submitDisabled,
  sending,
  onSubmit,
  modelPicker,
  durationControl,
  mode,
  onModeChange,
  firstFrameReferenceUrl,
  referenceLimit,
  generationBlockOf,
  attachmentPreview,
}: CardComposerProps) {
  const { data: user } = useUser()
  const composerRef = useRef<ComposerHandle>(null)
  const [initial] = useState(draft)
  const [focusOnMount] = useState(focusInput)
  const [parts, setParts] = useState(draft)
  const partsRef = useRef<readonly ComposerPart[]>(draft)
  const focused = useEffectEvent(onInputFocused)
  const dropped = useEffectEvent(onUploadsDropped)
  const appended = useEffectEvent(onAppended)

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
    if (initial.length > 0) restoreInto(composer, initial)
    if (focusOnMount) {
      composer.focus()
      focused()
    }
  }, [initial, focusOnMount])

  useEffect(() => {
    const composer = composerRef.current
    if (composer === null || appending.length === 0) return
    let hasContent = partsRef.current.length > 0
    for (const text of appending) {
      composer.append([{ kind: 'text', text: hasContent ? `\n${text}` : text }])
      hasContent = true
    }
    appended()
  }, [appending])

  const remaining = (limit: number) => limit - referenceImageCountOf(partsRef.current)
  const referenceCount = referenceImageCountOf(parts)
  const exceedsReferenceLimit = referenceLimit !== undefined && referenceCount > referenceLimit
  const block = generationBlockOf(referenceCount)
  const hasText = parts.some((part) => part.kind === 'text' && part.text.trim() !== '')

  const images = parts.flatMap((part) =>
    part.kind === 'media' && part.media.status === 'ready' && part.media.url !== undefined
      ? [{ name: part.media.name, url: part.media.url }]
      : [],
  )
  const candidates = [
    ...(firstFrameReferenceUrl === undefined
      ? []
      : [{ name: '选区首帧', url: firstFrameReferenceUrl }]),
    ...images.map((image) =>
      image.name === '选区首帧' && image.url !== firstFrameReferenceUrl
        ? { ...image, name: '已引用首帧' }
        : image,
    ),
  ]
  const frames = candidates.filter(
    (frame, index) => candidates.findIndex((candidate) => candidate.url === frame.url) === index,
  )
  const blockedReason = (item: EditMentionItem) =>
    item.kind !== 'frame' ||
    referenceLimit === undefined ||
    images.some((image) => image.url === item.url) ||
    remaining(referenceLimit) > 0
      ? undefined
      : `最多引用 ${referenceLimit} 张图片`
  const mention: ComposerMention<EditMentionItem> = {
    items: (query) => editMentionItems({ annotations: [], baseUrl: undefined, frames, query }),
    partsOf: (item) =>
      item.kind === 'frame' && blockedReason(item) === undefined
        ? [
            {
              kind: 'media',
              media: readyAttachment({ kind: 'image', name: item.name, url: item.url }),
            },
          ]
        : undefined,
    render: (menu) => (
      <EditMentionMenu blockedReason={blockedReason} frames="可引用图片" menu={menu} />
    ),
  }

  return (
    <>
      <Composer<never, EditMentionItem>
        accept="image"
        ariaLabel="修改要求"
        attachmentPreview={attachmentPreview}
        attachmentLimit={
          referenceLimit === undefined
            ? undefined
            : {
                notice: (dropped) => `参考图最多 ${referenceLimit} 张，本次有 ${dropped} 张未添加`,
                remaining: () => remaining(referenceLimit),
              }
        }
        attachmentsEnabled={hasPermission(user, PERMISSION.uploadsWrite)}
        className="video-editor-card-composer"
        dropScope="card"
        leading={
          <>
            <ChipGroup
              aria-label="生成方式"
              className="storyboard-bar-segmented"
              disabled={sending}
              onValueChange={(next) => {
                if (next === 'image' || next === 'edit') onModeChange(next)
              }}
              type="single"
              value={mode}
              variant="segmented"
            >
              <FilterChip className="storyboard-bar-segment" value="image" variant="segmented">
                图生
              </FilterChip>
              <FilterChip className="storyboard-bar-segment" value="edit" variant="segmented">
                编辑
              </FilterChip>
            </ChipGroup>
            {durationControl}
          </>
        }
        mention={mention}
        onChange={(next) => {
          partsRef.current = next
          setParts(next)
          const ready = next.filter(
            (part) => part.kind !== 'media' || part.media.status === 'ready',
          )
          onDraftChange(ready)
        }}
        onSubmit={onSubmit}
        placeholder={
          mode === 'image'
            ? '描述画面与动作，输入 @ 引用首帧，也可粘贴或拖入图片'
            : '描述该段的修改要求，输入 @ 引用图片，也可粘贴或拖入参考图'
        }
        ref={composerRef}
        sending={sending}
        submitAction={{
          // 首帧、尾帧不写进正文，只有它们时正文是空的，交不上去。
          disabled:
            submitDisabled ||
            exceedsReferenceLimit ||
            block !== undefined ||
            ((mode === 'edit' || referenceCount <= MAX_FIRST_FRAMES) && !hasText),
          emphasis: 'primary',
          icon: 'video',
          label: '生成视频',
          pendingLabel: '正在提交',
          size: 'sm',
        }}
        toolbarClassNames={{
          row: 'video-editor-card-toolbar',
          leading: 'video-editor-card-toolbar-leading',
          trailing: 'video-editor-card-toolbar-trailing',
        }}
        trailing={modelPicker}
      />
      {exceedsReferenceLimit ? (
        <InlineAlert
          message={`当前模型最多支持 ${referenceLimit} 张参考图，已引用 ${referenceCount} 张，无法生成视频；请删除多出的图片`}
        />
      ) : null}
    </>
  )
}

export type AiEditCardHandle = { appendText: (text: string) => void }

type AiEditCardProps = {
  ref?: Ref<AiEditCardHandle>
  open: boolean
  onExpand: () => void
  onCollapse: () => void
  anchorRef: RefObject<HTMLElement | null>
  positions: string
  detail: string
  frames: { first: string | undefined; last: string | undefined }
  draft: readonly ComposerPart[]
  onDraftChange: DraftChange
  onUploadsDropped: (count: number) => void
  canGenerate: boolean
  generating: boolean
  onGenerate: (submission: ComposerSubmission) => void
  modelPicker: ReactNode
  durationControl: ReactNode
  mode: ClipGenerationMode
  onModeChange: (mode: ClipGenerationMode) => void
  firstFrameReferenceUrl: string | undefined
  referenceLimit: number | undefined
  generationBlockOf: GenerationBlockOf
  attachmentPreview?: ComposerAttachmentPreviewOf | undefined
  alerts: ReactNode
}

export function AiEditCard({
  ref,
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
  durationControl,
  mode,
  onModeChange,
  firstFrameReferenceUrl,
  referenceLimit,
  generationBlockOf,
  attachmentPreview,
  alerts,
}: AiEditCardProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const miniRef = useRef<HTMLButtonElement>(null)
  const boxRef = useRef<Box | null>(null)
  const wasOpenRef = useRef(open)
  const morphRef = useRef<Animation | null>(null)
  const [focusInput, setFocusInput] = useState(false)
  const [appending, setAppending] = useState<readonly string[]>([])
  const title = `${positions} · 视频生成`
  const unfinished = draft.some((part) => part.kind === 'media' || part.text.trim() !== '')

  useImperativeHandle(
    ref,
    () => ({
      appendText: (text) => {
        setAppending((queued) => [...queued, text])
        onExpand()
      },
    }),
    [onExpand],
  )

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

  useLayoutEffect(() => {
    const card = cardRef.current
    const before = boxRef.current
    const toggled = wasOpenRef.current !== open
    wasOpenRef.current = open
    if (toggled && card !== null) {
      morphRef.current?.cancel()
      morphRef.current = null
      delete card.dataset['morphing']
    }
    place()
    if (!toggled || card === null) return
    const active = document.activeElement
    if (!open && (active === null || active === document.body || active.contains(card)))
      miniRef.current?.focus()
    const after = boxRef.current
    if (before === null || after === null) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const style = getComputedStyle(card)
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
      // 动画期间读到的 offsetWidth 是动画中的尺寸，落定后按最终尺寸重摆。
      place()
    }
    animation.finished.then(settle, settle)
  })

  // 时间线排在卡之后渲染，卡的 layout effect 执行时选区外框的 ref 尚未挂上；等本轮 ref 全部挂好后再摆一次。
  const anchorSeenRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (anchorRef.current === anchorSeenRef.current) return
    anchorSeenRef.current = anchorRef.current
    place()
  })

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
            appending={appending}
            attachmentPreview={attachmentPreview}
            draft={draft}
            durationControl={durationControl}
            firstFrameReferenceUrl={firstFrameReferenceUrl}
            focusInput={focusInput}
            generationBlockOf={generationBlockOf}
            mode={mode}
            modelPicker={modelPicker}
            onAppended={() => setAppending([])}
            onDraftChange={onDraftChange}
            onInputFocused={() => setFocusInput(false)}
            onModeChange={onModeChange}
            onSubmit={onGenerate}
            onUploadsDropped={onUploadsDropped}
            referenceLimit={referenceLimit}
            sending={generating}
            submitDisabled={!canGenerate}
          />
          {alerts}
        </section>
      ) : (
        <button
          aria-label={`展开${title}${unfinished ? '，未提交' : ''}`}
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
          {unfinished ? <span className="video-editor-card-mini-note">· 未提交</span> : null}
          <Icon decorative name="collapse" size="sm" />
        </button>
      )}
    </div>
  )
}
