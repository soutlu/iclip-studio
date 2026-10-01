/** 结构化分镜工作台的组合根：取数、草稿与路由参数在这里，状态分发给顶栏、分镜页、浮层与出片栏。 */

import { useNavigate, useSearch } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { MediaLightbox, type LightboxMedia } from '@/shared/ui/media-lightbox'
import { toast } from '@/shared/ui/toast'
import { useWorkspaceFile, type ArtifactRendererProps } from '@/shared/workbench'
import { formatShotPrompt, validateShot, type Shot } from '../shot-document'
import { frameBadges, latestFrameJobs } from '../frame-status'
import { generationBlockerOf, generationNoticeOf } from '../generation-blocker'
import { useFrameImageJobs } from '../image-edit/image-edit.api'
import { SHOTS_PATH } from '../shots'
import { useShotGenerations } from '../storyboard.api'
import { takeActionsOf, takesOfShot } from '../takes'
import { useGenerationGate } from '../use-generation-gate'
import { useShotArrowKeys } from '../use-shot-arrow-keys'
import { useShotsDraft } from '../use-shots-draft'
import { useLiveGenerations } from '../use-live-generations'
import { useStageSelection } from '../use-stage-selection'
import { useVideoGeneration } from '../use-video-generation'
import { VideoEditor } from '../video-editor/video-editor'
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
  /** 视频编辑器开在哪条出片记录上；换组就关掉。 */
  video?: string | undefined
}

export function StoryboardReader(props: ArtifactRendererProps) {
  const path = props.artifact.source.kind === 'file' ? props.artifact.source.path : SHOTS_PATH
  return <StoryboardWorkspace key={`${props.conversationId}:${path}`} {...props} />
}

function StoryboardWorkspace({ artifact, conversationId, readOnly }: ArtifactRendererProps) {
  const path = artifact.source.kind === 'file' ? artifact.source.path : SHOTS_PATH
  const gate = useGenerationGate()
  const file = useWorkspaceFile(conversationId, path)
  const generations = useShotGenerations(conversationId)
  const frameJobs = useFrameImageJobs(conversationId)
  useLiveGenerations(conversationId)
  // 关过编辑器就算看过那一格的终态；只记本次会话，刷新后没看过的终态会再出现一次。
  const [seenFrameJobs, setSeenFrameJobs] = useState<ReadonlySet<string>>(() => new Set())
  const video = useVideoGeneration(conversationId)
  // 打开时先选中哪一条、从哪个控件点开都由入口决定。
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

  const go = (next: ReaderSearch) => {
    const cleared =
      next.shot !== undefined && next.shot !== position
        ? { content: undefined, frame: undefined, video: undefined }
        : {}
    // 叠在导航那一刻的参数上：上传完成时才调的 `go` 拿的是发起时的闭包，不能用旧参数盖掉期间打开的浮层。
    void navigate({
      replace: true,
      search: (previous: ReaderSearch) => ({ ...previous, ...cleared, ...next }),
      to: '.',
    })
  }

  // ↑↓ 键与顶栏的上一组、下一组、镜头组列表共用这条换组路径。
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
    return <ReaderNotice text="文件格式不对，读不出镜头组" />
  }

  const videoEditRoot =
    search.video === undefined
      ? undefined
      : generations.data?.find((job) => job.id === search.video)
  // 只读时整页的编辑与生成入口一起收起。
  const editingDisabled = readOnly || gate.preparing
  // 提交途中按钮自己写着「提交中」，不另说原因。
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
    // 改过之后原因就过期了，等下一次出片再说；存盘状态那一格有自己的提示，不重复说。
    submitError: draft.hasUnsavedChanges ? undefined : video.errorOf(shot.index),
  })
  const generate = () =>
    gate.run(async (mounted) => {
      const saved = await draft.saveNow()
      if (saved === null || !mounted()) return
      const current = saved.shots.find((item) => item.index === shot.index)
      if (current === undefined) {
        video.reportError(shot.index, '无法读取已保存的镜头组，请重新打开后生成')
        return
      }
      await video.submit(current, saved.aspect_ratio)
    })
  // 选中成片的回填：把那次出片的镜头组写回当前组，图片跟着文档不跟记录。
  const refill = (prompt: Shot['prompt']) => {
    const problem = validateShot({ ...shot, prompt })
    if (problem !== undefined) {
      toast.error(problem)
      return
    }
    draft.updateShot(shot.index, (current) => ({ ...current, prompt }))
    toast('历史提示词已回填到当前镜头组')
  }
  const takes =
    generations.data === undefined
      ? undefined
      : takesOfShot(generations.data, shot.index, document.aspect_ratio)
  // 选中的成片不在本组列表里了（换了组、被删）就回到帧。
  const selectedTake = takes?.find((take) => take.job.id === stage.takeId)

  return (
    <>
      <div className="storyboard-workbench" ref={setRoot}>
        <StoryboardToolbar
          aspectRatio={document.aspect_ratio}
          fullPrompt={formatShotPrompt(shot)}
          onGoShot={goShot}
          position={position}
          shots={shots}
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
              // 只动路由不动舞台选中：显示帧时舞台跟到新图，放着成片就接着放。
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
            // 只挂当前组；换组就卸载重挂，进行中的上传属于原来那组，迟到的结果不要了。
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
          root={videoEditRoot}
          shotIndex={videoEditRoot?.shotIndex ?? undefined}
        />
      )}
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
