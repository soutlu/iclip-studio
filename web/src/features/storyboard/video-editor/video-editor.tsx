/** 视频编辑器：在一版成片上剪（裁剪、调序、拆分、删除），选几段交给 AI 改，满意再合成成新的一版。
 *
 * 版本、编辑段与合成都从服务端记录推出来，关掉重开、刷新都还在；剪辑草稿只存在浏览器。
 * 参考片段在提交时从基底上切好、上传，拼接在服务端。
 *
 * AI 改段的要求写在选中段时弹出的卡里。卡里没提交的要求只有一份，跟着当前选区走：换了选区不清空，
 * 提交成功才清空。 */

import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
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
import { useUnseenResults } from '../components/use-unseen-results'
import { compileReferencePrompt, draftPartsOf } from '../edit-prompt'
import { isRunningStatus } from '../shots'
import { useVideoModels, type GenerationJob } from '../storyboard.api'
import { AiEditCard } from './ai-edit-card'
import {
  aiTarget,
  canRemove,
  canSplitAt,
  clickSelect,
  compositeSegments,
  draftDuration,
  isBaseSegment,
  keyframeSegments,
  layoutDraft,
  MIN_RANGE_SECONDS,
  moveItems,
  removeItems,
  splitAt,
  trimBounds,
  trimClip,
  type AiTarget,
  type DraftClip,
  type DraftItem,
  type Edit,
  type EditOutcome,
} from './draft'
import { composingOf, editsOf, projectVersions, type ChainVersion } from './edit-chain'
import { EditorNotices } from './editor-notices'
import { EditorPreview, type EditorPreviewHandle } from './editor-preview'
import { EditorTimeline, type TimelineEntry } from './editor-timeline'
import { EditorVersionStrip, type VersionStripEntry } from './editor-version-strip'
import { layoutPlay, type PlaySegment } from './play-layout'
import { useEditDraft } from './use-edit-draft'
import { useAudioPeaks, useKeyframes, type PeaksState } from './use-media-analysis'
import { useMediaDurations } from './use-media-durations'
import { useStableValue } from './use-stable-value'
import {
  editableModels,
  pickEditModel,
  seedVideoEditJob,
  submitVideoComposite,
  submitVideoEdit,
  useVideoEditChain,
} from './video-editor.api'

/** 当前这一版的草稿与它不同时，版本条上多出来的那一格。 */
const UNCOMPOSED_LABEL = '未合成'
const DRAFT_KEY = 'draft'
const posterOf = (url: string) => videoSnapshotUrl(url, 320)
const LOADING_PEAKS: PeaksState = { kind: 'loading' }
const seconds = (value: number) => value.toFixed(1)

/** 看哪一版、看它的草稿还是它本身。只有草稿有改动时两者才不同。 */
type Picked = { jobId: string; view: 'draft' | 'version' }

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

/** 选区为什么还不能交给 AI；卡头与脚注都用它。能交给 AI 或没有选区时没有原因。 */
const blockedReason = (target: AiTarget): string | undefined => {
  switch (target.kind) {
    case 'modified':
      return '含已剪辑的段，无法生成视频；请先点击「合成成片」'
    case 'short':
      return `时长不足 ${MIN_RANGE_SECONDS} 秒，无法生成视频；请点击相邻的段一并选中`
    case 'ready':
    case 'empty':
      return undefined
  }
}

/** 卡头的末帧取段尾之前这么多秒：段尾正好是下一段的开头，截在那一刻可能截到下一段。 */
const LAST_FRAME_LEAD = 0.1
/** 卡头截图的宽：显示 30px，按两倍像素取。 */
const CARD_FRAME_WIDTH = 60

