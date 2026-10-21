import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { useMediaDownload } from '@/shared/api/media-download'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { Button, IconButton } from '@/shared/ui/button'
import type { ComposerPart, ComposerSubmission } from '@/shared/ui/composer'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { toast } from '@/shared/ui/toast'
import { GenerationPicker } from '../components/generation-picker'
import { StageFailure } from '../components/stage-failure'
import { useUnseenResults } from '../components/use-unseen-results'
import { compileReferencePrompt, draftPartsOf } from '../edit-prompt'
import { useStorageFailureNotice } from '../editing/browser-storage'
import type { Clip } from '../editing/clip'
import { EditorPreview, type EditorPreviewHandle } from '../editing/editor-preview'
import { EditorVersionStrip } from '../editing/editor-version-strip'
import { useAudioPeaks, useKeyframes, type PeaksState } from '../editing/media-analysis'
import { layoutPlay, type PlaySegment } from '../editing/play-layout'
import { handleUndoShortcut } from '../editing/undo-shortcut'
import { useMediaDurations } from '../editing/use-media-durations'
import { useStableValue } from '../editing/use-stable-value'
import { isComposite, isEditSegment, ORIGINAL_LABEL } from '../editing/version-lineage'
import { isRunningStatus } from '../shots'
import { useVideoModels, type GenerationJob } from '../storyboard.api'
import { AiEditCard, type AiEditCardHandle } from './ai-edit-card'
import { clipGenerationBlock, referenceImageCountOf } from './clip-generation'
import {
  chooseClipVersion,
  selectedClips,
  selectedGroup,
  selectedSource,
  selectionPositions,
} from './clip-selection'
import { groupsForBase } from './clip-versions'
import {
  canRemove,
  canSplitAt,
  clickSelect,
  compositeSegments,
  draftDuration,
  keyframeSegments,
  layoutDraft,
  moveItems,
  removeItems,
  splitAt,
  trimClip,
  type DraftItem,
  type Edit,
} from './draft'
import { DurationSlider } from './duration-slider'
import {
  composingOf,
  editOutcomeOf,
  editStatusOf,
  nextCompositeLabel,
  nextEditLabel,
  projectVersions,
  unfinishedComposites,
  type ChainVersion,
} from './edit-chain'
import { editorFootnote, secondsText, lengthDifference } from './editor-footnote'
import { EditorNotices } from './editor-notices'
import { EditorTimeline } from './editor-timeline'
import { ShotPrompts } from './shot-prompts'
import { draftTimelineEntries, versionTimelineEntries } from './timeline-entries'
import { useEditDraft } from './use-edit-draft'
import { useGenerationSettings } from './use-generation-settings'
import { usePickedView } from './use-picked-view'
import { useSubmissionGuard } from './use-submission-guard'
import {
  CURRENT_SELECTION_KEY,
  posterOf,
  projectVersionStrip,
  type Submission,
} from './version-strip'
import {
  seedVideoEditJob,
  submitClipGeneration,
  submitVideoComposite,
  useVideoEditChain,
} from './video-editor.api'

const LOADING_PEAKS: PeaksState = { kind: 'loading' }
const NO_REQUEST: readonly ComposerPart[] = []
const STORAGE_FAILURE = '当前浏览器无法保存剪辑选择，关闭编辑器后剪辑内容将丢失'
const LAST_FRAME_LEAD = 0.1
const CARD_FRAME_WIDTH = 60
const REFERENCE_FRAME_WIDTH = 1280

type Props = {
  conversationId: string
  root: GenerationJob | undefined
  loading: boolean
  shotIndex: number | undefined
  onClose: () => void
}

