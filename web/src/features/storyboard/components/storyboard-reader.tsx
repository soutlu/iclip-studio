import { useNavigate, useSearch } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { MediaLightbox, type LightboxMedia } from '@/shared/ui/media-lightbox'
import { toast } from '@/shared/ui/toast'
import { useWorkspaceFile, type ArtifactRendererProps } from '@/shared/workbench'
import { formatShotPrompt, shotGroupSummary, validateShot, type Shot } from '../shot-document'
import { frameBadges, latestFrameJobs } from '../frame-status'
import { generationBlockerOf, generationNoticeOf } from '../generation-blocker'
import { useFrameImageJobs } from '../image-edit/image-edit.api'
import { SHOTS_PATH } from '../shots'
import { submitVideoGeneration, useShotGenerations } from '../storyboard.api'
import { takeActionsOf, takesOfShot } from '../takes'
import { useGenerationGate } from '../use-generation-gate'
import { useShotArrowKeys } from '../use-shot-arrow-keys'
import { useShotsDraft } from '../use-shots-draft'
import { useLiveGenerations } from '../use-live-generations'
import { useStageSelection } from '../use-stage-selection'
import { useVideoGeneration } from '../use-video-generation'
import { VideoEditor } from '../video-editor/video-editor'
import { WholeFilmEditor } from '../whole-film/whole-film-editor'
import { ConflictDialog, ReaderNotice, SaveStatus } from './draft-status'
import { ReaderImageEdit, type FrameEditSession } from './reader-image-edit'
import { ReaderPage } from './reader-page'
import { StoryboardToolbar } from './storyboard-toolbar'
import { TakesTray } from './takes-tray'
import { VideoGenerationBar } from './video-generation-bar'

type ReaderSearch = {
  content?: string | undefined
  frame?: number | undefined
  shot?: number | undefined
  video?: string | undefined
  wholeFilm?: true | undefined
}

export function StoryboardReader(props: ArtifactRendererProps) {
  const path = props.artifact.source.kind === 'file' ? props.artifact.source.path : SHOTS_PATH
  return <StoryboardWorkspace key={`${props.conversationId}:${path}`} {...props} />
}

