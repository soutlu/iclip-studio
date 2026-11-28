import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type PointerEvent,
  type ReactElement,
} from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import { MEDIA_AUDIO_ACCEPT, uploadMediaFile } from '@/shared/api/media-upload'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import {
  AUDIO_KIND_LABELS,
  AudioCover,
  AuditionBuffering,
  AuditionButton,
  audioDurationText,
  type AudioCoverTraits,
  type Audition,
} from '@/shared/ui/audition'
import { IconButton } from '@/shared/ui/button'
import { ChipGroup, FilterChip } from '@/shared/ui/chip'
import { Composer, type ComposerHandle } from '@/shared/ui/composer'
import { Input } from '@/shared/ui/field'
import { useFileDropTarget } from '@/shared/ui/file-drop'
import { InlineAlert } from '@/shared/ui/inline-alert'
import {
  ContextMenuItem,
  ContextMenuRoot,
  ContextMenuSurface,
  ContextMenuTrigger,
} from '@/shared/ui/menu'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import { DRAG_THRESHOLD, releasePointer, useClickAfterDrag } from '../editing/timeline-drag'
import { useAudioPeaks } from '../editing/media-analysis'
import { useStableValue } from '../editing/use-stable-value'
import { filmViewQuery } from '../film/film.api'
import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'
import {
  filterAudio,
  firstAudioClipOf,
  LIBRARY_FILTERS,
  type ConversationAudio,
  type LibraryAudio,
  type LibraryKind,
  type LibraryScope,
} from './audio'
import { AudioRowWave, RowClock, TabAuditionBar } from './audio-card'
import { AudioLibrary } from './audio-library'
import type { CarryPoint } from './items-tab'
import type { FilmClip } from './composition/film'
import { useEditorEscape } from './editor-keys'
import { EmptyNote } from './empty-note'
import { MediaRow, RowProgress, UsedBadge } from './media-row'
import { TraitFilters } from './trait-filters'
import type { NewAudio } from './use-film-session'
import { useTabAudition } from './use-tab-audition'
import {
  refreshConversationMusic,
  submitMusic,
  useConversationMusic,
  useConversationTaskId,
} from './final-cut.api'

const MAX_PROMPT_CHARS = 3000

/** final-cut 里用着的那一行：行尾常驻的徽标，也接在整行按钮的名字后面。 */
const USED_LABEL = '已用'

const LIBRARY_KINDS: readonly LibraryKind[] = ['bgm', 'sfx']

/** 本对话的音频没有曲风情绪：封面按配乐、按编号挑。 */
const CONVERSATION_TRAITS: AudioCoverTraits = { audioKind: 'bgm' }

type AudioTabProps = {
  conversationId: string
  /** 这个页签是不是正显示着；被藏起来时停止试听。 */
  active: boolean
  /** final-cut 里现有的片段：看哪条音频用着、用在哪个片段上。 */
  clips: readonly FilmClip[]
  /** 点没用过的一行或它行尾的「+」、右键「加到播放头」或按 Enter。 */
  onAdd: (audio: NewAudio) => void
  /** 拖着一行移动；null 是拖动取消了。 */
  onCarry: (audio: NewAudio, point: CarryPoint | null) => void
  /** 拖着一行松手。 */
  onDrop: (audio: NewAudio, point: CarryPoint) => void
  /** 点 final-cut 里用着的那一行：选中最早用它的那个片段。 */
  onReveal: (clipId: string) => void
  onNotice: (message: string) => void
}

const statusLabel = (status: GenerationJob['status']) =>
  status === 'pending'
    ? '排队中'
    : isRunningStatus(status)
      ? '生成中'
      : status === 'completed'
        ? '已就绪'
        : '生成失败'

/** 还没生成完、生成失败的音频盖在封面上的状态：生成中是跳动的竖条，排队中是时钟，失败是警示。 */
function MusicStatus({ status }: { status: GenerationJob['status'] }) {
  const running = status !== 'pending' && isRunningStatus(status)
  return (
    <span
      aria-label={statusLabel(status)}
      className={cn('wf-music-status', status === 'failed' && 'is-failed')}
      role="img"
    >
      {running ? (
        <span aria-hidden="true" className="wf-music-pulse">
          <i />
          <i />
          <i />
        </span>
      ) : (
        <Icon decorative name={status === 'pending' ? 'final-cut-duration' : 'alert'} size="sm" />
      )}
    </span>
  )
}

