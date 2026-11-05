import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState, type CSSProperties } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { uploadMediaFile } from '@/shared/api/media-upload'
import { IconButton } from '@/shared/ui/button'
import { DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { MenuItem, MenuRoot, MenuSurface, MenuTrigger } from '@/shared/ui/menu'
import { toast } from '@/shared/ui/toast'
import { useUnseenResults } from '../components/use-unseen-results'
import { versionThumbSize } from '../components/version-thumb-size'
import { useSubmitLock } from '../use-submit-lock'
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
  currentUrl: string | null | undefined
  subtitle: string
  frames: readonly EditFrame[]
  aspectRatio: string
  initialKey?: string | undefined
  onClose: (opened: ReadonlySet<string>) => void
  onApply: (previousUrl: string | null, url: string | null) => Promise<void>
  regenerate?:
    | {
        parts: readonly EditDraftPart[]
        submit: (parts: EditDraftPart[]) => Promise<void>
        blocked?: string | undefined
      }
    | undefined
}

const REGENERATE_KEY = 'regenerate'

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
  const lock = useSubmitLock()
  const [selectedKey, setSelectedKey] = useState(initialKey ?? CURRENT_KEY)
  const [selectedAnnotation, setSelectedAnnotation] = useState<string | null>(null)
  const [wantedModel, setWantedModel] = useState<string>()
  const [wantedChannel, setWantedChannel] = useState<ImageChannel>('dev')
  const [wantedResolution, setWantedResolution] = useState<ImageResolution>('2k')
  const [operationError, setOperationError] = useState<string | null>(null)
  const [draftRevision, setDraftRevision] = useState(0)
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null)
  const composerRef = useRef<EditComposerHandle>(null)
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
  const entries = useMemo(
    () => frameImageEntries(jobs, currentUrl === undefined ? '' : currentUrl),
    [jobs, currentUrl],
  )
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
      ? `有 ${inFlight} 个任务正在生成或排队，关闭窗口不影响生成`
      : regenerating
        ? '新结果将出现在版本中，选用后生效'
        : selected?.kind === 'image'
          ? words.replaceNote
          : null

  const select = (key: string) => {
    setSelectedKey(key)
    setSelectedAnnotation(null)
    setOperationError(null)
    frameReplace.acknowledge()
  }
  const submit = async (parts: EditDraftPart[]) => {
    const { annotations } = draft
    const problem = editDraftError({ annotations, parts }, baseUrl)
    if (problem !== null) {
      setOperationError(problem)
      return false
    }
    if (currentUrl === undefined) {
      setOperationError(words.gone)
      return false
    }
    if (baseUrl === '') {
      setOperationError('暂无可编辑的图片，请先在版本中选择一张已生成的图片')
      return false
    }
    if (model === undefined || resolution === undefined) {
      setOperationError('图片模型尚未加载，无法提交；请稍后重试')
      return false
    }
    setOperationError(null)
    try {
      const annotatedUrl = referencesAnnotation(parts)
        ? (await uploadMediaFile(await exportAnnotatedImage(baseUrl, annotations), 'image')).url
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
      return true
    } catch (error) {
      setOperationError(errorMessageOf(error, '图片编辑提交失败'))
      return false
    }
  }
  const submitRegenerate = async (parts: EditDraftPart[]) => {
    if (regenerate === undefined || regenerate.blocked !== undefined) return false
    setOperationError(null)
    try {
      await regenerate.submit(parts)
      return true
    } catch (error) {
      setOperationError(errorMessageOf(error, '再生成提交失败'))
      return false
    }
  }
  const replace = async (url: string) => {
    if (await frameReplace.replace(url)) {
      drafts.clearDraft(url)
    }
  }

  const restoreInputs = () => {
    const job = selected?.job
    if (job === undefined || job === null) return
    const urls = readSubmittedImages(job)
    if (urls.length === 0) {
      toast.error('该记录没有可恢复的输入')
      return
    }
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
    drafts.updateDraft(base, () => ({ annotations: [], parts }))
    setDraftRevision((value) => value + 1)
    select(destination.key)
    toast.info('已恢复本次提交的图片和修改要求；画布上的标注需重新绘制')
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
              <span className="text-body-sm font-normal text-on-surface-muted">{subtitle}</span>
            </span>
          }
          closeLabel="关闭图片编辑"
        />
        <div className="image-edit-body">
          <div
            className="image-edit-stage-area"
            style={
              {
                '--image-edit-thumb-width': `${versionThumbSize(aspectRatio).width}px`,
              } as CSSProperties
            }
          >
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
                    toolbarHost={toolbarHost}
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
            <div className="image-edit-tools-host" ref={setToolbarHost} />
            <VersionStrip
              entries={entries}
              words={words}
              currentUrl={currentUrl ?? ''}
              aspectRatio={aspectRatio}
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
                    <MenuTrigger asChild disabled={frameReplace.pending !== null}>
                      <IconButton
                        label="图片历史操作"
                        name="more"
                        size="sm"
                        className="image-edit-versions-more"
                      />
                    </MenuTrigger>
                    <MenuSurface align="end" side="left">
                      <MenuItem icon="history" onSelect={restoreInputs}>
                        恢复本次输入
                      </MenuItem>
                    </MenuSurface>
                  </MenuRoot>
                ) : null
              }
            />
          </div>
          {footnote === null ? null : <p className="image-edit-footnote">{footnote}</p>}
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
          {regenerating && regenerate.blocked !== undefined ? (
            <p className="text-body-sm text-error">{regenerate.blocked}</p>
          ) : null}
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
              onSubmit={(parts) => void lock.run(() => submitRegenerate(parts))}
              phase={lock.phase}
              settings={null}
              submitBlocked={regenerate.blocked !== undefined}
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
              onSelectAnnotation={setSelectedAnnotation}
              initialParts={draft.parts}
              onPartsChange={(parts) => {
                drafts.updateDraft(baseUrl, (current) => ({ ...current, parts }))
                setOperationError(null)
              }}
              onSubmit={(parts) => void lock.run(() => submit(parts))}
              phase={lock.phase}
              settings={
                aspectUnsupported ? null : (
                  <EditGenerationSettings
                    models={models}
                    options={options}
                    aspectRatio={aspectRatio}
                    aspectNote={words.aspectNote(aspectRatio)}
                    onModelChange={setWantedModel}
                    onChannelChange={setWantedChannel}
                    onResolutionChange={setWantedResolution}
                  />
                )
              }
            />
          )}
        </div>
      </DialogSurface>
    </DialogRoot>
  )
}