function Editor({ conversationId, root, mediaUrl, shotIndex, onClose }: EditorProps) {
  const queryClient = useQueryClient()
  const chainQuery = useVideoEditChain(conversationId, root.id)
  const modelsQuery = useVideoModels()
  const models = useMemo(() => editableModels(modelsQuery.data?.items ?? []), [modelsQuery.data])
  const chainJobs = chainQuery.data?.items
  const jobs = useMemo(() => chainJobs ?? [], [chainJobs])
  const versions = useMemo(() => projectVersions(root, jobs), [root, jobs])
  const previewRef = useRef<EditorPreviewHandle>(null)
  const selectionBoxRef = useRef<HTMLSpanElement>(null)
  const [picked, setPicked] = useState<Picked>()
  const [currentTime, setCurrentTime] = useState(0)
  /** 卡里没提交的要求：文字与传好的参考图。 */
  const [request, setRequest] = useState<readonly ComposerPart[]>([])
  /** 上次收起卡时有几张参考图还没传好、没留下；下次改要求时收起这句提示。 */
  const [droppedUploads, setDroppedUploads] = useState(0)
  /** 卡展开着；一拖、一播、按 Escape 就收成胶囊。 */
  const [cardOpen, setCardOpen] = useState(true)
  const [wantedModel, setWantedModel] = useState<string>()
  // 两次互斥的提交；任一在跑时整个编辑器一起锁。
  const [operation, setOperation] = useState<'idle' | 'generating' | 'composing'>('idle')
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [composeError, setComposeError] = useState<string | null>(null)
  /** 脚注位置上要让人看到的一句话，下一次剪辑时收起。 */
  const [notice, setNotice] = useState<string | null>(null)
  const { downloading, download } = useMediaDownload()
  const busy = operation !== 'idle'
  const model = pickEditModel(models, wantedModel, modelsQuery.data?.default)

  const version: ChainVersion = versions.find((item) => item.jobId === picked?.jobId) ??
    versions.at(-1) ?? { jobId: root.id, label: 'V1', mediaUrl, sourceJobId: undefined }
  const keyframes = useKeyframes(version.mediaUrl)
  const segments = useMemo(
    () =>
      keyframes.data === undefined ? undefined : keyframeSegments(version.jobId, keyframes.data),
    [keyframes.data, version.jobId],
  )
  const versionDuration = keyframes.data?.duration
  const edits = useMemo(() => editsOf(jobs, version.jobId), [jobs, version.jobId])
  const composingJob = composingOf(jobs, version.jobId)

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
    segments,
    jobs: chainJobs,
    edits,
    outcomeOf,
    onNotice: setNotice,
    onComposed: (jobId) => setPicked({ jobId, view: 'draft' }),
  })
  const changed = editor?.changed ?? false
  const viewingDraft = !changed || picked?.view !== 'version'
  const waitingComposite = composingJob !== undefined || editor?.composite !== undefined
  const editable = editor !== undefined && viewingDraft && !waitingComposite && !busy
  const draft = editor?.draft ?? []
  // 提交 AI 改的那一会儿时间线锁着，选中照旧显示，卡也留着转圈；合成时不显示。
  const selection =
    editor !== undefined && viewingDraft && !waitingComposite && operation !== 'composing'
      ? editor.selection
      : []
  const pendingItems = draft.filter((item) => item.kind === 'pending')

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
  const versionPlay =
    versionDuration === undefined
      ? undefined
      : layoutPlay([{ mediaUrl: version.mediaUrl, start: 0, end: versionDuration }])
  const draftPlay = editor === undefined ? undefined : layoutPlay(draft.flatMap(partsOf))
  // 轮询每次都重建对象，段列表按内容稳定住，播放器才不会被无谓地重装。
  const current = useStableValue(viewingDraft ? draftPlay : versionPlay)
  const original = useStableValue(viewingDraft && changed ? versionPlay : undefined)
  const total = viewingDraft && editor !== undefined ? draftDuration(draft) : (versionDuration ?? 0)
  const scale = Math.max(versionDuration ?? 0, total)

  // ---------- 时间线 ----------

  const shownItems: readonly DraftItem[] = viewingDraft ? draft : (segments ?? [])
  const entries: TimelineEntry[] = layoutDraft(shownItems).map(({ item, at, duration }) => ({
    id: item.id,
    at,
    duration,
    parts: partsOf(item),
    clip: item.kind === 'clip' ? item : undefined,
    changed: segments !== undefined && !isBaseSegment(item, segments),
    runningSince:
      item.kind === 'pending'
        ? edits.find((edit) => edit.id === item.editJobId)?.createdAt
        : undefined,
  }))
  const audioUrls = useStableValue([
    ...new Set(entries.flatMap((entry) => entry.parts.map((part) => part.mediaUrl))),
  ])
  const peaks = useAudioPeaks(audioUrls)
  const peaksFailure = [...peaks.values()].find((state) => state.kind === 'failed')

  const target: AiTarget =
    editor === undefined
      ? { kind: 'empty' }
      : aiTarget(
          draft,
          selection,
          editor.segments,
          edits.map((edit) => ({
            id: edit.id,
            rangeStartMs: edit.rangeStartMs,
            rangeEndMs: edit.rangeEndMs,
            duration: resultDuration(edit),
          })),
        )

  // 版本条上「未合成」那格的小绿点：本次打开期间见过它在生成、结果回来时没在看草稿、之后也还没看。
  const completedEdits = edits.filter((edit) => edit.status === 'completed')
  const unseen = useUnseenResults(
    edits.filter((edit) => isRunningStatus(edit.status)).map((edit) => edit.id),
    viewingDraft && changed ? completedEdits.at(-1)?.id : undefined,
  )
  const freshResult = !viewingDraft && completedEdits.some((edit) => unseen.isUnseen(edit.id))

  // ---------- 操作 ----------

  const seedJob = (job: GenerationJob) =>
    seedVideoEditJob(queryClient, conversationId, root.id, job)

  const apply = (edit: Edit | undefined) => {
    if (edit === undefined || editor === undefined || !editable) return
    editor.apply(edit)
    setPicked({ jobId: version.jobId, view: 'draft' })
    setNotice(null)
  }

  const pick = (key: string) => {
    if (busy) return
    setNotice(null)
    setPicked(
      key === DRAFT_KEY ? { jobId: version.jobId, view: 'draft' } : { jobId: key, view: 'version' },
    )
  }

  // 没有选区时没有卡；下次选中时卡展开着出来。
  if (selection.length === 0 && !cardOpen) setCardOpen(true)

  /** 点了时间线上的一段：卡收着时点的是选区里的段，只把卡展开、不改选中（不然点单选的那段会把它取消）；
   * 别的照点选规则改选中，卡展开。 */
  const clickSegment = (id: string) => {
    if (editor === undefined || !editable) return
    if (!cardOpen && selection.includes(id)) {
      setCardOpen(true)
      return
    }
    editor.select(clickSelect(draft, selection, id))
    setCardOpen(true)
  }
  const collapseCard = () => setCardOpen(false)

  /** 卡里点「生成视频」：要求里的参考图按出现的先后排成 `reference_image_urls`，正文里写 `@ImageN`。 */
  const generate = async (submission: ComposerSubmission) => {
    if (busy || editor === undefined || target.kind !== 'ready') return
    if (submission.text.trim() === '') {
      setGenerateError('请填写修改要求')
      return
    }
    if (model === undefined) {
      setGenerateError('暂无可用的编辑模型')
      return
    }
    const { text, referenceImageUrls } = compileReferencePrompt(draftPartsOf(submission.parts))
    // 「生成中」的锁覆盖切参考片段、上传与提交三步，任一步失败都照 generateError 显示。
    setOperation('generating')
    setGenerateError(null)
    setNotice(null)
    try {
      const job = await submitVideoEdit({
        conversationId,
        taskId: root.taskId,
        sourceJobId: version.jobId,
        baseMediaUrl: version.mediaUrl,
        range: target.range,
        model,
        prompt: text.trim(),
        referenceImageUrls,
      })
      seedJob(job)
      // 选中的段换成占位，选区没了，卡随之收走；要求清空。
      editor.submitted(job.id)
      setRequest([])
      setDroppedUploads(0)
    } catch (error) {
      setGenerateError(errorMessageOf(error, '视频编辑提交失败'))
    } finally {
      setOperation('idle')
    }
  }

  const segmentsToCompose = compositeSegments(draft)
  const canCompose = changed && segmentsToCompose !== undefined && !waitingComposite && !busy
  const compose = async () => {
    if (!canCompose || editor === undefined || segmentsToCompose === undefined) return
    setOperation('composing')
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
      setOperation('idle')
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

  const stripEntries: VersionStripEntry[] = [...versions].reverse().flatMap((item) => {
    const own: VersionStripEntry = {
      key: item.jobId,
      label: item.label,
      name: item.label,
      poster: posterOf(item.mediaUrl),
      running: undefined,
      unseen: false,
    }
    if (item.jobId !== version.jobId || !changed) return [own]
    const draftEntry: VersionStripEntry = {
      key: DRAFT_KEY,
      label: UNCOMPOSED_LABEL,
      name: [
        UNCOMPOSED_LABEL,
        waitingComposite ? '合成中' : undefined,
        freshResult ? '新结果' : undefined,
      ]
        .filter((part) => part !== undefined)
        .join(' · '),
      poster: posterOf(item.mediaUrl),
      running: composingJob === undefined ? undefined : { since: composingJob.createdAt },
      unseen: freshResult,
    }
    return [draftEntry, own]
  })
  const selectedKey = changed && viewingDraft ? DRAFT_KEY : version.jobId

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
    if (!viewingDraft)
      return `正在查看 ${version.label} 原片；点击「${UNCOMPOSED_LABEL}」可返回草稿继续剪辑`
    if (waitingComposite) return '正在合成，完成后将生成新版本；合成期间无法剪辑'
    if (operation === 'generating') return '正在截取参考片段并提交给 AI…'
    if (range !== undefined) {
      const which = positions(range.first, range.last)
      const reason = blockedReason(target)
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
      return `${delta}剪辑尚未合成，确认后请点击右上角「合成成片」`
    }
    return '点击一段即可选中，再点击相邻的段可连续选中；拖动两端可裁剪，按住中间拖动可调整顺序'
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
      共 <b>{seconds(total)}</b> 秒
      {viewingDraft && changed && Math.abs(shorter) >= 0.05
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
      loading={operation === 'composing' || waitingComposite}
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
      disabled={viewingDraft && changed}
      leadingIcon="download"
      loading={downloading}
      onClick={() => void download(version.mediaUrl, '生成的视频')}
      size="md"
      variant="ghost"
    >
      下载
    </Button>
  )

  const timeline = keyframes.isError ? (
    <p className="video-editor-timeline-loading" role="alert">
      {errorMessageOf(keyframes.error, '该视频的关键帧读取失败')}
      <Button onClick={() => void keyframes.refetch()} size="md" variant="ghost">
        重试
      </Button>
    </p>
  ) : editor === undefined || versionDuration === undefined ? (
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
      onSelect={(next) => editor.select(next)}
      onTrim={(id, edge, value) => apply(trimClip(draft, id, edge, value))}
      onTrimPreview={(clock, edge) => previewRef.current?.previewAt(clock, edge)}
      peaksOf={(url) => peaks.get(url) ?? LOADING_PEAKS}
      scale={scale}
      selection={selection}
      selectionBoxRef={selectionBoxRef}
      total={total}
    />
  )

  // ---------- AI 改段的弹出卡 ----------

  const selectedClips = selection.flatMap((id) => {
    const item = draft.find((candidate) => candidate.id === id)
    return item?.kind === 'clip' ? [item] : []
  })
  const frameOf = (clip: DraftClip | undefined, at: (clip: DraftClip) => number) => {
    const url = clip === undefined ? undefined : urlOf(clip.sourceJobId)
    return clip === undefined || url === undefined
      ? undefined
      : videoSnapshotUrl(url, CARD_FRAME_WIDTH, at(clip))
  }
  const cardDetail =
    target.kind === 'ready'
      ? `${seconds(target.range.start)} – ${seconds(target.range.end)} 秒 · 视频和原声一起重做`
      : blockedReason(target)
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
        canGenerate={target.kind === 'ready' && model !== undefined && !busy}
        detail={cardDetail}
        draft={request}
        frames={{
          first: frameOf(selectedClips[0], (clip) => clip.start),
          last: frameOf(selectedClips.at(-1), (clip) =>
            Math.max(clip.start, clip.end - LAST_FRAME_LEAD),
          ),
        }}
        generating={operation === 'generating'}
        modelPicker={
          <GenerationPicker
            className="video-editor-model-picker"
            disabled={busy || models.length === 0}
            label="编辑模型"
            leading={<Icon decorative name="video" size="sm" />}
            onChange={setWantedModel}
            options={models.map((value) => ({ value }))}
            text={model ?? '暂无可用的编辑模型'}
            value={model ?? ''}
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
        if (busy) toast.info('请等待提交完成')
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
            contentKey={`${version.jobId}:${viewingDraft ? 'draft' : 'version'}`}
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
            original={original}
            overlay={card}
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
              />
            }
          />
        </div>
      </DialogSurface>
    </DialogRoot>
  )
}