const isReady = (audio: ConversationAudio): audio is ConversationAudio & { url: string } =>
  audio.status === 'completed' && audio.url !== null

/** 页签里的两块：这段对话的音频，参考音频库里的配乐和音效。 */
type AudioView = 'conversation' | 'library'

export function AudioTab({
  conversationId,
  active,
  clips,
  onAdd,
  onCarry,
  onDrop,
  onReveal,
  onNotice,
}: AudioTabProps) {
  const queryClient = useQueryClient()
  const music = useConversationMusic(conversationId)
  const items = music.data ?? []
  const [query, setQuery] = useState('')
  const shown = filterAudio(items, query)

  // 本对话的音频不带波形，上传的也不记时长：和时间线一样从音频文件里读
  const readyUrls = useStableValue(items.flatMap((item) => (isReady(item) ? [item.url] : [])))
  const peaks = useAudioPeaks(readyUrls)
  /** 构建待加入轨道的音频数据；尚不满足加入条件时返回不可加入的原因文案。 */
  const addable = (item: ConversationAudio): NewAudio | string => {
    if (!isReady(item))
      return item.status === 'failed'
        ? '音乐生成失败，无法加入轨道；请重新生成'
        : '音乐尚未生成完成，无法加入轨道；请等待生成完成'
    const state = item.durationMs === null ? peaks.get(item.url) : undefined
    const duration =
      item.durationMs ??
      (state?.kind === 'ready' ? Math.round(state.peaks.duration * 1000) : undefined)
    if (duration === undefined)
      return state === undefined || state.kind === 'loading'
        ? '正在读取音频时长，请稍后加入轨道'
        : '音频时长读取失败，无法加入轨道'
    return { label: item.title, src: item.url, mediaStart: 0, duration }
  }
  const peaksOf = (item: ConversationAudio | LibraryAudio) => {
    if ('reference' in item) return item.reference.peaks
    const state = item.url === null ? undefined : peaks.get(item.url)
    return state?.kind === 'ready' ? state.peaks.peaks : null
  }

  // 「本对话」和「音频库」两块：搜索框共用，本对话的按名字筛，音频库的按它去搜
  const [view, setView] = useState<AudioView>('conversation')
  const [scope, setScope] = useState<LibraryScope>({ kind: 'bgm', traits: {} })
  // 选中片段时侧栏自动切到「属性」，这个页签只是藏起来、没有卸掉：试听要跟着停，不然声音在放、控件却看不见。
  // 两块共用一个试听和底部的试听条，切换「本对话 / 音频库」时停下
  const {
    audition,
    toggle,
    shown: auditioning,
  } = useTabAudition({
    active,
    onError: () => onNotice('音频试听失败，请重试'),
  })
  const showView = (next: AudioView) => {
    if (next === view) return
    audition.stop()
    setView(next)
  }
  const rowFor = (item: ConversationAudio | LibraryAudio, ready: NewAudio | string) => {
    const used = item.url === null ? undefined : firstAudioClipOf(clips, item.url)
    const durationMs = typeof ready === 'string' ? item.durationMs : ready.duration
    const traits = 'reference' in item ? item.reference : CONVERSATION_TRAITS
    const start = () => {
      if (isReady(item))
        toggle({
          id: item.id,
          url: item.url,
          title: item.title,
          peaks: peaksOf(item),
          traits,
          durationMs: durationMs ?? 0,
        })
    }
    return (
      <AudioRow
        addable={ready}
        audio={item}
        audition={audition}
        conversationId={conversationId}
        key={item.id}
        onAdd={() => (typeof ready === 'string' ? onNotice(ready) : onAdd(ready))}
        onCarry={(point) => {
          if (typeof ready !== 'string') onCarry(ready, point)
        }}
        onDrop={(point) => {
          if (typeof ready !== 'string') onDrop(ready, point)
        }}
        onNotice={onNotice}
        onReveal={() => {
          if (used !== undefined) onReveal(used.id)
        }}
        onStartAt={(ratio) => {
          start()
          audition.seek(ratio, durationMs ?? undefined)
        }}
        onToggle={start}
        peaks={peaksOf(item)}
        traits={traits}
        used={used !== undefined}
      />
    )
  }

  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const upload = async (files: File[]) => {
    setUploading(true)
    // 导入的音频进「本对话」：在音频库里导入时切过去，好看到新的一条
    showView('conversation')
    for (const file of files) {
      try {
        await uploadMediaFile(file, 'audio', { conversationId })
        await refreshConversationMusic(queryClient, conversationId)
      } catch (error) {
        onNotice(errorMessageOf(error, '音频导入失败，请重试'))
      }
    }
    setUploading(false)
  }
  const drop = useFileDropTarget({
    blocked: uploading,
    onFiles: (files) => void upload(files),
    onDirectory: () => onNotice('拖入的是文件夹，无法导入；请拖入音频文件'),
  })

  const search = (
    <Input
      aria-label="搜索音频"
      leadingIcon="final-cut-search"
      onChange={(event) => setQuery(event.currentTarget.value)}
      placeholder="搜索"
      type="search"
      value={query}
      wrapperClassName="wf-field wf-search"
    />
  )
  const top = (
    <div className="wf-audio-top">
      <ChipGroup
        aria-label="音频来源"
        className="wf-seg"
        onValueChange={(value) => {
          if (value === 'conversation' || value === 'library') showView(value)
        }}
        type="single"
        value={view}
        variant="segmented"
      >
        <FilterChip className="wf-seg-item" value="conversation" variant="segmented">
          本对话
        </FilterChip>
        <FilterChip className="wf-seg-item" value="library" variant="segmented">
          音频库
        </FilterChip>
      </ChipGroup>
      <div className="wf-audio-tools">
        <GenerateMusic
          conversationId={conversationId}
          onNotice={onNotice}
          onSubmitted={() => showView('conversation')}
        >
          <button
            aria-label="生成音乐"
            className="wf-chip-btn is-soft ui-state ui-focus"
            type="button"
          >
            <Icon decorative name="final-cut-generate" size="sm" />
            生成
          </button>
        </GenerateMusic>
        <IconButton
          className="wf-audio-import"
          disabled={uploading}
          label="导入音频"
          name={uploading ? 'loading' : 'final-cut-upload'}
          onClick={() => fileRef.current?.click()}
          size="sm"
          tooltip="导入音频"
        />
        <input
          accept={MEDIA_AUDIO_ACCEPT}
          aria-label="选择音频文件"
          className="hidden"
          multiple
          onChange={(event) => {
            const files = [...(event.target.files ?? [])]
            event.target.value = ''
            if (files.length > 0) void upload(files)
          }}
          ref={fileRef}
          tabIndex={-1}
          type="file"
        />
      </div>
    </div>
  )
  const bar =
    auditioning === null ? null : <TabAuditionBar audition={audition} item={auditioning} />
  if (view === 'library')
    return (
      <div className="wf-audio">
        <div className="wf-tab-head">
          {top}
          {search}
          <div className="wf-audio-filters">
            <ChipGroup
              aria-label="音频库分类"
              className="wf-filters"
              onValueChange={(value) => {
                const kind = LIBRARY_KINDS.find((each) => each === value)
                // 换子类时清掉属性筛选，关键词留着
                if (kind !== undefined) setScope({ kind, traits: {} })
              }}
              type="single"
              value={scope.kind}
            >
              {LIBRARY_KINDS.map((kind) => (
                <FilterChip className="wf-filter" key={kind} value={kind}>
                  {AUDIO_KIND_LABELS[kind]}
                </FilterChip>
              ))}
            </ChipGroup>
            <TraitFilters
              keys={LIBRARY_FILTERS[scope.kind]}
              onChange={(traits) => setScope({ ...scope, traits })}
              value={scope.traits}
            />
          </div>
        </div>
        <AudioLibrary
          query={query}
          renderRow={(item) =>
            rowFor(item, {
              label: item.title,
              src: item.url,
              mediaStart: 0,
              duration: item.durationMs,
            })
          }
          scope={scope}
        />
        {bar}
      </div>
    )

  return (
    <div className={cn('wf-audio', drop.dragOver && 'is-over')} {...drop.dragHandlers}>
      <div className="wf-tab-head">
        {top}
        {search}
      </div>
      {music.isError ? (
        <div className="wf-audio-alert">
          <InlineAlert
            action={{ label: '重试', onClick: () => void music.refetch() }}
            message={errorMessageOf(music.error, '读取音频失败')}
          />
        </div>
      ) : music.isPending ? (
        <EmptyNote icon="final-cut-music">正在读取音频…</EmptyNote>
      ) : items.length === 0 ? (
        <EmptyNote icon="final-cut-music">暂无音频，请点击「生成」或「导入音频」</EmptyNote>
      ) : shown.length === 0 ? (
        <EmptyNote icon="final-cut-music">暂无符合条件的音频，请更换关键词</EmptyNote>
      ) : (
        <ul aria-label="音频" className="wf-tab-list wf-audio-list">
          {shown.map((item) => rowFor(item, addable(item)))}
        </ul>
      )}
      {bar}
    </div>
  )
}