export function VideoEditor({ conversationId, root, loading, shotIndex, onClose }: Props) {
  if (root === undefined || root.outputUrl === null) {
    return (
      <DialogRoot open onOpenChange={(open) => !open && onClose()}>
        <DialogSurface aria-describedby={undefined} className="max-w-md">
          <DialogHeader title="编辑视频" closeLabel="关闭视频编辑" />
          <DialogBody>
            <p className="text-body-sm text-on-surface-muted" role="status">
              {loading
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
      key={root.id}
      mediaUrl={root.outputUrl}
      onClose={onClose}
      root={root}
      shotIndex={shotIndex}
    />
  )
}

type EditorProps = {
  conversationId: string
  root: GenerationJob
  mediaUrl: string
  shotIndex: number | undefined
  onClose: () => void
}

function Editor({ conversationId, root, mediaUrl, shotIndex, onClose }: EditorProps) {
  const queryClient = useQueryClient()
  const chainQuery = useVideoEditChain(conversationId, root.id)
  const modelsQuery = useVideoModels()
  const settings = useGenerationSettings(modelsQuery.data)
  const { mode, chosen } = settings
  const chainJobs = chainQuery.data?.items
  const jobs = useMemo(() => chainJobs ?? [], [chainJobs])
  const versions = useMemo(() => projectVersions(root, jobs), [root, jobs])
  const previewRef = useRef<EditorPreviewHandle>(null)
  const selectionBoxRef = useRef<HTMLSpanElement>(null)
  const cardRef = useRef<AiEditCardHandle>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [playbackRequest, setPlaybackRequest] = useState<{
    id: number
    start: number
    end: number
  }>()
  const [request, setRequest] = useState(NO_REQUEST)
  const [droppedUploads, setDroppedUploads] = useState(0)
  const [cardOpen, setCardOpen] = useState(true)
  // 正在舞台上查看失败原因的那条任务；不改草稿与选用版本。
  const [failedJobId, setFailedJobId] = useState<string>()
  const [submission, setSubmission] = useState<Submission>()
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [composeError, setComposeError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeStorageFailure = useStorageFailureNotice(STORAGE_FAILURE, setNotice)
  const [picked, setPicked] = usePickedView(conversationId, root.id, noticeStorageFailure)
  const { downloading, download } = useMediaDownload()
  const busy = submission !== undefined
  useSubmissionGuard(busy)

  const pickedBaseJobId = picked?.baseJobId
  const version = useMemo<ChainVersion>(
    () =>
      versions.find((item) => item.jobId === pickedBaseJobId) ??
      versions.at(-1) ?? {
        jobId: root.id,
        label: ORIGINAL_LABEL,
        mediaUrl,
        sourceJobId: undefined,
      },
    [versions, pickedBaseJobId, root.id, mediaUrl],
  )
  const wholeVersion =
    versions.find((item) => item.jobId === picked?.jobId) ?? versions.at(-1) ?? version
  const view = picked?.view ?? 'whole'
  const viewingClips = view === 'clips'
  const viewingVersion = view === 'version'
  const keyframes = useKeyframes(version.mediaUrl)
  const segments = useMemo(
    () =>
      keyframes.data === undefined ? undefined : keyframeSegments(version.jobId, keyframes.data),
    [keyframes.data, version.jobId],
  )
  const versionDuration = keyframes.data?.duration
  const wholeKeyframes = useKeyframes(wholeVersion.mediaUrl)
  const groups = useMemo(() => groupsForBase(version.jobId, jobs), [version.jobId, jobs])
  const edits = useMemo(
    () => groups.flatMap((group) => group.edits).filter(isEditSegment),
    [groups],
  )
  const composingJob = composingOf(jobs, version.jobId)
  const chooseScope = (scope: 'whole' | 'clips') => {
    setFailedJobId(undefined)
    setPicked({ jobId: wholeVersion.jobId, baseJobId: version.jobId, view: scope })
    if (scope === 'whole') setCardOpen(false)
  }

  const resultUrls = useMemo(
    () =>
      edits.flatMap((edit) =>
        edit.status === 'completed' && edit.outputUrl !== null ? [edit.outputUrl] : [],
      ),
    [edits],
  )
  const knownDurations = useMemo(() => {
    const known: Record<string, number> = {}
    for (const edit of edits)
      if (edit.outputUrl !== null && edit.durationMs !== null)
        known[edit.outputUrl] = edit.durationMs / 1000
    return known
  }, [edits])
  const durations = useMediaDurations(resultUrls, knownDurations)
  const resultDuration = (edit: GenerationJob) =>
    edit.outputUrl === null ? undefined : (durations[edit.outputUrl] ?? undefined)
  const statusOf = (edit: GenerationJob) => editStatusOf(edit, durations)

  const editor = useEditDraft({
    conversationId,
    version,
    versions,
    segments,
    jobs: chainJobs,
    edits,
    outcomeOf: (editJobId) => {
      const edit = edits.find((item) => item.id === editJobId)
      return edit === undefined ? undefined : editOutcomeOf(statusOf(edit))
    },
    onNotice: setNotice,
    onStorageFailure: noticeStorageFailure,
    onComposed: (jobId) => {
      setFailedJobId(undefined)
      setPicked({ jobId, baseJobId: version.jobId, view: 'version' })
    },
  })
  const changed = editor?.changed ?? false
  const waitingComposite = composingJob !== undefined || editor?.composite !== undefined
  const editable = editor !== undefined && !viewingVersion && !waitingComposite && !busy
  const draft = editor?.draft ?? []
  const selection = viewingClips && editor !== undefined ? editor.selection : []
  const generating = draft.some((item) => item.kind === 'pending')
  const candidateGroup = selectedGroup(draft, selection, version.jobId, jobs, resultDuration)
  const source = selectedSource(draft, selection)
  const selectedMedia = selectedClips(draft, selection)
  const selectedDuration = selectedMedia?.reduce((sum, clip) => sum + clip.end - clip.start, 0) ?? 0
  const positions = selectionPositions(draft, selection)

  const generationBlockOf = (referenceImageCount: number) =>
    chosen === undefined
      ? undefined
      : clipGenerationBlock(chosen.model, {
          mode,
          seconds: mode === 'image' ? chosen.imageSeconds : selectedDuration,
          referenceImageCount,
        })
  const requestBlock = generationBlockOf(referenceImageCountOf(request))
  const blockReason =
    selection.length === 0
      ? undefined
      : candidateGroup?.edits.some((edit) => isRunningStatus(edit.status)) === true
        ? '该区间正在生成新版本，无法再次生成；请等待生成完成'
        : candidateGroup === undefined
          ? '所选片段在原片中不连续，无法生成新版本；请选择原片时间连续的片段'
          : chosen === undefined
            ? '暂无可用的视频模型'
            : requestBlock?.cause === 'selection'
              ? requestBlock.message
              : undefined

  const urlOf = (sourceJobId: string) =>
    sourceJobId === version.jobId
      ? version.mediaUrl
      : (edits.find((edit) => edit.id === sourceJobId)?.outputUrl ?? undefined)
  const segmentOf = (clip: Clip): PlaySegment | undefined => {
    const url = urlOf(clip.sourceJobId)
    return url === undefined ? undefined : { mediaUrl: url, start: clip.start, end: clip.end }
  }
  const partsOf = (item: DraftItem): PlaySegment[] =>
    (item.kind === 'clip' ? [item] : item.replaced).flatMap((clip) => segmentOf(clip) ?? [])
  const referenceClips = selectedMedia?.flatMap((clip) => segmentOf(clip) ?? [])
  const canGenerate =
    candidateGroup !== undefined &&
    referenceClips !== undefined &&
    referenceClips.length === selectedMedia?.length &&
    blockReason === undefined
  const versionPlay =
    wholeKeyframes.data === undefined
      ? undefined
      : layoutPlay([
          { mediaUrl: wholeVersion.mediaUrl, start: 0, end: wholeKeyframes.data.duration },
        ])
  const draftPlay = editor === undefined ? undefined : layoutPlay(draft.flatMap(partsOf))
  const current = viewingVersion ? versionPlay : draftPlay
  const total = editor === undefined ? (versionDuration ?? 0) : draftDuration(draft)
  const previewDuration = viewingVersion ? (wholeKeyframes.data?.duration ?? 0) : total
  const scale = viewingVersion ? previewDuration : Math.max(versionDuration ?? 0, total)
  const difference = lengthDifference(version.label, versionDuration ?? 0, total)

  const versionSegments =
    wholeKeyframes.data === undefined
      ? []
      : keyframeSegments(wholeVersion.jobId, wholeKeyframes.data)
  const shownItems = viewingVersion ? versionSegments : draft
  const entries = viewingVersion
    ? versionTimelineEntries(versionSegments, wholeVersion.mediaUrl)
    : draftTimelineEntries({
        draft,
        partsOf,
        groups,
        baseJobId: version.jobId,
        jobs,
        durationOf: resultDuration,
      })
  const audioUrls = useStableValue([
    ...new Set(entries.flatMap((entry) => entry.parts.map((part) => part.mediaUrl))),
  ])
  const peaks = useAudioPeaks(audioUrls)
  const peaksFailure = [...peaks.values()].find((state) => state.kind === 'failed')

  const unseen = useUnseenResults(
    edits.filter((edit) => isRunningStatus(edit.status)).map((edit) => edit.id),
    viewingClips ? source?.sourceJobId : undefined,
  )

  const seedJob = (job: GenerationJob) =>
    seedVideoEditJob(queryClient, conversationId, root.id, job)

  const apply = (edit: Edit | undefined) => {
    if (edit === undefined || editor === undefined || !editable) return
    editor.apply(edit)
    chooseScope('clips')
    setNotice(null)
  }

  const playSelection = (nextDraft: readonly DraftItem[], ids: readonly string[]) => {
    const placed = layoutDraft(nextDraft).filter(({ item }) => ids.includes(item.id))
    const first = placed[0]
    const last = placed.at(-1)
    if (first === undefined || last === undefined) return
    setCurrentTime(first.at)
    setPlaybackRequest((previous) => ({
      id: (previous?.id ?? 0) + 1,
      start: first.at,
      end: last.at + last.duration,
    }))
  }

  const pick = (key: string) => {
    if (busy) return
    setNotice(null)
    if (jobs.find((job) => job.id === key)?.status === 'failed') {
      setFailedJobId(key)
      setCardOpen(false)
      previewRef.current?.previewAt(currentTime)
      return
    }
    setFailedJobId(undefined)
    if (!viewingClips) {
      if (!versions.some((item) => item.jobId === key)) return
      setPicked({ jobId: key, baseJobId: version.jobId, view: 'version' })
      return
    }
    if (editor === undefined || candidateGroup === undefined || !editable) return
    if (key === CURRENT_SELECTION_KEY) {
      playSelection(draft, selection)
      return
    }
    const chosenEdit =
      key === candidateGroup.key ? undefined : candidateGroup.edits.find((edit) => edit.id === key)
    if (
      key !== candidateGroup.key &&
      (chosenEdit?.status !== 'completed' || chosenEdit.outputUrl === null)
    )
      return
    const duration = chosenEdit === undefined ? undefined : resultDuration(chosenEdit)
    if (chosenEdit !== undefined && duration === undefined) {
      setNotice('结果时长读取失败，未更改当前片段的选用版本')
      return
    }
    const next = chooseClipVersion(
      draft,
      selection,
      chosenEdit === undefined
        ? { sourceJobId: version.jobId, start: candidateGroup.start, end: candidateGroup.end }
        : { sourceJobId: chosenEdit.id, start: 0, end: duration ?? 0 },
    )
    if (next === undefined) return
    apply(next)
    playSelection(next.draft, next.selection)
  }

  if (selection.length === 0 && !cardOpen) setCardOpen(true)

  const clickSegment = (id: string, extend = false) => {
    if (editor === undefined || !editable) return
    const next = extend ? clickSelect(draft, editor.selection, id) : [id]
    editor.select(next)
    chooseScope('clips')
    setCardOpen(true)
    playSelection(draft, next)
  }
  const collapseCard = () => setCardOpen(false)

  const generate = async (input: ComposerSubmission) => {
    if (
      busy ||
      editor === undefined ||
      !canGenerate ||
      candidateGroup === undefined ||
      referenceClips === undefined ||
      chosen === undefined
    )
      return
    const { text, referenceImageUrls } = compileReferencePrompt(draftPartsOf(input.parts))
    setSubmission({
      kind: 'edit',
      targetKey: candidateGroup.key,
      since: new Date().toISOString(),
      label: nextEditLabel(candidateGroup),
    })
    setFailedJobId(undefined)
    setGenerateError(null)
    setNotice(null)
    try {
      const job = await submitClipGeneration({
        conversationId,
        taskId: root.taskId,
        sourceJobId: version.jobId,
        generation:
          mode === 'image' ? { mode, seconds: chosen.imageSeconds } : { mode, referenceClips },
        range: { start: candidateGroup.start, end: candidateGroup.end },
        model: chosen.model,
        prompt: text.trim(),
        referenceImageUrls,
      })
      seedJob(job)
      editor.submitted()
      chooseScope('clips')
      setDroppedUploads(0)
    } catch (error) {
      setGenerateError(errorMessageOf(error, '片段生成提交失败'))
    } finally {
      setSubmission(undefined)
    }
  }

  const segmentsToCompose = compositeSegments(draft)
  const canCompose =
    !viewingVersion && changed && segmentsToCompose !== undefined && !waitingComposite && !busy
  const compose = async () => {
    if (!canCompose || editor === undefined || segmentsToCompose === undefined) return
    setFailedJobId(undefined)
    setPicked({ jobId: wholeVersion.jobId, baseJobId: version.jobId, view: 'whole' })
    setSubmission({
      kind: 'compose',
      targetKey: version.jobId,
      since: new Date().toISOString(),
      label: nextCompositeLabel(versions, jobs),
    })
    setComposeError(null)
    setNotice(null)
    try {
      const job = await submitVideoComposite({
        conversationId,
        taskId: root.taskId,
        baseJobId: version.jobId,
        segments: segmentsToCompose,
      })
      seedJob(job)
      editor.composing(job.id)
      toast.success('已提交合成，完成后将生成新版本')
    } catch (error) {
      setComposeError(errorMessageOf(error, '合成任务提交失败'))
    } finally {
      setSubmission(undefined)
    }
  }

  const strip = projectVersionStrip({
    view,
    changed,
    baseJobId: version.jobId,
    baseMediaUrl: version.mediaUrl,
    versions,
    unfinishedComposites: unfinishedComposites(versions, jobs),
    viewedJobId: wholeVersion.jobId,
    group: candidateGroup,
    source,
    firstReference: referenceClips?.[0],
    statusOf,
    isUnseen: unseen.isUnseen,
    submission,
  })
  const viewedFailure =
    failedJobId === undefined || !strip.entries.some((entry) => entry.key === failedJobId)
      ? undefined
      : jobs.find((job) => job.id === failedJobId)

  const footnote = editorFootnote({
    notice,
    loaded: editor !== undefined,
    view,
    viewedLabel: wholeVersion.label,
    submitting: busy,
    waitingComposite,
    draft,
    selection,
    positions,
    blockReason,
    generating,
    changed,
    difference,
  })

  const toolButtons = (
    <>
      <span aria-hidden="true" className="editor-bar-divider" />
      <IconButton
        disabled={!editable || editor?.canUndo !== true}
        label="撤销"
        name="undo"
        onClick={() => {
          setFailedJobId(undefined)
          editor?.undo()
        }}
        size="sm"
      />
      <IconButton
        disabled={!editable || editor?.canRedo !== true}
        label="重做"
        name="redo"
        onClick={() => {
          setFailedJobId(undefined)
          editor?.redo()
        }}
        size="sm"
      />
      <span aria-hidden="true" className="editor-bar-divider" />
      <Button
        className="editor-bar-button editor-tool"
        disabled={!editable || !canSplitAt(draft, currentTime)}
        leadingIcon="split"
        onClick={() => apply(splitAt(draft, currentTime))}
        size="md"
        variant="ghost"
      >
        <span className="editor-tool-label">拆分</span>
      </Button>
      <Button
        className="editor-bar-button editor-tool"
        disabled={!editable || !canRemove(draft, selection)}
        leadingIcon="delete"
        onClick={() => apply(removeItems(draft, selection))}
        size="md"
        variant="ghost"
      >
        <span className="editor-tool-label">删除</span>
      </Button>
    </>
  )

  const readout = (
    <span className="editor-readout">
      共 <b>{secondsText(previewDuration)}</b> 秒
      {!viewingVersion && changed && difference !== undefined ? ` · ${difference}` : null}
    </span>
  )

  const composeButton = changed ? (
    <Button
      className="editor-compose"
      disabled={!canCompose}
      leadingIcon="video"
      loading={submission?.kind === 'compose' || waitingComposite}
      onClick={() => void compose()}
      size="md"
      title={generating ? 'AI 生成尚未完成，无法合成' : undefined}
    >
      {waitingComposite ? '合成中' : '合成新版本'}
    </Button>
  ) : undefined

  const downloadButton = (
    <Button
      className="editor-bar-button"
      disabled={viewingClips || (!viewingVersion && changed)}
      leadingIcon="download"
      loading={downloading}
      onClick={() =>
        void download(viewingVersion ? wholeVersion.mediaUrl : version.mediaUrl, '生成的视频')
      }
      size="md"
      variant="ghost"
    >
      下载
    </Button>
  )

  const timelineKeyframes = viewingVersion ? wholeKeyframes : keyframes
  const timeline = timelineKeyframes.isError ? (
    <p className="editor-timeline-loading" role="alert">
      {errorMessageOf(timelineKeyframes.error, '该视频的关键帧读取失败')}
      <Button onClick={() => void timelineKeyframes.refetch()} size="md" variant="ghost">
        重试
      </Button>
    </p>
  ) : editor === undefined || timelineKeyframes.data === undefined ? (
    <p className="editor-timeline-loading" role="status">
      正在读取分段…
    </p>
  ) : (
    <EditorTimeline
      currentTime={currentTime}
      draft={shownItems}
      editable={editable}
      entries={entries}
      onDelete={() => apply(removeItems(draft, selection))}
      onClickSegment={clickSegment}
      onMove={(ids, before) => apply(moveItems(draft, ids, before))}
      onScrub={collapseCard}
      onSeek={(time) => previewRef.current?.previewAt(time)}
      onSelect={(next) => {
        editor.select(next)
        chooseScope('clips')
        playSelection(draft, next)
      }}
      onTrim={(id, edge, value) => apply(trimClip(draft, id, edge, value))}
      onTrimPreview={(clock, edge) => previewRef.current?.previewAt(clock, edge)}
      peaksOf={(url) => peaks.get(url) ?? LOADING_PEAKS}
      scale={scale}
      selection={selection}
      selectionBoxRef={selectionBoxRef}
      total={previewDuration}
    />
  )

  const frameOf = (
    clip: Clip | undefined,
    at: (clip: Clip) => number,
    width = CARD_FRAME_WIDTH,
  ) => {
    const url = clip === undefined ? undefined : urlOf(clip.sourceJobId)
    return clip === undefined || url === undefined
      ? undefined
      : videoSnapshotUrl(url, width, at(clip))
  }
  const cardDetail =
    blockReason ??
    (candidateGroup === undefined
      ? undefined
      : `${secondsText(candidateGroup.start)} – ${secondsText(candidateGroup.end)} 秒 · ${mode === 'image' ? '根据引用图片生成新版本' : '视频和原声一起重做'}`)
  const card =
    positions === undefined || cardDetail === undefined ? null : (
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
        canGenerate={canGenerate && !busy}
        detail={cardDetail}
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
        firstFrameReferenceUrl={frameOf(
          selectedMedia?.[0],
          (clip) => clip.start,
          REFERENCE_FRAME_WIDTH,
        )}
        frames={{
          first: frameOf(selectedMedia?.[0], (clip) => clip.start),
          last: frameOf(selectedMedia?.at(-1), (clip) =>
            Math.max(clip.start, clip.end - LAST_FRAME_LEAD),
          ),
        }}
        generating={submission?.kind === 'edit'}
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
        positions={positions}
        ref={cardRef}
        referenceLimit={chosen?.model.maxReferenceImages}
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
        className="editor-dialog"
        onEscapeKeyDown={(event) => {
          if (card === null || !cardOpen) return
          event.preventDefault()
          collapseCard()
        }}
        onInteractOutside={(event) => event.preventDefault()}
        onKeyDown={(event) =>
          handleUndoShortcut(event, editable ? editor : undefined, () => setFailedJobId(undefined))
        }
      >
        <DialogHeader
          actions={composeButton}
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
            backdrop={posterOf(current?.[0]?.mediaUrl ?? version.mediaUrl)}
            barEnd={downloadButton}
            contentKey={
              viewingVersion
                ? `${wholeVersion.jobId}:version`
                : `${version.jobId}:${viewingClips ? 'clips' : 'whole'}`
            }
            current={current}
            currentTime={currentTime}
            footnote={
              <>
                <EditorNotices
                  chainError={
                    chainQuery.isError
                      ? errorMessageOf(chainQuery.error, '读取编辑记录失败')
                      : undefined
                  }
                  composeError={composeError}
                  onReloadChain={() => void chainQuery.refetch()}
                  peaksError={
                    peaksFailure?.kind === 'failed'
                      ? errorMessageOf(peaksFailure.error, '原声读取失败')
                      : undefined
                  }
                />
                <p className="editor-footnote" role={notice === null ? undefined : 'status'}>
                  {footnote}
                </p>
              </>
            }
            onPlay={() => {
              collapseCard()
              setFailedJobId(undefined)
            }}
            onTime={setCurrentTime}
            playbackRequest={viewingClips ? playbackRequest : undefined}
            viewControl={
              <div aria-label="视频预览范围" className="video-editor-compare" role="group">
                <button
                  aria-pressed={!viewingClips}
                  disabled={busy}
                  onClick={() => chooseScope('whole')}
                  type="button"
                >
                  整条
                </button>
                <button
                  aria-pressed={viewingClips}
                  disabled={busy}
                  onClick={() => chooseScope('clips')}
                  type="button"
                >
                  片段
                </button>
              </div>
            }
            overlay={
              <>
                {card}
                <ShotPrompts
                  canAppend={card !== null && !busy}
                  onAppend={(text) => cardRef.current?.appendText(text)}
                  root={root}
                  shotIndex={shotIndex}
                />
              </>
            }
            picture={
              viewedFailure === undefined ? undefined : (
                <StageFailure
                  key={viewedFailure.id}
                  message={viewedFailure.errorMessage?.trim()}
                  title={isComposite(viewedFailure) ? '合成失败' : '生成失败'}
                />
              )
            }
            poster={posterOf(current?.[0]?.mediaUrl ?? version.mediaUrl)}
            readout={readout}
            ref={previewRef}
            timeline={timeline}
            tools={toolButtons}
            versions={
              <EditorVersionStrip
                entries={strip.entries}
                onSelect={pick}
                selectedKey={viewedFailure?.id ?? strip.selectedKey}
                title={viewingClips && positions !== undefined ? positions : '整条'}
              />
            }
          />
        </div>
      </DialogSurface>
    </DialogRoot>
  )
}
