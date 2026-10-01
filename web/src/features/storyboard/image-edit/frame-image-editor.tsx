import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { uploadMediaFile } from '@/shared/api/media-upload'
import { Button, IconButton } from '@/shared/ui/button'
import { DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { MediaFallback } from '@/shared/ui/media-fallback'
import { type LightboxMedia, MediaLightbox } from '@/shared/ui/media-lightbox'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { toast } from '@/shared/ui/toast'
import { AnnotationCanvas } from './annotation-canvas'
import { exportAnnotatedImage } from './annotation-export'
import { EditComposer, type EditComposerHandle } from './edit-composer'
import { EditGenerationSettings } from './edit-generation-settings'
import { CURRENT_KEY, entryBaseUrl, frameImageEntries } from './edit-history'
import { EditResultStrip } from './edit-result-strip'
import { EditTaskPreview } from './edit-task-preview'
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
import type { EditDraftPart, FrameEditTarget } from './image-edit-types'
import { useFrameEditDrafts } from './use-frame-edit-drafts'
import './image-edit.css'

type FrameImageEditorProps = {
  target: FrameEditTarget
  frames: readonly string[]
  aspectRatio: string
  /** 打开时先选中哪一条；从帧上「有新结果」进来时是那条任务。 */
  initialKey?: string | undefined
  onClose: () => void
  onApply: (previousUrl: string, url: string) => Promise<void>
}

export function FrameImageEditor({
  target,
  frames,
  aspectRatio,
  initialKey,
  onClose,
  onApply,
}: FrameImageEditorProps) {
  const queryClient = useQueryClient()
  const drafts = useFrameEditDrafts(target)
  const [selectedKey, setSelectedKey] = useState(initialKey ?? CURRENT_KEY)
  const [selectedAnnotation, setSelectedAnnotation] = useState<string | null>(null)
  const [preview, setPreview] = useState<LightboxMedia | null>(null)
  // 记地址而不是布尔：换一条结果就该重新试着加载那张图。
  const [brokenResult, setBrokenResult] = useState<string | null>(null)
  const [wantedModel, setWantedModel] = useState<string>()
  const [wantedChannel, setWantedChannel] = useState<ImageChannel>('dev')
  const [wantedResolution, setWantedResolution] = useState<ImageResolution>('2k')
  // 应用期间锁住编辑器其余部分；上传与提交只在输入卡里转圈，不锁窗口。
  const [applying, setApplying] = useState(false)
  const [operationError, setOperationError] = useState<string | null>(null)
  // 从外部整份换掉草稿时加一：画布与输入卡换 key 重挂，撤销栈随之清空、输入卡装回新草稿。
  const [draftRevision, setDraftRevision] = useState(0)
  // 用户确认过的当前帧，应用时拿它当替换凭据。
  //
  // 不能跟着渲染走：这一帧被 agent 换掉时，缩略图条上那一小格会悄悄改一张图，用户盯着结果
  // 根本不会发现，跟着走等于没有守卫，会直接盖掉别人刚写的。也不能锁死在打开那一刻，否则
  // 应用完窗口留着就再也对不上。所以只在用户确实看过这一格时更新：翻缩略图条、自己应用成功、
  // 以及被拒绝一次之后。
  const acknowledgedRef = useRef<string | undefined>(undefined)
  const applyingRef = useRef(false)
  const composerRef = useRef<EditComposerHandle>(null)
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
  // 当前帧随应用实时变；编辑器不记打开那一刻的地址，不然应用完窗口还留着就对不上了。
  const currentUrl = frames[target.frameNumber - 1]
  acknowledgedRef.current ??= currentUrl
  const entries = useMemo(() => frameImageEntries(jobs, currentUrl ?? ''), [jobs, currentUrl])
  // 选中的那条被折进当前帧格（刚应用过）或还没拉回来时，落回当前帧。
  const selected = entries.find((entry) => entry.key === selectedKey) ?? entries[0]
  const baseUrl = selected === undefined ? '' : entryBaseUrl(selected, currentUrl ?? '')
  const draft = useMemo(() => draftOf(drafts.drafts, baseUrl), [drafts.drafts, baseUrl])
  const busy = applying
  const canApply =
    selected?.kind === 'image' && currentUrl !== undefined && selected.url !== currentUrl

  const select = (key: string) => {
    setSelectedKey(key)
    setSelectedAnnotation(null)
    setOperationError(null)
    // 翻看缩略图条时正好看见了当前帧那一格。
    acknowledgedRef.current = currentUrl
  }
  const submit = async (parts: EditDraftPart[]) => {
    const { annotations } = draft
    const problem = editDraftError({ annotations, parts }, baseUrl)
    if (problem !== null) {
      setOperationError(problem)
      return
    }
    if (currentUrl === undefined) {
      setOperationError('这一帧已经不在分镜里了，关掉窗口重新选一帧')
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
      setSelectedKey(job.id)
      seedImageEditJob(queryClient, target, job)
    } catch (error) {
      setOperationError(errorMessageOf(error, '图片编辑提交失败'))
    }
  }
  const apply = async () => {
    if (!canApply || applyingRef.current) return
    const applied = selected.url
    applyingRef.current = true
    setApplying(true)
    setOperationError(null)
    try {
      await onApply(acknowledgedRef.current ?? currentUrl, applied)
      // 这张图成了当前帧，画在它上面的圈是上一轮的输入，留着只会误导。
      drafts.clearDraft(applied)
      acknowledgedRef.current = applied
      setSelectedKey(CURRENT_KEY)
      toast.success('已应用到当前帧')
    } catch (error) {
      // 多半是这一帧被 agent 换过了：报出来的同时认下新的那张，用户再点一次就是冲着它去的。
      acknowledgedRef.current = currentUrl
      setOperationError(errorMessageOf(error, '图片尚未应用，请重试'))
    } finally {
      applyingRef.current = false
      setApplying(false)
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
          if (busy) toast.info('请等待应用完成')
          else onClose()
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
              <span className="text-body-sm font-normal text-on-surface-muted">
                · 镜头组 {target.shotIndex} · 帧 @{target.frameNumber}
              </span>
            </span>
          }
          closeLabel="关闭图片编辑"
        />
        <div className="image-edit-body">
          <div className="image-edit-left">
            {currentUrl === undefined ? (
              <p className="image-edit-photo text-body-sm text-on-surface-muted" role="alert">
                这一帧已经不在分镜里了，关掉窗口重新选一帧
              </p>
            ) : selected?.kind === 'pending' || selected?.kind === 'failed' ? (
              <EditTaskPreview
                key={`${selected.key}:${baseUrl}`}
                entry={selected}
                baseUrl={baseUrl}
                disabled={busy}
                onReturnToCurrent={() => select(CURRENT_KEY)}
              />
            ) : selected?.kind === 'image' ? (
              brokenResult === selected.url ? (
                <p className="image-edit-photo">
                  <MediaFallback kind="image" />
                </p>
              ) : (
                <div className="image-edit-photo">
                  <button
                    aria-label="预览图片编辑结果"
                    className="size-full cursor-zoom-in rounded-[inherit] ui-focus ui-focus-inline"
                    onClick={() =>
                      setPreview({ kind: 'image', name: '图片编辑结果', url: selected.url })
                    }
                    type="button"
                  >
                    <img
                      alt="图片编辑结果"
                      src={selected.url}
                      onError={() => setBrokenResult(selected.url)}
                    />
                  </button>
                </div>
              )
            ) : (
              <div className="image-edit-canvas-slot">
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
                  disabled={busy}
                  onInsertReference={(id) => {
                    const annotation = draft.annotations.find((item) => item.id === id)
                    if (annotation !== undefined) composerRef.current?.insertAnnotation(annotation)
                  }}
                />
              </div>
            )}
            <EditResultStrip
              entries={entries}
              currentUrl={currentUrl ?? ''}
              disabled={busy}
              selectedKey={selected?.key ?? CURRENT_KEY}
              onSelect={select}
              hasMore={jobsQuery.hasNextPage}
              loadingMore={jobsQuery.isFetchingNextPage}
              onLoadMore={() => void jobsQuery.fetchNextPage()}
              actions={
                selected !== undefined && selected.kind !== 'current' && selected.job !== null ? (
                  <MenuRoot>
                    <MenuTrigger asChild>
                      <IconButton
                        disabled={busy}
                        label="图片历史操作"
                        name="more"
                        size="md"
                        className="rounded-full"
                      />
                    </MenuTrigger>
                    <MenuSurface align="end">
                      <MenuItem icon="history" disabled={busy} onSelect={restoreInputs}>
                        恢复这次的输入
                      </MenuItem>
                    </MenuSurface>
                  </MenuRoot>
                ) : null
              }
            />
          </div>
          <div className="image-edit-right">
            <section className="flex flex-col gap-4">
              <div>
                <h3 className="text-title-lg font-semibold">想怎么修改？</h3>
                <p className="mt-1 text-body-sm text-on-surface-muted">
                  描述你的想法，也可以引用图片或标注
                </p>
              </div>
              <EditComposer
                key={`${baseUrl}:${draftRevision}`}
                ref={composerRef}
                baseUrl={baseUrl}
                frames={frames}
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
              <p className="text-center text-caption text-on-surface-muted">
                画幅 {aspectRatio}，跟随分镜
              </p>
            </section>
            <div className="image-edit-submit-area">
              {aspectUnsupported ? (
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
              {canApply ? (
                <>
                  <Button
                    className="image-edit-primary-action"
                    disabled={busy}
                    loading={applying}
                    onClick={() => void apply()}
                  >
                    应用到当前帧
                  </Button>
                  <p className="text-center text-caption text-on-surface-muted">
                    应用只替换当前帧，之后可以继续修改
                  </p>
                </>
              ) : null}
            </div>
          </div>
        </div>
        <MediaLightbox media={preview} onClose={() => setPreview(null)} />
      </DialogSurface>
    </DialogRoot>
  )
}
