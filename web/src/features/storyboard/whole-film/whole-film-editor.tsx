/** 整片编辑器：视频编辑器的整片模式。把这段对话读得到的成片（自己的与继承的）放进素材区，从各条素材上挑段、
 * 在成片轨上交叉剪辑成一条整片；字幕取各段来源的口播识别结果，跟着画面走，只能改字；背景音乐上传或生成，
 * 自动对齐切点、口播处压低，预览时跟着画面放（见 use-film-music）。「合成成片」把草稿排成时间线交给服务端，
 * 合成出的每一版进版本条，点开预览、下载。
 *
 * 编辑只存在浏览器里（ADR-0003），按对话一份；浏览器里没有草稿而已经合成过时，按最新一版重建。界面上不调声音。 */

import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useBrandTemplates } from '@/shared/api/brand-templates'
import { errorMessageOf } from '@/shared/api/client'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { Button, IconButton } from '@/shared/ui/button'
import { DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { toast } from '@/shared/ui/toast'
import { VideoDownload } from '@/shared/ui/video-download'
import type { ConversationTask } from '@/shared/workbench'
import { BlockedReason } from '../components/blocked-reason'
import { groupConversationVideos } from '../conversation-videos/video-groups'
import { useShotGenerations } from '../storyboard.api'
import { EditorPreview, type EditorPreviewHandle } from '../video-editor/editor-preview'
import { EditorVersionStrip, type VersionStripEntry } from '../video-editor/editor-version-strip'
import { layoutPlay } from '../video-editor/play-layout'
import { useAudioPeaks, type PeaksState } from '../video-editor/use-media-analysis'
import { useMediaDurations } from '../video-editor/use-media-durations'
import { useStableValue } from '../video-editor/use-stable-value'
import {
  addManualSubtitle,
  brandDuration,
  wholeFilmDuration,
  setBrand,
  MAX_FILM_SEGMENTS,
  MAX_FILM_SUBTITLES,
  canSplitAt,
  EMPTY_FILM,
  filmDuration,
  fitsInFilm,
  insertClockOf,
  insertSegment,
  MAX_FILM_SECONDS,
  moveSegment,
  putLane,
  removeManualSubtitle,
  removeSegment,
  segmentAt,
  segmentDuration,
  setManualText,
  setSentenceText,
  splitAt,
  trimSegment,
  type FilmState,
} from './film-draft'
import { BrandCard, MusicCard, SegmentCard, SubtitleCard } from './film-card'
import { MusicMenu } from './film-music-menu'
import {
  materialCatalog,
  materialName,
  type Material,
  type MaterialDuration,
} from './film-materials'
import { AddMenu, AddVideoRow, type BrandMenuProps } from './film-menus'
import { brandOf, matchesFilmRatio, templateBlockedReason, useFilmDimensions } from './film-brand'
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
import {
  seedSubtitleJob,
  seedWholeFilmJob,
  submitSubtitle,
  submitWholeFilm,
  useConversationMusic,
  useConversationSubtitles,
} from './whole-film.api'
import './whole-film.css'

/** 时间线至少按这么多秒排：空轨、短片时刻度不至于太密。 */
const MIN_SCALE_SECONDS = 20
const LOADING_PEAKS: PeaksState = { kind: 'loading' }
const STORAGE_FAILURE = '当前浏览器无法保存草稿，关闭编辑器后整片内容将丢失'
const UNCOMPOSED_LABEL = '未合成'
/** 版本条上草稿那一格的键；别的格子用整片记录的 id。 */
const DRAFT_KEY = 'draft'
const seconds = (value: number) => value.toFixed(1)
const posterOf = (url: string | undefined, at = 0) =>
  url === undefined ? undefined : videoSnapshotUrl(url, 320, at)

/** 控制条上「下载」的外观：与拆分、删除同一档的文字按钮（VideoDownload 带字时样式全由这里给）。 */
const DOWNLOAD_CLASS =
  'video-editor-bar-button relative inline-flex h-(--control-height-md) cursor-pointer items-center justify-center gap-2 rounded-sm text-body-sm font-medium whitespace-nowrap ui-state ui-focus'

/** 按键落在输入框里时让给输入框自己（Cmd/Ctrl+Z 在那里是撤销打字）。 */
const isTextEntry = (target: EventTarget) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && target.type !== 'range'))

