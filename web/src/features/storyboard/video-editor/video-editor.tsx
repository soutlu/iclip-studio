/** 视频编辑器：在一版成片上剪（裁剪、调序、拆分、删除），选几段交给 AI 改，满意再合成成新的一版。
 *
 * 版本、编辑段与合成都从服务端记录推出来，关掉重开、刷新都还在；剪辑草稿只存在浏览器
 * （ADR-0010）。参考片段在提交时从基底上切好、上传，拼接在服务端。 */

import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { useMediaDownload } from '@/shared/api/media-download'
import { Icon } from '@/shared/icons'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { Button, IconButton } from '@/shared/ui/button'
import { DialogBody, DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { toast } from '@/shared/ui/toast'
import { useUnseenResults } from '../components/use-unseen-results'
import { isRunningStatus } from '../shots'
import { useVideoModels, type GenerationJob } from '../storyboard.api'
import {
  aiTarget,
  canRemove,
  canSplitAt,
  compositeSegments,
  draftDuration,
  isBaseSegment,
  keyframeSegments,
  layoutDraft,
  moveItems,
  removeItems,
  splitAt,
  trimBounds,
  trimClip,
  type AiTarget,
  type DraftItem,
  type Edit,
  type EditOutcome,
} from './draft'
import { composingOf, editsOf, projectVersions, type ChainVersion } from './edit-chain'
import { EditorComposer, type EditorReference } from './editor-composer'
import { EditorModelMenu } from './editor-model-menu'
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
              {loading ? '正在读取视频记录…' : '找不到这条视频记录，关掉后从成片区重新打开。'}
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

/** 右栏那一行：AI 要改哪几段，或为什么还不能改。 */
const targetLine = (target: AiTarget): string => {
  switch (target.kind) {
    case 'ready':
      return `AI 改${positions(target.first, target.last)} · ${seconds(target.range.start)} – ${seconds(target.range.end)} 秒`
    case 'empty':
      return '先在时间线上点选要改的段'
    case 'modified':
      return '裁过、拆过的段要先合成，再让 AI 改'
    case 'short':
      return '这段太短，连上相邻的段再改'
  }
}

function Editor({ conversationId, root, mediaUrl, shotIndex, onClose }: EditorProps) {
  const queryClient = useQueryClient()
  const chainQuery = useVideoEditChain(conversationId, root.id)
  const modelsQuery = useVideoModels()
  const models = useMemo(() => editableModels(modelsQuery.data?.items ?? []), [modelsQuery.data])
  const chainJobs = chainQuery.data?.items
  const jobs = useMemo(() => chainJobs ?? [], [chainJobs])
  const versions = useMemo(() => projectVersions(root, jobs), [root, jobs])
  const previewRef = useRef<EditorPreviewHandle>(null)
  const [picked, setPicked] = useState<Picked>()
  const [currentTime, setCurrentTime] = useState(0)
  const [prompt, setPrompt] = useState('')
  const [references, setReferences] = useState<EditorReference[]>([])
  const [wantedModel, setWantedModel] = useState<string>()
  // 两次互斥的提交加上传参考图；任一在跑时整个编辑器一起锁。
  const [operation, setOperation] = useState<'idle' | 'uploading' | 'generating' | 'composing'>(
    'idle',
  )
  const [operationError, setOperationError] = useState<string | null>(null)
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
      return { kind: 'failed', message: edit.errorMessage ?? '没有生成结果' }
    const duration = durations[edit.outputUrl]
    if (duration === null) return { kind: 'failed', message: '读不出结果的时长' }
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
  const selection = editable ? (editor?.selection ?? []) : []
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
    editor === undefined || !editable
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

  const generate = async () => {
    if (busy || editor === undefined || target.kind !== 'ready') return
    const text = prompt.trim()
    if (text === '') {
      setOperationError('先写下想怎么改')
      return
    }
    if (model === undefined) {
      setOperationError('没有可用的编辑模型')
      return
    }
    // 「生成中」的锁覆盖切参考片段、上传与提交三步，任一步失败都照 operationError 显示。
    setOperation('generating')
    setOperationError(null)
    setNotice(null)
    try {
      const job = await submitVideoEdit({
        conversationId,
        taskId: root.taskId,
        sourceJobId: version.jobId,
        baseMediaUrl: version.mediaUrl,
        range: target.range,
        model,
        prompt: text,
        referenceImageUrls: references.map((reference) => reference.url),
      })
      seedJob(job)
      editor.submitted(job.id)
    } catch (error) {
      setOperationError(errorMessageOf(error, '视频编辑提交失败'))
    } finally {
      setOperation('idle')
    }
  }

  const segmentsToCompose = compositeSegments(draft)
  const canCompose = changed && segmentsToCompose !== undefined && !waitingComposite && !busy
  const compose = async () => {
    if (!canCompose || editor === undefined || segmentsToCompose === undefined) return
    setOperation('composing')
    setOperationError(null)
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
      toast.success('已提交合成，完成后会成为新版本')
    } catch (error) {
      setOperationError(errorMessageOf(error, '合成任务提交失败'))
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
      return `正在看 ${version.label} 本身；点「${UNCOMPOSED_LABEL}」回到草稿接着剪`
    if (waitingComposite) return '正在合成，完成后成为新的一版；合成期间先不能剪'
    if (operation === 'generating') return '正在切参考片段、交给 AI…'
    if (range !== undefined) {
      const which = positions(range.first, range.last)
      if (target.kind === 'modified' || target.kind === 'short')
        return `选中${which}：${targetLine(target)}`
      if (selection.length > 1)
        return `选中${which}：AI 只重做选中的段，原声跟着一起重做；其余画面保持不变`
      const only = draft.find((item) => item.id === selection[0])
      const trimmable =
        only?.kind === 'clip' &&
        (['start', 'end'] as const).some((edge) => {
          const { min, max } = trimBounds(only, edge)
          return min < max
        })
      return trimmable
        ? `选中${which}：拖两端裁短，按住中间拖动调顺序；要 AI 重做就在右边写要求`
        : `选中${which}：这段已经最短，裁不动；按住中间拖动调顺序，要 AI 重做就在右边写要求`
    }
    if (pendingItems.length > 0)
      return 'AI 正在改，关掉窗口也会继续；其他段照样能剪，等 AI 生成完再合成'
    if (changed) {
      const delta =
        Math.abs(shorter) >= 0.05
          ? `比 ${version.label} ${shorter > 0 ? '短' : '长'} ${seconds(Math.abs(shorter))} 秒；`
          : ''
      return `${delta}剪辑还没合成，满意就点右上角「合成成片」`
    }
    return '点一段选中，再点相邻的段连着选；拖两端裁剪，按住中间拖动调顺序'
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
      title={pendingItems.length > 0 ? '等 AI 生成完再合成' : undefined}
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
      {errorMessageOf(keyframes.error, '读不出这条视频的关键帧')}
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
      onMove={(ids, before) => apply(moveItems(draft, ids, before))}
      onSeek={(time) => previewRef.current?.previewAt(time)}
      onSelect={(next) => editor.select(next)}
      onTrim={(id, edge, value) => apply(trimClip(draft, id, edge, value))}
      onTrimPreview={(clock, edge) => previewRef.current?.previewAt(clock, edge)}
      peaksOf={(url) => peaks.get(url) ?? LOADING_PEAKS}
      scale={scale}
      selection={selection}
      total={total}
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
              <p className="video-editor-footnote" role={notice === null ? undefined : 'status'}>
                {footnote}
              </p>
            }
            onTime={setCurrentTime}
            original={original}
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
          <section aria-label="AI 改段" className="video-editor-inspector">
            <p className="video-editor-target">
              <Icon decorative name="duration" size="sm" />
              <span>{targetLine(target)}</span>
            </p>
            <EditorComposer
              disabled={busy}
              footer={
                <div className="video-editor-generation-controls">
                  <EditorModelMenu
                    disabled={busy}
                    model={model}
                    models={models}
                    onChange={setWantedModel}
                  />
                  <Button
                    className="video-editor-generate"
                    disabled={!editable || target.kind !== 'ready' || model === undefined}
                    loading={operation === 'generating'}
                    onClick={() => void generate()}
                    trailingIcon="send-up"
                  >
                    生成
                  </Button>
                </div>
              }
              onBusyChange={(uploading) => setOperation(uploading ? 'uploading' : 'idle')}
              onPromptChange={(value) => {
                setPrompt(value)
                setOperationError(null)
              }}
              onReferencesChange={setReferences}
              prompt={prompt}
              references={references}
            />
            <EditorNotices
              chainError={
                chainQuery.isError
                  ? errorMessageOf(chainQuery.error, '读取编辑记录失败')
                  : undefined
              }
              modelsError={
                modelsQuery.isError
                  ? errorMessageOf(modelsQuery.error, '读取视频模型失败')
                  : undefined
              }
              onReloadChain={() => void chainQuery.refetch()}
              onReloadModels={() => void modelsQuery.refetch()}
              operationError={operationError}
              peaksError={
                peaksFailure?.kind === 'failed'
                  ? errorMessageOf(peaksFailure.error, '原声读不出来')
                  : undefined
              }
            />
          </section>
        </div>
      </DialogSurface>
    </DialogRoot>
  )
}
