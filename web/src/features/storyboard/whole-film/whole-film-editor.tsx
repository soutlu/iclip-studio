import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useBrandTemplates } from '@/shared/api/brand-templates'
import { errorMessageOf } from '@/shared/api/client'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { normalizeCaptionText } from '@/shared/lib/caption-text'
import { usePreviewFont } from '@/shared/lib/use-preview-font'
import { Button, IconButton } from '@/shared/ui/button'
import { DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { toast } from '@/shared/ui/toast'
import { VideoDownload } from '@/shared/ui/video-download'
import type { ConversationTask } from '@/shared/workbench'
import { BlockedReason } from '../components/blocked-reason'
import { groupConversationVideos } from '../conversation-videos/video-groups'
import { useStorageFailureNotice } from '../editing/browser-storage'
import { EditorPreview, PreviewMessage, type EditorPreviewHandle } from '../editing/editor-preview'
import { EditorVersionStrip, type VersionStripEntry } from '../editing/editor-version-strip'
import { keyframeRanges } from '../editing/keyframe-segments'
import { useAudioPeaks, type PeaksState } from '../editing/media-analysis'
import { layoutPlay } from '../editing/play-layout'
import { handleUndoShortcut } from '../editing/undo-shortcut'
import { useMediaDurations } from '../editing/use-media-durations'
import { useStableValue } from '../editing/use-stable-value'
import { useShotGenerations } from '../storyboard.api'
import { defaultCaptionLayout, measureCaptionLayout, type CaptionLayout } from './caption-layout'
import { FilmCaption } from './film-caption'
import {
  brandDuration,
  wholeFilmDuration,
  setBrand,
  setFont,
  setSegmentVolume,
  setMusicVolume,
  resetMusicStart,
  canSplitAt,
  EMPTY_FILM,
  filmDuration,
  insertBlockedReason,
  insertClockOf,
  insertSegment,
  moveSegment,
  putLane,
  removeSegment,
  segmentDuration,
  setSentenceText,
  splitAt,
  trimSegment,
  type FilmState,
} from './film-draft'
import { BrandCard, MusicCard, SegmentCard, SubtitleCard } from './film-card'
import { MAX_FILM_SECONDS, MAX_FILM_SEGMENTS } from './film-limits'
import { MusicMenu } from './film-music-menu'
import { composableMusic, isMusicPending } from './film-music-status'
import {
  materialCatalog,
  materialName,
  type Material,
  type MaterialDuration,
} from './film-materials'
import { AddVideoRow, type BrandMenuProps } from './film-menus'
import {
  brandOf,
  isVideoTemplate,
  matchesFilmRatio,
  templateBlockedReason,
  useFilmDimensions,
} from './film-brand'
import { FilmFontMenu } from './film-font-menu'
import { composeBlockedReason, wholeFilmBody } from './film-submit'
import {
  burnedSubtitles,
  captionAt,
  latestSubtitles,
  projectSubtitles,
  subtitleSourceOf,
  type SubtitleSource,
} from './film-subtitles'
import { FilmTimeline, type FilmSelection, type LaneView, type MaterialPick } from './film-timeline'
import { draftFromVersion, firstSourceOf, wholeFilmVersions } from './film-versions'
import { useFilmDraft, type DraftSeed } from './use-film-draft'
import { useFilmMusic } from './use-film-music'
import { useFilmPreviewAudio } from './use-film-preview-audio'
import { useKeyframeIndexes } from './use-keyframe-indexes'
import { FilmSoundControls } from './film-sound-controls'
import {
  seedSubtitleJob,
  seedWholeFilmJob,
  submitSubtitle,
  submitWholeFilm,
  useConversationMusic,
  useConversationSubtitles,
} from './whole-film.api'
import './whole-film.css'

const MIN_SCALE_SECONDS = 20
const LOADING_PEAKS: PeaksState = { kind: 'loading' }
const STORAGE_FAILURE = '当前浏览器无法保存草稿，关闭编辑器后整片内容将丢失'
const UNCOMPOSED_LABEL = '未合成'
const DRAFT_KEY = 'draft'
const seconds = (value: number) => value.toFixed(1)
const posterOf = (url: string | undefined, at = 0) =>
  url === undefined ? undefined : videoSnapshotUrl(url, 320, at)

const DOWNLOAD_CLASS =
  'editor-bar-button relative inline-flex h-(--control-height-md) cursor-pointer items-center justify-center gap-2 rounded-sm text-body-sm font-medium whitespace-nowrap ui-state ui-focus'

type Props = {
  conversationId: string
  task: ConversationTask
  onClose: () => void
}

export function WholeFilmEditor({ conversationId, task, onClose }: Props) {
  const queryClient = useQueryClient()
  const videos = useShotGenerations(conversationId)
  const subtitlesQuery = useConversationSubtitles(conversationId)
  const musicRecords = useConversationMusic(conversationId)
  const templatesQuery = useBrandTemplates()
  const previewRef = useRef<EditorPreviewHandle>(null)
  const anchorRef = useRef<HTMLElement>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [playback, setPlayback] = useState({ playing: false, muted: true })
  // Radix 模态弹窗把焦点锁在弹窗内，挂到弹窗外的浮层拿不到焦点，生成面板要挂在编辑器里。
  const [editorElement, setEditorElement] = useState<HTMLElement | null>(null)
  const [selection, setSelection] = useState<FilmSelection>()
  const [pick, setPick] = useState<MaterialPick>()
  const [materialPreview, setMaterialPreview] = useState<{
    jobId: string
    range?: { start: number; end: number }
  }>()
  const [materialTime, setMaterialTime] = useState(0)
  const [previewSeek, setPreviewSeek] = useState<{
    clock: number
    boundary?: 'start' | 'end' | undefined
  }>()
  useEffect(() => {
    if (previewSeek !== undefined)
      previewRef.current?.previewAt(previewSeek.clock, previewSeek.boundary)
  }, [previewSeek])
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(() => new Set())
  const [viewingKey, setViewingKey] = useState(DRAFT_KEY)
  const [submitting, setSubmitting] = useState(false)
  const [composeError, setComposeError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeStorageFailure = useStorageFailureNotice(STORAGE_FAILURE, setNotice)

  const taskId = task.kind === 'ready' ? task.taskId : undefined
  const taskBlocked =
    task.kind === 'failed'
      ? '任务信息读取失败，无法提交；请点击「重试」'
      : '任务信息读取中，暂时无法提交'

  const catalog = useMemo(
    () =>
      videos.data === undefined ? undefined : materialCatalog(groupConversationVideos(videos.data)),
    [videos.data],
  )
  const known = catalog?.byJob
  const versions = useMemo(() => wholeFilmVersions(videos.data ?? []), [videos.data])
  const materialOf = (jobId: string) => catalog?.byJob.get(jobId)

  const latest = useMemo(
    () => (subtitlesQuery.data === undefined ? undefined : latestSubtitles(subtitlesQuery.data)),
    [subtitlesQuery.data],
  )
  const sourceOf = (jobId: string): SubtitleSource | undefined =>
    latest === undefined ? undefined : subtitleSourceOf(latest.get(jobId))

  const newestVersion = versions.done.at(-1)
  const seed = (): DraftSeed => {
    if (newestVersion === undefined) return { kind: 'blank' }
    if (musicRecords.data === undefined) return { kind: 'records-loading' }
    if (templatesQuery.isPending) return { kind: 'records-loading' }
    const templates = templatesQuery.data?.items ?? []
    return {
      kind: 'version',
      label: newestVersion.label,
      stored: draftFromVersion(newestVersion.job, {
        takeOf: (jobId) => materialOf(jobId)?.takeId,
        templateName: (templateId) => templates.find((item) => item.id === templateId)?.name,
        generatedMusic: new Set(musicRecords.data.map((job) => job.id)),
        newId: () => crypto.randomUUID(),
      }),
    }
  }
  const draft = useFilmDraft({
    conversationId,
    known,
    seed,
    onNotice: setNotice,
    onStorageFailure: noticeStorageFailure,
  })
  const film = draft?.film ?? EMPTY_FILM
  const { segments } = film
  const total = filmDuration(segments)
  const fullTotal = wholeFilmDuration(film)
  const bodyStart = (film.intro?.durationMs ?? 0) / 1000
  const bodyTime = currentTime - bodyStart
  const frame = useFilmDimensions(materialOf(segments[0]?.sourceJobId ?? '')?.url)
  const templateBlocked = templateBlockedReason(film, templatesQuery.data?.items, frame.data)

  const viewedDone = versions.done.find((item) => item.job.id === viewingKey)
  const viewedRunning = versions.running.find((job) => job.id === viewingKey)
  const viewedFailed = versions.failed.find((job) => job.id === viewingKey)
  const viewingDraft =
    viewedDone === undefined && viewedRunning === undefined && viewedFailed === undefined

  const probeUrls = useStableValue([
    ...(catalog === undefined
      ? []
      : [...catalog.byJob.values()].flatMap((item) =>
          item.knownDuration === undefined ? [item.url] : [],
        )),
    ...(viewedDone !== undefined && viewedDone.job.durationMs === null ? [viewedDone.url] : []),
  ])
  const durations = useMediaDurations(probeUrls)
  const sourceUrls = useStableValue([
    ...new Set((draft?.lanes ?? []).flatMap((lane) => materialOf(lane.jobId)?.url ?? [])),
  ])
  const keyframes = useKeyframeIndexes(sourceUrls)
  const durationOf = (material: Material): MaterialDuration => {
    const frames = keyframes.get(material.url)
    return frames?.kind === 'ready'
      ? frames.index.duration
      : (material.knownDuration ?? durations[material.url])
  }

  const lanes: LaneView[] = (draft?.lanes ?? []).flatMap((lane) => {
    const material = materialOf(lane.jobId)
    const group = catalog?.groups.find((item) => item.id === material?.groupId)
    const take = group?.takes.find((item) => item.id === lane.takeId)
    if (material === undefined || group === undefined || take === undefined) return []
    const frames = keyframes.get(material.url)
    return [
      {
        lane,
        label: group.label,
        material,
        versions: take.versions,
        duration: frames?.kind === 'ready' ? frames.index.duration : undefined,
        shots: frames?.kind === 'ready' ? keyframeRanges(frames.index) : [],
        shotState:
          frames?.kind === 'failed' ? 'error' : frames?.kind === 'ready' ? 'ready' : 'loading',
        onRetryShots: () => {
          if (frames?.kind === 'failed') frames.retry()
        },
      },
    ]
  })
  const scale = Math.max(MIN_SCALE_SECONDS, fullTotal, ...lanes.map((view) => view.duration ?? 0))

  const peakUrls = useStableValue([
    ...new Set([
      ...lanes.map((view) => view.material.url),
      ...segments.flatMap((segment) => materialOf(segment.sourceJobId)?.url ?? []),
    ]),
  ])
  const peaks = useAudioPeaks(peakUrls)

  const { subtitles, statuses } = projectSubtitles(film, sourceOf)
  const speechProjection = projectSubtitles(film, sourceOf, false)
  const subtitleStatuses = film.music === null ? statuses : speechProjection.statuses
  const unduckedCount =
    film.music !== null && film.music.gain === undefined
      ? speechProjection.statuses.filter(
          (item) => item.kind === 'failed' || item.kind === 'missing',
        ).length
      : 0
  const burned = burnedSubtitles(subtitles)
  const previewFont = usePreviewFont(
    film.font == null ? null : { id: film.font.fontId, url: film.font.url },
    burned.map((item) => item.text).join('\n'),
  )
  const captionTexts = useStableValue(burned.map((item) => item.text))
  const captionFont = useStableValue(
    previewFont.kind === 'ready'
      ? {
          fontFamily: previewFont.fontFamily,
          fontWeight: previewFont.fontWeight,
          fontStyle: previewFont.fontStyle,
        }
      : undefined,
  )
  const systemFont = previewFont.kind === 'system'
  const captionLayout = useMemo((): CaptionLayout | undefined => {
    if (frame.data === undefined) return undefined
    if (captionFont !== undefined)
      return measureCaptionLayout(captionTexts, frame.data, captionFont)
    return systemFont ? defaultCaptionLayout(captionTexts, frame.data) : undefined
  }, [captionTexts, frame.data, captionFont, systemFont])
  const rawCaption = captionAt(burned, bodyTime)
  const caption =
    captionLayout?.kind === 'ready' && rawCaption !== undefined
      ? captionLayout.texts.get(rawCaption)
      : rawCaption
  const fontBlocked =
    film.font == null
      ? undefined
      : templatesQuery.data === undefined
        ? templatesQuery.isError
          ? '字体信息读取失败，请重试'
          : '正在读取字体信息…'
        : !templatesQuery.data.items.some(
              (item) =>
                item.id === film.font?.fontId && item.kind === 'font' && item.disabledAt === null,
            )
          ? '所选字体已停用或不可用，无法合成；请更换字幕字体'
          : previewFont.kind === 'loading'
            ? '正在加载字幕字体…'
            : previewFont.kind === 'failed' || previewFont.kind === 'unsupported'
              ? previewFont.message
              : frame.isError
                ? '正文画幅读取失败，无法排版字幕；请重试'
                : frame.data === undefined
                  ? '正在读取正文画幅以排版字幕…'
                  : captionLayout?.kind === 'failed'
                    ? captionLayout.message
                    : undefined

  const draftAudioSegments = [
    ...(film.intro == null
      ? []
      : [{ mediaUrl: film.intro.url, start: 0, end: film.intro.durationMs / 1000 }]),
    ...segments.flatMap((segment) => {
      const url = materialOf(segment.sourceJobId)?.url
      return url === undefined
        ? []
        : [{ mediaUrl: url, start: segment.start, end: segment.end, volume: segment.volume ?? 1 }]
    }),
    ...(film.outro == null
      ? []
      : [{ mediaUrl: film.outro.url, start: 0, end: film.outro.durationMs / 1000 }]),
  ]
  const draftPlay = layoutPlay(draftAudioSegments)
  const viewedDuration =
    viewedDone === undefined
      ? undefined
      : viewedDone.job.durationMs === null
        ? durations[viewedDone.url]
        : viewedDone.job.durationMs / 1000
  const previewMaterial =
    materialPreview === undefined ? undefined : materialOf(materialPreview.jobId)
  const previewingMaterial = viewingDraft && previewMaterial !== undefined
  const materialDuration = previewMaterial === undefined ? undefined : durationOf(previewMaterial)
  const materialRange =
    materialPreview?.range ??
    (materialDuration == null ? undefined : { start: 0, end: materialDuration })
  const current = useStableValue(
    previewingMaterial
      ? materialRange === undefined
        ? materialDuration === null
          ? []
          : undefined
        : layoutPlay([{ mediaUrl: previewMaterial.url, ...materialRange }])
      : viewingDraft
        ? draft === undefined
          ? undefined
          : draftPlay
        : viewedDone === undefined || viewedDuration === null
          ? []
          : viewedDuration === undefined
            ? undefined
            : layoutPlay([{ mediaUrl: viewedDone.url, start: 0, end: viewedDuration }]),
  )
  const firstUrl = draftPlay[0]?.mediaUrl
  const pendingPoster = (jobId: string | undefined) =>
    posterOf(jobId === undefined ? undefined : materialOf(jobId)?.url)
  const viewedPending = viewedRunning ?? viewedFailed
  const stagePoster = previewingMaterial
    ? posterOf(previewMaterial.url, materialRange?.start)
    : viewedDone !== undefined
      ? posterOf(viewedDone.url)
      : viewedPending !== undefined
        ? pendingPoster(firstSourceOf(viewedPending))
        : posterOf(firstUrl)
  const stageBackdrop = previewingMaterial ? posterOf(previewMaterial.url) : stagePoster
  const stageMessage = previewingMaterial
    ? '素材时长读取失败，暂时无法预览'
    : viewedRunning !== undefined
      ? '整片合成中'
      : viewedFailed !== undefined
        ? '整片合成失败'
        : viewedDone !== undefined
          ? '该版本时长读取失败，暂时无法预览'
          : '成片轨暂无片段'

  const selectedIndex =
    selection?.kind === 'segment'
      ? segments.findIndex((segment) => segment.id === selection.id)
      : -1
  const selectedSegment = segments[selectedIndex]
  const subtitleIndex =
    selection?.kind === 'subtitle' ? subtitles.findIndex((item) => item.key === selection.key) : -1
  const selectedSubtitle = subtitles[subtitleIndex]

  const editable = draft !== undefined && viewingDraft

  const previewFilm = (clock = currentTime, boundary?: 'start' | 'end') => {
    setMaterialPreview(undefined)
    setPreviewSeek({ clock, boundary })
  }
  const showMaterial = (target: MaterialPick, clock: number, boundary?: 'start' | 'end') => {
    setMaterialPreview({
      jobId: target.sourceJobId,
      range: { start: target.start, end: target.end },
    })
    setMaterialTime(clock - target.start)
    setPreviewSeek({ clock: clock - target.start, boundary })
    setSelection(undefined)
  }

  const apply = (
    next: FilmState | ((present: FilmState) => FilmState) | undefined,
    typing?: string,
  ) => {
    if (next === undefined || draft === undefined) return
    if (materialPreview !== undefined) previewFilm()
    draft.apply(next, typing)
    if (typing === undefined) setNotice(null)
  }

  const music = useFilmMusic({
    conversationId,
    taskId,
    taskBlocked,
    film,
    total,
    subtitles: speechProjection.subtitles,
    apply,
    onNotice: setNotice,
  })
  const previewAudio = useFilmPreviewAudio({
    segments: draftAudioSegments,
    music: music.previewMusic,
    waiting: isMusicPending(music.status),
    bodyStartSeconds: bodyStart,
    bodyDuration: total,
    playback:
      viewingDraft && !previewingMaterial ? playback : { playing: false, muted: playback.muted },
    clock: currentTime,
  })
  const musicSelected = selection?.kind === 'music' && music.card !== undefined
  const selectedBrand = selection?.kind === 'brand' ? film[selection.position] : undefined
  const shownSelection: FilmSelection =
    viewingDraft &&
    (selectedSegment !== undefined ||
      selectedSubtitle !== undefined ||
      musicSelected ||
      selectedBrand != null)
      ? selection
      : undefined

  const insert = (target: MaterialPick, index: number) => {
    const duration = segmentDuration(target)
    const blocked = insertBlockedReason(segments, duration, brandDuration(film))
    if (blocked !== undefined) {
      setNotice(blocked)
      return
    }
    const next = insertSegment(film, target, index, crypto.randomUUID())
    if (next === undefined) return
    apply(next)
    const end = bodyStart + insertClockOf(segments, index) + duration
    requestAnimationFrame(() => previewRef.current?.previewAt(end, 'end'))
  }

  const retry = async (sourceJobId: string) => {
    if (retrying.has(sourceJobId)) return
    if (taskId === undefined) {
      setNotice(taskBlocked)
      return
    }
    setRetrying((busy) => new Set(busy).add(sourceJobId))
    try {
      const job = await submitSubtitle({ conversationId, sourceJobId, taskId })
      seedSubtitleJob(queryClient, conversationId, job)
    } catch (error) {
      toast.error(errorMessageOf(error, '字幕识别提交失败'))
    } finally {
      setRetrying((busy) => {
        const next = new Set(busy)
        next.delete(sourceJobId)
        return next
      })
    }
  }

  const addMaterial = (material: Material) => {
    if (draft === undefined) return
    draft.setLanes(putLane(draft.lanes, { takeId: material.takeId, jobId: material.jobId }))
    setPick(undefined)
    setSelection(undefined)
    setMaterialPreview({ jobId: material.jobId })
    setMaterialTime(0)
    setPreviewSeek({ clock: 0 })
  }

  const switchVersion = (view: LaneView, material: Material) => {
    if (material.jobId === view.material.jobId) return
    addMaterial(material)
    setNotice(
      `已换成 ${material.version}，之后从该素材轨选取的片段使用 ${material.version}；成片轨上已有的片段不变`,
    )
  }

  const removeSelected = () => {
    if (selection?.kind === 'brand') {
      apply(setBrand(film, selection.position, null))
      setSelection(undefined)
      return
    }
    if (selectedSegment === undefined) return
    apply(removeSegment(film, selectedSegment.id))
    setSelection(undefined)
  }

  const view = (key: string) => {
    setMaterialPreview(undefined)
    setPreviewSeek({ clock: key === DRAFT_KEY ? currentTime : 0 })
    setViewingKey(key)
    setSelection(undefined)
    setPick(undefined)
    setNotice(null)
  }

  const brands: BrandMenuProps = {
    templates:
      frame.data === undefined
        ? []
        : (templatesQuery.data?.items ?? []).filter(
            (template) =>
              (template.kind === 'intro' || template.kind === 'outro') &&
              (!isVideoTemplate(template) ||
                (frame.data !== undefined && matchesFilmRatio(template, frame.data))),
          ),
    reason:
      segments.length === 0
        ? '成片轨暂无正文视频，无法选择片头片尾；请先放入正文视频'
        : frame.isError
          ? '正文画幅读取失败，请重试'
          : frame.data === undefined
            ? '正在读取正文画幅…'
            : templatesQuery.isError
              ? '模板读取失败，请重试'
              : templatesQuery.data === undefined
                ? '正在读取模板…'
                : undefined,
    retry: frame.isError
      ? () => void frame.refetch()
      : templatesQuery.isError
        ? () => void templatesQuery.refetch()
        : undefined,
    intro: film.intro,
    outro: film.outro,
    onSelect: (position, template) => {
      if (!isVideoTemplate(template)) return
      const next = setBrand(film, position, brandOf(template))
      if (wholeFilmDuration(next) > MAX_FILM_SECONDS) {
        setNotice(
          `加入${position === 'intro' ? '片头' : '片尾'}后整片超过 ${MAX_FILM_SECONDS} 秒，无法加入；请先删减内容`,
        )
        return
      }
      apply(next)
      setSelection({ kind: 'brand', position })
    },
    onRemove: (position) => {
      apply(setBrand(film, position, null))
      setSelection(undefined)
    },
  }

  const composeBlocked = composeBlockedReason({
    submitting,
    segmentCount: segments.length,
    totalSeconds: fullTotal,
    submittedSubtitleCount: burned.length,
    templateBlocked,
    fontBlocked,
    task: task.kind,
    subtitleRecords:
      subtitlesQuery.data !== undefined ? 'ready' : subtitlesQuery.isError ? 'failed' : 'loading',
    recognizing: subtitleStatuses.filter((status) => status.kind === 'running').length,
    music: music.status,
    subtitles,
  })

  const compose = async () => {
    if (composeBlocked !== undefined || taskId === undefined) return
    const plan = composableMusic(music.status)
    setSubmitting(true)
    setComposeError(null)
    setNotice(null)
    try {
      const job = await submitWholeFilm(
        wholeFilmBody({
          conversationId,
          taskId,
          film,
          subtitles: burned,
          music: plan,
        }),
      )
      seedWholeFilmJob(queryClient, conversationId, job)
      toast.success('已提交合成，完成后将生成新版本')
    } catch (error) {
      setComposeError(errorMessageOf(error, '整片合成提交失败，请重试'))
    } finally {
      setSubmitting(false)
    }
  }

  const footnote = (() => {
    if (notice !== null) return notice
    if (draft === undefined) return undefined
    if (viewedDone !== undefined)
      return `正在查看 ${viewedDone.label}，点击「${UNCOMPOSED_LABEL}」可继续剪辑`
    if (viewedRunning !== undefined) return '正在合成，关闭窗口不影响合成'
    if (viewedFailed !== undefined) return '整片合成失败，请检查剪辑后重新点击「合成成片」'
    if (previewingMaterial)
      return `正在预览${materialName(previewMaterial)}${materialRange === undefined ? '' : ` · ${seconds(materialRange.start)}–${seconds(materialRange.end)} 秒`}`
    return music.footnote(musicSelected)
  })()

  const toolButtons = (
    <>
      <span aria-hidden="true" className="editor-bar-divider" />
      <IconButton
        disabled={!editable || draft?.canUndo !== true}
        label="撤销"
        name="undo"
        onClick={() => {
          previewFilm()
          draft?.undo()
        }}
        size="sm"
      />
      <IconButton
        disabled={!editable || draft?.canRedo !== true}
        label="重做"
        name="redo"
        onClick={() => {
          previewFilm()
          draft?.redo()
        }}
        size="sm"
      />
      <span aria-hidden="true" className="editor-bar-divider" />
      <BlockedReason
        reason={
          segments.length >= MAX_FILM_SEGMENTS
            ? `片段最多 ${MAX_FILM_SEGMENTS} 段，无法继续拆分；请先删减片段`
            : undefined
        }
        side="bottom"
      >
        <Button
          className="editor-bar-button editor-tool"
          disabled={!editable || !canSplitAt(segments, bodyTime)}
          leadingIcon="split"
          onClick={() => apply(splitAt(film, bodyTime, crypto.randomUUID()))}
          size="md"
          variant="ghost"
        >
          <span className="editor-tool-label">拆分</span>
        </Button>
      </BlockedReason>
      <Button
        className="editor-bar-button editor-tool"
        disabled={!editable || (selectedSegment === undefined && selectedBrand == null)}
        leadingIcon="delete"
        onClick={removeSelected}
        size="md"
        variant="ghost"
      >
        <span className="editor-tool-label">删除</span>
      </Button>
    </>
  )

  const readout = (
    <span className="editor-readout">
      {previewingMaterial ? (
        <>
          素材选区 ·{' '}
          <b>
            {seconds(materialRange === undefined ? 0 : materialRange.end - materialRange.start)}
          </b>{' '}
          秒
        </>
      ) : (
        <>
          共 <b>{seconds(viewingDraft ? fullTotal : (viewedDuration ?? 0))}</b> 秒 · 上限{' '}
          {MAX_FILM_SECONDS} 秒
        </>
      )}
    </span>
  )

  const seedFailure =
    catalog !== undefined && draft === undefined && musicRecords.isError
      ? {
          message: errorMessageOf(musicRecords.error, '读取音乐记录失败'),
          retry: () => void musicRecords.refetch(),
        }
      : undefined

  const timeline =
    videos.isError && catalog === undefined ? (
      <p className="editor-timeline-loading" role="alert">
        {errorMessageOf(videos.error, '读取视频记录失败')}
        <Button onClick={() => void videos.refetch()} size="md" variant="ghost">
          重试
        </Button>
      </p>
    ) : seedFailure !== undefined ? (
      <p className="editor-timeline-loading" role="alert">
        {`${seedFailure.message}，暂时无法恢复上次合成的剪辑`}
        <Button onClick={seedFailure.retry} size="md" variant="ghost">
          重试
        </Button>
      </p>
    ) : catalog === undefined ? (
      <p className="editor-timeline-loading" role="status">
        正在读取成片…
      </p>
    ) : draft === undefined ? (
      <p className="editor-timeline-loading" role="status">
        正在恢复上次合成的剪辑…
      </p>
    ) : (
      <FilmTimeline
        addVideo={
          <AddVideoRow
            catalog={catalog}
            disabled={!viewingDraft}
            durationOf={durationOf}
            onAdd={addMaterial}
          />
        }
        brands={brands}
        subtitleSettings={
          <FilmFontMenu
            font={film.font}
            fonts={(templatesQuery.data?.items ?? []).filter((item) => item.kind === 'font')}
            reason={
              templatesQuery.isError
                ? '字体读取失败，请重试'
                : templatesQuery.data === undefined
                  ? '正在读取字体…'
                  : undefined
            }
            retry={templatesQuery.isError ? () => void templatesQuery.refetch() : undefined}
            onSelect={(font) => apply(setFont(film, font))}
          />
        }
        anchorRef={anchorRef}
        currentTime={currentTime}
        durationOf={durationOf}
        lanes={lanes}
        materialOf={materialOf}
        onDelete={(id) => {
          apply(removeSegment(film, id))
          setSelection(undefined)
        }}
        onInsert={insert}
        onMove={(id, before) => apply(moveSegment(film, id, before))}
        onPick={(next) => {
          setPick(next)
          if (next !== undefined) setSelection(undefined)
        }}
        onPreviewMaterial={showMaterial}
        onRetry={(sourceJobId) => void retry(sourceJobId)}
        onScrub={() => {
          previewFilm()
          setSelection((value) => (value?.kind === 'segment' ? value : undefined))
        }}
        onSeek={(time) => previewFilm(time)}
        onSelect={(next) => {
          previewFilm()
          setSelection(next)
          if (next !== undefined) setPick(undefined)
        }}
        music={music.status}
        musicAdd={<MusicMenu container={editorElement} {...music.menu} />}
        onMoveMusic={music.move}
        onRemoveMusic={() => {
          music.remove()
          setSelection(undefined)
        }}
        onSwitchVersion={switchVersion}
        onTrim={(id, edge, value) => {
          const segment = segments.find((item) => item.id === id)
          const material = segment === undefined ? undefined : materialOf(segment.sourceJobId)
          const duration = material === undefined ? undefined : durationOf(material)
          apply(trimSegment(film, id, edge, value, duration ?? undefined))
        }}
        onTrimPreview={(target, clock, edge) => {
          setMaterialPreview({
            jobId: target.sourceJobId,
            range: { start: target.start, end: target.end },
          })
          setMaterialTime(clock - target.start)
          setPreviewSeek({ clock: clock - target.start, boundary: edge })
        }}
        peaksOf={(url) => peaks.get(url) ?? LOADING_PEAKS}
        pick={viewingDraft ? pick : undefined}
        retrying={retrying}
        scale={scale}
        segments={segments}
        selection={shownSelection}
        statuses={subtitleStatuses.map((item) => ({
          ...item,
          at: item.at + bodyStart,
          end: item.end + bodyStart,
        }))}
        subtitles={subtitles.map((item) => ({
          ...item,
          at: item.at + bodyStart,
          end: item.end + bodyStart,
        }))}
        total={fullTotal}
        bodyTotal={total}
        intro={film.intro}
        outro={film.outro}
      />
    )

  const segmentMaterial =
    selectedSegment === undefined ? undefined : materialOf(selectedSegment.sourceJobId)
  const subtitleMaterial =
    selectedSubtitle === undefined
      ? undefined
      : materialOf(
          segments.find((segment) => segment.id === selectedSubtitle.segmentId)?.sourceJobId ?? '',
        )
  const card = !viewingDraft ? null : selectedBrand != null && selection?.kind === 'brand' ? (
    <BrandCard
      anchorRef={anchorRef}
      position={selection.position}
      template={selectedBrand}
      brands={brands}
      onClose={() => setSelection(undefined)}
    />
  ) : selectedSegment !== undefined && segmentMaterial !== undefined ? (
    <SegmentCard
      anchorRef={anchorRef}
      end={selectedSegment.end}
      frame={videoSnapshotUrl(segmentMaterial.url, 60, selectedSegment.start)}
      key={selectedSegment.id}
      onClose={() => setSelection(undefined)}
      position={selectedIndex + 1}
      source={materialName(segmentMaterial)}
      start={selectedSegment.start}
    />
  ) : selectedSubtitle !== undefined ? (
    <SubtitleCard
      anchorRef={anchorRef}
      key={selectedSubtitle.key}
      onClose={() => setSelection(undefined)}
      onText={(text) =>
        apply(setSentenceText(film, selectedSubtitle.textKey, text), selectedSubtitle.textKey)
      }
      origin={
        selectedSubtitle.kind === 'snapshot'
          ? '从已合成版本恢复'
          : subtitleMaterial === undefined
            ? '自动识别的口播'
            : `来自${materialName(subtitleMaterial)} 的口播`
      }
      position={subtitleIndex + 1}
      text={selectedSubtitle.text}
    />
  ) : musicSelected && music.card !== undefined ? (
    <MusicCard
      anchorRef={anchorRef}
      detail={music.card.detail}
      lines={music.card.lines}
      onClose={() => setSelection(undefined)}
      onRegenerate={music.card.onRegenerate}
      onRemove={() => {
        music.remove()
        setSelection(undefined)
      }}
      title={music.card.title}
    />
  ) : null

  const stripEntries: VersionStripEntry[] = [
    {
      key: DRAFT_KEY,
      label: UNCOMPOSED_LABEL,
      name: `${UNCOMPOSED_LABEL}的整片`,
      poster: posterOf(firstUrl),
      running: undefined,
      unseen: false,
    },
    ...versions.running.map((job) => ({
      key: job.id,
      label: undefined,
      name: '整片合成中',
      poster: pendingPoster(firstSourceOf(job)),
      running: { since: job.createdAt },
      unseen: false,
    })),
    ...versions.failed.map((job) => ({
      key: job.id,
      label: undefined,
      name: '整片合成失败',
      poster: pendingPoster(firstSourceOf(job)),
      running: undefined,
      failed: true,
      unseen: false,
    })),
    ...versions.done.toReversed().map((item) => ({
      key: item.job.id,
      label: item.label,
      name: `整片 ${item.label}`,
      poster: posterOf(item.url),
      running: undefined,
      unseen: false,
    })),
  ]

  const composeButton = (
    <BlockedReason reason={composeBlocked} side="bottom">
      <Button
        aria-disabled={composeBlocked === undefined ? undefined : true}
        className="editor-compose"
        onClick={() => {
          if (composeBlocked === undefined) void compose()
        }}
        size="md"
      >
        {submitting ? (
          <Icon className="motion-safe:animate-spin" decorative name="loading" size="md" />
        ) : (
          <Icon decorative name="video" size="md" />
        )}
        合成成片
      </Button>
    </BlockedReason>
  )

  const downloadButton =
    viewedDone === undefined ? (
      <Button
        className="editor-bar-button"
        disabled
        leadingIcon="download"
        size="md"
        title="合成后可下载"
        variant="ghost"
      >
        下载
      </Button>
    ) : (
      <VideoDownload
        className={DOWNLOAD_CLASS}
        jobId={viewedDone.job.id}
        url={viewedDone.url}
        watermarkUrl={null}
      >
        下载
      </VideoDownload>
    )

  const showingDraftFilm = viewingDraft && !previewingMaterial
  const captionPresentation =
    showingDraftFilm && captionLayout?.kind === 'ready' ? captionLayout.presentation : undefined
  const captionText =
    showingDraftFilm && caption !== undefined && (systemFont || captionLayout?.kind === 'ready')
      ? normalizeCaptionText(caption)
      : undefined

  return (
    <DialogRoot open onOpenChange={(open) => !open && onClose()}>
      <DialogSurface
        aria-describedby={undefined}
        className="editor-dialog"
        onEscapeKeyDown={(event) => {
          if (shownSelection === undefined && pick === undefined && !previewingMaterial) return
          event.preventDefault()
          setSelection(undefined)
          setPick(undefined)
          previewFilm()
        }}
        onInteractOutside={(event) => event.preventDefault()}
        onKeyDown={(event) =>
          handleUndoShortcut(event, viewingDraft ? draft : undefined, () => previewFilm())
        }
      >
        <DialogHeader
          actions={composeButton}
          className="editor-header border-0"
          closeLabel="关闭视频编辑"
          title={
            <span className="editor-title">
              <span>编辑视频</span>
              <span className="text-body-sm font-normal text-on-surface-muted">整片</span>
            </span>
          }
        />
        <div
          aria-label="整片编辑器"
          className="editor-workspace whole-film-editor"
          ref={setEditorElement}
        >
          <EditorPreview
            aspectRatio={
              captionPresentation === undefined
                ? undefined
                : captionPresentation.frame.width / captionPresentation.frame.height
            }
            backdrop={stageBackdrop}
            barEnd={downloadButton}
            contentKey={
              previewingMaterial
                ? `material:${previewMaterial.jobId}`
                : viewingDraft
                  ? 'whole-film'
                  : `version:${viewingKey}`
            }
            current={current}
            currentTime={previewingMaterial ? materialTime : currentTime}
            externalAudio={
              showingDraftFilm
                ? {
                    blocked:
                      previewAudio.state.kind === 'ready'
                        ? undefined
                        : previewAudio.state.kind === 'loading'
                          ? '正在准备预览声音…'
                          : previewAudio.state.message,
                  }
                : undefined
            }
            footnote={
              <>
                {task.kind === 'failed' ? (
                  <InlineAlert
                    action={{ label: '重试', onClick: task.retry }}
                    message="任务信息读取失败，识别字幕、生成音乐与合成暂时无法提交"
                  />
                ) : null}
                {composeError === null ? null : <InlineAlert message={composeError} />}
                {viewingDraft && previewAudio.state.kind === 'failed' ? (
                  <InlineAlert
                    message={previewAudio.state.message}
                    action={{ label: '重试', onClick: previewAudio.state.retry }}
                  />
                ) : null}
                {viewingDraft && fontBlocked !== undefined ? (
                  <InlineAlert
                    message={fontBlocked}
                    {...(previewFont.kind === 'failed'
                      ? { action: { label: '重试', onClick: previewFont.retry } }
                      : previewFont.kind === 'unsupported'
                        ? {}
                        : frame.isError
                          ? { action: { label: '重试', onClick: () => void frame.refetch() } }
                          : templatesQuery.isError
                            ? {
                                action: {
                                  label: '重试',
                                  onClick: () => void templatesQuery.refetch(),
                                },
                              }
                            : {})}
                  />
                ) : null}
                {templateBlocked === undefined ? null : (
                  <InlineAlert
                    message={templateBlocked}
                    {...(brands.retry === undefined
                      ? {}
                      : { action: { label: '重试', onClick: brands.retry } })}
                  />
                )}
                {subtitlesQuery.isError && seedFailure === undefined ? (
                  <InlineAlert
                    action={{ label: '重试', onClick: () => void subtitlesQuery.refetch() }}
                    message={errorMessageOf(subtitlesQuery.error, '读取字幕记录失败')}
                  />
                ) : null}
                {videos.isError && catalog !== undefined ? (
                  <InlineAlert
                    action={{ label: '重试', onClick: () => void videos.refetch() }}
                    message={errorMessageOf(videos.error, '读取视频记录失败')}
                  />
                ) : null}
                {viewingDraft && !previewingMaterial && unduckedCount > 0 ? (
                  <p className="editor-footnote" role="status">
                    有 {unduckedCount} 段缺少口播识别，配乐未自动避让；请在字幕轨重新识别
                  </p>
                ) : null}
                {footnote === undefined ? null : (
                  <p className="editor-footnote" role={notice === null ? undefined : 'status'}>
                    {footnote}
                  </p>
                )}
              </>
            }
            onPlay={() => {
              setSelection((value) => (value?.kind === 'segment' ? value : undefined))
              if (showingDraftFilm) previewAudio.prime()
            }}
            onPlaybackChange={setPlayback}
            onTime={previewingMaterial ? setMaterialTime : setCurrentTime}
            overlay={card}
            picture={
              <>
                {captionText === undefined ? null : (
                  <FilmCaption presentation={captionPresentation} text={captionText} />
                )}
                {current?.length === 0 ? <PreviewMessage>{stageMessage}</PreviewMessage> : null}
              </>
            }
            poster={stagePoster}
            readout={readout}
            ref={previewRef}
            timeline={
              <>
                <FilmSoundControls
                  segmentLabel={
                    selectedSegment === undefined ? undefined : `第 ${selectedIndex + 1} 段`
                  }
                  sourceVolume={selectedSegment?.volume ?? 1}
                  musicVolume={film.music?.volume ?? 1}
                  sourceDisabled={!editable || selectedSegment === undefined}
                  musicDisabled={!editable || music.status.kind !== 'ready'}
                  alignmentBlocked={
                    !editable
                      ? '正在查看已合成版本，无法调整配乐；请返回「未合成」'
                      : music.status.kind !== 'ready'
                        ? '暂无可用配乐，无法自动对齐；请先添加配乐'
                        : music.status.placement.shortBy > 0
                          ? '配乐时长不足，无法自动对齐；请更换配乐'
                          : music.status.song.grid === null
                            ? '未检测到拍点，无法自动对齐；请拖动音乐调整起点'
                            : undefined
                  }
                  onSourceVolume={(volume, edit) => {
                    if (selectedSegment !== undefined)
                      apply(
                        (present) => setSegmentVolume(present, selectedSegment.id, volume),
                        edit,
                      )
                  }}
                  onMusicVolume={(volume, edit) =>
                    apply((present) => setMusicVolume(present, volume), edit)
                  }
                  onAlign={() => {
                    apply(resetMusicStart(film))
                    setNotice('已按当前剪辑自动对齐配乐')
                  }}
                />
                <div className="whole-film-track-scroll" role="region" aria-label="轨道列表">
                  {viewingDraft ? (
                    timeline
                  ) : (
                    <div className="whole-film-timeline-locked" inert>
                      {timeline}
                    </div>
                  )}
                </div>
              </>
            }
            tools={toolButtons}
            versions={
              <EditorVersionStrip
                entries={stripEntries}
                onSelect={view}
                selectedKey={viewingDraft ? DRAFT_KEY : viewingKey}
              />
            }
            viewControl={null}
          />
        </div>
      </DialogSurface>
    </DialogRoot>
  )
}
