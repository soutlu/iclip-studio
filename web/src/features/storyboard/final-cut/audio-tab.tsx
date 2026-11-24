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
import { useAudition } from '@/shared/ui/audition'
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
import { durationLabel, filterAudio, firstAudioClipOf, type ConversationAudio } from './audio'
import { AudioLibrary } from './audio-library'
import type { CarryPoint } from './items-tab'
import type { FilmClip } from './composition/film'
import { useEditorEscape } from './editor-keys'
import { EmptyNote } from './empty-note'
import type { NewAudio } from './use-film-session'
import {
  refreshConversationMusic,
  submitMusic,
  useConversationMusic,
  useConversationTaskId,
} from './final-cut.api'

const MAX_PROMPT_CHARS = 3000

/** final-cut 里用着的那一行：行尾那个勾的无障碍名，也接在整行按钮的名字后面。 */
const USED_LABEL = '使用中'

// 名字下面那条迷你波形的竖条高度（视框 14 高）：只是一个「这是音频」的装饰，每行一样，不是这条音频真实的波形
const WAVE_STEP = 4
const WAVE_BARS = [
  5, 9, 12, 7, 4, 8, 13, 10, 6, 3, 7, 11, 13, 8, 5, 9, 12, 6, 4, 8, 11, 7, 5, 3,
].map((height, index) => ({ x: index * WAVE_STEP, height }))

function SongWave() {
  return (
    <svg
      aria-hidden="true"
      className="wf-song-wave"
      viewBox={`0 0 ${WAVE_BARS.length * WAVE_STEP} 14`}
    >
      {WAVE_BARS.map(({ x, height }) => (
        <rect height={height} key={x} rx={1} width={2} x={x} y={(14 - height) / 2} />
      ))}
    </svg>
  )
}

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