type Press = { pointerId: number; originX: number; originY: number; moved: boolean }

type AudioRowProps = {
  /** 本对话的音频，或「音频库」里的一条（带库里那条的波形和属性）。 */
  audio: ConversationAudio | LibraryAudio
  conversationId: string
  addable: NewAudio | string
  used: boolean
  /** 页签共用的试听：看这一行是不是当前那条、在不在放。 */
  audition: Audition
  /** 波形峰值；还没读到、读不出来时是 null（这时试听中的行展开一条细进度条）。 */
  peaks: readonly number[] | null
  /** 封面按它挑插画。 */
  traits: AudioCoverTraits
  onToggle: () => void
  /** 点没在试听的这一行的波形：从点到的比例处开始试听。 */
  onStartAt: (ratio: number) => void
  onAdd: () => void
  onCarry: (point: CarryPoint | null) => void
  onDrop: (point: CarryPoint) => void
  onReveal: () => void
  onNotice: (message: string) => void
}

/**
 * 一条音频（媒体行，见 `MediaRow`）：左边插画封面（音效是圆形试听键），中间名字和对称波形，右边时长
 * （试听中是「当前 / 总长」，悬停时换成「+」），用着的常驻「✓ 已用」。整行点了加入配乐行，也能拖进时间线。
 */
