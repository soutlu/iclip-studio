import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { uploadMediaFile } from '@/shared/api/media-upload'
import { toast } from '@/shared/ui/toast'
import { useStableValue } from '../editing/use-stable-value'
import { isRunningStatus } from '../shots'
import { moveMusic, setMusic, type FilmMusic, type FilmState } from './film-draft'
import {
  internalCuts,
  musicGainCurve,
  placeMusic,
  speechSpansOf,
  withFadeOut,
  type MusicPlacement,
  type Song,
} from './film-music'
import type { MusicStatus } from './film-music-status'
import type { FilmSubtitle } from './film-subtitles'
import type { PreviewMusic } from './use-film-preview-audio'
import {
  musicPromptOf,
  seedMusicJob,
  submitMusic,
  useConversationMusic,
  useMusicAnalysis,
  useMusicDescription,
  useUploadedMusicAccess,
  type MusicDescription,
} from './whole-film.api'

const seconds = (value: number) => value.toFixed(1)

export type MusicCardView = {
  title: string
  detail: string
  lines: readonly string[]
  onRegenerate: (() => void) | undefined
}

type Options = {
  conversationId: string
  taskId: string | null | undefined
  taskBlocked: string | undefined
  film: FilmState
  total: number
  subtitles: readonly FilmSubtitle[]
  apply: (next: FilmState | ((present: FilmState) => FilmState) | undefined) => void
  onNotice: (message: string) => void
}

export type FilmMusicState = {
  status: MusicStatus
  card: MusicCardView | undefined
  footnote: (selected: boolean) => string | undefined
  previewMusic: PreviewMusic | undefined
  menu: {
    description: MusicDescription
    onOpenGenerate: () => void
    onGenerate: (prompt: string) => Promise<boolean>
    onUpload: (file: File) => void
    busy: boolean
    generateBlocked: string | undefined
  }
  move: (start: number) => void
  remove: () => void
}

const musicTitle = (music: FilmMusic): string =>
  music.kind === 'generate' ? '生成的音乐' : (music.name ?? '上传的音乐')

