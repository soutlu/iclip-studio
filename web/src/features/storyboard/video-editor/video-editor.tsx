import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import type { PercentCrop } from 'react-image-crop'
import { errorMessageOf } from '@/shared/api/client'
import { useMediaDownload } from '@/shared/api/media-download'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { Button } from '@/shared/ui/button'
import type {
  ComposerAttachmentPreviewOf,
  ComposerPart,
  ComposerSubmission,
} from '@/shared/ui/composer'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { toast } from '@/shared/ui/toast'
import { GenerationPicker } from '../components/generation-picker'
import {
  compileImageClipPrompt,
  compileReferencePrompt,
  draftPartsOf,
  MAX_FIRST_FRAMES,
} from '../edit-prompt'
import { EditorPreview, type EditorPreviewHandle } from '../editing/editor-preview'
import {
  keyframeQuery,
  useAudioPeaks,
  useKeyframes,
  type PeaksState,
} from '../editing/media-analysis'
import { layoutPlay, type PlaySegment } from '../editing/play-layout'
import { isShortcutTarget } from '../editing/shortcut-target'
import { useMediaDurations } from '../editing/use-media-durations'
import { useStableValue } from '../editing/use-stable-value'
import { isComposite, ORIGINAL_LABEL } from '../editing/version-lineage'
import { useShotGenerations, useVideoModels, type GenerationJob } from '../storyboard.api'
import { AiEditCard, type AiEditCardHandle } from './ai-edit-card'
import { clipGenerationBlock, referenceImageCountOf } from './clip-generation'
import {
  anchorOfClock,
  canCompose,
  clockOfAnchor,
  compositeSegmentsOf,
  compositionOf,
  pickedBlocksOf,
  picksFromComposite,
  segmentsLength,
  segmentsOf,
  selectedUnits,
  shotUnitId,
  unitsOf,
  type Selection,
  type Unit,
} from './composition'
import { EditBlockCard } from './edit-block-card'
import {
  editBlocksOf,
  failedEditsOf,
  failureMessageOf,
  isSettling,
  laneEditsOf,
  shotsOf,
  spanName,
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
import { ClipsTimeline, VersionsTimeline, type VersionRow } from './editor-timeline'
import { FailureNotice } from './failure-notice'
import {
  failureNoticesOf,
  useDismissedFailures,
  type FailureNotice as Notice,
} from './failure-notices'
import { planFrames } from './first-frames'
import { ShotPrompts } from './shot-prompts'
import { useGenerationSettings } from './use-generation-settings'
import { usePicks } from './use-picks'
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
/** 合成比原片长或短不到这么多（秒）时不提。 */
const LENGTH_NOTE_THRESHOLD = 0.05

const secondsText = (value: number) => value.toFixed(1)
const posterOf = (url: string) => videoSnapshotUrl(url, 320)

/**
 * 镜头提示词面板左边在视口里的横坐标。面板挂在按钮所在的宿主里、右端对齐按钮；刚挂上时还没定位、
 * 又在缩放进场，所以不量面板自己的位置，按宿主右端减面板的布局宽度算。
 */
const promptsPanelLeft = (panel: HTMLElement): number =>
  (panel.closest('.video-editor-prompts') ?? panel).getBoundingClientRect().right -
  panel.offsetWidth

type View = 'versions' | 'clips'

type Props = {
  conversationId: string
  /** 打开编辑器的那条素材片：出片，或某条出片的一次合成。 */
  video: GenerationJob | undefined
  loading: boolean
  shotIndex: number | undefined
  onClose: () => void
}

export function VideoEditor({ conversationId, video, loading, shotIndex, onClose }: Props) {
  const conversationJobs = useShotGenerations(conversationId).data
  // 从一次合成打开时，编辑的仍是它的原片；版本视图先看打开的那一版。
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

/** 失败提示：同一件事（按 key）一直失败只提示一次，恢复后再失败才再提示。 */
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
  // 版本视图看的那一版；没选就是最近完成的一版。
  const [viewedId, setViewedId] = useState(openedCompositeId)
  // 打开着的镜头提示词面板：生成卡要让开它。
  const [promptsPanel, setPromptsPanel] = useState<HTMLDivElement | null>(null)
  const [selection, setSelection] = useState<Selection>()
  const [currentTime, setCurrentTime] = useState(0)
  // 选中后播放头要停的原片位置。选用一变预览先在自己的 effect 里回到原处，子组件的 effect 先跑，在这里跳才不会被覆盖。
  const [seekRequest, setSeekRequest] = useState<{ anchor: number }>()
  const [request, setRequest] = useState(NO_REQUEST)
  // 首帧、尾帧拖过的裁切框，按图片地址记，与输入卡的草稿一样活到编辑器关闭。
  const [frameCrops, setFrameCrops] = useState(NO_CROPS)
  const [droppedUploads, setDroppedUploads] = useState(0)
  const [cardOpen, setCardOpen] = useState(true)
  const [submission, setSubmission] = useState<Submission>()
  const [generateError, setGenerateError] = useState<string | null>(null)
  const { downloading, download } = useMediaDownload()
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
  const knownDurations = useMemo(() => {
    const known: Record<string, number> = {}
    for (const { job } of lane)
      if (job.outputUrl !== null && job.durationMs !== null)
        known[job.outputUrl] = job.durationMs / 1000
    return known
  }, [lane])
  const durations = useMediaDurations(resultUrls, knownDurations)
  const blocks = useMemo(() => editBlocksOf(lane, durations), [lane, durations])
  const durationOf = (jobId: string) => {
    const state = blocks.find((block) => block.id === jobId)?.state
    return state?.kind === 'ready' ? state.duration : undefined
  }

  const latest = latestCompositeOf(jobs, root.id)
  const latestSegments =
    latest === undefined ? undefined : compositeSegmentsOf(latest, root.id, durationOf)
  const { picks, pick, unpick } = usePicks({
    conversationId,
    rootJobId: root.id,
    blocks,
    fallback: shots === undefined ? [] : picksFromComposite(latestSegments, root.id, shots, blocks),
    ready:
      chainJobs !== undefined &&
      shots !== undefined &&
      blocks.every((block) => block.state.kind !== 'measuring'),
  })
  const picked = useMemo(() => pickedBlocksOf(blocks, picks), [blocks, picks])
  const units = useMemo(() => unitsOf(shots ?? [], picked), [shots, picked])
  const pieces = useMemo(
    () => compositionOf({ id: root.id, mediaUrl }, shots ?? [], picked),
    [root.id, mediaUrl, shots, picked],
  )
  const segments = segmentsOf(pieces)
  const composing = composingOf(jobs, root.id)
  const composable =
    shots !== undefined &&
    canCompose({
      current: segments,
      original: [{ sourceJobId: root.id, start: 0, end: duration }],
      latest: latestSegments,
      composing: composing !== undefined,
      busy,
    })

  // 最近完成的合成一换（不论从哪里提交），切到版本视图看它，从头、停着。
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

  // 只在新的定位请求时跳：之后选用再变不该把播放头拉回去。
  const seekToAnchor = useEffectEvent((anchor: number) =>
    previewRef.current?.previewAt(clockOfAnchor(pieces, anchor)),
  )
  useEffect(() => {
    if (seekRequest !== undefined) seekToAnchor(seekRequest.anchor)
  }, [seekRequest])

  // 剪辑视图的选区
  const clipsView = view === 'clips'
  const chosenUnits = clipsView ? selectedUnits(units, selection) : []
  const firstUnit = chosenUnits[0]
  const lastUnit = chosenUnits.at(-1)
  const selectedBlock =
    clipsView && selection?.kind === 'edit'
      ? blocks.find((block) => block.id === selection.id)
      : undefined
  // 选着的编辑片段不在了，或在跑的那条落定了，就不再选着。
  if (selection?.kind === 'edit') {
    const block = blocks.find((item) => item.id === selection.id)
    if (block === undefined || (selection.settling && !isSettling(block.state)))
      setSelection(undefined)
  }
  const shotSpan =
    firstUnit === undefined || lastUnit === undefined
      ? undefined
      : {
          from: shots?.find((shot) => shot.start === firstUnit.start)?.no ?? 0,
          to: shots?.find((shot) => shot.end === lastUnit.end)?.no ?? 0,
        }
  const range =
    firstUnit === undefined || lastUnit === undefined
      ? undefined
      : { start: firstUnit.start, end: lastUnit.end }
  const unitSegment = (unit: Unit): PlaySegment =>
    unit.kind === 'shot'
      ? { mediaUrl, start: unit.start, end: unit.end }
      : { mediaUrl: unit.block.job.outputUrl ?? '', start: 0, end: unit.block.state.duration }
  const referenceClips = chosenUnits.map(unitSegment)
  const selectedDuration = referenceClips.reduce((sum, clip) => sum + clip.end - clip.start, 0)

  const generationBlockOf = (referenceImageCount: number) =>
    chosen === undefined
      ? undefined
      : clipGenerationBlock(chosen.model, {
          mode,
          seconds: mode === 'image' ? chosen.imageSeconds : selectedDuration,
          referenceImageCount,
        })
  const requestBlock = generationBlockOf(referenceImageCountOf(request))

  // 图生时每张图的用途与裁切，按去重后真正发送的图算。
  const frameUrls =
    mode === 'image' ? compileReferencePrompt(draftPartsOf(request)).referenceImageUrls : []
  const imageSizes = useImageSizes(frameUrls)
  // 舞台按原片画幅摆，图生的首帧也按它裁；读到之前舞台按播放器读到的画面比例。
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
  /** 提交前定下首帧、尾帧要裁的框：原图与原片的尺寸还没读完就等它读完。 */
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
    shotSpan !== undefined &&
    blocks.some(
      (block) =>
        block.from === shotSpan.from && block.to === shotSpan.to && isSettling(block.state),
    )
  // 这几个镜头最近一次生成失败了：卡上写出原因，重新提交后就不再是最近一次。
  const lastFailure =
    shotSpan === undefined
      ? undefined
      : failedEdits.find((edit) => edit.from === shotSpan.from && edit.to === shotSpan.to)
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

  /** 选中原片轨上的几个单位：停下，播放头到选区开头，弹出生成卡。 */
  const selectUnits = (ids: readonly string[]) => {
    if (busy) return
    setSelection(ids.length === 0 ? undefined : { kind: 'units', ids })
    setCardOpen(true)
    const first = units.find((unit) => unit.id === ids[0])
    if (first !== undefined) setSeekRequest({ anchor: first.start })
  }

  /** 点编辑轨上的一条：可用的立即选用（重叠的取消），在跑、失败的只看状态。 */
  const clickBlock = (id: string) => {
    const block = blocks.find((item) => item.id === id)
    if (block === undefined || busy) return
    if (block.state.kind === 'ready') pick(id)
    setSelection({ kind: 'edit', id, settling: isSettling(block.state) })
    setSeekRequest({ anchor: block.start })
  }

  /** 改用原片：取消这条的选用，选中换回来的镜头。 */
  const restoreOriginal = (id: string) => {
    const block = blocks.find((item) => item.id === id)
    if (block === undefined || busy) return
    unpick(id)
    const restored = (shots ?? []).filter((shot) => block.from <= shot.no && shot.no <= block.to)
    setSelection({ kind: 'units', ids: restored.map(shotUnitId) })
    setCardOpen(true)
    setSeekRequest({ anchor: block.start })
  }

  const chooseView = (next: View) => {
    if (next === view) return
    setView(next)
    setSelection(undefined)
    if (next === 'versions') setViewedId(undefined)
  }

  const { dismissed, dismiss } = useDismissedFailures(conversationId, root.id)
  const notices = failureNoticesOf(failedEdits, failedCompositeOf(jobs, root.id), dismissed)

  /** 点失败提醒：回到剪辑视图；编辑段的失败另在原片轨上选中那几个镜头、弹出生成卡。 */
  const openFailure = ({ edit }: Notice) => {
    if (busy) return
    chooseView('clips')
    if (edit === undefined) {
      setSelection(undefined)
      return
    }
    selectUnits(
      units.filter((unit) => unit.start < edit.end && edit.start < unit.end).map((unit) => unit.id),
    )
  }

  const collapseCard = () => setCardOpen(false)

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
        segments,
      })
      seedJob(job)
      toast.success('已提交合成，完成后切到版本视图查看')
    } catch (error) {
      toast.error(errorMessageOf(error, '合成任务提交失败'))
    } finally {
      setSubmission(undefined)
    }
  }

  // 版本视图：每一版读自己的关键帧，看的那一版放在舞台上
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
  const composingSegments =
    composing === undefined ? undefined : compositeSegmentsOf(composing, root.id, durationOf)
  const composingLength =
    composingSegments === undefined
      ? undefined
      : segmentsLength(composingSegments, (jobId) =>
          jobId === root.id ? keyframes.data?.duration : durationOf(jobId),
        )

  const wholePlay =
    viewedDuration === undefined
      ? undefined
      : layoutPlay([{ mediaUrl: viewed.mediaUrl, start: 0, end: viewedDuration }])
  const current = clipsView ? (shots === undefined ? undefined : pieces) : wholePlay
  const total = clipsView ? (pieces.at(-1)?.at ?? 0) + (pieces.at(-1)?.duration ?? 0) : 0
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
  const peaks = useAudioPeaks(audioUrls)
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
    <Button
      className="video-editor-compose"
      leadingIcon="download"
      loading={downloading}
      onClick={() => void download(viewed.mediaUrl, '生成的视频')}
      size="md"
      variant="inverted"
    >
      下载
    </Button>
  )

  // 版本视图只在看的那一版读不出关键帧时报错；别的版本读不出只是那一行空着。
  const timelineKeyframes = clipsView ? keyframes : viewedKeyframes
  const peaksOf = (url: string) => peaks.get(url) ?? LOADING_PEAKS
  const timeline =
    timelineKeyframes?.isError === true ? (
      <p className="editor-timeline-loading" role="alert">
        {errorMessageOf(timelineKeyframes.error, '该视频的关键帧读取失败')}
        <Button onClick={() => void timelineKeyframes.refetch()} size="md" variant="ghost">
          重试
        </Button>
      </p>
    ) : clipsView && shots !== undefined ? (
      <ClipsTimeline
        anchor={anchorOfClock(pieces, currentTime)}
        blocks={blocks}
        duration={duration}
        onClickBlock={clickBlock}
        onScrub={collapseCard}
        onSeek={(anchor) => previewRef.current?.previewAt(clockOfAnchor(pieces, anchor))}
        onSelectUnits={selectUnits}
        peaksOf={peaksOf}
        rootUrl={mediaUrl}
        selection={selection}
        selectionBoxRef={selectionBoxRef}
        shots={shots}
        units={units}
      />
    ) : !clipsView ? (
      <VersionsTimeline
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

  const frameOf = (unit: Unit | undefined, edge: 'start' | 'end', width = CARD_FRAME_WIDTH) => {
    if (unit === undefined) return undefined
    const segment = unitSegment(unit)
    const at =
      edge === 'start' ? segment.start : Math.max(segment.start, segment.end - LAST_FRAME_LEAD)
    return videoSnapshotUrl(segment.mediaUrl, width, at)
  }
  const unitsCard =
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
        firstFrameReferenceUrl={frameOf(firstUnit, 'start', REFERENCE_FRAME_WIDTH)}
        frames={{ first: frameOf(firstUnit, 'start'), last: frameOf(lastUnit, 'end') }}
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
        onCollapse={collapseCard}
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
  const blockCard =
    selectedBlock === undefined ? null : (
      <EditBlockCard
        anchorRef={selectionBoxRef}
        block={selectedBlock}
        key={selectedBlock.id}
        onClose={() => setSelection(undefined)}
        onUseOriginal={() => restoreOriginal(selectedBlock.id)}
        picked={picked.some((block) => block.id === selectedBlock.id)}
      />
    )

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
          if (unitsCard !== null && cardOpen) {
            event.preventDefault()
            collapseCard()
          } else if (blockCard !== null) {
            event.preventDefault()
            setSelection(undefined)
          }
        }}
        onInteractOutside={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          // 空格播放、暂停；焦点在按钮上时也不触发按钮
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
                canAppend={unitsCard !== null && !busy}
                onAppend={(text) => cardRef.current?.appendText(text)}
                panelRef={setPromptsPanel}
                root={root}
                shotIndex={shotIndex}
              />
            }
            contentKey={clipsView ? 'clips' : `version:${viewed.jobId}`}
            current={current}
            currentTime={currentTime}
            onPlay={collapseCard}
            onTime={setCurrentTime}
            overlay={clipsView ? (unitsCard ?? blockCard) : null}
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
