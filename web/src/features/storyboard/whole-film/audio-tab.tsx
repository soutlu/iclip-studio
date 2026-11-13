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
import { Button, IconButton } from '@/shared/ui/button'
import { Composer, type ComposerHandle } from '@/shared/ui/composer'
import { useEscapeAheadOfDialog } from '@/shared/ui/dialog'
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
import { audioTitleOf, durationLabel, filterAudio, firstAudioBlockOf } from './audio'
import type { CarryPoint } from './components-tab'
import type { FilmBlock } from './composition/film'
import type { NewAudio } from './use-film-session'
import {
  refreshConversationMusic,
  submitMusic,
  useConversationMusic,
  useConversationTaskId,
} from './whole-film.api'

const MAX_PROMPT_CHARS = 3000

type AudioTabProps = {
  conversationId: string
  /** 成片里现有的块：看哪条音频用着、用在哪个块上。 */
  blocks: readonly FilmBlock[]
  /** 右键「加到播放头」或按 Enter。 */
  onAdd: (audio: NewAudio) => void
  /** 拖着一行移动；null 是拖动取消了。 */
  onCarry: (audio: NewAudio, point: CarryPoint | null) => void
  /** 拖着一行松手。 */
  onDrop: (audio: NewAudio, point: CarryPoint) => void
  /** 点成片里用着的那一行：选中它对应的块。 */
  onReveal: (blockId: string) => void
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
      className={cn('wf-music-status', running && 'is-running', status === 'failed' && 'is-failed')}
      role="img"
    >
      {running ? (
        <span aria-hidden="true" className="wf-music-pulse">
          <i />
          <i />
          <i />
        </span>
      ) : (
        <Icon decorative name={status === 'pending' ? 'duration' : 'alert'} size="sm" />
      )}
    </span>
  )
}

const isReady = (job: GenerationJob): job is GenerationJob & { outputUrl: string } =>
  job.status === 'completed' && job.outputUrl !== null

export function AudioTab({
  conversationId,
  blocks,
  onAdd,
  onCarry,
  onDrop,
  onReveal,
  onNotice,
}: AudioTabProps) {
  const queryClient = useQueryClient()
  const music = useConversationMusic(conversationId)
  const jobs = music.data ?? []
  const [query, setQuery] = useState('')
  const shown = filterAudio(jobs, query)

  // 上传的音频记录上没有时长：和时间线一样从音频文件里读
  const unmeasured = useStableValue(
    jobs.flatMap((job) => (isReady(job) && job.durationMs === null ? [job.outputUrl] : [])),
  )
  const peaks = useAudioPeaks(unmeasured)
  /** 加进成片的样子；还加不了时是加不了的原因。 */
  const addable = (job: GenerationJob): NewAudio | string => {
    if (!isReady(job))
      return job.status === 'failed'
        ? '音乐生成失败，无法加入成片；请重新生成'
        : '音乐还没生成完，无法加入成片'
    const state = job.durationMs === null ? peaks.get(job.outputUrl) : undefined
    const duration =
      job.durationMs ??
      (state?.kind === 'ready' ? Math.round(state.peaks.duration * 1000) : undefined)
    if (duration === undefined)
      return state === undefined || state.kind === 'loading'
        ? '正在读取音频时长，请稍后再加'
        : '音频时长读取失败，无法加入成片'
    return { label: audioTitleOf(job), jobId: job.id, src: job.outputUrl, mediaStart: 0, duration }
  }

  // 同一时间只播一条：所有行共用一个播放器
  const [playing, setPlaying] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  useEffect(
    () => () => {
      audioRef.current?.pause()
    },
    [],
  )
  const toggle = (job: GenerationJob & { outputUrl: string }) => {
    const audio = audioRef.current ?? new Audio()
    if (audioRef.current === null) {
      audio.addEventListener('ended', () => setPlaying(null))
      audioRef.current = audio
    }
    if (playing === job.id) {
      audio.pause()
      setPlaying(null)
      return
    }
    audio.setAttribute('src', job.outputUrl)
    setPlaying(job.id)
    audio.play().catch(() => {
      setPlaying(null)
      onNotice('这条音频播放失败，请重试')
    })
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
    onDirectory: () => onNotice('不能导入文件夹，请拖入音频文件'),
  })

  return (
    <div className={cn('wf-audio', drop.dragOver && 'is-over')} {...drop.dragHandlers}>
      <Input
        aria-label="搜索音频"
        leadingIcon="search"
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="搜索音频"
        type="search"
        value={query}
        wrapperClassName="wf-audio-search"
      />
      <div className="wf-audio-actions">
        <GenerateMusic conversationId={conversationId} onNotice={onNotice}>
          <Button className="wf-audio-action" leadingIcon="sparkles" size="md" variant="primary">
            生成音乐
          </Button>
        </GenerateMusic>
        <Button
          className="wf-audio-action is-import"
          disabled={uploading}
          leadingIcon="upload"
          loading={uploading}
          onClick={() => fileRef.current?.click()}
          size="md"
          variant="outlined"
        >
          导入音频
        </Button>
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
      {music.isError ? (
        <div className="wf-audio-note">
          <InlineAlert
            action={{ label: '重试', onClick: () => void music.refetch() }}
            message={errorMessageOf(music.error, '读取音频失败')}
          />
        </div>
      ) : music.isPending ? (
        <p className="wf-audio-note" role="status">
          正在读取音频…
        </p>
      ) : jobs.length === 0 ? (
        <p className="wf-audio-note" role="status">
          暂无音频，请点「生成音乐」或「导入音频」
        </p>
      ) : shown.length === 0 ? (
        <p className="wf-audio-note" role="status">
          暂无符合条件的音频，请换个关键词
        </p>
      ) : (
        <ul aria-label="音频" className="wf-audio-list">
          {shown.map((job) => {
            const used = firstAudioBlockOf(blocks, job.id)
            const ready = addable(job)
            return (
              <AudioRow
                addable={ready}
                conversationId={conversationId}
                job={job}
                key={job.id}
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
                onToggle={() => {
                  if (isReady(job)) toggle(job)
                }}
                playing={playing === job.id}
                used={used !== undefined}
              />
            )
          })}
        </ul>
      )}
    </div>
  )
}

