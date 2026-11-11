import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import type { PercentCrop } from 'react-image-crop'
import { errorMessageOf } from '@/shared/api/client'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import type { TimeSpan } from '@/shared/lib/time-spans'
import { Button } from '@/shared/ui/button'
import type {
  ComposerAttachmentPreviewOf,
  ComposerPart,
  ComposerSubmission,
} from '@/shared/ui/composer'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { toast } from '@/shared/ui/toast'
import { VideoDownload } from '@/shared/ui/video-download'
import { GenerationPicker } from '../components/generation-picker'
import {
  compileImageClipPrompt,
  compileReferencePrompt,
  draftPartsOf,
  MAX_FIRST_FRAMES,
} from '../edit-prompt'
import type { SecondsRange } from '../editing/clip'
import { EditorPreview, type EditorPreviewHandle } from '../editing/editor-preview'
import {
  keyframeQuery,
  useAudioPeaks,
  useKeyframes,
  type PeaksState,
} from '../editing/media-analysis'
import { layoutPlay } from '../editing/play-layout'
import { isShortcutTarget } from '../editing/shortcut-target'
import { StageLabel } from '../editing/stage-label'
import { useStableValue } from '../editing/use-stable-value'
import { isComposite, ORIGINAL_LABEL } from '../editing/version-lineage'
import { useShotGenerations, useVideoModels, type GenerationJob } from '../storyboard.api'
import { AiEditCard, type AiEditCardHandle } from './ai-edit-card'
import { clipGenerationBlock, referenceImageCountOf } from './clip-generation'
import {
  canCompose,
  composeSegmentsOf,
  compositeSegmentsOf,
  draftItemsOf,
  draftLineOf,
  isPicked,
  keepPlace,
  outputOf,
  pickPart,
  previewPick,
  putShot,
  readyEditsOf,
  shotOn,
  totalOf,
  trimItem,
  unpickPart,
  type Draft,
  type DraftSource,
} from './draft'
import {
  coveredSpan,
  editBlocksOf,
  editTitleOf,
  failedEditsOf,
  failureMessageOf,
  isRangeOf,
  laneEditsOf,
  partItemId,
  shotsOf,
  spanName,
  type KeyframeRead,
} from './edit-blocks'
import {
  composingOf,
  failedCompositeOf,
  latestCompositeOf,
  projectVersions,
  rootVersionGroup,
  type ChainVersion,
} from './edit-chain'
import { DurationSlider } from './duration-slider'
import {
  ClipsTimeline,
  VersionsTimeline,
  type RunChange,
  type Selection,
  type TrimChange,
  type TrimPreview,
  type VersionRow,
} from './editor-timeline'
import { FailureNotice } from './failure-notice'
import {
  failureNoticesOf,
  useDismissedFailures,
  type FailureNotice as Notice,
} from './failure-notices'
import { planFrames } from './first-frames'
import { SelectionCard } from './selection-card'
import { ShotPrompts } from './shot-prompts'
import { useDraft } from './use-draft'
import { useGenerationSettings } from './use-generation-settings'
import { useSubmissionGuard } from './use-submission-guard'
import {
  imageSizeQuery,
  seedVideoEditJob,
  submitClipGeneration,
  submitVideoComposite,
  useImageSizes,
  useVideoEditChain,
  videoSizeQuery,
} from './video-editor.api'

const LOADING_PEAKS: PeaksState = { kind: 'loading' }
const NO_REQUEST: readonly ComposerPart[] = []
const NO_CROPS: ReadonlyMap<string, PercentCrop> = new Map()
const NO_JOBS: readonly GenerationJob[] = []
const LAST_FRAME_LEAD = 0.1
const CARD_FRAME_WIDTH = 60
const REFERENCE_FRAME_WIDTH = 1280
const LENGTH_NOTE_THRESHOLD = 0.05

const secondsText = (value: number) => value.toFixed(1)
const posterOf = (url: string) => videoSnapshotUrl(url, 320)

const promptsPanelLeft = (panel: HTMLElement): number =>
  (panel.closest('.video-editor-prompts') ?? panel).getBoundingClientRect().right -
  panel.offsetWidth

type View = 'versions' | 'clips'

type Props = {
  conversationId: string
  video: GenerationJob | undefined
  loading: boolean
  shotIndex: number | undefined
  onClose: () => void
}