export function useFilmMusic({
  conversationId,
  taskId,
  taskBlocked,
  film,
  total,
  subtitles,
  apply,
  onNotice,
}: Options): FilmMusicState {
  const queryClient = useQueryClient()
  const records = useConversationMusic(conversationId)
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [describing, setDescribing] = useState(false)
  const description = useMusicDescription(conversationId, describing)

  const music = film.music
  const access = useUploadedMusicAccess(
    music?.kind === 'upload' && music.verifyAccess === true ? music.jobId : undefined,
  )
  const record =
    music?.kind === 'generate' ? records.data?.find((job) => job.id === music.jobId) : undefined
  const url =
    music === null
      ? undefined
      : music.kind === 'upload'
        ? music.verifyAccess === true && access.data === undefined
          ? undefined
          : music.url
        : record?.status === 'completed'
          ? (record.outputUrl ?? undefined)
          : undefined
  const analysis = useMusicAnalysis(url)

  const curve = music?.gain ?? musicGainCurve(speechSpansOf(subtitles), total)
  const previewCurve = useStableValue(withFadeOut(curve, Math.round(total * 1000)))
  const song: Song | undefined = useMemo(
    () =>
      analysis.data === undefined
        ? undefined
        : { duration: analysis.data.duration, grid: analysis.data.grid },
    [analysis.data],
  )
  const cuts = useStableValue(internalCuts(film.segments))
  const userStart = music?.userStart
  const placement: MusicPlacement | undefined = useMemo(
    () =>
      song === undefined || userStart === undefined
        ? undefined
        : placeMusic(song, total, cuts, userStart),
    [song, total, cuts, userStart],
  )

  const generateBlocked = taskId === undefined ? taskBlocked : undefined
  const generate = async (prompt: string): Promise<boolean> => {
    if (taskId === undefined || submitting) return false
    setSubmitting(true)
    try {
      const job = await submitMusic({ conversationId, prompt, taskId })
      seedMusicJob(queryClient, conversationId, job)
      const next: FilmMusic = { kind: 'generate', jobId: job.id, userStart: null }
      apply((present) => setMusic(present, next))
      return true
    } catch (error) {
      toast.error(errorMessageOf(error, '音乐生成提交失败'))
      return false
    } finally {
      setSubmitting(false)
    }
  }
  const prompt = record === undefined ? undefined : musicPromptOf(record)
  const regenerate =
    prompt === undefined || generateBlocked !== undefined || submitting
      ? undefined
      : () => void generate(prompt)

  const upload = async (file: File) => {
    setUploading(true)
    try {
      const { uploadId, url: uploaded } = await uploadMediaFile(file, 'audio')
      const next: FilmMusic = {
        kind: 'upload',
        jobId: uploadId,
        name: file.name,
        url: uploaded,
        userStart: null,
      }
      apply((present) => setMusic(present, next))
    } catch (error) {
      onNotice(errorMessageOf(error, '音乐上传失败'))
    } finally {
      setUploading(false)
    }
  }

  const status = ((): MusicStatus => {
    const failed = (message: string, onRetry: (() => void) | undefined): MusicStatus => ({
      kind: 'failed',
      message,
      onRetry,
    })
    if (uploading) return { kind: 'uploading' }
    if (submitting) return { kind: 'submitting' }
    if (music === null) return { kind: 'none' }
    if (music.kind === 'upload' && music.verifyAccess === true) {
      if (access.isError)
        return failed(
          errorMessageOf(access.error, '上传音乐权限读取失败'),
          () => void access.refetch(),
        )
      if (access.data === undefined) return { kind: 'reading' }
      if (
        access.data.kind !== 'audio' ||
        access.data.operation !== 'upload' ||
        access.data.status !== 'completed'
      )
        return failed('该上传音乐已不可用，无法复用；请替换或删除', undefined)
    }
    if (music.kind === 'generate') {
      if (records.data === undefined)
        return records.isError
          ? failed('音乐记录读取失败', () => void records.refetch())
          : { kind: 'reading' }
      if (record === undefined)
        return failed('生成的音乐记录不存在，无法使用；请删除音乐', undefined)
      if (isRunningStatus(record.status)) return { kind: 'generating' }
      if (url === undefined) return failed('音乐生成失败', regenerate)
    }
    if (analysis.isError) return failed('音乐读取失败', () => void analysis.refetch())
    if (analysis.data === undefined || song === undefined || placement === undefined)
      return { kind: 'reading' }
    return {
      kind: 'ready',
      title: musicTitle(music),
      song,
      peaks: analysis.data.peaks,
      placement,
      previewCurve,
      plan: {
        audioJobId: music.jobId,
        start: placement.start,
        curve,
        volume: music.volume ?? 1,
      },
    }
  })()

  const ready = status.kind === 'ready' ? status : undefined
  const shortBy = ready?.placement.shortBy ?? 0

  const card = ((): MusicCardView | undefined => {
    if (ready === undefined) return undefined
    const { song: shown, placement: placed } = ready
    const covered = Math.min(total, placed.available)
    const beat =
      shown.grid === null
        ? '该音乐未检测到拍子，未按切点对齐'
        : placed.cutCount === 0
          ? `每分钟 ${shown.grid.bpm} 拍 · 成片轨只有一段，没有切点`
          : `每分钟 ${shown.grid.bpm} 拍 · ${placed.cutCount} 个切点中 ${placed.onBeat.length} 个落在拍上`
    return {
      title: ready.title,
      detail: `使用 ${seconds(placed.start)}–${seconds(placed.start + covered)} 秒 · 整首 ${seconds(shown.duration)} 秒`,
      lines: shortBy > 0 ? [beat, `音乐比成片短 ${seconds(shortBy)} 秒，不循环补齐`] : [beat],
      onRegenerate: music?.kind === 'generate' ? regenerate : undefined,
    }
  })()

  const footnote = (selected: boolean): string | undefined => {
    if (ready === undefined) return undefined
    if (shortBy > 0)
      return `${music?.kind === 'upload' ? '上传' : '生成'}的音乐只有 ${seconds(ready.song.duration)} 秒，铺不满第一段开头到最后一段结尾，不循环补齐`
    if (ready.song.grid === null)
      return ready.placement.userPlaced
        ? '该音乐未检测到拍子，未按切点对齐'
        : '该音乐未检测到拍子，从 0 秒起使用，未按切点对齐'
    if (!selected) return undefined
    return ready.placement.userPlaced
      ? '已按拖动的位置使用音乐；拖动音乐可换用别的范围'
      : '音乐已自动对齐；拖动音乐可换用别的范围'
  }

  const previewMusic =
    ready === undefined || analysis.data === undefined || url === undefined
      ? undefined
      : {
          url,
          buffer: analysis.data.buffer,
          start: ready.placement.start,
          curve,
          volume: music?.volume ?? 1,
        }

  return {
    status,
    card,
    footnote,
    previewMusic,
    menu: {
      description,
      onOpenGenerate: () => setDescribing(true),
      onGenerate: generate,
      onUpload: (file) => void upload(file),
      busy: uploading || submitting,
      generateBlocked,
    },
    move: (start) => apply(moveMusic(film, start)),
    remove: () => apply(setMusic(film, null)),
  }
}
