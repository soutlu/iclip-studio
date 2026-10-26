import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useId, useRef, useState, type ReactElement } from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import { MEDIA_AUDIO_ACCEPT, uploadMediaFile } from '@/shared/api/media-upload'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { Composer, type ComposerHandle } from '@/shared/ui/composer'
import { useFileDropTarget } from '@/shared/ui/file-drop'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import { BlockedReason } from '../components/blocked-reason'
import { filmViewQuery } from '../film/film.api'
import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'
import type { EditContext } from './editing/context'
import type { WholeFilmDraft } from './editing/draft'
import { setMusic } from './editing/music'
import type { EditResult } from './editing/result'
import { musicTitleOf } from './music-view'
import {
  refreshConversationMusic,
  submitMusic,
  useConversationMusic,
  useConversationTaskId,
} from './whole-film.api'

const MAX_PROMPT_CHARS = 3000

const durationLabel = (ms: number) => {
  const seconds = Math.round(ms / 1000)
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

const musicStatusLabel = (status: GenerationJob['status']) =>
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
      aria-label={musicStatusLabel(status)}
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
        <Icon
          decorative
          name={status === 'pending' ? 'duration' : status === 'completed' ? 'check' : 'alert'}
          size="sm"
        />
      )}
    </span>
  )
}

type MusicPanelProps = {
  conversationId: string
  draft: WholeFilmDraft
  context: EditContext
  apply: (result: EditResult) => boolean
  onNotice: (message: string) => void
}

export function MusicPanel({ conversationId, draft, context, apply, onNotice }: MusicPanelProps) {
  const queryClient = useQueryClient()
  const music = useConversationMusic(conversationId)
  const [playing, setPlaying] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  // 试听用一个不上屏的 Audio：同一时刻只放一首，关掉编辑器就停
  const audioRef = useRef<HTMLAudioElement | null>(null)
  useEffect(
    () => () => {
      audioRef.current?.pause()
    },
    [],
  )
  const songs = music.data ?? []

  const upload = async (files: File[]) => {
    setUploading(true)
    for (const file of files) {
      try {
        await uploadMediaFile(file, 'audio', { conversationId })
        await refreshConversationMusic(queryClient, conversationId)
      } catch (error) {
        onNotice(errorMessageOf(error, '音乐上传失败'))
      }
    }
    setUploading(false)
  }
  const drop = useFileDropTarget({
    blocked: uploading,
    onFiles: (files) => void upload(files),
    onDirectory: () => onNotice('不能上传文件夹，请拖入音频文件'),
  })

  const toggle = (job: GenerationJob) => {
    if (job.outputUrl === null) return
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
      onNotice('这首音乐播放失败，请稍后重试')
    })
  }

  return (
    <div
      aria-label="音乐素材"
      className={cn('wf-music-panel', drop.dragOver && 'is-over')}
      role="region"
      {...drop.dragHandlers}
    >
      <div className="wf-panel-head">
        <span className="wf-panel-title">
          音乐 <span className="wf-panel-count">{songs.length} 首</span>
        </span>
        <input
          accept={MEDIA_AUDIO_ACCEPT}
          aria-label="选择音乐文件"
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
        <p className="wf-panel-note" role="alert">
          {errorMessageOf(music.error, '读取音乐失败')}
        </p>
      ) : music.isPending ? (
        <p className="wf-panel-note" role="status">
          正在读取音乐…
        </p>
      ) : songs.length === 0 ? (
        <p className="wf-panel-note">暂无音乐</p>
      ) : (
        <ul aria-label="这段对话的音乐" className="wf-song-list">
          {songs.map((job, index) => (
            <SongRow
              context={context}
              conversationId={conversationId}
              onNotice={onNotice}
              inUse={draft.music?.jobId === job.id}
              job={job}
              key={job.id}
              label={`音乐 ${index + 1}`}
              onToggle={() => toggle(job)}
              onUse={() => {
                if (apply(setMusic(draft, { jobId: job.id }, context))) {
                  audioRef.current?.pause()
                  setPlaying(null)
                }
              }}
              playing={playing === job.id}
            />
          ))}
        </ul>
      )}
      <Button
        className="wf-music-upload"
        disabled={uploading}
        leadingIcon="upload"
        loading={uploading}
        onClick={() => fileRef.current?.click()}
        size="md"
        variant="tonal"
      >
        添加音频
      </Button>
    </div>
  )
}

type SongRowProps = {
  job: GenerationJob
  label: string
  context: EditContext
  conversationId: string
  inUse: boolean
  playing: boolean
  onToggle: () => void
  onUse: () => void
  onNotice: (message: string) => void
}