export function VideoEditor({ conversationId, video, loading, shotIndex, onClose }: Props) {
  const conversationJobs = useShotGenerations(conversationId).data
  const opened = video !== undefined && isComposite(video) ? video : undefined
  const root =
    opened === undefined ? video : conversationJobs?.find((job) => job.id === opened.rootJobId)
  if (root === undefined || root.outputUrl === null) {
    return (
      <DialogRoot open onOpenChange={(open) => !open && onClose()}>
        <DialogSurface aria-describedby={undefined} className="max-w-md">
          <DialogHeader title="编辑视频" closeLabel="关闭视频编辑" />
          <DialogBody>
            <p className="text-body-sm text-on-surface-muted" role="status">
              {loading || (opened !== undefined && conversationJobs === undefined)
                ? '正在读取视频记录…'
                : '未找到该视频记录，请关闭后在「本组素材片」中重新打开'}
            </p>
          </DialogBody>
        </DialogSurface>
      </DialogRoot>
    )
  }
  return (
    <Editor
      conversationId={conversationId}
      conversationJobs={conversationJobs ?? NO_JOBS}
      key={root.id}
      mediaUrl={root.outputUrl}
      onClose={onClose}
      openedCompositeId={opened?.id}
      root={root}
      shotIndex={shotIndex}
    />
  )
}

type EditorProps = {
  conversationId: string
  conversationJobs: readonly GenerationJob[]
  root: GenerationJob
  mediaUrl: string
  openedCompositeId: string | undefined
  shotIndex: number | undefined
  onClose: () => void
}

type Submission = 'edit' | 'compose'

const useFailureToasts = (failures: readonly { key: string; message: string }[]) => {
  const reportedRef = useRef(new Set<string>())
  useEffect(() => {
    const current = new Set(failures.map(({ key }) => key))
    for (const key of reportedRef.current) if (!current.has(key)) reportedRef.current.delete(key)
    for (const { key, message } of failures) {
      if (reportedRef.current.has(key)) continue
      reportedRef.current.add(key)
      toast.error(message)
    }
  }, [failures])
}