type Press = { pointerId: number; originX: number; originY: number; moved: boolean }

type AudioRowProps = {
  job: GenerationJob
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
  job,
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
  const title = audioTitleOf(job)
  const ready = isReady(job)
  const durationMs = typeof addable === 'string' ? job.durationMs : addable.duration
  const pressRef = useRef<Press | null>(null)
  const clickAfterDrag = useClickAfterDrag()
  const [lifting, setLifting] = useState(false)

  const press = (event: PointerEvent<HTMLButtonElement>) => {
    // 还加不了的不起拖，松手也不会落进成片
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
  useEscapeAheadOfDialog(lifting, cancel)

  return (
    <li
      className={cn('wf-song', used && 'is-used', lifting && 'is-lifting')}
      title={ready ? '拖到时间线上；右键：加到播放头' : undefined}
    >
      <ContextMenuRoot>
        <ContextMenuTrigger asChild>
          <button
            aria-keyshortcuts="Enter"
            aria-label={used ? `${title}，已使用` : title}
            className="wf-song-select"
            onClick={() => {
              if (!clickAfterDrag.take() && used) onReveal()
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
        <ContextMenuSurface aria-label={title}>
          <ContextMenuItem onSelect={onAdd}>加到播放头</ContextMenuItem>
        </ContextMenuSurface>
      </ContextMenuRoot>
      {ready ? (
        <IconButton
          aria-pressed={playing}
          className="wf-song-play"
          label={playing ? `暂停试听：${title}` : `试听：${title}`}
          name={playing ? 'pause' : 'play'}
          onClick={onToggle}
          size="sm"
        />
      ) : (
        <MusicStatus status={job.status} />
      )}
      <span className="wf-song-text">
        <span className="wf-song-title" title={title}>
          {title}
        </span>
        {ready && (durationMs !== null || used) ? (
          <span className="wf-song-meta">
            {[durationMs === null ? null : durationLabel(durationMs), used ? '已使用' : null]
              .filter((part) => part !== null)
              .join(' · ')}
          </span>
        ) : null}
      </span>
      {job.status === 'failed' ? (
        <span className="wf-song-actions">
          {job.operation === 'generate' ? (
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
              <IconButton label={`查看失败原因：${title}`} name="more" size="xs" />
            </PopupTrigger>
            <PopupSurface
              align="end"
              aria-label={`失败原因：${title}`}
              className="wf-song-details"
              collisionPadding={16}
              sideOffset={6}
            >
              <strong>{statusLabel(job.status)}</strong>
              {job.errorMessage !== null ? (
                <p className="wf-music-error">{job.errorMessage}</p>
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
      ? '对话信息读取失败，无法生成；请关闭后重新打开成片编辑器'
      : task.data === undefined
        ? '正在读取对话信息，稍后再试'
        : text === ''
          ? '尚未填写音乐描述，无法生成；请用一句话描述想要的音乐'
          : text.length > MAX_PROMPT_CHARS
            ? `描述超过 ${MAX_PROMPT_CHARS} 字，无法生成；请删减到 ${MAX_PROMPT_CHARS} 字以内`
            : undefined
  const hint =
    reason ??
    (initialPrompt !== undefined && text === initialPrompt.trim()
      ? '已填入上次的描述，可直接修改'
      : initialPrompt === undefined && text === musicDescription.trim()
        ? '已填入工程文件里的配乐描述，可直接修改'
        : '生成后出现在「音频」页签的列表里')

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
      <PopupSurface
        align="start"
        aria-describedby={hintId}
        aria-label="生成音乐"
        className="wf-generate"
        collisionPadding={16}
        container={trigger?.parentElement ?? null}
        // 浮层挂在成片弹窗里：焦点落回弹窗本身（比如点了提交、按钮随即置灰）时不算点到外面
        onFocusOutside={(event) => {
          if (event.target !== trigger?.closest('[role="dialog"]')) return
          event.preventDefault()
          if (open) composer?.focus()
        }}
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
          onChange={(parts) =>
            setTyped(parts.map((part) => (part.kind === 'text' ? part.text : '')).join(''))
          }
          onSubmit={(submission) => void generate(submission.text)}
          placeholder={
            film.isPending && open
              ? '正在读取工程文件里的配乐…'
              : '描述想要的音乐：风格、情绪、乐器、节奏'
          }
          ref={setComposer}
          sending={submitting}
          submitAction={{
            disabled: reason !== undefined,
            emphasis: 'primary',
            icon: 'music',
            label: '生成音乐',
            pendingLabel: '正在提交',
            size: 'sm',
          }}
        />
      </PopupSurface>
    </PopupRoot>
  )
}