function SongRow({
  job,
  label,
  context,
  conversationId,
  inUse,
  playing,
  onToggle,
  onUse,
  onNotice,
}: SongRowProps) {
  const ready = job.status === 'completed' && job.outputUrl !== null
  const title = musicTitleOf(job)
  const durationMs = job.durationMs ?? context.music[job.id]?.durationMs
  const useBlocked = !ready
    ? musicStatusLabel(job.status)
    : context.music[job.id] === undefined
      ? '正在读取这首音乐的时长，稍后再试'
      : undefined
  return (
    <li className={cn('wf-song', inUse && 'is-used')}>
      <BlockedReason reason={useBlocked}>
        <button
          aria-disabled={useBlocked === undefined ? undefined : true}
          aria-label={`选用：${title}`}
          aria-pressed={inUse}
          className="wf-song-select"
          onClick={() => {
            if (useBlocked === undefined) onUse()
          }}
          type="button"
        />
      </BlockedReason>
      {ready ? (
        <IconButton
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
          {label} · {title}
        </span>
        {ready && durationMs !== undefined ? (
          <span className="wf-song-meta">{durationLabel(durationMs)}</span>
        ) : null}
      </span>
      <span className="wf-song-actions">
        {inUse ? (
          <span aria-label="在用" className="wf-song-used" role="img">
            <Icon decorative name="check" size="xs" />
          </span>
        ) : null}
        {job.status === 'failed' && job.operation === 'generate' ? (
          <GenerateMusic conversationId={conversationId} initialPrompt={title} onNotice={onNotice}>
            <IconButton label={`重新生成：${title}`} name="refresh" size="xs" />
          </GenerateMusic>
        ) : null}
        <PopupRoot>
          <PopupTrigger asChild>
            <IconButton label={`查看音乐详情：${title}`} name="more" size="xs" />
          </PopupTrigger>
          <PopupSurface
            align="end"
            aria-label={`音乐详情：${title}`}
            className="wf-song-details"
            collisionPadding={16}
            sideOffset={6}
          >
            <strong>{musicStatusLabel(job.status)}</strong>
            {job.errorMessage !== null ? (
              <p className="wf-music-error">{job.errorMessage}</p>
            ) : null}
            <p>{title}</p>
          </PopupSurface>
        </PopupRoot>
      </span>
    </li>
  )
}

/** 音乐轨固定按钮位内的生成状态；查看列表不改变轨道布局。 */
export function MusicAction({
  conversationId,
  musicJobId,
  onNotice,
  onOpenMusic,
}: {
  conversationId: string
  musicJobId: string | undefined
  onNotice: (message: string) => void
  onOpenMusic: () => void
}) {
  const music = useConversationMusic(conversationId)
  const jobs = music.data ?? []
  const generated = jobs.filter((job) => job.operation === 'generate')
  const latest = generated.find((job) => isRunningStatus(job.status)) ?? generated[0]
  const status =
    latest !== undefined && (latest.status !== 'completed' || latest.id !== musicJobId)
      ? latest.status
      : undefined
  return (
    <GenerateMusic conversationId={conversationId} onNotice={onNotice}>
      <button
        aria-label="生成音乐"
        className="wf-head-add wf-music-action ui-focus"
        onClick={onOpenMusic}
        title={status === undefined ? '生成音乐' : musicStatusLabel(status)}
        type="button"
      >
        {status === undefined ? (
          <Icon decorative name="add" size="xs" />
        ) : (
          <MusicStatus status={status} />
        )}
      </button>
    </GenerateMusic>
  )
}

const isMissing = (error: unknown) => error instanceof ApiError && error.status === 404

/**
 * 生成音乐的浮层，向上弹；`children` 是打开它的按钮（音乐轨轨名旁的「+」）。
 * 生成好的音乐出现在素材页的音乐列表里。
 */
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
  // 用户输入的文字；null 表示还没动过，框里是预填的描述
  const [typed, setTyped] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const task = useConversationTaskId(conversationId)
  // 工程文件里写了配乐就拿它当默认描述；没有工程文件（404）就空着
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
        : '生成后出现在左侧「音乐」列表')

  // Composer 不受控：每次打开都是新挂上的，挂上时写入手上的文字；用户还没输入时，后到的工程文件配乐也写进去。
  // 浮层内容比 open 晚一轮挂上，所以跟着 Composer 句柄走，不跟 open 走
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
        // 挂到 body 会落在成片弹窗外，弹窗的滚动锁会拦下输入框的滚轮
        container={trigger?.parentElement ?? null}
        onFocusOutside={(event) => {
          // 焦点在 body 时浮层里有节点被移除（预填换掉占位、提交钮换成转圈），成片弹窗的 FocusScope 会把
          // 焦点拉回弹窗容器；这不是用户离开，留住浮层并把焦点还给输入框。点到外面仍照常关闭
          if (event.target !== trigger?.closest('[role="dialog"]')) return
          event.preventDefault()
          if (open) composer?.focus()
        }}
        side="top"
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