function AudioRow({
  audio,
  conversationId,
  addable,
  used,
  audition,
  peaks,
  traits,
  onToggle,
  onStartAt,
  onAdd,
  onCarry,
  onDrop,
  onReveal,
  onNotice,
}: AudioRowProps) {
  const title = audio.title
  const ready = isReady(audio)
  const current = audition.current === audio.id
  const playing = audition.playing === audio.id
  const durationMs = typeof addable === 'string' ? audio.durationMs : addable.duration
  const pressRef = useRef<Press | null>(null)
  const clickAfterDrag = useClickAfterDrag()
  const [lifting, setLifting] = useState(false)

  const press = (event: PointerEvent<HTMLButtonElement>) => {
    // 还加不了的不起拖，松手也不会落进 final-cut
    if (event.button !== 0 || typeof addable === 'string') return
    event.currentTarget.setPointerCapture(event.pointerId)
    clickAfterDrag.reset()
    pressRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      moved: false,
    }
  }
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const current = pressRef.current
    if (current === null || current.pointerId !== event.pointerId) return
    if (!current.moved) {
      const distance = Math.hypot(event.clientX - current.originX, event.clientY - current.originY)
      if (distance <= DRAG_THRESHOLD) return
      current.moved = true
      setLifting(true)
    }
    onCarry({ clientX: event.clientX, clientY: event.clientY })
  }
  const release = (event: PointerEvent<HTMLButtonElement>) => {
    const current = pressRef.current
    if (current === null || current.pointerId !== event.pointerId) return
    releasePointer(event)
    pressRef.current = null
    setLifting(false)
    if (!current.moved) return
    clickAfterDrag.swallow()
    onDrop({ clientX: event.clientX, clientY: event.clientY })
  }
  const cancel = () => {
    if (pressRef.current?.moved === true) {
      clickAfterDrag.swallow()
      onCarry(null)
    }
    pressRef.current = null
    setLifting(false)
  }
  useEditorEscape(lifting, cancel)

  // 还加不了的行点了什么都不做，按 Enter、右键时才说明原因
  const addsOnClick = typeof addable !== 'string'
  const hit = (
    <ContextMenuRoot>
      <ContextMenuTrigger asChild>
        <button
          aria-keyshortcuts="Enter"
          aria-label={used ? `${title}，${USED_LABEL}` : title}
          className={cn('wf-row-hit', !addsOnClick && !used && 'is-inert')}
          onClick={() => {
            if (clickAfterDrag.take()) return
            if (used) onReveal()
            else if (addsOnClick) onAdd()
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            onAdd()
          }}
          onPointerCancel={cancel}
          onPointerDown={press}
          onPointerMove={move}
          onPointerUp={release}
          type="button"
        />
      </ContextMenuTrigger>
      <ContextMenuSurface aria-label={title} className="wf-menu">
        <ContextMenuItem onSelect={onAdd}>加到播放头</ContextMenuItem>
      </ContextMenuSurface>
    </ContextMenuRoot>
  )
  const cover =
    'reference' in audio && audio.reference.audioKind === 'sfx' ? (
      <AuditionButton
        label={playing ? `暂停试听：${title}` : `试听：${title}`}
        onToggle={onToggle}
        playing={playing}
      >
        {current ? <AuditionBuffering audition={audition} /> : null}
      </AuditionButton>
    ) : (
      <AudioCover
        id={audio.id}
        onToggle={ready ? onToggle : undefined}
        size="sm"
        state={playing ? 'playing' : current ? 'paused' : 'idle'}
        title={title}
        traits={traits}
      >
        {ready ? null : <MusicStatus status={audio.status} />}
        {current ? <AuditionBuffering audition={audition} /> : null}
      </AudioCover>
    )
  const failure =
    audio.status === 'failed' ? (
      <span className="wf-media-actions">
        {audio.generated ? (
          <GenerateMusic conversationId={conversationId} initialPrompt={title} onNotice={onNotice}>
            <IconButton label={`重新生成：${title}`} name="refresh" size="xs" />
          </GenerateMusic>
        ) : null}
        <PopupRoot>
          <PopupTrigger asChild>
            <IconButton label={`查看失败原因：${title}`} name="final-cut-more" size="xs" />
          </PopupTrigger>
          <PopupSurface
            align="end"
            aria-label={`失败原因：${title}`}
            className="wf-music-details"
            collisionPadding={16}
            sideOffset={6}
          >
            <strong>{statusLabel(audio.status)}</strong>
            {audio.errorMessage !== null ? (
              <p className="wf-music-error">{audio.errorMessage}</p>
            ) : null}
            <p>{title}</p>
          </PopupSurface>
        </PopupRoot>
      </span>
    ) : undefined
  return (
    <MediaRow
      badge={used ? <UsedBadge>{USED_LABEL}</UsedBadge> : undefined}
      className={cn(lifting && 'is-lifting')}
      cover={cover}
      current={current}
      detail={
        ready && peaks !== null ? (
          <AudioRowWave
            audition={audition}
            current={current}
            durationMs={durationMs ?? 0}
            onStartAt={onStartAt}
            peaks={peaks}
            title={title}
          />
        ) : undefined
      }
      end={
        !ready || durationMs === null ? undefined : current ? (
          <RowClock audition={audition} durationMs={durationMs} />
        ) : (
          <span className="wf-media-duration">{audioDurationText(durationMs)}</span>
        )
      }
      actions={
        failure ??
        (addsOnClick && !used ? (
          // 整行已能用 Enter 加入，「+」不再占一个 Tab 停靠点
          <IconButton
            label={`放入配乐行：${title}`}
            name="final-cut-add"
            onClick={onAdd}
            size="xs"
            tabIndex={-1}
            tooltip="放入配乐行"
          />
        ) : undefined)
      }
      hit={hit}
      title={title}
    >
      {ready && peaks === null ? (
        <RowProgress
          audition={audition}
          current={current}
          durationMs={durationMs ?? 0}
          label={`播放进度：${title}`}
        />
      ) : null}
    </MediaRow>
  )
}

