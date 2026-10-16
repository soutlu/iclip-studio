/** 视频编辑器：在一版成片上剪（裁剪、调序、拆分、删除），选几段交给 AI 改，满意再合成成新的一版。
 *
 * 整片与片段候选来自服务端记录，选用与剪辑保存在浏览器；生成完成不会自动替换用户选用的版本。
 * 参考片段在提交时按当前选用的素材裁剪、拼接并上传，最终成片由服务端合成。
 *
 * AI 改段的要求由用户在选中段时弹出的卡里填写。卡里没提交的要求只有一份，
 * 换了选区也不清空，提交成功才清空。 */

import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Slider } from 'radix-ui'
import { errorMessageOf } from '@/shared/api/client'
import type { ComposerHandle } from '@/shared/ui/composer'
import { useMediaDownload } from '@/shared/api/media-download'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { Button, IconButton } from '@/shared/ui/button'
import type { ComposerPart, ComposerSubmission } from '@/shared/ui/composer'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { toast } from '@/shared/ui/toast'
import { GenerationPicker } from '../components/generation-picker'
import { useUnseenResults } from '../components/use-unseen-results'
import { compileReferencePrompt, draftPartsOf } from '../edit-prompt'
import { isRunningStatus } from '../shots'
import { MAX_EDIT_REFERENCES } from '../generation-limits'
import { useVideoModels, type GenerationJob } from '../storyboard.api'
import { AiEditCard } from './ai-edit-card'
import { clipDurationError, type ClipGenerationMode } from './clip-generation'
import { ShotPrompts } from './shot-prompts'
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
  trimBounds,
  trimClip,
  type DraftClip,
  type DraftItem,
  type Edit,
  type EditOutcome,
} from './draft'
import {
  composingOf,
  isComposite,
  isEditSegment,
  projectVersions,
  type ChainVersion,
} from './edit-chain'
import { groupForClip, groupsForBase } from './clip-versions'
import {
  chooseClipVersion,
  selectedClips as clipsOfSelection,
  selectedGroup,
  selectedSource,
} from './clip-selection'
import { EditorNotices } from './editor-notices'
import { EditorPreview, type EditorPreviewHandle } from './editor-preview'
import { EditorTimeline, type TimelineEntry } from './editor-timeline'
import { EditorVersionStrip, type VersionStripEntry } from './editor-version-strip'
import { layoutPlay, type PlaySegment } from './play-layout'
import { useEditDraft } from './use-edit-draft'
import { usePickedView } from './use-picked-view'
import { useAudioPeaks, useKeyframes, type PeaksState } from './use-media-analysis'
import { useMediaDurations } from './use-media-durations'
import { useStableValue } from './use-stable-value'
import { useSubmissionGuard } from './use-submission-guard'
import {
  pickGenerationModel,
  seedVideoEditJob,
  submitVideoComposite,
  submitClipGeneration,
  useVideoEditChain,
} from './video-editor.api'

const posterOf = (url: string) => videoSnapshotUrl(url, 320)
const LOADING_PEAKS: PeaksState = { kind: 'loading' }
const seconds = (value: number) => value.toFixed(1)
const NO_REQUEST: readonly ComposerPart[] = []
const CURRENT_SELECTION_KEY = 'current-selection'
const SUBMISSION_KEY = 'submitting'
const STORAGE_FAILURE = '当前浏览器无法保存剪辑选择，关闭编辑器后剪辑内容将丢失'

type Props = {
  conversationId: string
  /** 链的根：抽屉里那条完成的出片记录。列表里找不到它就只能提示。 */
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
              {loading ? '正在读取视频记录…' : '未找到该视频记录，请关闭后在「本组成片」中重新打开'}
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

/** 按键落在输入框里时让给输入框自己（Cmd/Ctrl+Z 在那里是撤销打字）。 */
const isTextEntry = (target: EventTarget) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && target.type !== 'range'))

/** 一段或几段的名字：第 2 段、第 2–3 段。 */
const positions = (first: number, last: number) =>
  first === last ? `第 ${first} 段` : `第 ${first}–${last} 段`

/** 卡头的末帧取段尾之前这么多秒：段尾正好是下一段的开头，截在那一刻可能截到下一段。 */
const LAST_FRAME_LEAD = 0.1
/** 卡头截图的宽：显示 30px，按两倍像素取。 */
const CARD_FRAME_WIDTH = 60

