/** 整片编辑器里的音乐：上传、生成、读出来、按剪辑对齐、预览混音，连同音乐轨、卡片与提示要显示的东西。
 * 草稿里只记是哪条音频记录与人拖到的起点；铺法每次按此刻的剪辑与字幕重新算，不存。 */

import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { uploadMediaFile } from '@/shared/api/media-upload'
import { toast } from '@/shared/ui/toast'
import { isRunningStatus } from '../shots'
import { useStableValue } from '../video-editor/use-stable-value'
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
import type { MusicTrackView } from './film-music-track'
import type { FilmSubtitle } from './film-subtitles'
import { useMusicPlayback } from './use-music-playback'
import {
  musicPromptOf,
  seedMusicJob,
  submitMusic,
  useConversationMusic,
  useMusicAnalysis,
  useMusicDescription,
  type MusicDescription,
} from './whole-film.api'

const seconds = (value: number) => value.toFixed(1)

/** 选中音乐时卡片上写什么。 */
export type MusicCardView = {
  title: string
  detail: string
  lines: readonly string[]
  onRegenerate: (() => void) | undefined
}

type Options = {
  conversationId: string
  /** 本对话此刻挂的需求单；还没读到时不能生成。 */
  taskId: string | null | undefined
  film: FilmState
  total: number
  subtitles: readonly FilmSubtitle[]
  /** 改草稿：上传、生成完成后才落的改动给函数，按那一刻的草稿算。 */
  apply: (next: FilmState | ((present: FilmState) => FilmState) | undefined) => void
  /** 让人看到的一句话（脚注位置）。 */
  onNotice: (message: string) => void
  playback: { playing: boolean; muted: boolean }
  currentTime: number
}

export type FilmMusicState = {
  view: MusicTrackView
  /** 选得中音乐（读出来了）时卡片上写什么；否则没有。 */
  card: MusicCardView | undefined
  /** 脚注：选中音乐时的说明，或音乐太短、没检测到拍子这类要一直看得到的情况。 */
  footnote: (selected: boolean) => string | undefined
  /** 「合成成片」因音乐不可用的原因。 */
  composeBlocked: string | undefined
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
  /** 用户按播放的那一下调用，放开音乐的声音。 */
  prime: () => void
}

export function useFilmMusic({
  conversationId,
  taskId,
  film,
  total,
  subtitles,
  apply,
  onNotice,
  playback,
  currentTime,
}: Options): FilmMusicState {
  const queryClient = useQueryClient()
  const records = useConversationMusic(conversationId)
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [describing, setDescribing] = useState(false)
  const description = useMusicDescription(conversationId, describing)

  const music = film.music
  const record =
    music?.kind === 'generate' ? records.data?.find((job) => job.id === music.jobId) : undefined
  const url =
    music === null
      ? undefined
      : music.kind === 'upload'
        ? music.url
        : record?.status === 'completed'
          ? (record.outputUrl ?? undefined)
          : undefined
  const analysis = useMusicAnalysis(url)
  const name = music?.kind === 'upload' ? music.name : '生成的音乐'

  const curve = musicGainCurve(speechSpansOf(subtitles), total)
  const previewCurve = useStableValue(withFadeOut(curve, Math.round(total * 1000)))
  const song: Song | undefined =
    analysis.data === undefined
      ? undefined
      : { duration: analysis.data.duration, grid: analysis.data.grid }
  const placement: MusicPlacement | undefined =
    song === undefined || music === null
      ? undefined
      : placeMusic(song, total, internalCuts(film.segments), music.userStart)

  const generateBlocked = taskId === undefined ? '任务信息读取中，暂时无法生成' : undefined
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

  const view = ((): MusicTrackView => {
    if (uploading) return { kind: 'busy', label: '正在上传音乐…' }
    if (music === null) return { kind: 'empty' }
    if (music.kind === 'generate') {
      if (records.data === undefined)
        return records.isError
          ? {
              kind: 'failed',
              label: '音乐记录读取失败',
              onRetry: () => void records.refetch(),
            }
          : { kind: 'busy', label: '正在读取音乐…' }
      if (record === undefined)
        return { kind: 'failed', label: '找不到这首生成的音乐', onRetry: undefined }
      if (isRunningStatus(record.status))
        return { kind: 'busy', label: '音乐生成中，完成后自动对齐' }
      if (url === undefined) return { kind: 'failed', label: '音乐生成失败', onRetry: regenerate }
    }
    if (analysis.isError)
      return { kind: 'failed', label: '音乐读取失败', onRetry: () => void analysis.refetch() }
    if (analysis.data === undefined || song === undefined || placement === undefined)
      return { kind: 'busy', label: '正在读取音乐…' }
    return { kind: 'ready', name, song, peaks: analysis.data.peaks, placement, curve: previewCurve }
  })()

  const ready = view.kind === 'ready' ? view : undefined
  const shortBy = ready?.placement.shortBy ?? 0

  const card = ((): MusicCardView | undefined => {
    if (ready === undefined) return undefined
    const { song: shown, placement: placed } = ready
    const covered = Math.min(total, placed.available)
    const beat =
      shown.grid === null
        ? '这首音乐没有检测到拍子，未按切点对齐'
        : placed.cutCount === 0
          ? `每分钟 ${shown.grid.bpm} 拍 · 成片轨只有一段，没有切点`
          : `每分钟 ${shown.grid.bpm} 拍 · ${placed.cutCount} 个切点中 ${placed.onBeat.length} 个落在拍上`
    return {
      title: name,
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
        ? '这首音乐没有检测到拍子，未按切点对齐'
        : '这首音乐没有检测到拍子，从 0 秒起使用，未按切点对齐'
    if (!selected) return undefined
    return ready.placement.userPlaced
      ? '已按拖动的位置使用音乐；拖动音乐可换用别的范围'
      : '音乐已自动对齐；拖动音乐可换用别的范围'
  }

  const { prime } = useMusicPlayback({
    buffer: ready === undefined ? undefined : analysis.data?.buffer,
    songStart: ready?.placement.start ?? 0,
    curve: previewCurve,
    total,
    playing: playback.playing,
    muted: playback.muted,
    clock: currentTime,
  })

  return {
    view,
    card,
    footnote,
    composeBlocked:
      shortBy > 0 ? `音乐比成片短 ${seconds(shortBy)} 秒，请重新生成或换一首` : undefined,
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
    prime,
  }
}