function Editor({
  conversationId,
  conversationJobs,
  root,
  mediaUrl,
  openedCompositeId,
  shotIndex,
  onClose,
}: EditorProps) {
  const queryClient = useQueryClient()
  const chainQuery = useVideoEditChain(conversationId, root.id)
  const modelsQuery = useVideoModels()
  const settings = useGenerationSettings(modelsQuery.data)
  const { mode, chosen } = settings
  const chainJobs = chainQuery.data?.items
  const jobs = chainJobs ?? NO_JOBS
  const versions = useMemo(
    () => projectVersions(root, rootVersionGroup(root, jobs, conversationJobs)),
    [root, jobs, conversationJobs],
  )
  const previewRef = useRef<EditorPreviewHandle>(null)
  const selectionBoxRef = useRef<HTMLSpanElement>(null)
  const cardRef = useRef<AiEditCardHandle>(null)
  const [view, setView] = useState<View>(openedCompositeId === undefined ? 'clips' : 'versions')
  const [viewedId, setViewedId] = useState(openedCompositeId)
  const [promptsPanel, setPromptsPanel] = useState<HTMLDivElement | null>(null)
  const [selection, setSelection] = useState<Selection>()
  const [preview, setPreview] = useState<'draft' | 'source'>('draft')
  const [draftClock, setDraftClock] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [seekRequest, setSeekRequest] = useState<{ clock: number; boundary?: 'end' }>()
  const [request, setRequest] = useState(NO_REQUEST)
  const [frameCrops, setFrameCrops] = useState(NO_CROPS)
  const [droppedUploads, setDroppedUploads] = useState(0)
  const [cardOpen, setCardOpen] = useState(true)
  const [trimPreview, setTrimPreview] = useState<TrimPreview>()
  const [videoSettled, setVideoSettled] = useState(false)
  const [buffered, setBuffered] = useState<readonly TimeSpan[]>([])
  const [submission, setSubmission] = useState<Submission>()
  const [generateError, setGenerateError] = useState<string | null>(null)
  const busy = submission !== undefined
  useSubmissionGuard(busy)

  const keyframes = useKeyframes(mediaUrl)
  const shots = useMemo(
    () => (keyframes.data === undefined ? undefined : shotsOf(keyframes.data)),
    [keyframes.data],
  )
  const duration = keyframes.data?.duration ?? 0
  const lane = useMemo(
    () => (shots === undefined ? [] : laneEditsOf(root.id, jobs, shots)),
    [root.id, jobs, shots],
  )
  const failedEdits = useMemo(
    () => (shots === undefined ? [] : failedEditsOf(root.id, jobs, shots)),
    [root.id, jobs, shots],
  )
  const resultUrls = useStableValue(
    lane.flatMap(({ job }) =>
      job.status === 'completed' && job.outputUrl !== null ? [job.outputUrl] : [],
    ),
  )
  const resultKeyframes = useQueries({
    queries: resultUrls.map(keyframeQuery),
    combine: (results) =>
      new Map(
        results.map((result, at): [string, KeyframeRead] => [
          resultUrls[at] ?? '',
          { data: result.data, isError: result.isError },
        ]),
      ),
  })
  const blocks = editBlocksOf(lane, (url) => resultKeyframes.get(url))
  const source: DraftSource | undefined =
    shots === undefined
      ? undefined
      : {
          rootId: root.id,
          rootUrl: mediaUrl,
          duration,
          shots,
          edits: readyEditsOf(blocks),
        }
  const lengthOf = (jobId: string) =>
    jobId === root.id
      ? keyframes.data?.duration
      : source?.edits.find((edit) => edit.id === jobId)?.duration

  const latest = latestCompositeOf(jobs, root.id)
  const latestSegments = latest === undefined ? undefined : compositeSegmentsOf(latest, lengthOf)
  const { draft, change } = useDraft({
    conversationId,
    rootJobId: root.id,
    source,
    latest: latestSegments,
    ready:
      chainJobs !== undefined &&
      shots !== undefined &&
      blocks.every((block) => block.state.kind !== 'measuring'),
  })
  const items = source === undefined || draft === undefined ? [] : draftItemsOf(source, draft)
  const pieces = outputOf(items)
  const staged = trimPreview?.kind === 'draft' ? trimPreview.items : items
  const composing = composingOf(jobs, root.id)
  const composable =
    source !== undefined &&
    draft !== undefined &&
    canCompose({
      source,
      pieces,
      latest: latestSegments,
      composing: composing !== undefined,
      busy,
    })

  const latestId = latest?.id ?? null
  const [seenLatestId, setSeenLatestId] = useState<string | null>()
  if (chainJobs !== undefined && seenLatestId !== latestId) {
    if (seenLatestId !== undefined && latestId !== null) {
      setView('versions')
      setViewedId(latestId)
      setSelection(undefined)
    }
    setSeenLatestId(latestId)
  }

  const seekTo = useEffectEvent(({ clock, boundary }: { clock: number; boundary?: 'end' }) =>
    previewRef.current?.previewAt(clock, boundary),
  )
  useEffect(() => {
    if (seekRequest !== undefined) seekTo(seekRequest)
  }, [seekRequest])

  const clipsView = view === 'clips'
  const selectedItem =
    clipsView && selection?.kind === 'draft'
      ? items.find((item) => item.id === selection.id)
      : undefined
  const runningBlock =
    clipsView && selection?.kind === 'running'
      ? blocks.find((block) => block.id === selection.id && block.state.kind === 'running')
      : undefined
  if (
    (selection?.kind === 'draft' && selectedItem === undefined && clipsView) ||
    (selection?.kind === 'running' && runningBlock === undefined && clipsView)
  )
    setSelection(undefined)
  const chosenRun: SecondsRange | undefined =
    clipsView && selection?.kind === 'run'
      ? { start: selection.start, end: selection.end }
      : undefined
  const range: SecondsRange | undefined =
    chosenRun !== undefined && trimPreview?.kind === 'run'
      ? { start: trimPreview.run.start, end: trimPreview.run.end }
      : chosenRun
  const shotSpan =
    range === undefined || shots === undefined ? undefined : coveredSpan(shots, range)
  const sourcePreview = range !== undefined && preview === 'source'
  const referenceClips = range === undefined ? [] : [{ mediaUrl, ...range }]
  const selectedDuration = range === undefined ? 0 : range.end - range.start

  const generationBlockOf = (referenceImageCount: number) =>
    chosen === undefined
      ? undefined
      : clipGenerationBlock(chosen.model, {
          mode,
          seconds: mode === 'image' ? chosen.imageSeconds : selectedDuration,
          referenceImageCount,
        })
  const requestBlock = generationBlockOf(referenceImageCountOf(request))

  const frameUrls =
    mode === 'image' ? compileReferencePrompt(draftPartsOf(request)).referenceImageUrls : []
  const imageSizes = useImageSizes(frameUrls)
  const videoSize = useQuery(videoSizeQuery(mediaUrl)).data
  const framePlans = planFrames({
    urls: frameUrls,
    sizeOf: (url) => imageSizes.get(url),
    video: videoSize,
    crops: frameCrops,
  })
  const attachmentPreview: ComposerAttachmentPreviewOf = ({ url }) => {
    const plan = url === undefined ? undefined : framePlans.get(url)
    if (url === undefined || plan === undefined) return undefined
    return {
      details: plan.details,
      crop:
        plan.crop === undefined || videoSize === undefined
          ? undefined
          : {
              aspect: videoSize.width / videoSize.height,
              value: plan.crop.value,
              onChange: (crop) => setFrameCrops((previous) => new Map(previous).set(url, crop)),
            },
    }
  }
  const readFrameCrops = async (urls: readonly string[]) => {
    if (urls.length === 0 || urls.length > MAX_FIRST_FRAMES) return undefined
    const [size, ...images] = await Promise.all([
      queryClient.fetchQuery(videoSizeQuery(mediaUrl)),
      ...urls.map((url) => queryClient.fetchQuery(imageSizeQuery(url))),
    ])
    const plans = planFrames({
      urls,
      sizeOf: (url) => images[urls.indexOf(url)],
      video: size,
      crops: frameCrops,
    })
    return new Map(
      [...plans].flatMap(([url, plan]) =>
        plan.crop === undefined ? [] : [[url, plan.crop.rect] as const],
      ),
    )
  }
  const generatingSameShots =
    range !== undefined &&
    blocks.some((block) => block.state.kind === 'running' && isRangeOf(block.job, range))
  const lastFailure =
    range === undefined ? undefined : failedEdits.find((edit) => isRangeOf(edit.job, range))
  const blockReason =
    range === undefined
      ? undefined
      : generatingSameShots
        ? '这几个镜头正在生成，无法再次生成；请等待生成完成'
        : chosen === undefined
          ? '暂无可用的视频模型'
          : requestBlock?.cause === 'selection'
            ? requestBlock.message
            : undefined
  const canGenerate = range !== undefined && blockReason === undefined

  const seedJob = (job: GenerationJob) =>
    seedVideoEditJob(queryClient, conversationId, root.id, job)

  const showSource = (seek: { clock: number; boundary?: 'end' }) => {
    if (!sourcePreview) setDraftClock(clipsView ? currentTime : 0)
    setPreview('source')
    setSeekRequest(seek)
  }

  const showDraft = (clock?: number) => {
    setPreview('draft')
    if (clock !== undefined) setSeekRequest({ clock })
    else if (sourcePreview) setSeekRequest({ clock: draftClock })
  }

  const selectRun = (next: SecondsRange | undefined) => {
    if (busy) return
    setCardOpen(true)
    if (next === undefined) {
      setSelection(undefined)
      showDraft()
      return
    }
    setSelection({ kind: 'run', ...next })
    showSource({ clock: next.start })
  }

  const trimRun = ({ edge, start, end }: RunChange) => {
    if (busy) return
    setSelection({ kind: 'run', start, end })
    showSource(edge === 'end' ? { clock: end, boundary: 'end' } : { clock: start })
  }

  const selectDraft = (id: string, within = items) => {
    const item = within.find((candidate) => candidate.id === id)
    if (item === undefined) return
    setSelection({ kind: 'draft', id })
    showDraft(item.at)
  }

  const selectRunning = (id: string) => {
    setSelection({ kind: 'running', id })
    showDraft()
  }

  const seekDraft = (clock: number) => {
    if (sourcePreview) showDraft(clock)
    else previewRef.current?.previewAt(clock)
  }

  const changeDraft = (next: Draft) => {
    if (busy || source === undefined) return
    const after = draftItemsOf(source, next)
    change(next)
    if (sourcePreview) setDraftClock(keepPlace(items, after, draftClock))
    else setSeekRequest({ clock: keepPlace(items, after, currentTime) })
    return after
  }

  const toggleShot = (no: number) => {
    if (source !== undefined && draft !== undefined)
      changeDraft(putShot(source, draft, no, !shotOn(source, draft, no)))
  }

  const togglePart = (editId: string, seg: number) => {
    if (source === undefined || draft === undefined) return undefined
    if (isPicked(draft, editId, seg)) {
      if (selection?.kind === 'draft' && selection.id === partItemId(editId, seg))
        setSelection(undefined)
      return changeDraft(unpickPart(draft, editId, seg))
    }
    return changeDraft(pickPart(source, draft, editId, seg))
  }

  const clickPart = (editId: string, seg: number) => {
    if (draft === undefined) return
    const picking = !isPicked(draft, editId, seg)
    const after = togglePart(editId, seg)
    if (after === undefined) return
    if (picking) selectDraft(partItemId(editId, seg), after)
    else if (sourcePreview) showDraft(keepPlace(items, after, draftClock))
  }

  const trimmedDraft = ({ id, t0, t1 }: TrimChange) => {
    const item = items.find((candidate) => candidate.id === id)
    return draft === undefined || item === undefined ? undefined : trimItem(draft, item, { t0, t1 })
  }

  const trim = (trimChange: TrimChange) => {
    const next = trimmedDraft(trimChange)
    if (busy || source === undefined || next === undefined) return
    change(next)
    const now = draftItemsOf(source, next).find((candidate) => candidate.id === trimChange.id)
    if (now === undefined) return
    setSeekRequest(
      trimChange.edge === 'end' ? { clock: now.at + now.d, boundary: 'end' } : { clock: now.at },
    )
  }

  const followTrim = (next: TrimPreview | undefined) => {
    if (busy && next !== undefined) return
    setTrimPreview(next)
    if (next?.kind === 'run') showSource(next.seek)
    else if (next !== undefined) setSeekRequest(next.seek)
  }

  const removeItem = (id: string) => {
    const item = items.find((candidate) => candidate.id === id)
    if (item === undefined) return
    if (item.kind === 'shot') toggleShot(item.no)
    else togglePart(item.edit.id, item.seg)
  }

  const chooseView = (next: View) => {
    if (next === view) return
    setView(next)
    setSelection(undefined)
    setPreview('draft')
    if (next === 'versions') setViewedId(undefined)
  }

  const { dismissed, dismiss } = useDismissedFailures(conversationId, root.id)
  const notices = failureNoticesOf(failedEdits, failedCompositeOf(jobs, root.id), dismissed)

  const openFailure = ({ edit }: Notice) => {
    if (busy) return
    chooseView('clips')
    if (edit === undefined) {
      setSelection(undefined)
      showDraft()
      return
    }
    selectRun({ start: edit.start, end: edit.end })
  }

  const collapseCard = () => setCardOpen(false)

  const closeCard = () => {
    collapseCard()
    showDraft()
  }

  const generate = async (input: ComposerSubmission) => {
    if (busy || !canGenerate || range === undefined || chosen === undefined) return
    const parts = draftPartsOf(input.parts)
    const { text, referenceImageUrls } =
      mode === 'image' ? compileImageClipPrompt(parts) : compileReferencePrompt(parts)
    setSubmission('edit')
    setGenerateError(null)
    try {
      const rects = mode === 'image' ? await readFrameCrops(referenceImageUrls) : undefined
      const job = await submitClipGeneration({
        conversationId,
        taskId: root.taskId,
        sourceJobId: root.id,
        generation:
          mode === 'image' ? { mode, seconds: chosen.imageSeconds } : { mode, referenceClips },
        range,
        model: chosen.model,
        prompt: text.trim(),
        referenceImageUrls,
        frameCrops: rects,
      })
      seedJob(job)
      setDroppedUploads(0)
    } catch (error) {
      setGenerateError(errorMessageOf(error, '片段生成提交失败'))
    } finally {
      setSubmission(undefined)
    }
  }

  const compose = async () => {
    if (!composable) return
    setSubmission('compose')
    try {
      const job = await submitVideoComposite({
        conversationId,
        taskId: root.taskId,
        baseJobId: root.id,
        segments: composeSegmentsOf(pieces),
      })
      seedJob(job)
      toast.success('已提交合成，完成后切到版本视图查看')
    } catch (error) {
      toast.error(errorMessageOf(error, '合成任务提交失败'))
    } finally {
      setSubmission(undefined)
    }
  }

  const rootVersion: ChainVersion = { jobId: root.id, label: ORIGINAL_LABEL, mediaUrl }
  const listed = versions.length === 0 ? [rootVersion] : versions
  const viewed =
    listed.find((version) => version.jobId === viewedId) ?? listed.at(-1) ?? rootVersion
  const versionKeyframes = useQueries({
    queries: (clipsView ? [] : listed).map((version) => keyframeQuery(version.mediaUrl)),
  })
  const versionRows = listed.map((version, at): VersionRow => {
    const index = versionKeyframes[at]?.data
    return {
      ...version,
      original: version.jobId === root.id,
      shots: index === undefined ? undefined : shotsOf(index),
      duration: index?.duration,
    }
  })
  const viewedKeyframes = versionKeyframes[listed.indexOf(viewed)]
  const viewedDuration = viewedKeyframes?.data?.duration
  const composingLength = (
    composing === undefined ? undefined : compositeSegmentsOf(composing, lengthOf)
  )?.reduce((sum, { start, end }) => sum + end - start, 0)

  const wholePlay =
    viewedDuration === undefined
      ? undefined
      : layoutPlay([{ mediaUrl: viewed.mediaUrl, start: 0, end: viewedDuration }])
  const timelineKeyframes = clipsView ? keyframes : viewedKeyframes
  const current =
    timelineKeyframes?.isError === true
      ? []
      : clipsView
        ? shots === undefined
          ? undefined
          : sourcePreview
            ? layoutPlay([{ mediaUrl, start: 0, end: duration }])
            : layoutPlay(outputOf(staged))
        : wholePlay
  const total = clipsView ? totalOf(items) : 0
  const lengthDifference = total - duration

  const audioUrls = useStableValue(
    clipsView
      ? [
          mediaUrl,
          ...blocks.flatMap((block) =>
            block.state.kind === 'ready' && block.job.outputUrl !== null
              ? [block.job.outputUrl]
              : [],
          ),
        ]
      : listed.map((version) => version.mediaUrl),
  )
  const peaks = useAudioPeaks(audioUrls, { enabled: videoSettled })
  useFailureToasts(
    useMemo(
      () => [
        ...[...peaks].flatMap(([url, state]) =>
          state.kind === 'failed'
            ? [{ key: `peaks:${url}`, message: errorMessageOf(state.error, '原声读取失败') }]
            : [],
        ),
        ...(chainQuery.error === null
          ? []
          : [
              {
                key: 'chain',
                message: errorMessageOf(chainQuery.error, '读取编辑记录失败'),
              },
            ]),
      ],
      [peaks, chainQuery.error],
    ),
  )

  const readout = (
    <span className="editor-readout">
      共 <b>{secondsText(clipsView ? total : (viewedDuration ?? 0))}</b> 秒
      {clipsView && Math.abs(lengthDifference) >= LENGTH_NOTE_THRESHOLD
        ? ` · 比原片${lengthDifference > 0 ? '长' : '短'} ${secondsText(Math.abs(lengthDifference))} 秒`
        : null}
    </span>
  )

  const barEnd = clipsView ? (
    <Button
      className="video-editor-compose"
      disabled={!composable}
      leadingIcon="video"
      loading={submission === 'compose'}
      onClick={() => void compose()}
      size="md"
    >
      {composing === undefined ? '合成新版本' : '正在合成'}
    </Button>
  ) : (
    <VideoDownload
      className="video-editor-compose"
      jobId={viewed.jobId}
      url={viewed.mediaUrl}
      variant="inverted"
      watermarkUrl={null}
    >
      下载
    </VideoDownload>
  )

  const peaksOf = (url: string) => peaks.get(url) ?? LOADING_PEAKS
  const timeline =
    timelineKeyframes?.isError === true ? (
      <p className="editor-timeline-loading" role="alert">
        {errorMessageOf(timelineKeyframes.error, '该视频的关键帧读取失败')}
        <Button onClick={() => void timelineKeyframes.refetch()} size="md" variant="ghost">
          重试
        </Button>
      </p>
    ) : clipsView && source !== undefined && draft !== undefined ? (
      <ClipsTimeline
        blocks={blocks}
        buffered={buffered}
        clock={currentTime}
        duration={duration}
        isPicked={(editId, seg) => isPicked(draft, editId, seg)}
        clockOn={sourcePreview ? 'source' : 'draft'}
        items={items}
        onClickPart={clickPart}
        onScrub={collapseCard}
        onSeek={seekDraft}
        onSelectDraft={(id) => selectDraft(id)}
        onSelectRun={selectRun}
        onSelectRunning={selectRunning}
        onToggleShot={toggleShot}
        onTogglePart={(editId, seg) => void togglePart(editId, seg)}
        onTrim={trim}
        onTrimPreview={followTrim}
        onTrimRun={trimRun}
        peaksOf={peaksOf}
        previewPick={(editId, seg) => previewPick(source, draft, editId, seg)}
        previewTrim={(trimChange) => draftItemsOf(source, trimmedDraft(trimChange) ?? draft)}
        rootUrl={mediaUrl}
        selection={selection}
        selectionBoxRef={selectionBoxRef}
        shotOn={(no) => shotOn(source, draft, no)}
        shots={source.shots}
      />
    ) : !clipsView ? (
      <VersionsTimeline
        buffered={buffered}
        composing={composing === undefined ? undefined : { duration: composingLength }}
        currentTime={currentTime}
        onScrub={() => {}}
        onSeek={(clock) => previewRef.current?.previewAt(clock)}
        onSelect={setViewedId}
        peaksOf={peaksOf}
        versions={versionRows}
        viewedId={viewed.jobId}
      />
    ) : (
      <p className="editor-timeline-loading" role="status">
        正在读取分段…
      </p>
    )

  const frameOf = (edge: 'start' | 'end', width = CARD_FRAME_WIDTH) =>
    chosenRun === undefined
      ? undefined
      : videoSnapshotUrl(
          mediaUrl,
          width,
          edge === 'start'
            ? chosenRun.start
            : Math.max(chosenRun.start, chosenRun.end - LAST_FRAME_LEAD),
        )
  const generationCard =
    range === undefined || shotSpan === undefined ? null : (
      <AiEditCard
        alerts={
          <>
            {droppedUploads === 0 ? null : (
              <InlineAlert
                message={`有 ${droppedUploads} 张图片收起时尚未上传完成，未能保留，请重新添加`}
              />
            )}
            {generateError === null ? null : <InlineAlert message={generateError} />}
            {modelsQuery.isError ? (
              <InlineAlert
                action={{ label: '重新加载模型', onClick: () => void modelsQuery.refetch() }}
                message={errorMessageOf(modelsQuery.error, '读取视频模型失败')}
              />
            ) : null}
          </>
        }
        anchorRef={selectionBoxRef}
        attachmentPreview={attachmentPreview}
        avoidLeft={promptsPanel === null ? undefined : () => promptsPanelLeft(promptsPanel)}
        canGenerate={canGenerate && !busy}
        detail={
          blockReason ??
          (lastFailure === undefined
            ? `原片 ${secondsText(range.start)} – ${secondsText(range.end)} 秒 · ${mode === 'image' ? '根据引用图片生成新版本' : '视频和原声一起重做'}`
            : `上次生成失败：${failureMessageOf(lastFailure.job)}`)
        }
        detailFailed={blockReason === undefined && lastFailure !== undefined}
        draft={request}
        durationControl={
          mode === 'image' && chosen !== undefined ? (
            <DurationSlider
              disabled={busy}
              max={chosen.model.image.maxSeconds}
              min={chosen.model.image.minSeconds}
              onChange={settings.setImageSeconds}
              seconds={chosen.imageSeconds}
            />
          ) : null
        }
        firstFrameReferenceUrl={frameOf('start', REFERENCE_FRAME_WIDTH)}
        frames={{ first: frameOf('start'), last: frameOf('end') }}
        generating={submission === 'edit'}
        generationBlockOf={generationBlockOf}
        mode={mode}
        modelPicker={
          <GenerationPicker
            className="video-editor-model-picker"
            disabled={busy || settings.models.length === 0}
            label={mode === 'edit' ? '编辑模型' : '图生模型'}
            leading={<Icon decorative name="video" size="sm" />}
            onChange={(value) => {
              settings.setModel(value)
              setGenerateError(null)
            }}
            options={settings.models.map(({ id }) => ({ value: id }))}
            text={chosen?.model.id ?? '暂无可用的视频模型'}
            value={chosen?.model.id ?? ''}
          />
        }
        onCollapse={closeCard}
        onDraftChange={(parts) => {
          setRequest(parts)
          setGenerateError(null)
          setDroppedUploads(0)
        }}
        onExpand={() => setCardOpen(true)}
        onGenerate={(input) => void generate(input)}
        onModeChange={(next) => {
          if (busy) return
          settings.setMode(next)
          setGenerateError(null)
        }}
        onUploadsDropped={setDroppedUploads}
        open={cardOpen}
        positions={spanName(shotSpan)}
        ref={cardRef}
        referenceLimit={chosen?.model.maxReferenceImages}
      />
    )
  const stageLabel =
    sourcePreview && range !== undefined && shotSpan !== undefined ? (
      <StageLabel label={`原片 · ${spanName(shotSpan)}`} range={range} time={currentTime} />
    ) : null
  const selectedEdit =
    selectedItem?.kind === 'edit'
      ? blocks.find((block) => block.id === selectedItem.edit.id)
      : undefined
  const smallCard =
    selectedItem !== undefined ? (
      <SelectionCard
        action={
          selectedEdit === undefined || selectedEdit.job.outputUrl === null ? undefined : (
            <VideoDownload
              className="border-0 text-on-surface-variant"
              jobId={selectedEdit.job.id}
              url={selectedEdit.job.outputUrl}
              watermarkUrl={null}
            />
          )
        }
        anchorRef={selectionBoxRef}
        frame={videoSnapshotUrl(selectedItem.mediaUrl, CARD_FRAME_WIDTH, selectedItem.t0)}
        key={selectedItem.id}
        line={draftLineOf(staged.find((item) => item.id === selectedItem.id) ?? selectedItem)}
        onClose={() => setSelection(undefined)}
        title={
          selectedItem.kind === 'shot'
            ? `镜头 ${selectedItem.no}`
            : selectedEdit === undefined
              ? '编辑片段'
              : editTitleOf(selectedEdit)
        }
      />
    ) : runningBlock !== undefined ? (
      <SelectionCard
        anchorRef={selectionBoxRef}
        frame={undefined}
        key={runningBlock.id}
        line="完成后显示在编辑轨"
        onClose={() => setSelection(undefined)}
        title={`${spanName(runningBlock)} · 正在生成`}
      />
    ) : null

  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (open) return
        if (busy) toast.info('正在提交，请等待提交完成后再离开')
        else onClose()
      }}
    >
      <DialogSurface
        aria-describedby={undefined}
        className="editor-dialog video-editor-dialog"
        onEscapeKeyDown={(event) => {
          if (generationCard !== null && cardOpen) {
            event.preventDefault()
            closeCard()
          } else if (smallCard !== null) {
            event.preventDefault()
            setSelection(undefined)
          }
        }}
        onInteractOutside={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (
            (event.key === 'Delete' || event.key === 'Backspace') &&
            selectedItem !== undefined &&
            !event.defaultPrevented &&
            isShortcutTarget(event)
          ) {
            event.preventDefault()
            removeItem(selectedItem.id)
            return
          }
          if (
            event.key !== ' ' ||
            event.defaultPrevented ||
            event.metaKey ||
            event.ctrlKey ||
            !isShortcutTarget(event)
          )
            return
          event.preventDefault()
          previewRef.current?.toggle()
        }}
      >
        <DialogHeader
          className="editor-header border-0"
          closeLabel="关闭视频编辑"
          title={
            <span className="editor-title">
              <span>编辑视频</span>
              {shotIndex === undefined ? null : (
                <span className="text-body-sm font-normal text-on-surface-muted">
                  镜头组 {shotIndex}
                </span>
              )}
            </span>
          }
        />
        <div aria-label="视频编辑器" className="editor-workspace">
          <EditorPreview
            aspectRatio={videoSize === undefined ? undefined : videoSize.width / videoSize.height}
            backdrop={posterOf(mediaUrl)}
            barEnd={barEnd}
            barNotice={
              notices.length === 0 ? null : (
                <FailureNotice
                  notices={notices}
                  onDismiss={(notice) => dismiss(notice.id)}
                  onOpen={openFailure}
                />
              )
            }
            barStart={
              <div aria-label="查看方式" className="video-editor-view-switch" role="group">
                {(['versions', 'clips'] as const).map((option) => (
                  <button
                    aria-pressed={view === option}
                    disabled={busy}
                    key={option}
                    onClick={() => chooseView(option)}
                    type="button"
                  >
                    {option === 'versions' ? '版本' : '剪辑'}
                  </button>
                ))}
              </div>
            }
            barTools={
              <ShotPrompts
                canAppend={generationCard !== null && !busy}
                onAppend={(text) => cardRef.current?.appendText(text)}
                panelRef={setPromptsPanel}
                root={root}
                shotIndex={shotIndex}
              />
            }
            contentKey={
              clipsView ? (sourcePreview ? 'source' : 'clips') : `version:${viewed.jobId}`
            }
            current={current}
            currentTime={currentTime}
            shownTime={trimPreview?.shown}
            shownDuration={trimPreview?.kind === 'draft' ? total : undefined}
            onBuffered={setBuffered}
            onDownloadSettled={() => setVideoSettled(true)}
            onPlay={collapseCard}
            onTime={setCurrentTime}
            overlay={
              clipsView ? (
                <>
                  {stageLabel}
                  {generationCard ?? smallCard}
                </>
              ) : null
            }
            poster={posterOf(current?.[0]?.mediaUrl ?? mediaUrl)}
            readout={readout}
            ref={previewRef}
            timeline={timeline}
          />
        </div>
      </DialogSurface>
    </DialogRoot>
  )
}