function Editor({ conversationId, root, mediaUrl, shotIndex, onClose }: EditorProps) {
  const queryClient = useQueryClient()
  const chainQuery = useVideoEditChain(conversationId, root.id)
  const modelsQuery = useVideoModels()
  const [mode, setMode] = useState<ClipGenerationMode>('edit')
  const [wantedSeconds, setWantedSeconds] = useState<number>()
  const models = useMemo(
    () =>
      (modelsQuery.data?.clipModels ?? []).filter((item) => mode === 'image' || item.edit !== null),
    [modelsQuery.data, mode],
  )
  const chainJobs = chainQuery.data?.items
  const jobs = useMemo(() => chainJobs ?? [], [chainJobs])
  const versions = useMemo(() => projectVersions(root, jobs), [root, jobs])
  const previewRef = useRef<EditorPreviewHandle>(null)
  const selectionBoxRef = useRef<HTMLSpanElement>(null)
  const requestComposerRef = useRef<ComposerHandle>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [playbackRequest, setPlaybackRequest] = useState<{
    id: number
    start: number
    end: number
  }>()
  /** 卡里没提交的要求：文字与传好的参考图。 */
  const [request, setRequest] = useState(NO_REQUEST)
  /** 上次收起卡时有几张参考图还没传好、没留下；下次改要求时收起这句提示。 */
  const [droppedUploads, setDroppedUploads] = useState(0)
  /** 卡展开着；一拖、一播、按 Escape 就收成胶囊。 */
  const [cardOpen, setCardOpen] = useState(true)
  const [wantedModel, setWantedModel] = useState<string>()
  // 两次互斥的提交；任一在跑时整个编辑器一起锁。
  const [submission, setSubmission] = useState<{
    kind: 'edit' | 'compose'
    targetKey: string
    since: string
    label: string
  }>()
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [composeError, setComposeError] = useState<string | null>(null)
  /** 脚注位置上要让人看到的一句话，下一次剪辑时收起。 */
  const [notice, setNotice] = useState<string | null>(null)
  /** 草稿与看哪一版都存进浏览器，写不进去时同一次打开里只说一次。 */
  const storageFailedRef = useRef(false)
  const noticeStorageFailure = () => {
    if (storageFailedRef.current) return
    storageFailedRef.current = true
    setNotice(STORAGE_FAILURE)
  }
  // 编辑基底与明确点开的历史成片分别记；默认整片预览当前剪辑。
  const [picked, setPicked] = usePickedView(conversationId, root.id, noticeStorageFailure)
  const { downloading, download } = useMediaDownload()
  const busy = submission !== undefined
  useSubmissionGuard(busy)
  const modelId = pickGenerationModel(
    models.map((item) => item.id),
    wantedModel,
    modelsQuery.data?.default,
  )
  const model = models.find((item) => item.id === modelId)
  const imageSeconds = wantedSeconds ?? model?.image.defaultSeconds ?? 0

  // 整片浏览与编辑基底分别记。查看历史不会替换已选片段，合成完成也不清空选择。
  const version: ChainVersion = versions.find((item) => item.jobId === picked?.baseJobId) ??
    versions.at(-1) ?? { jobId: root.id, label: '原片', mediaUrl, sourceJobId: undefined }
  const wholeVersion =
    versions.find((item) => item.jobId === picked?.jobId) ?? versions.at(-1) ?? version
  const viewingClips = picked?.view === 'clips'
  const viewingVersion = picked?.view === 'version'
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
  const chooseScope = (view: 'whole' | 'clips') => {
    setPicked({ jobId: wholeVersion.jobId, baseJobId: version.jobId, view })
    if (view === 'whole') setCardOpen(false)
  }

  // AI 结果多长：记录上有就用，没有就开播放器去探。
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

  const outcomeOf = (editJobId: string): EditOutcome | undefined => {
    const edit = edits.find((item) => item.id === editJobId)
    if (edit === undefined) return undefined
    if (isRunningStatus(edit.status)) return { kind: 'running' }
    if (edit.status !== 'completed' || edit.outputUrl === null)
      return { kind: 'failed', message: edit.errorMessage ?? '未返回生成结果' }
    const duration = durations[edit.outputUrl]
    if (duration === null) return { kind: 'failed', message: '结果时长读取失败' }
    return duration === undefined ? { kind: 'running' } : { kind: 'done', duration }
  }

  const editor = useEditDraft({
    conversationId,
    version,
    versions,
    segments,
    jobs: chainJobs,
    edits,
    outcomeOf,
    onNotice: setNotice,
    onStorageFailure: noticeStorageFailure,
    onComposed: (jobId) => {
      setPicked({ jobId, baseJobId: version.jobId, view: 'version' })
    },
  })
  const changed = editor?.changed ?? false
  const waitingComposite = composingJob !== undefined || editor?.composite !== undefined
  const editable = editor !== undefined && !viewingVersion && !waitingComposite && !busy
  const draft = editor?.draft ?? []
  const selection = viewingClips && editor !== undefined ? editor.selection : []
  const pendingItems = draft.filter((item) => item.kind === 'pending')
  const candidateGroup = selectedGroup(draft, selection, version.jobId, jobs, resultDuration)
  const source = selectedSource(draft, selection)
  const pendingEdits = candidateGroup?.edits.filter((edit) => isRunningStatus(edit.status)) ?? []
  const selectedRunning = pendingEdits.length > 0
  const target =
    candidateGroup === undefined
      ? undefined
      : {
          range: { start: candidateGroup.start, end: candidateGroup.end },
        }
  const selectedMedia = clipsOfSelection(draft, selection)
  const selectedDuration = selectedMedia?.reduce((sum, clip) => sum + clip.end - clip.start, 0) ?? 0
  const blockReason =
    selection.length === 0
      ? undefined
      : selectedRunning
        ? '该区间正在生成新版本，请等待生成完成'
        : candidateGroup === undefined
          ? '请选择原片时间连续的片段，再生成新版本'
          : model === undefined
            ? '暂无可用的视频模型'
            : clipDurationError(model, mode, mode === 'image' ? imageSeconds : selectedDuration)

  // ---------- 预览 ----------

  const urlOf = (sourceJobId: string) =>
    sourceJobId === version.jobId
      ? version.mediaUrl
      : (edits.find((edit) => edit.id === sourceJobId)?.outputUrl ?? undefined)
  const partsOf = (item: DraftItem): PlaySegment[] =>
    (item.kind === 'clip' ? [item] : item.replaced).flatMap((clip) => {
      const url = urlOf(clip.sourceJobId)
      return url === undefined ? [] : [{ mediaUrl: url, start: clip.start, end: clip.end }]
    })
  const referenceClips = selectedMedia?.flatMap((clip) => {
    const mediaUrl = urlOf(clip.sourceJobId)
    return mediaUrl === undefined ? [] : [{ mediaUrl, start: clip.start, end: clip.end }]
  })
  const canGenerate =
    target !== undefined &&
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

  // ---------- 时间线 ----------

  const shownItems = viewingVersion
    ? wholeKeyframes.data === undefined
      ? []
      : keyframeSegments(wholeVersion.jobId, wholeKeyframes.data)
    : draft
  const entries: TimelineEntry[] = layoutDraft(shownItems).map(({ item, at, duration }) => {
    const group =
      !viewingVersion && item.kind === 'clip'
        ? (groups.find((group) => group.edits.some((edit) => edit.id === item.sourceJobId)) ??
          groupForClip(item, version.jobId, jobs, resultDuration))
        : undefined
    const editedVersion =
      group?.edits.findIndex(
        (edit) => edit.id === (item.kind === 'clip' ? item.sourceJobId : ''),
      ) ?? -1
    return {
      id: item.id,
      at,
      duration,
      parts:
        viewingVersion && item.kind === 'clip'
          ? [{ mediaUrl: wholeVersion.mediaUrl, start: item.start, end: item.end }]
          : partsOf(item),
      clip: item.kind === 'clip' ? item : undefined,
      changed: group !== undefined,
      runningSince: undefined,
      versionLabel: editedVersion < 0 ? undefined : `V${editedVersion + 1}`,
    }
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

  // ---------- 操作 ----------

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
    const chosen =
      key === candidateGroup.key ? undefined : candidateGroup.edits.find((edit) => edit.id === key)
    if (key !== candidateGroup.key && (chosen?.status !== 'completed' || chosen.outputUrl === null))
      return
    const duration = chosen === undefined ? undefined : resultDuration(chosen)
    if (chosen !== undefined && duration === undefined) {
      setNotice('结果时长读取失败，未更改当前片段的选用版本')
      return
    }
    const next = chooseClipVersion(
      draft,
      selection,
      chosen === undefined
        ? { sourceJobId: version.jobId, start: candidateGroup.start, end: candidateGroup.end }
        : { sourceJobId: chosen.id, start: 0, end: duration ?? 0 },
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

  /** 卡里点「生成视频」：要求里的参考图按出现的先后排成 `reference_image_urls`，正文里写 `@ImageN`。 */
  const generate = async (input: ComposerSubmission) => {
    if (
      busy ||
      editor === undefined ||
      !canGenerate ||
      target === undefined ||
      candidateGroup === undefined ||
      referenceClips === undefined
    )
      return
    if (mode === 'edit' && input.text.trim() === '') {
      setGenerateError('请填写修改要求')
      return
    }
    if (model === undefined) {
      setGenerateError('暂无可用的视频模型')
      return
    }
    const { text, referenceImageUrls } = compileReferencePrompt(draftPartsOf(input.parts))
    if (mode === 'image' && referenceImageUrls.length === 0) {
      setGenerateError('请在描述中引用至少一张图片')
      return
    }
    // 制作参考、上传和等待受理都属于提交中；只有服务端任务才显示生成中。
    setSubmission({
      kind: 'edit',
      targetKey: candidateGroup.key,
      since: new Date().toISOString(),
      label: `V${candidateGroup.edits.length + 1}`,
    })
    setGenerateError(null)
    setNotice(null)
    try {
      const job = await submitClipGeneration({
        conversationId,
        taskId: root.taskId,
        sourceJobId: version.jobId,
        generation: mode === 'image' ? { mode, seconds: imageSeconds } : { mode, referenceClips },
        range: target.range,
        model,
        prompt: text.trim(),
        referenceImageUrls,
      })
      seedJob(job)
      // 新结果只作为候选出现。当前素材和已选版本保持不动。
      editor.submitted()
      chooseScope('clips')
      setRequest(NO_REQUEST)
      requestComposerRef.current?.clear()
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
    setPicked({ jobId: wholeVersion.jobId, baseJobId: version.jobId, view: 'whole' })
    setSubmission({
      kind: 'compose',
      targetKey: version.jobId,
      since: new Date().toISOString(),
      label: `V${versions.length + jobs.filter((job) => isComposite(job) && job.status !== 'completed').length}`,
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

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isTextEntry(event.target) || !(event.metaKey || event.ctrlKey)) return
    if (event.key.toLowerCase() !== 'z' || editor === undefined || !editable) return
    event.preventDefault()
    if (event.shiftKey) {
      if (editor.canRedo) editor.redo()
    } else if (editor.canUndo) editor.undo()
  }

  // ---------- 版本条 ----------

  const completedWholeEntries: VersionStripEntry[] = versions.map((item) => ({
    key: item.jobId,
    label: item.label,
    name: item.label,
    poster: posterOf(item.mediaUrl),
    running: undefined,
    unseen: false,
  }))
  const wholeInFlight = jobs
    .filter((job) => isComposite(job) && job.status !== 'completed')
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map((job, at): VersionStripEntry => ({
      key: job.id,
      label: `V${versions.length + at}`,
      name: `V${versions.length + at} · ${job.status === 'failed' ? '合成失败' : '合成中'}`,
      poster: posterOf(version.mediaUrl),
      running: isRunningStatus(job.status) ? { since: job.createdAt, label: '合成中' } : undefined,
      failed: job.status === 'failed',
      disabled: true,
      unseen: false,
    }))
  const clipEntries: VersionStripEntry[] =
    candidateGroup === undefined
      ? []
      : [
          {
            key: candidateGroup.key,
            label: '原片',
            name: '原片',
            poster: videoSnapshotUrl(version.mediaUrl, 320, candidateGroup.start),
            running: undefined,
            unseen: false,
          },
          ...candidateGroup.edits.map((edit, at): VersionStripEntry => {
            const label = `V${at + 1}`
            const failed = edit.status === 'failed'
            const running = isRunningStatus(edit.status)
            const duration = resultDuration(edit)
            const unreadable = edit.outputUrl !== null && durations[edit.outputUrl] === null
            const isNewResult =
              edit.status === 'completed' && duration !== undefined && unseen.isUnseen(edit.id)
            return {
              key: edit.id,
              label,
              name: [
                label,
                running
                  ? '生成中'
                  : failed
                    ? '失败'
                    : unreadable
                      ? '结果时长读取失败'
                      : isNewResult
                        ? '新结果'
                        : undefined,
              ]
                .filter(Boolean)
                .join(' · '),
              poster: posterOf(edit.outputUrl ?? edit.sourceUrl ?? version.mediaUrl),
              running: running ? { since: edit.createdAt, label: '生成中' } : undefined,
              failed: failed || unreadable,
              disabled:
                edit.status !== 'completed' ||
                edit.outputUrl === null ||
                (duration === undefined && !unreadable),
              unseen: isNewResult,
            }
          }),
        ]
  const hasCurrentCandidate =
    source !== undefined &&
    (source.sourceJobId === version.jobId ||
      candidateGroup?.edits.some((edit) => edit.id === source.sourceJobId))
  // 剪裁后的结果或多个版本拼出的选区不冒充一个完整候选，仍标出当前实际预览的内容。
  if (candidateGroup !== undefined && !hasCurrentCandidate) {
    const first = referenceClips?.[0]
    clipEntries.push({
      key: CURRENT_SELECTION_KEY,
      label: '当前',
      name: '当前选用',
      poster: first === undefined ? undefined : videoSnapshotUrl(first.mediaUrl, 320, first.start),
      running: undefined,
      unseen: false,
    })
  }
  const stripEntries = [
    ...(viewingClips ? clipEntries : [...completedWholeEntries, ...wholeInFlight]),
  ]
  if (
    submission !== undefined &&
    (viewingClips
      ? submission.kind === 'edit' && submission.targetKey === candidateGroup?.key
      : submission.kind === 'compose')
  ) {
    stripEntries.push({
      key: SUBMISSION_KEY,
      label: submission.label,
      name: `${submission.label} · 提交中`,
      poster: posterOf(referenceClips?.[0]?.mediaUrl ?? version.mediaUrl),
      running: { since: submission.since, label: '提交中' },
      disabled: true,
      unseen: false,
    })
  }
  stripEntries.reverse()
  const selectedKey = viewingClips
    ? !hasCurrentCandidate
      ? CURRENT_SELECTION_KEY
      : source?.sourceJobId === version.jobId
        ? (candidateGroup?.key ?? '')
        : (source?.sourceJobId ?? '')
    : viewingVersion
      ? wholeVersion.jobId
      : changed
        ? ''
        : version.jobId

  // ---------- 脚注 ----------

  const range =
    selection.length === 0
      ? undefined
      : {
          first: draft.findIndex((item) => item.id === selection[0]) + 1,
          last: draft.findIndex((item) => item.id === selection.at(-1)) + 1,
        }
  const shorter = (versionDuration ?? 0) - total
  const footnote = (() => {
    if (notice !== null) return notice
    if (editor === undefined) return ''
    if (viewingVersion) return `正在查看 ${wholeVersion.label}；点击「整片」可返回当前选用内容`
    if (submission !== undefined) return '正在提交，请等待提交完成后再离开'
    if (waitingComposite) return '正在合成，完成后将生成新版本；合成期间无法剪辑'
    if (!viewingClips) return '正在预览时间线当前选用内容；点击片段可查看和切换版本'
    if (range !== undefined) {
      const which = positions(range.first, range.last)
      const reason = blockReason
      if (reason !== undefined) return `选中${which}：${reason}`
      if (selection.length > 1) return `选中${which}：仅重做所选段的画面和原声，其余部分保持不变`
      const only = draft.find((item) => item.id === selection[0])
      const trimmable =
        only?.kind === 'clip' &&
        (['start', 'end'] as const).some((edge) => {
          const { min, max } = trimBounds(only, edge)
          return min < max
        })
      return trimmable
        ? `选中${which}：拖动两端可裁剪，按住中间拖动可调整顺序；如需 AI 重做，请在卡片中填写修改要求`
        : `选中${which}：已是最短，无法继续裁剪；按住中间拖动可调整顺序，如需 AI 重做，请在卡片中填写修改要求`
    }
    if (pendingItems.length > 0)
      return 'AI 生成中，关闭窗口不影响生成；其他段可继续剪辑，生成完成后可合成'
    if (changed) {
      const delta =
        Math.abs(shorter) >= 0.05
          ? `比 ${version.label} ${shorter > 0 ? '短' : '长'} ${seconds(Math.abs(shorter))} 秒；`
          : ''
      return `${delta}已保存各片段选择，点击「合成成片」按选用版本生成整片`
    }
    return '点击片段选中并播放，按住 Shift 可选择相邻片段；拖动两端可裁剪，按住中间可调序'
  })()

  // ---------- 渲染 ----------

  const toolButtons = (
    <>
      <span aria-hidden="true" className="video-editor-bar-divider" />
      <IconButton
        disabled={!editable || editor?.canUndo !== true}
        label="撤销"
        name="undo"
        onClick={() => editor?.undo()}
        size="sm"
      />
      <IconButton
        disabled={!editable || editor?.canRedo !== true}
        label="重做"
        name="redo"
        onClick={() => editor?.redo()}
        size="sm"
      />
      <span aria-hidden="true" className="video-editor-bar-divider" />
      <Button
        className="video-editor-bar-button video-editor-tool"
        disabled={!editable || !canSplitAt(draft, currentTime)}
        leadingIcon="split"
        onClick={() => apply(splitAt(draft, currentTime))}
        size="md"
        variant="ghost"
      >
        <span className="video-editor-tool-label">拆分</span>
      </Button>
      <Button
        className="video-editor-bar-button video-editor-tool"
        disabled={!editable || !canRemove(draft, selection)}
        leadingIcon="delete"
        onClick={() => apply(removeItems(draft, selection))}
        size="md"
        variant="ghost"
      >
        <span className="video-editor-tool-label">删除</span>
      </Button>
    </>
  )

  const readout = (
    <span className="video-editor-readout">
      共 <b>{seconds(previewDuration)}</b> 秒
      {!viewingVersion && changed && Math.abs(shorter) >= 0.05
        ? ` · 比 ${version.label} ${shorter > 0 ? '短' : '长'} ${seconds(Math.abs(shorter))} 秒`
        : null}
    </span>
  )

  /** 标题行的主按钮：草稿有改动时把它合成成片。 */
  const composeButton = changed ? (
    <Button
      className="video-editor-compose"
      disabled={!canCompose}
      leadingIcon="video"
      loading={submission?.kind === 'compose' || waitingComposite}
      onClick={() => void compose()}
      size="md"
      title={pendingItems.length > 0 ? 'AI 生成尚未完成，无法合成' : undefined}
    >
      {waitingComposite ? '合成中' : '合成成片'}
    </Button>
  ) : undefined

  /** 控制条最右的下载：下的是这一版本身，看着有改动的草稿时灰着。 */
  const downloadButton = (
    <Button
      className="video-editor-bar-button"
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
    <p className="video-editor-timeline-loading" role="alert">
      {errorMessageOf(timelineKeyframes.error, '该视频的关键帧读取失败')}
      <Button onClick={() => void timelineKeyframes.refetch()} size="md" variant="ghost">
        重试
      </Button>
    </p>
  ) : editor === undefined || timelineKeyframes.data === undefined ? (
    <p className="video-editor-timeline-loading" role="status">
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

  // ---------- AI 改段的弹出卡 ----------

  const selectedClips = selection.flatMap((id) => {
    const item = draft.find((candidate) => candidate.id === id)
    return item?.kind === 'clip' ? [item] : []
  })
  const frameOf = (
    clip: DraftClip | undefined,
    at: (clip: DraftClip) => number,
    width = CARD_FRAME_WIDTH,
  ) => {
    const url = clip === undefined ? undefined : urlOf(clip.sourceJobId)
    return clip === undefined || url === undefined
      ? undefined
      : videoSnapshotUrl(url, width, at(clip))
  }
  const cardDetail =
    blockReason ??
    (target === undefined
      ? undefined
      : `${seconds(target.range.start)} – ${seconds(target.range.end)} 秒 · ${mode === 'image' ? '根据引用图片生成新版本' : '视频和原声一起重做'}`)
  const card =
    range === undefined || cardDetail === undefined ? null : (
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
        composerRef={requestComposerRef}
        canGenerate={canGenerate && model !== undefined && !busy}
        detail={cardDetail}
        draft={request}
        frames={{
          first: frameOf(selectedClips[0], (clip) => clip.start),
          last: frameOf(selectedClips.at(-1), (clip) =>
            Math.max(clip.start, clip.end - LAST_FRAME_LEAD),
          ),
        }}
        generating={submission?.kind === 'edit'}
        referenceLimit={Math.min(
          MAX_EDIT_REFERENCES,
          model?.maxReferenceImages ?? MAX_EDIT_REFERENCES,
        )}
        mode={mode}
        onModeChange={(next) => {
          if (busy) return
          setMode(next)
          setGenerateError(null)
        }}
        firstFrameReferenceUrl={frameOf(selectedClips[0], (clip) => clip.start, 1280)}
        durationControl={
          mode === 'image' && model !== undefined ? (
            <div className="video-editor-duration">
              <Slider.Root
                className="video-editor-duration-slider"
                disabled={busy}
                min={model.image.minSeconds}
                max={model.image.maxSeconds}
                step={1}
                value={[imageSeconds]}
                onValueChange={([value]) => {
                  if (value !== undefined) setWantedSeconds(value)
                }}
              >
                <Slider.Track className="video-editor-duration-track">
                  <Slider.Range className="video-editor-duration-range" />
                </Slider.Track>
                <Slider.Thumb
                  aria-label="生成时长（秒）"
                  aria-valuetext={`${imageSeconds} 秒`}
                  className="video-editor-duration-thumb ui-focus"
                />
              </Slider.Root>
              <output aria-label="当前生成时长" className="video-editor-duration-value">
                {imageSeconds}
                <span>秒</span>
              </output>
            </div>
          ) : null
        }
        modelPicker={
          <GenerationPicker
            className="video-editor-model-picker"
            disabled={busy || models.length === 0}
            label={mode === 'edit' ? '编辑模型' : '图生模型'}
            leading={<Icon decorative name="video" size="sm" />}
            onChange={(value) => {
              setWantedModel(value)
              setGenerateError(null)
            }}
            options={models.map(({ id }) => ({ value: id }))}
            text={model?.id ?? '暂无可用的视频模型'}
            value={model?.id ?? ''}
          />
        }
        onCollapse={collapseCard}
        onDraftChange={(parts) => {
          setRequest(parts)
          setGenerateError(null)
          setDroppedUploads(0)
        }}
        onExpand={() => setCardOpen(true)}
        onGenerate={(submission) => void generate(submission)}
        onUploadsDropped={setDroppedUploads}
        open={cardOpen}
        positions={positions(range.first, range.last)}
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
        className="video-editor-dialog"
        onEscapeKeyDown={(event) => {
          // 卡展开着时 Escape 先把它收起，再按一次才关编辑器。
          if (card === null || !cardOpen) return
          event.preventDefault()
          collapseCard()
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
              {shotIndex === undefined ? null : (
                <span className="text-body-sm font-normal text-on-surface-muted">
                  镜头组 {shotIndex}
                </span>
              )}
            </span>
          }
        />
        <div aria-label="视频编辑器" className="video-editor">
          <EditorPreview
            backdrop={{
              current: posterOf(current?.[0]?.mediaUrl ?? version.mediaUrl),
              original: posterOf(version.mediaUrl),
            }}
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
                <p className="video-editor-footnote" role={notice === null ? undefined : 'status'}>
                  {footnote}
                </p>
              </>
            }
            onPlay={collapseCard}
            onTime={setCurrentTime}
            original={undefined}
            playbackRequest={viewingClips ? playbackRequest : undefined}
            viewControl={
              <div aria-label="视频预览范围" className="video-editor-compare" role="group">
                <button
                  aria-pressed={!viewingClips}
                  disabled={busy}
                  onClick={() => chooseScope('whole')}
                  type="button"
                >
                  整片
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
                  onAppend={(text) => {
                    const parts = [
                      { kind: 'text' as const, text: `${request.length > 0 ? '\n' : ''}${text}` },
                    ]
                    if (cardOpen) requestComposerRef.current?.append(parts)
                    else {
                      setRequest([...request, ...parts])
                      setCardOpen(true)
                    }
                  }}
                  root={root}
                  shotIndex={shotIndex}
                />
              </>
            }
            poster={posterOf(current?.[0]?.mediaUrl ?? version.mediaUrl)}
            readout={readout}
            ref={previewRef}
            timeline={timeline}
            tools={toolButtons}
            versions={
              <EditorVersionStrip
                entries={stripEntries}
                onSelect={pick}
                selectedKey={selectedKey}
                title={
                  viewingClips && range !== undefined ? positions(range.first, range.last) : '整片'
                }
                showSingle
              />
            }
          />
        </div>
      </DialogSurface>
    </DialogRoot>
  )
}