function StoryboardWorkspace({
  artifact,
  conversationId,
  conversationTitle,
  readOnly,
}: ArtifactRendererProps) {
  const path = artifact.source.kind === 'file' ? artifact.source.path : SHOTS_PATH
  const gate = useGenerationGate()
  const file = useWorkspaceFile(conversationId, path)
  const generations = useShotGenerations(conversationId)
  const frameJobs = useFrameImageJobs(conversationId)
  useLiveGenerations(conversationId)
  const [seenFrameJobs, setSeenFrameJobs] = useState<ReadonlySet<string>>(() => new Set())
  const [imageEdit, setImageEdit] = useState<FrameEditSession | null>(null)
  const draft = useShotsDraft({ conversationId, path, file: file.data?.file })
  const latestFrameJob = useMemo(
    () => latestFrameJobs(frameJobs.data?.items ?? []),
    [frameJobs.data],
  )
  const navigate = useNavigate()
  const search: ReaderSearch = useSearch({ strict: false })
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const [media, setMedia] = useState<LightboxMedia | null>(null)
  const document = draft.document
  const shots = document?.shots ?? []
  const position =
    search.shot !== undefined && search.shot >= 1 && search.shot <= shots.length ? search.shot : 1
  const stage = useStageSelection(position)
  const video = useVideoGeneration(conversationId)

  const go = (next: ReaderSearch) => {
    const cleared =
      next.shot !== undefined && next.shot !== position
        ? { content: undefined, frame: undefined, video: undefined }
        : {}
    void navigate({
      replace: true,
      search: (previous: ReaderSearch) => ({ ...previous, ...cleared, ...next }),
      to: '.',
    })
  }

  const goShot = (next: number) => go({ shot: next })

  useShotArrowKeys(root, {
    onGo: goShot,
    position,
    total: shots.length,
  })

  if (file.isPending && document === null) return <ReaderNotice text="正在读取分镜…" />
  if (file.isError && document === null)
    return <ReaderNotice text={errorMessageOf(file.error, '读取分镜失败')} />
  const shot = shots[position - 1]
  if (document === null || shot === undefined) {
    return <ReaderNotice text="文件格式不正确，镜头组读取失败" />
  }

  const videoEditRoot =
    search.video === undefined
      ? undefined
      : generations.data?.find((job) => job.id === search.video)
  const editingDisabled = readOnly || gate.preparing
  const generateBlocker = gate.preparing
    ? undefined
    : generationBlockerOf({
        modelsStatus: video.modelsStatus,
        readOnly,
        saveState: draft.state.kind,
        uploading: gate.uploading,
      })
  const generateNotice = generationNoticeOf({
    aspectRatio: document.aspect_ratio,
    model: video.options.model,
    submitError: draft.hasUnsavedChanges ? undefined : video.errorOf(shot.index),
  })
  const generate = () =>
    gate.run(async (mounted) => {
      const saved = await draft.saveNow()
      if (saved === null || !mounted()) return
      const current = saved.shots.find((item) => item.index === shot.index)
      if (current === undefined) {
        video.reportError(shot.index, '已保存的镜头组读取失败，请重新打开后生成')
        return
      }
      await video.submit(current.index, (choice) =>
        submitVideoGeneration({
          ...choice,
          aspectRatio: saved.aspect_ratio,
          conversationId,
          shot: current,
        }),
      )
    })
  const refill = (prompt: Shot['prompt']) => {
    const problem = validateShot({ ...shot, prompt })
    if (problem !== undefined) {
      toast.error(problem)
      return
    }
    draft.updateShot(shot.index, (current) => ({ ...current, prompt }))
    toast('已将历史提示词回填到当前镜头组')
  }
  const takes =
    generations.data === undefined
      ? undefined
      : takesOfShot(generations.data, shot.index, document.aspect_ratio)
  const selectedTake = takes?.find((take) => take.job.id === stage.takeId)

  return (
    <>
      <div className="storyboard-workbench" ref={setRoot}>
        <StoryboardToolbar
          copy={{ done: '已复制完整提示词', label: '复制完整提示词', text: formatShotPrompt(shot) }}
          groups={shots.map((item) => shotGroupSummary(item, document.aspect_ratio))}
          onGoShot={goShot}
          onWholeFilm={readOnly ? undefined : () => go({ wholeFilm: true })}
          position={position}
          status={
            <SaveStatus
              state={draft.state}
              hasUnsavedChanges={draft.hasUnsavedChanges}
              appliedUpload={draft.hasUnsavedUpload}
              onRetry={() => void draft.saveNow()}
            />
          }
        />
        <div className="flex min-h-0 w-full min-w-0 flex-1 overflow-hidden">
          <ReaderPage
            editingDisabled={editingDisabled}
            aspect_ratio={document.aspect_ratio}
            onUpdateShot={(updater) => draft.updateShot(shot.index, updater)}
            onReplaceFrame={(frame, previousUrl, url) => {
              draft.replaceFrame(shot.index, frame, previousUrl, url)
              draft.recordUpload(shot.index, frame, url)
            }}
            onUploaded={(content, frame, url, follow) => {
              draft.recordUpload(shot.index, frame, url)
              if (follow) go({ content, frame })
            }}
            onUploadingChange={gate.onUploadingChange}
            onEditFrame={(frame, open) => {
              setImageEdit({
                target: { conversationId, shotIndex: shot.index, frameNumber: frame },
                ...(open.kind === 'result' ? { initialKey: open.jobId } : {}),
                trigger:
                  window.document.activeElement instanceof HTMLElement
                    ? window.document.activeElement
                    : null,
              })
            }}
            content={search.content}
            frame={search.frame}
            frameBadges={frameBadges(shot, latestFrameJob, seenFrameJobs)}
            key={shot.index}
            onSelect={(content, frame) => {
              stage.selectContent()
              go({ content, frame })
            }}
            onPreview={setMedia}
            shot={shot}
            take={
              selectedTake === undefined
                ? undefined
                : {
                    actions: takeActionsOf(selectedTake, { readOnly }),
                    onEditVideo: () => go({ video: selectedTake.job.id }),
                    onRefill: () => {
                      if (selectedTake.history !== undefined) refill(selectedTake.history)
                    },
                    take: selectedTake,
                  }
            }
            takes={
              <TakesTray
                error={
                  generations.isError
                    ? errorMessageOf(generations.error, '读取视频记录失败')
                    : undefined
                }
                onSelect={stage.selectTake}
                selectedId={selectedTake?.job.id}
                takes={takes}
              />
            }
          />
        </div>
        <VideoGenerationBar
          aspect={{
            description: '画幅写回分镜，不是生成参数',
            disabled: editingDisabled,
            onChange: draft.updateAspectRatio,
            value: document.aspect_ratio,
          }}
          blocker={generateBlocker}
          models={{ items: video.models, status: video.modelsStatus }}
          notice={generateNotice}
          onChange={video.setOptions}
          onGenerate={() => void generate()}
          shotIndex={shot.index}
          submitting={gate.preparing}
          value={video.options}
        />
      </div>
      <MediaLightbox media={media} onClose={() => setMedia(null)} />
      {search.video === undefined ? null : (
        <VideoEditor
          conversationId={conversationId}
          loading={generations.isPending}
          onClose={() => go({ video: undefined })}
          shotIndex={videoEditRoot?.shotIndex ?? undefined}
          video={videoEditRoot}
        />
      )}
      {search.wholeFilm === true && !readOnly ? (
        <WholeFilmEditor
          conversationId={conversationId}
          conversationTitle={conversationTitle}
          onClose={() => go({ wholeFilm: undefined })}
        />
      ) : null}
      {imageEdit === null ? null : (
        <ReaderImageEdit
          aspectRatio={document.aspect_ratio}
          frames={shots.find((item) => item.index === imageEdit.target.shotIndex)?.image_urls ?? []}
          latestFrameJobs={latestFrameJob}
          onApply={(previousUrl, url) =>
            draft.applyFrame(
              imageEdit.target.shotIndex,
              imageEdit.target.frameNumber,
              previousUrl,
              url,
            )
          }
          onClose={(seen) => {
            if (seen !== undefined) setSeenFrameJobs((current) => new Set(current).add(seen.id))
            setImageEdit(null)
          }}
          session={imageEdit}
        />
      )}
      <ConflictDialog state={draft.state} resolve={draft.resolveConflict} />
    </>
  )
}
