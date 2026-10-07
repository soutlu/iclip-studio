import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { uploadMediaFile } from '@/shared/api/media-upload'
import { IconButton } from '@/shared/ui/button'
import { DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { toast } from '@/shared/ui/toast'
import { useUnseenResults } from '../components/use-unseen-results'
import { AnnotationCanvas } from './annotation-canvas'
import { exportAnnotatedImage } from './annotation-export'
import { EditComposer, type EditComposerHandle } from './edit-composer'
import { EditGenerationSettings } from './edit-generation-settings'
import { CURRENT_KEY, entryBaseUrl, frameImageEntries } from './edit-history'
import { editorWordsOf } from './edit-target'
import { EditStage, StillStage } from './edit-stage'
import { draftOf, editDraftError } from './image-edit-draft'
import {
  compileEditRequest,
  readSubmittedImages,
  readSubmittedPrompt,
  referencesAnnotation,
  resolveImageOptions,
  restoreEditParts,
  seedImageEditJob,
  submitImageEdit,
  useImageEditJobs,
  useImageModels,
  type ImageChannel,
  type ImageResolution,
} from './image-edit.api'
import type { EditDraftPart, EditFrame, FrameEditTarget } from './image-edit-types'
import { useFrameEditDrafts } from './use-frame-edit-drafts'
import { useFrameReplace } from './use-frame-replace'
import { VersionStrip } from './version-strip'
import './image-edit.css'

type FrameImageEditorProps = {
  target: FrameEditTarget
  /** 这张图此刻在用的那一版；已经不在分镜里时为 undefined，在分镜里但没有在用的（制作页没选用的生成图）为 null。
   * 随替换实时变，不记打开那一刻的。 */
  currentUrl: string | null | undefined
  /** 标题「编辑图片」后面的一句：分镜页写组与帧，制作页写图的名字。 */
  subtitle: string
  /** 输入卡里 `@` 与「+」能插的本组图片，下标加一是编号。 */
  frames: readonly EditFrame[]
  aspectRatio: string
  /** 打开时先选中哪一条；从帧上「有新结果」进来时是那条任务。 */
  initialKey?: string | undefined
  /** `opened` 是本次真正点开看过（看时已落定）的任务 id，只有它们可以标成看过。 */
  onClose: (opened: ReadonlySet<string>) => void
  /** 把这一帧从 `previousUrl` 换成 `url`；替换与撤销都走它，这一帧已不是 `previousUrl` 时应当拒绝。
   * null 只出现在 `currentUrl` 可以为 null 的地方：从没有在用的图第一次选用，或撤销回没有在用的图。 */
  onApply: (previousUrl: string | null, url: string | null) => Promise<void>
  /** 按描述再生成（制作页的生成图才有）：`parts` 是这张图的描述，参考图是图片；`submit` 收输入卡里的样子，
   * 失败时抛出给人看的原因。新的出来进版本条，选用才用上。 */
  regenerate?:
    | {
        parts: readonly EditDraftPart[]
        submit: (parts: EditDraftPart[]) => Promise<void>
      }
    | undefined
}

/** 版本条末尾「再生成」那一格的选中键；任务号与地址都不会是它。 */
const REGENERATE_KEY = 'regenerate'

/** 编辑图片窗口：装配舞台、版本条与输入卡，持有选中条目、选中标注与生成偏好。 */
export function FrameImageEditor({
  target,
  currentUrl,
  subtitle,
  frames,
  aspectRatio,
  initialKey,
  onClose,
  onApply,
  regenerate,
}: FrameImageEditorProps) {
  const queryClient = useQueryClient()
  const drafts = useFrameEditDrafts(target)
  // 只随用户点版本条而变：提交新任务、任务落定都不挪舞台。
  const [selectedKey, setSelectedKey] = useState(initialKey ?? CURRENT_KEY)
  const [selectedAnnotation, setSelectedAnnotation] = useState<string | null>(null)
  const [wantedModel, setWantedModel] = useState<string>()
  const [wantedChannel, setWantedChannel] = useState<ImageChannel>('dev')
  const [wantedResolution, setWantedResolution] = useState<ImageResolution>('2k')
  const [operationError, setOperationError] = useState<string | null>(null)
  // 从外部整份换掉草稿时加一：画布与输入卡换 key 重挂，撤销栈随之清空、输入卡装回新草稿。
  const [draftRevision, setDraftRevision] = useState(0)
  const composerRef = useRef<EditComposerHandle>(null)
  // 再生成时输入卡里的描述：开着编辑器时留着改过的样子，关掉再开回到文件里的。
  const [regenerateParts, setRegenerateParts] = useState(regenerate?.parts ?? [])
  const regenerating = regenerate !== undefined && selectedKey === REGENERATE_KEY
  const modelsQuery = useImageModels()
  const models = modelsQuery.data?.items ?? []
  const options = resolveImageOptions(models, aspectRatio, {
    model: wantedModel ?? modelsQuery.data?.default,
    channel: wantedChannel,
    resolution: wantedResolution,
  })
  const { model, resolution, channel, aspectUnsupported } = options
  const jobsQuery = useImageEditJobs(target)
  const jobs = useMemo(
    () => jobsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [jobsQuery.data],
  )
  const words = editorWordsOf(target)
  const frameReplace = useFrameReplace({ currentUrl, onApply })
  // 图已经不在分镜里时舞台只说这一句，当前帧那一格空着。
  const entries = useMemo(
    () => frameImageEntries(jobs, currentUrl === undefined ? '' : currentUrl),
    [jobs, currentUrl],
  )
  // 选中的那条被折进当前帧格（刚替换过）或还没拉回来时，落回当前帧；撤销后它回到条里，舞台随之回到对比。
  const selected = entries.find((entry) => entry.key === selectedKey) ?? entries[0]
  const unseen = useUnseenResults(
    entries.flatMap((entry) => (entry.kind === 'pending' ? [entry.job.id] : [])),
    (selected?.kind === 'image' || selected?.kind === 'failed') && selected.job !== null
      ? selected.job.id
      : undefined,
  )
  const baseUrl = selected === undefined ? '' : entryBaseUrl(selected, currentUrl ?? '')
  const draft = useMemo(() => draftOf(drafts.drafts, baseUrl), [drafts.drafts, baseUrl])
  const inFlight = entries.filter((entry) => entry.kind === 'pending').length
  const footnote =
    inFlight > 0
      ? `有 ${inFlight} 个任务在生成或排队，关掉窗口也会继续`
      : regenerating
        ? '新的出来后在版本里，选用才用上'
        : selected?.kind === 'image'
          ? words.replaceNote
          : words.aspectNote(aspectRatio)

  const select = (key: string) => {
    setSelectedKey(key)
    setSelectedAnnotation(null)
    setOperationError(null)
    // 翻看版本条时正好看见了当前帧那一格。
    frameReplace.acknowledge()
  }
  const submit = async (parts: EditDraftPart[]) => {
    const { annotations } = draft
    const problem = editDraftError({ annotations, parts }, baseUrl)
    if (problem !== null) {
      setOperationError(problem)
      return
    }
    if (currentUrl === undefined) {
      setOperationError(words.gone)
      return
    }
    if (baseUrl === '') {
      setOperationError('还没有可以改的图，先在版本里选一张出了图的')
      return
    }
    if (model === undefined || resolution === undefined) {
      setOperationError('图片模型还没读到，稍等一下再提交')
      return
    }
    setOperationError(null)
    try {
      // 引用了标注才导出标注图，它代替干净底图占 @图片1。
      const annotatedUrl = referencesAnnotation(parts)
        ? await uploadMediaFile(await exportAnnotatedImage(baseUrl, annotations), 'image')
        : undefined
      const request = compileEditRequest(parts, {
        annotatedUrl,
        baseUrl,
        numberOf: (id) => annotations.find((annotation) => annotation.id === id)?.number,
      })
      const job = await submitImageEdit(target, request, baseUrl, {
        aspectRatio,
        model: model.model,
        resolution,
        ...(channel === undefined ? {} : { channel }),
      })
      seedImageEditJob(queryClient, target, job)
    } catch (error) {
      setOperationError(errorMessageOf(error, '图片编辑提交失败'))
    }
  }
  const submitRegenerate = async (parts: EditDraftPart[]) => {
    if (regenerate === undefined) return
    setOperationError(null)
    try {
      await regenerate.submit(parts)
    } catch (error) {
      setOperationError(errorMessageOf(error, '再生成提交失败'))
    }
  }
  const replace = async (url: string) => {
    if (await frameReplace.replace(url)) {
      // 这张图成了当前帧，画在它上面的圈是上一轮的输入，留着只会误导。
      drafts.clearDraft(url)
    }
  }

  const restoreInputs = () => {
    const job = selected?.job
    if (job === undefined || job === null) return
    const urls = readSubmittedImages(job)
    if (urls.length === 0) {
      toast.error('这条记录没有可恢复的输入')
      return
    }
    // 草稿归属于底图。恢复时也切回它，避免画面和装回的输入指向不同图片。
    const wanted = job.sourceUrl ?? currentUrl
    const onBase = entries.find(
      (entry) => (entry.kind === 'image' || entry.kind === 'current') && entry.url === wanted,
    )
    const destination = onBase ?? entries[0]
    if (destination === undefined) return
    const base = entryBaseUrl(destination, currentUrl ?? '')
    const parts = restoreEditParts(
      { prompt: readSubmittedPrompt(job), referenceImageUrls: urls },
      base,
    )
    // 保存的是带标注的图片，无法还原画布上可编辑的圈与编号。
    drafts.updateDraft(base, () => ({ annotations: [], parts }))
    setDraftRevision((value) => value + 1)
    select(destination.key)
    toast.info('已装回这次提交的图片和修改要求；画布上的标注需要重画')
  }

  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) {
          if (frameReplace.pending !== null) toast.info('请等待替换完成')
          else onClose(unseen.opened)
        }
      }}
    >
      <DialogSurface
        aria-describedby={undefined}
        className="image-edit-dialog"
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          // Dialog 先于画布捕获 Escape；画布内取消笔迹/选择时不能关闭编辑器。
          if (selectedAnnotation !== null) {
            event.preventDefault()
            setSelectedAnnotation(null)
          } else if (
            event.target instanceof Element &&
            event.target.closest('[data-annotation-canvas]')
          ) {
            event.preventDefault()
          }
        }}
      >
        <DialogHeader
          className="image-edit-header border-0"
          title={
            <span className="image-edit-title">
              <span>编辑图片</span>{' '}
              <span className="text-body-sm font-normal text-on-surface-muted">· {subtitle}</span>
            </span>
          }
          closeLabel="关闭图片编辑"
        />
        <div className="image-edit-body">
          <div className="image-edit-stage-area">
            {regenerating ? (
              <StillStage aspectRatio={aspectRatio} label={words.current} url={currentUrl} />
            ) : (
              <EditStage
                aspectRatio={aspectRatio}
                baseUrl={baseUrl}
                canvas={
                  <AnnotationCanvas
                    key={`${baseUrl}:${draftRevision}`}
                    url={baseUrl}
                    annotations={draft.annotations}
                    onChange={(annotations) => {
                      drafts.updateDraft(baseUrl, (current) => ({ ...current, annotations }))
                      setOperationError(null)
                    }}
                    selectedId={selectedAnnotation}
                    onSelect={setSelectedAnnotation}
                    disabled={frameReplace.pending !== null}
                    onInsertReference={(id) => {
                      const annotation = draft.annotations.find((item) => item.id === id)
                      if (annotation !== undefined)
                        composerRef.current?.insertAnnotation(annotation)
                    }}
                  />
                }
                currentUrl={currentUrl}
                entry={selected}
                words={words}
                replace={{
                  error: frameReplace.error,
                  onReplace: (url) => void replace(url),
                  onUndo: () => void frameReplace.undo(),
                  pending: frameReplace.pending,
                  undoable: frameReplace.undoable,
                }}
              />
            )}
            <VersionStrip
              entries={entries}
              words={words}
              currentUrl={currentUrl ?? ''}
              disabled={frameReplace.pending !== null}
              selectedKey={regenerating ? REGENERATE_KEY : (selected?.key ?? CURRENT_KEY)}
              onSelect={select}
              regenerate={
                regenerate === undefined
                  ? undefined
                  : { onSelect: () => select(REGENERATE_KEY), selected: regenerating }
              }
              isUnseen={(entry) =>
                entry.kind === 'image' && entry.job !== null && unseen.isUnseen(entry.job.id)
              }
              hasMore={jobsQuery.hasNextPage}
              loadingMore={jobsQuery.isFetchingNextPage}
              onLoadMore={() => void jobsQuery.fetchNextPage()}
              actions={
                !regenerating &&
                selected !== undefined &&
                selected.kind !== 'current' &&
                selected.job !== null ? (
                  <MenuRoot>
                    {/* disabled 交给菜单触发器：它拦下自己的按下与按键，再转交给按钮置灰。 */}
                    <MenuTrigger asChild disabled={frameReplace.pending !== null}>
                      <IconButton
                        label="图片历史操作"
                        name="more"
                        size="md"
                        className="rounded-full"
                      />
                    </MenuTrigger>
                    <MenuSurface align="end" side="left">
                      <MenuItem icon="history" onSelect={restoreInputs}>
                        恢复这次的输入
                      </MenuItem>
                    </MenuSurface>
                  </MenuRoot>
                ) : null
              }
            />
          </div>
          {aspectUnsupported && !regenerating ? (
            <p role="alert" className="text-body-sm text-error">
              暂无模型支持 {aspectRatio}，请先调整分镜画幅
            </p>
          ) : null}
          {modelsQuery.isError ? (
            <InlineAlert
              action={{ label: '重新加载模型', onClick: () => void modelsQuery.refetch() }}
              message={errorMessageOf(modelsQuery.error, '读取图片模型失败')}
            />
          ) : null}
          {drafts.error !== null ? (
            <InlineAlert
              action={{
                label: '重新开始',
                onClick: () => {
                  drafts.reset()
                  setDraftRevision((value) => value + 1)
                },
              }}
              message={drafts.error}
            />
          ) : null}
          {jobsQuery.isError ? (
            <InlineAlert
              action={{ label: '重试', onClick: () => void jobsQuery.refetch() }}
              message={errorMessageOf(jobsQuery.error, '读取图片编辑记录失败')}
            />
          ) : null}
          {operationError !== null ? <InlineAlert message={operationError} /> : null}
          {regenerating ? (
            <EditComposer
              key={REGENERATE_KEY}
              ref={composerRef}
              baseUrl={undefined}
              regenerate
              editingResult={false}
              frames={frames}
              frameGroup={words.frames}
              aspectRatio={aspectRatio}
              annotations={[]}
              selectedAnnotation={null}
              onSelectAnnotation={() => {}}
              initialParts={regenerateParts}
              onPartsChange={(parts) => {
                setRegenerateParts(parts)
                setOperationError(null)
              }}
              onSubmit={submitRegenerate}
              // 模型与画幅照文件里写的，这里不选。
              settings={null}
            />
          ) : (
            <EditComposer
              key={`${baseUrl}:${draftRevision}`}
              ref={composerRef}
              baseUrl={baseUrl}
              editingResult={selected?.kind === 'image'}
              frames={frames}
              frameGroup={words.frames}
              aspectRatio={aspectRatio}
              annotations={draft.annotations}
              selectedAnnotation={selectedAnnotation}
              // 芯片指的是画在当前底图上的圈，选中的那条条目不变。
              onSelectAnnotation={setSelectedAnnotation}
              initialParts={draft.parts}
              onPartsChange={(parts) => {
                drafts.updateDraft(baseUrl, (current) => ({ ...current, parts }))
                setOperationError(null)
              }}
              onSubmit={submit}
              settings={
                aspectUnsupported ? null : (
                  <EditGenerationSettings
                    models={models}
                    options={options}
                    aspectRatio={aspectRatio}
                    onModelChange={setWantedModel}
                    onChannelChange={setWantedChannel}
                    onResolutionChange={setWantedResolution}
                  />
                )
              }
            />
          )}
          <p className="image-edit-footnote">{footnote}</p>
        </div>
      </DialogSurface>
    </DialogRoot>
  )
}
