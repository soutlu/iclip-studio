import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import { MEDIA_AUDIO_ACCEPT, uploadMediaFile } from '@/shared/api/media-upload'
import { Icon } from '@/shared/icons'
import { cn } from '@/shared/lib/utils'
import { Button, IconButton } from '@/shared/ui/button'
import { PopupRoot, PopupSurface, PopupTrigger } from '@/shared/ui/popup'
import { BlockedReason } from '../components/blocked-reason'
import { Wave } from '../editing/timeline'
import { filmViewQuery } from '../film/film.api'
import { isRunningStatus } from '../shots'
import type { GenerationJob } from '../storyboard.api'
import type { EditContext } from './editing/context'
import type { WholeFilmDraft } from './editing/draft'
import { setMusic } from './editing/music'
import type { EditResult } from './editing/result'
import { useMusicAnalysis } from './music-analysis'
import { musicTitleOf, peaksStateOf } from './music-view'
import {
  refreshConversationMusic,
  submitMusic,
  useConversationMusic,
  useConversationTaskId,
} from './whole-film.api'

const MAX_PROMPT_CHARS = 3000

const seconds = (ms: number) => Math.round(ms / 1000)

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

  const upload = async (file: File) => {
    setUploading(true)
    try {
      await uploadMediaFile(file, 'audio', { conversationId })
      await refreshConversationMusic(queryClient, conversationId)
    } catch (error) {
      onNotice(errorMessageOf(error, '音乐上传失败'))
    } finally {
      setUploading(false)
    }
  }

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
    <div className="wf-music-panel">
      <div className="wf-panel-head">
        <span className="wf-panel-title">
          音乐 <span className="wf-panel-count">{songs.length} 首</span>
        </span>
        <GenerateMusic conversationId={conversationId} onNotice={onNotice} />
        <Button
          disabled={uploading}
          leadingIcon="upload"
          loading={uploading}
          onClick={() => fileRef.current?.click()}
          size="md"
          variant="outlined"
        >
          上传
        </Button>
        <input
          accept={MEDIA_AUDIO_ACCEPT}
          aria-label="选择音乐文件"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file !== undefined) void upload(file)
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
        <p className="wf-panel-note">这段对话还没有音乐，可以点「生成」或「上传」</p>
      ) : (
        <ul aria-label="这段对话的音乐" className="wf-song-list">
          {songs.map((job) => (
            <SongRow
              context={context}
              inUse={draft.music?.jobId === job.id}
              job={job}
              key={job.id}
              onToggle={() => toggle(job)}
              onUse={() => apply(setMusic(draft, { jobId: job.id }, context))}
              playing={playing === job.id}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

type SongRowProps = {
  job: GenerationJob
  context: EditContext
  inUse: boolean
  playing: boolean
  onToggle: () => void
  onUse: () => void
}

function SongRow({ job, context, inUse, playing, onToggle, onUse }: SongRowProps) {
  const ready = job.status === 'completed' && job.outputUrl !== null
  const analysis = useMusicAnalysis(ready ? (job.outputUrl ?? undefined) : undefined)
  const title = musicTitleOf(job)
  const durationMs = job.durationMs ?? analysis.data?.durationMs
  const source = job.operation === 'upload' ? '上传' : '生成'
  const meta = isRunningStatus(job.status)
    ? '生成中，完成后可以使用'
    : !ready
      ? (job.errorMessage ?? '生成失败')
      : durationMs === undefined
        ? source
        : `${source} · ${seconds(durationMs)} 秒`
  const useBlocked = !ready
    ? '这首音乐还不能用'
    : context.music[job.id] === undefined
      ? '正在读取这首音乐的时长，稍后再试'
      : undefined
  return (
    <li className={cn('wf-song', inUse && 'is-used')}>
      <IconButton
        disabled={!ready}
        label={playing ? `暂停试听：${title}` : `试听：${title}`}
        name={playing ? 'pause' : 'play'}
        onClick={onToggle}
        size="sm"
      />
      <span className="wf-song-text">
        <span className="wf-song-title" title={title}>
          {title}
        </span>
        <span className="wf-song-meta">{meta}</span>
      </span>
      <span aria-hidden="true" className="wf-song-wave">
        {ready && durationMs !== undefined ? (
          <Wave
            part={{ mediaUrl: job.outputUrl ?? '', start: 0, end: durationMs / 1000 }}
            state={peaksStateOf(analysis)}
          />
        ) : null}
      </span>
      {inUse ? (
        <span className="wf-song-used">
          <Icon decorative name="check" size="xs" />
          在用
        </span>
      ) : (
        <BlockedReason reason={useBlocked}>
          <Button
            aria-disabled={useBlocked === undefined ? undefined : true}
            aria-label={`用这首：${title}`}
            onClick={() => {
              if (useBlocked === undefined) onUse()
            }}
            size="md"
            variant="outlined"
          >
            用这首
          </Button>
        </BlockedReason>
      )}
    </li>
  )
}

const isMissing = (error: unknown) => error instanceof ApiError && error.status === 404

function GenerateMusic({
  conversationId,
  onNotice,
}: {
  conversationId: string
  onNotice: (message: string) => void
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const task = useConversationTaskId(conversationId)
  // 工程文件里写了配乐就拿它当默认描述；没有工程文件（404）就空着
  const film = useQuery({
    ...filmViewQuery(conversationId),
    enabled: open,
    retry: (count, error) => !isMissing(error) && count < 1,
  })
  const suggested = film.data?.film.musicDescription ?? ''
  const text = prompt ?? suggested
  const reason = submitting
    ? '正在提交，请稍候'
    : task.isError
      ? '对话信息读取失败，无法生成；请关闭后重新打开整片'
      : task.data === undefined
        ? '正在读取对话信息，稍后再试'
        : text.trim() === ''
          ? '尚未填写音乐描述，无法生成；请用一句话描述想要的音乐'
          : undefined

  const generate = async () => {
    if (reason !== undefined) return
    setSubmitting(true)
    try {
      const job = await submitMusic({
        conversationId,
        prompt: text.trim(),
        taskId: task.data ?? null,
      })
      await refreshConversationMusic(queryClient, conversationId, job)
      setOpen(false)
      setPrompt(null)
    } catch (error) {
      onNotice(errorMessageOf(error, '音乐生成提交失败'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <PopupRoot onOpenChange={setOpen} open={open}>
      <PopupTrigger asChild>
        <Button leadingIcon="sparkles" size="md">
          生成
        </Button>
      </PopupTrigger>
      <PopupSurface
        align="end"
        aria-label="生成音乐"
        className="wf-generate"
        side="bottom"
        sideOffset={6}
      >
        <label className="wf-generate-label" htmlFor="wf-music-prompt">
          音乐描述
        </label>
        <textarea
          className="wf-generate-text ui-focus"
          id="wf-music-prompt"
          maxLength={MAX_PROMPT_CHARS}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={
            film.isPending && open ? '正在读取工程文件里的配乐…' : '用一句话描述想要的音乐'
          }
          rows={4}
          value={text}
        />
        <div className="wf-generate-foot">
          <span>生成好后出现在音乐列表里，点「用这首」放进整片</span>
          <BlockedReason reason={reason}>
            <Button
              aria-disabled={reason === undefined ? undefined : true}
              loading={submitting}
              onClick={() => void generate()}
              size="md"
            >
              生成音乐
            </Button>
          </BlockedReason>
        </div>
      </PopupSurface>
    </PopupRoot>
  )
}