type Props = {
  conversationId: string
  /** 本对话此刻挂的需求单：重新识别字幕、生成音乐、合成整片都归属到它；没读到时这几样先不能提交。宿主没给时当作在读。 */
  task: ConversationTask | undefined
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
  // 生成面板挂在编辑器里（模态弹窗外的浮层拿不到焦点）。
  const [editorElement, setEditorElement] = useState<HTMLElement | null>(null)
  const [selection, setSelection] = useState<FilmSelection>()
  const [pick, setPick] = useState<MaterialPick>()
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(() => new Set())
  /** 版本条上选中的那一格：草稿，或某一条整片。 */
  const [viewingKey, setViewingKey] = useState(DRAFT_KEY)
  const [submitting, setSubmitting] = useState(false)
  const [composeError, setComposeError] = useState<string | null>(null)
  /** 脚注位置上要让人看到的一句话，下一次剪辑时收起。 */
  const [notice, setNotice] = useState<string | null>(null)
  const storageFailedRef = useRef(false)
  const noticeStorageFailure = () => {
    if (storageFailedRef.current) return
    storageFailedRef.current = true
    setNotice(STORAGE_FAILURE)
  }

  const taskId = task?.kind === 'ready' ? task.taskId : undefined
  const taskState = task?.kind ?? 'loading'
  const taskBlocked =
    taskState === 'failed'
      ? '任务信息读取失败，暂时无法提交；请点击「重试」'
      : '任务信息读取中，暂时无法提交'

  const catalog = useMemo(
    () =>
      videos.data === undefined ? undefined : materialCatalog(groupConversationVideos(videos.data)),
    [videos.data],
  )
  const known = useMemo(
    () => (catalog === undefined ? undefined : new Set(catalog.byJob.keys())),
    [catalog],
  )
  const versions = useMemo(() => wholeFilmVersions(videos.data ?? []), [videos.data])
  const materialOf = (jobId: string) => catalog?.byJob.get(jobId)

  const latest = useMemo(
    () => (subtitlesQuery.data === undefined ? undefined : latestSubtitles(subtitlesQuery.data)),
    [subtitlesQuery.data],
  )
  const sourceOf = (jobId: string): SubtitleSource | undefined =>
    latest === undefined ? undefined : subtitleSourceOf(latest.get(jobId))

  // 浏览器里没有草稿而合成过：从最新版本的最终字幕与模板快照恢复，音乐记录用于区分生成与上传。
  const newestVersion = versions.done.at(-1)
  const seed = (): DraftSeed => {
    if (newestVersion === undefined) return null
    if (musicRecords.data === undefined) return undefined
    return {
      label: newestVersion.label,
      stored: draftFromVersion(newestVersion.job, {
        groupOf: (jobId) => materialOf(jobId)?.groupId,
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

  // ---------- 版本 ----------

  const viewedDone = versions.done.find((item) => item.job.id === viewingKey)
  const viewedRunning = versions.running.find((job) => job.id === viewingKey)
  const viewedFailed = versions.failed.find((job) => job.id === viewingKey)
  // 选中的那一条不在了（换了一批记录）就回到草稿。
  const viewingDraft =
    viewedDone === undefined && viewedRunning === undefined && viewedFailed === undefined

  // 素材多长：记录上有就用，没有就开播放器去探；看着的那一版没记时长也去探。
  const probeUrls = useStableValue([
    ...(catalog === undefined
      ? []
      : [...catalog.byJob.values()].flatMap((item) =>
          item.knownDuration === undefined ? [item.url] : [],
        )),
    ...(viewedDone !== undefined && viewedDone.job.durationMs === null ? [viewedDone.url] : []),
  ])
  const durations = useMediaDurations(probeUrls)
  const durationOf = (material: Material): MaterialDuration =>
    material.knownDuration ?? durations[material.url]

  const lanes: LaneView[] = (draft?.lanes ?? []).flatMap((lane) => {
    const material = materialOf(lane.jobId)
    const group = catalog?.groups.find((item) => item.id === lane.groupId)
    if (material === undefined || group === undefined) return []
    return [
      {
        lane,
        label: group.label,
        material,
        versions: group.versions,
        duration: durationOf(material),
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

  // ---------- 字幕 ----------

  const { subtitles, statuses } = projectSubtitles(film, sourceOf)
  // 恢复的字幕有自己的快照，音乐压低仍依赖来源识别；识别中的口播不能被快照掩盖。
  const speechProjection = projectSubtitles(film, sourceOf, false)
  const subtitleStatuses = film.music === null ? statuses : speechProjection.statuses
  const burned = burnedSubtitles(subtitles)

  // ---------- 预览 ----------

  const draftPlay = layoutPlay([
    ...(film.intro == null
      ? []
      : [{ mediaUrl: film.intro.url, start: 0, end: film.intro.durationMs / 1000 }]),
    ...segments.flatMap((segment) => {
      const url = materialOf(segment.sourceJobId)?.url
      return url === undefined ? [] : [{ mediaUrl: url, start: segment.start, end: segment.end }]
    }),
    ...(film.outro == null
      ? []
      : [{ mediaUrl: film.outro.url, start: 0, end: film.outro.durationMs / 1000 }]),
  ])
  const viewedDuration =
    viewedDone === undefined
      ? undefined
      : viewedDone.job.durationMs === null
        ? durations[viewedDone.url]
        : viewedDone.job.durationMs / 1000
  const current = useStableValue(
    viewingDraft
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
  const stagePoster =
    viewedDone !== undefined
      ? posterOf(viewedDone.url)
      : viewedPending !== undefined
        ? pendingPoster(firstSourceOf(viewedPending))
        : posterOf(firstUrl)
  const stageMessage =
    viewedRunning !== undefined
      ? '整片合成中'
      : viewedFailed !== undefined
        ? '整片合成失败'
        : viewedDone !== undefined
          ? '这一版的时长读取失败，暂时无法预览'
          : '成片轨还是空的'

  // ---------- 选中 ----------

  // 选中的段或字幕不在了（撤销、删掉、换了识别结果）就当没选。
  const selectedIndex =
    selection?.kind === 'segment'
      ? segments.findIndex((segment) => segment.id === selection.id)
      : -1
  const selectedSegment = segments[selectedIndex]
  const subtitleIndex =
    selection?.kind === 'subtitle' ? subtitles.findIndex((item) => item.key === selection.key) : -1
  const selectedSubtitle = subtitles[subtitleIndex]

  // ---------- 操作 ----------

  const editable = draft !== undefined && viewingDraft

  const apply = (
    next: FilmState | ((present: FilmState) => FilmState) | undefined,
    typing?: string,
  ) => {
    if (next === undefined || draft === undefined) return
    draft.apply(next, typing)
    if (typing === undefined) setNotice(null)
  }

  // ---------- 音乐 ----------

  const music = useFilmMusic({
    conversationId,
    taskId,
    taskBlocked,
    film,
    total,
    subtitles: speechProjection.subtitles,
    previewSegments: draftPlay,
    bodyStartSeconds: bodyStart,
    apply,
    onNotice: setNotice,
    // 看着合成好的一版时，那一版自带混好的声音，草稿的音乐不跟着放。
    playback: viewingDraft ? playback : { playing: false, muted: playback.muted },
    currentTime,
  })
  // 音乐读出来了才选得中；拿掉、换了还在读的就当没选。
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
    if (segments.length >= MAX_FILM_SEGMENTS) {
      setNotice(`片段最多 ${MAX_FILM_SEGMENTS} 段，无法继续插入；请先删减片段`)
      return
    }
    if (!fitsInFilm(segments, duration, brandDuration(film))) {
      setNotice(
        `整片含片头片尾已有 ${seconds(fullTotal)} 秒，放不下这 ${seconds(duration)} 秒；请先删减成片轨上的段`,
      )
      return
    }
    const next = insertSegment(film, target, index, crypto.randomUUID())
    if (next === undefined) return
    apply(next)
    // 播放头移到新段的结尾：接着按回车插入，下一段就排在它后面。
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
    draft.setLanes(putLane(draft.lanes, { groupId: material.groupId, jobId: material.jobId }))
    if (pick?.groupId === material.groupId && pick.sourceJobId !== material.jobId)
      setPick(undefined)
  }

  const switchVersion = (view: LaneView, material: Material) => {
    if (material.jobId === view.material.jobId) return
    addMaterial(material)
    setNotice(
      `已换成 ${material.version}，之后从这条素材轨挑的段用 ${material.version}；成片轨上已有的段不变`,
    )
  }

  const addSubtitleBlocked =
    subtitles.length >= MAX_FILM_SUBTITLES
      ? `字幕最多 ${MAX_FILM_SUBTITLES} 条，无法继续添加；请先删减字幕`
      : draft === undefined || segmentAt(segments, bodyTime) !== undefined
        ? undefined
        : '播放头处没有正文画面，无法添加字幕；请把播放头移到成片轨的正文段上'
  const addSubtitle = () => {
    if (subtitles.length >= MAX_FILM_SUBTITLES) {
      setNotice(`字幕最多 ${MAX_FILM_SUBTITLES} 条，无法继续添加；请先删减字幕`)
      return
    }
    const id = crypto.randomUUID()
    const next = addManualSubtitle(film, bodyTime, id)
    if (next === undefined) return
    apply(next)
    setSelection({ kind: 'subtitle', key: id })
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

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isTextEntry(event.target) || !(event.metaKey || event.ctrlKey)) return
    if (event.key.toLowerCase() !== 'z' || draft === undefined || !viewingDraft) return
    event.preventDefault()
    if (event.shiftKey) {
      if (draft.canRedo) draft.redo()
    } else if (draft.canUndo) draft.undo()
  }

  const view = (key: string) => {
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
            (template) => frame.data !== undefined && matchesFilmRatio(template, frame.data),
          ),
    reason:
      segments.length === 0
        ? '请先在成片轨放入正文视频，再选择片头片尾'
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
      const next = setBrand(film, position, brandOf(template))
      if (wholeFilmDuration(next) > MAX_FILM_SECONDS) {
        setNotice(
          `加入${position === 'intro' ? '片头' : '片尾'}后整片超过 ${MAX_FILM_SECONDS} 秒；请先删减内容`,
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

  // ---------- 合成 ----------

  const composeBlocked = composeBlockedReason({
    submitting,
    segmentCount: segments.length,
    totalSeconds: fullTotal,
    submittedSubtitleCount: burned.length,
    templateBlocked,
    task: taskState,
    subtitleRecords:
      subtitlesQuery.data !== undefined ? 'ready' : subtitlesQuery.isError ? 'failed' : 'loading',
    recognizing: subtitleStatuses.filter((status) => status.kind === 'running').length,
    music: music.readiness,
    subtitles,
  })

  const compose = async () => {
    if (composeBlocked !== undefined || taskId === undefined) return
    const { readiness } = music
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
          music: readiness.kind === 'ready' ? readiness.plan : null,
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

  // ---------- 脚注 ----------

  const footnote = (() => {
    if (notice !== null) return notice
    if (draft === undefined) return ''
    if (viewedDone !== undefined)
      return `正在查看 ${viewedDone.label}；点击「${UNCOMPOSED_LABEL}」可返回草稿继续剪辑`
    if (viewedRunning !== undefined) return '整片合成中，关闭窗口不影响合成；完成后可预览与下载'
    if (viewedFailed !== undefined) return '整片合成失败，请检查剪辑后重新点击「合成成片」'
    if (pick !== undefined)
      return '拖动两端调整选区，按住选区拖到上面的成片轨；也可按回车插入到播放头处'
    if (selectedBrand != null) return '片头片尾位置固定，不能拖动或裁剪；可在卡片中更换或删除模板'
    if (selectedSegment !== undefined)
      return `选中第 ${selectedIndex + 1} 段：拖动两端可裁剪，按住中间拖动可调整顺序`
    if (selectedSubtitle !== undefined)
      return `选中第 ${subtitleIndex + 1} 条字幕：在卡片中改字，时间跟着画面走`
    const aboutMusic = music.footnote(musicSelected)
    if (aboutMusic !== undefined) return aboutMusic
    if (lanes.length === 0 && segments.length === 0) return '时间线为空，请从「添加」放入视频'
    if (segments.length === 0) return '在素材轨上拖选一段，拖到上面的成片轨'
    return '素材轨底部的细条是已用进成片轨的区间；声音在合成时统一处理'
  })()

  // ---------- 渲染 ----------

  const toolButtons = (
    <>
      <span aria-hidden="true" className="video-editor-bar-divider" />
      <IconButton
        disabled={!editable || draft?.canUndo !== true}
        label="撤销"
        name="undo"
        onClick={() => draft?.undo()}
        size="sm"
      />
      <IconButton
        disabled={!editable || draft?.canRedo !== true}
        label="重做"
        name="redo"
        onClick={() => draft?.redo()}
        size="sm"
      />
      <span aria-hidden="true" className="video-editor-bar-divider" />
      <BlockedReason
        reason={
          segments.length >= MAX_FILM_SEGMENTS
            ? `片段最多 ${MAX_FILM_SEGMENTS} 段，无法继续拆分；请先删减片段`
            : undefined
        }
        side="bottom"
      >
        <Button
          className="video-editor-bar-button video-editor-tool"
          disabled={!editable || !canSplitAt(segments, bodyTime)}
          leadingIcon="split"
          onClick={() => apply(splitAt(film, bodyTime, crypto.randomUUID()))}
          size="md"
          variant="ghost"
        >
          <span className="video-editor-tool-label">拆分</span>
        </Button>
      </BlockedReason>
      <Button
        className="video-editor-bar-button video-editor-tool"
        disabled={!editable || (selectedSegment === undefined && selectedBrand == null)}
        leadingIcon="delete"
        onClick={removeSelected}
        size="md"
        variant="ghost"
      >
        <span className="video-editor-tool-label">删除</span>
      </Button>
      {catalog === undefined || draft === undefined ? null : (
        <AddMenu
          catalog={catalog}
          brands={brands}
          disabled={!viewingDraft}
          durationOf={durationOf}
          onAdd={addMaterial}
        />
      )}
    </>
  )

  const readout = (
    <span className="video-editor-readout">
      共 <b>{seconds(viewingDraft ? fullTotal : (viewedDuration ?? 0))}</b> 秒 · 上限{' '}
      {MAX_FILM_SECONDS} 秒
    </span>
  )

  /** 重建草稿要用的记录读不出来：说清读的是什么，给重试。 */
  const seedFailure =
    catalog !== undefined && draft === undefined && musicRecords.isError
      ? {
          message: errorMessageOf(musicRecords.error, '读取音乐记录失败'),
          retry: () => void musicRecords.refetch(),
        }
      : undefined

  const timeline =
    videos.isError && catalog === undefined ? (
      <p className="video-editor-timeline-loading" role="alert">
        {errorMessageOf(videos.error, '读取视频记录失败')}
        <Button onClick={() => void videos.refetch()} size="md" variant="ghost">
          重试
        </Button>
      </p>
    ) : seedFailure !== undefined ? (
      <p className="video-editor-timeline-loading" role="alert">
        {`${seedFailure.message}，暂时无法恢复上次合成的剪辑`}
        <Button onClick={seedFailure.retry} size="md" variant="ghost">
          重试
        </Button>
      </p>
    ) : catalog === undefined ? (
      <p className="video-editor-timeline-loading" role="status">
        正在读取成片…
      </p>
    ) : draft === undefined ? (
      <p className="video-editor-timeline-loading" role="status">
        正在恢复上次合成的剪辑…
      </p>
    ) : (
      <FilmTimeline
        addSubtitleBlocked={addSubtitleBlocked}
        addVideo={<AddVideoRow catalog={catalog} durationOf={durationOf} onAdd={addMaterial} />}
        anchorRef={anchorRef}
        currentTime={currentTime}
        durationOf={durationOf}
        lanes={lanes}
        materialOf={materialOf}
        onAddSubtitle={addSubtitle}
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
        onRetry={(sourceJobId) => void retry(sourceJobId)}
        // 拖动时收起字幕卡与音乐卡；选中的段留着（拖的可能就是它的两端）。
        onScrub={() => setSelection((value) => (value?.kind === 'segment' ? value : undefined))}
        onSeek={(time) => previewRef.current?.previewAt(time)}
        onSelect={(next) => {
          setSelection(next)
          if (next !== undefined) setPick(undefined)
        }}
        music={music.view}
        musicAdd={<MusicMenu container={editorElement} {...music.menu} />}
        onMoveMusic={music.move}
        onRemoveMusic={() => {
          music.remove()
          setSelection(undefined)
        }}
        onSwitchVersion={switchVersion}
        onTrim={(id, edge, value) => apply(trimSegment(film, id, edge, value))}
        onTrimPreview={(clock, edge) => previewRef.current?.previewAt(clock, edge)}
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
      onRemove={
        selectedSubtitle.kind === 'manual'
          ? () => {
              apply(removeManualSubtitle(film, selectedSubtitle.textKey))
              setSelection(undefined)
            }
          : undefined
      }
      onText={(text) =>
        apply(
          selectedSubtitle.kind === 'manual'
            ? setManualText(film, selectedSubtitle.textKey, text)
            : setSentenceText(film, selectedSubtitle.textKey, text),
          selectedSubtitle.textKey,
        )
      }
      position={subtitleIndex + 1}
      restored={selectedSubtitle.kind === 'snapshot'}
      source={
        selectedSubtitle.kind !== 'sentence' || subtitleMaterial === undefined
          ? undefined
          : materialName(subtitleMaterial)
      }
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

  // 新的在前：草稿、在合成的、失败的、完成的各版。
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
        className="video-editor-compose"
        onClick={() => {
          if (composeBlocked === undefined) void compose()
        }}
        size="md"
      >
        {/* 提交中不用 `loading`：它落原生 disabled，悬停就说不出原因了。 */}
        {submitting ? (
          <Icon className="motion-safe:animate-spin" decorative name="loading" size="md" />
        ) : (
          <Icon decorative name="video" size="md" />
        )}
        合成成片
      </Button>
    </BlockedReason>
  )

  /** 控制条最右的下载：下的是选中的那一版，看着草稿或还没合成好时灰着。 */
  const downloadButton =
    viewedDone === undefined ? (
      <Button
        className="video-editor-bar-button"
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

  return (
    <DialogRoot open onOpenChange={(open) => !open && onClose()}>
      <DialogSurface
        aria-describedby={undefined}
        className="video-editor-dialog"
        onEscapeKeyDown={(event) => {
          // 有选中或选区时 Escape 先收起它们，再按一次才关编辑器。
          if (shownSelection === undefined && pick === undefined) return
          event.preventDefault()
          setSelection(undefined)
          setPick(undefined)
        }}
        onInteractOutside={(event) => event.preventDefault()}
        onKeyDown={keyDown}
      >
        <DialogHeader
          actions={composeButton}
          className="video-editor-header border-0"
          closeLabel="关闭视频编辑"
          title={
            <span className="video-editor-title">
              <span>编辑视频</span>
              <span className="text-body-sm font-normal text-on-surface-muted">整片</span>
            </span>
          }
        />
        <div
          aria-label="整片编辑器"
          className="video-editor whole-film-editor"
          ref={setEditorElement}
        >
          <EditorPreview
            backdrop={{ current: stagePoster, original: undefined }}
            barEnd={downloadButton}
            caption={viewingDraft ? captionAt(burned, bodyTime) : undefined}
            contentKey={viewingDraft ? 'whole-film' : `version:${viewingKey}`}
            current={current}
            currentTime={currentTime}
            muteMediaAudio={viewingDraft}
            playBlocked={
              viewingDraft && music.previewAudio.kind !== 'ready'
                ? music.previewAudio.kind === 'loading'
                  ? '正在准备预览声音…'
                  : music.previewAudio.message
                : undefined
            }
            emptyMessage={stageMessage}
            footnote={
              <>
                {task?.kind === 'failed' ? (
                  <InlineAlert
                    action={{ label: '重试', onClick: task.retry }}
                    message="任务信息读取失败，识别字幕、生成音乐与合成暂时无法提交"
                  />
                ) : null}
                {composeError === null ? null : <InlineAlert message={composeError} />}
                {viewingDraft && music.previewAudio.kind === 'failed' ? (
                  <InlineAlert
                    message={music.previewAudio.message}
                    action={{ label: '重试', onClick: music.previewAudio.retry }}
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
                <p className="video-editor-footnote" role={notice === null ? undefined : 'status'}>
                  {footnote}
                </p>
              </>
            }
            onPlay={() => {
              setSelection(undefined)
              if (viewingDraft) music.prime()
            }}
            onPlaybackChange={setPlayback}
            onTime={setCurrentTime}
            original={undefined}
            overlay={card}
            poster={stagePoster}
            readout={readout}
            ref={previewRef}
            timeline={
              viewingDraft ? (
                timeline
              ) : (
                // 看着某一版时草稿在下面淡着、不能动，点「未合成」回来接着剪。
                <div className="whole-film-timeline-locked" inert>
                  {timeline}
                </div>
              )
            }
            tools={toolButtons}
            versions={
              <EditorVersionStrip
                entries={stripEntries}
                onSelect={view}
                selectedKey={viewingDraft ? DRAFT_KEY : viewingKey}
                showSingle
              />
            }
          />
        </div>
      </DialogSurface>
    </DialogRoot>
  )
}