function MusicStatus({ status }: { status: GenerationJob['status'] }) {
  const running = status !== 'pending' && isRunningStatus(status)
  return (
    <span
      aria-label={statusLabel(status)}
      className={cn(
        'wf-song-disc wf-music-status',
        running && 'is-running',
        status === 'failed' && 'is-failed',
      )}
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

  // 上传的音频不记时长：和时间线一样从音频文件里读
  const unmeasured = useStableValue(
    items.flatMap((item) => (isReady(item) && item.durationMs === null ? [item.url] : [])),
  )
  const peaks = useAudioPeaks(unmeasured)
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

  // 「本对话」和「音频库」两块：搜索框共用，本对话的按名字筛，音频库的按它去搜
  const [view, setView] = useState<AudioView>('conversation')
  // 选中片段时侧栏自动切到「属性」，这个页签只是藏起来、没有卸掉：试听要跟着停，不然声音在放、控件却看不见；
  // 切到「音频库」时本对话的试听也停
  const { playing, toggle } = useAudition({
    active: active && view === 'conversation',
    onError: () => onNotice('音频试听失败，请重试'),
  })
  const rowFor = (
    item: ConversationAudio,
    ready: NewAudio | string,
    audition: { playing: boolean; onToggle: () => void },
  ) => {
    const used = item.url === null ? undefined : firstAudioClipOf(clips, item.url)
    return (
      <AudioRow
        addable={ready}
        audio={item}
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
        onToggle={audition.onToggle}
        playing={audition.playing}
        used={used !== undefined}
      />
    )
  }

  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const upload = async (files: File[]) => {
    setUploading(true)
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
      placeholder="搜索音频"
      type="search"
      value={query}
      wrapperClassName="wf-field wf-search wf-audio-search"
    />
  )
  const views = (
    <ChipGroup
      aria-label="音频来源"
      className="wf-seg wf-audio-views"
      onValueChange={(value) => {
        if (value === 'conversation' || value === 'library') setView(value)
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
  )
  if (view === 'library')
    return (
      <div className="wf-audio">
        {views}
        <AudioLibrary
          active={active}
          onNotice={onNotice}
          query={query}
          renderRow={(item, audition) =>
            rowFor(
              item,
              { label: item.title, src: item.url, mediaStart: 0, duration: item.durationMs },
              audition,
            )
          }
          search={search}
        />
      </div>
    )

  return (
    <div className={cn('wf-audio', drop.dragOver && 'is-over')} {...drop.dragHandlers}>
      {views}
      <div className="wf-audio-tools">
        <GenerateMusic conversationId={conversationId} onNotice={onNotice}>
          <button className="wf-chip-btn is-soft ui-state ui-focus" type="button">
            <Icon decorative name="final-cut-generate" size="sm" />
            生成音乐
          </button>
        </GenerateMusic>
        <IconButton
          className="wf-audio-import"
          disabled={uploading}
          label="导入音频"
          name={uploading ? 'loading' : 'final-cut-upload'}
          onClick={() => fileRef.current?.click()}
          size="sm"
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
      {search}
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
        <EmptyNote icon="final-cut-music">暂无音频，请点击「生成音乐」或「导入音频」</EmptyNote>
      ) : shown.length === 0 ? (
        <EmptyNote icon="final-cut-music">暂无符合条件的音频，请更换关键词</EmptyNote>
      ) : (
        <ul aria-label="音频" className="wf-tab-list wf-audio-list">
          {shown.map((item) =>
            rowFor(item, addable(item), {
              playing: playing === item.id,
              onToggle: () => {
                if (isReady(item)) toggle(item.id, item.url)
              },
            }),
          )}
        </ul>
      )}
    </div>
  )
}

type Press = { pointerId: number; originX: number; originY: number; moved: boolean }

type AudioRowProps = {
  audio: ConversationAudio
  conversationId: string
  addable: NewAudio | string
  used: boolean
  playing: boolean
  onToggle: () => void
  onAdd: () => void
  onCarry: (point: CarryPoint | null) => void
  onDrop: (point: CarryPoint) => void
  onReveal: () => void
  onNotice: (message: string) => void
}

function AudioRow({
  audio,
  conversationId,
  addable,
  used,
  playing,
  onToggle,
  onAdd,
  onCarry,
  onDrop,
  onReveal,
  onNotice,
}: AudioRowProps) {
  const title = audio.title
  const ready = isReady(audio)
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
  return (
    <li className={cn('wf-song wf-card', playing && 'is-playing', lifting && 'is-lifting')}>
      <ContextMenuRoot>
        <ContextMenuTrigger asChild>
          <button
            aria-keyshortcuts="Enter"
            aria-label={used ? `${title}，${USED_LABEL}` : title}
            className={cn('wf-song-select', !addsOnClick && !used && 'is-inert')}
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
      {ready ? (
        <IconButton
          aria-pressed={playing}
          className="wf-song-disc"
          label={playing ? `暂停试听：${title}` : `试听：${title}`}
          name={playing ? 'final-cut-pause' : 'final-cut-play'}
          onClick={onToggle}
          size="sm"
        />
      ) : (
        <MusicStatus status={audio.status} />
      )}
      <span className="wf-song-text">
        <span className="wf-song-title" title={title}>
          {title}
        </span>
        {ready && durationMs !== null ? (
          <span className="wf-song-meta">
            <SongWave />
            {durationLabel(durationMs)}
          </span>
        ) : null}
      </span>
      {used ? (
        <span aria-label={USED_LABEL} className="wf-song-used" role="img">
          <Icon decorative name="final-cut-in-use" size="sm" />
        </span>
      ) : addsOnClick ? (
        // 整行已能用 Enter 加入，「+」不再占一个 Tab 停靠点
        <IconButton
          className="wf-song-add"
          label={`放入配乐行：${title}`}
          name="final-cut-add"
          onClick={onAdd}
          size="xs"
          tabIndex={-1}
          tooltip="放入配乐行"
        />
      ) : null}
      {audio.status === 'failed' ? (
        <span className="wf-song-actions">
          {audio.generated ? (
            <GenerateMusic
              conversationId={conversationId}
              initialPrompt={title}
              onNotice={onNotice}
            >
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
              className="wf-song-details"
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
      ) : null}
    </li>
  )
}

const isMissing = (error: unknown) => error instanceof ApiError && error.status === 404

/** 描述框下面的快捷描述：点一下把描述换成它。 */
const MUSIC_PRESETS = [
  { label: '木吉他', prompt: '轻快温暖的原声木吉他，松弛早秋亚麻氛围' },
  { label: '都市轻快', prompt: '松弛都市轻节奏，柔和电钢琴' },
  { label: '极简钢琴', prompt: '清澈极简钢琴尾奏，温暖留白' },
] as const

/** 点 `children` 弹出生成音乐的输入框；`initialPrompt` 是重新生成时沿用的描述。 */
export function GenerateMusic({
  conversationId,
  onNotice,
  children,
  initialPrompt,
}: {
  conversationId: string
  onNotice: (message: string) => void
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
      {/* 触发的「生成音乐」「重新生成」都在右边，输入卡和它们右对齐 */}
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
          className="wf-generate-composer"
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