const isMissing = (error: unknown) => error instanceof ApiError && error.status === 404

/** 描述框下面的快捷描述：点一下把描述换成它。 */
const MUSIC_PRESETS = [
  { label: '木吉他', prompt: '轻快温暖的原声木吉他，松弛早秋亚麻氛围' },
  { label: '都市轻快', prompt: '松弛都市轻节奏，柔和电钢琴' },
  { label: '极简钢琴', prompt: '清澈极简钢琴尾奏，温暖留白' },
] as const

/**
 * 点 `children` 弹出生成音乐的输入框；`initialPrompt` 是重新生成时沿用的描述，
 * `onSubmitted` 在提交成功、输入框收起后调。
 */
export function GenerateMusic({
  conversationId,
  onNotice,
  onSubmitted,
  children,
  initialPrompt,
}: {
  conversationId: string
  onNotice: (message: string) => void
  onSubmitted?: () => void
  children: ReactElement
  initialPrompt?: string
}) {
  const queryClient = useQueryClient()
  const hintId = useId()
  const [composer, setComposer] = useState<ComposerHandle | null>(null)
  const [open, setOpen] = useState(false)
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null)
  const [typed, setTyped] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const task = useConversationTaskId(conversationId)
  const film = useQuery({
    ...filmViewQuery(conversationId),
    enabled: open,
    retry: (count, error) => !isMissing(error) && count < 1,
  })
  const musicDescription = film.data?.film.musicDescription ?? ''
  const suggested = initialPrompt ?? musicDescription
  const text = (typed ?? suggested).trim()
  const reason = submitting
    ? '正在提交，请稍候'
    : task.isError
      ? '对话信息读取失败，无法生成；请刷新页面后重试'
      : task.data === undefined
        ? '正在读取对话信息，请稍后再试'
        : text === ''
          ? '尚未填写音乐描述，无法生成；请用一句话描述想要的音乐'
          : text.length > MAX_PROMPT_CHARS
            ? `描述超过 ${MAX_PROMPT_CHARS} 字，无法生成；请精简至 ${MAX_PROMPT_CHARS} 字以内`
            : undefined
  const hint =
    reason ??
    (initialPrompt !== undefined && text === initialPrompt.trim()
      ? '已填入上次的描述，可直接修改'
      : initialPrompt === undefined && text === musicDescription.trim()
        ? '已填入工程文件中的配乐描述，可直接修改'
        : '生成后可在「配乐」页签的列表中查看')

  const fill = useEffectEvent((target: ComposerHandle) =>
    target.restore({ media: [], parts: text === '' ? [] : [{ kind: 'text', text }], text: '' }),
  )
  const pristine = typed === null
  useEffect(() => {
    if (composer !== null) fill(composer)
  }, [composer])
  useEffect(() => {
    if (composer !== null && pristine) fill(composer)
  }, [composer, pristine, suggested])

  const fillPreset = (prompt: string) => {
    setTyped(prompt)
    composer?.restore({ media: [], parts: [{ kind: 'text', text: prompt }], text: '' })
    composer?.focus()
  }

  const generate = async (prompt: string) => {
    if (reason !== undefined) return
    setSubmitting(true)
    try {
      const job = await submitMusic({ conversationId, prompt, taskId: task.data ?? null })
      await refreshConversationMusic(queryClient, conversationId, job)
      setOpen(false)
      setTyped(null)
      onSubmitted?.()
    } catch (error) {
      onNotice(errorMessageOf(error, '音乐生成提交失败'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <PopupRoot onOpenChange={setOpen} open={open}>
      <PopupTrigger asChild ref={setTrigger}>
        {children}
      </PopupTrigger>
      {/* 触发的「生成」「重新生成」都在右边，输入卡和它们右对齐 */}
      <PopupSurface
        align="end"
        aria-describedby={hintId}
        aria-label="生成音乐"
        className="wf-generate"
        collisionPadding={16}
        container={trigger?.parentElement ?? null}
        side="bottom"
        sideOffset={6}
      >
        <div className="wf-generate-head">
          <p className="wf-generate-title">生成音乐</p>
          <p
            className={cn('wf-generate-hint', reason !== undefined && !submitting && 'is-blocked')}
            id={hintId}
          >
            {hint}
          </p>
        </div>
        <Composer
          ariaLabel="音乐描述"
          attachmentsEnabled={false}
          className="wf-field ui-state"
          leading={
            <div aria-label="快捷描述" className="wf-generate-presets" role="group">
              {MUSIC_PRESETS.map((preset) => (
                <button
                  className="wf-generate-preset ui-state ui-focus"
                  key={preset.label}
                  onClick={() => fillPreset(preset.prompt)}
                  type="button"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          }
          onChange={(parts) =>
            setTyped(parts.map((part) => (part.kind === 'text' ? part.text : '')).join(''))
          }
          onSubmit={(submission) => void generate(submission.text)}
          placeholder={
            film.isPending && open
              ? '正在读取工程文件中的配乐…'
              : '描述想要的音乐：风格、情绪、乐器、节奏'
          }
          ref={setComposer}
          sending={submitting}
          submitAction={{
            disabled: reason !== undefined,
            emphasis: 'primary',
            icon: 'final-cut-music',
            label: '生成音乐',
            pendingLabel: '正在提交',
            size: 'sm',
          }}
          toolbarClassNames={{ leading: 'min-w-0' }}
        />
      </PopupSurface>
    </PopupRoot>
  )
}
