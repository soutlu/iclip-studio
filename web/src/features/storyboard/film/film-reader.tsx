import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { errorMessageOf, UserFacingError } from '@/shared/api/client'
import { hasPermission, PERMISSION, useUser } from '@/shared/auth'
import { Button } from '@/shared/ui/button'
import {
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogSurface,
} from '@/shared/ui/dialog'
import { MediaLightbox, type LightboxMedia } from '@/shared/ui/media-lightbox'
import { toast } from '@/shared/ui/toast'
import type { ArtifactRendererProps } from '@/shared/workbench'
import { ReaderNotice, SaveStatus } from '../components/draft-status'
import { StoryboardToolbar } from '../components/storyboard-toolbar'
import { TakesTray } from '../components/takes-tray'
import { VideoGenerationBar } from '../components/video-generation-bar'
import { frameBadgeOf } from '../frame-status'
import { generationBlockerOf, generationNoticeOf } from '../generation-blocker'
import { imageEditConversationKey, useFrameImageJobs } from '../image-edit/image-edit.api'
import { useShotGenerations } from '../storyboard.api'
import { takeActionsOf, takesOfShot } from '../takes'
import { useGenerationGate } from '../use-generation-gate'
import { useLiveGenerations } from '../use-live-generations'
import { useShotArrowKeys } from '../use-shot-arrow-keys'
import { useStageSelection } from '../use-stage-selection'
import { useVideoGeneration } from '../use-video-generation'
import { VideoEditor } from '../video-editor/video-editor'
import { WholeFilmEditor } from '../whole-film/whole-film-editor'
import {
  chooseFilmImage,
  filmQueryKey,
  generateFilmImage,
  generateFilmVideo,
  setFilmAspectRatio,
  useFilmFileChanges,
  useFilmView,
  type FilmFrame,
  type FilmView,
} from './film.api'
import {
  contentOfFrame,
  filmGroupSummary,
  missingFramesText,
  resolveFilmSelection,
  segmentFrames,
} from './film-content'
import { FilmImageEdit, type FilmEditSession } from './film-image-edit'
import { latestNodeImageJob, latestNodeJob, useFilmReplace } from './film-images'
import { FilmScript } from './film-script'
import { FilmStage } from './film-stage'
import { useFilmDraft, type FilmSaveState } from './use-film-draft'

type ReaderSearch = {
  content?: string | undefined
  frame?: number | undefined
  shot?: number | undefined
  video?: string | undefined
  wholeFilm?: true | undefined
}

const REPLACE_UPLOAD = 0

const TEXT_UPLOAD = -1

const ASPECT_SAVE = -2

const FILM_ASPECT_DESCRIPTION = '画幅写回分镜，所有镜头组与机位图一并修改'

export function FilmReader(props: ArtifactRendererProps) {
  return <FilmWorkspace key={props.conversationId} {...props} />
}

function FilmWorkspace({ conversationId, conversationTitle, readOnly }: ArtifactRendererProps) {
  const film = useFilmView(conversationId)
  useFilmFileChanges(conversationId)
  useLiveGenerations(conversationId)
  const draft = useFilmDraft(conversationId, film.data)
  const generations = useShotGenerations(conversationId)
  const imageJobs = useFrameImageJobs(conversationId)
  const gate = useGenerationGate()
  const { data: user } = useUser()
  const uploads = hasPermission(user, PERMISSION.uploadsWrite)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const search: ReaderSearch = useSearch({ strict: false })
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const [media, setMedia] = useState<LightboxMedia | null>(null)
  const view = draft.view
  const groups = view?.groups ?? []
  const position =
    search.shot !== undefined && search.shot >= 1 && search.shot <= groups.length ? search.shot : 1
  const group = groups[position - 1]
  const selection =
    group === undefined
      ? undefined
      : resolveFilmSelection(group, { content: search.content, frame: search.frame })
  const frame =
    group === undefined || selection?.frame === undefined
      ? undefined
      : group.frames[selection.frame - 1]
  const stage = useStageSelection(position)
  const video = useVideoGeneration(conversationId, group?.model)
  const takes =
    generations.data === undefined || group === undefined
      ? undefined
      : takesOfShot(generations.data, group.index, group.aspectRatio)
  const selectedTake = takes?.find((take) => take.job.id === stage.takeId)
  const [cardAction, setCardAction] = useState<{
    node: string
    kind: 'generate' | 'choose'
    error?: string
  } | null>(null)

  const savedFilm = async () => {
    const saved = await draft.saveNow()
    if (saved === null) throw new UserFacingError('修改尚未保存，无法继续；请处理保存问题后重试')
    return saved
  }
  const applyImage = async (node: string, url: string | null) => {
    const saved = await savedFilm()
    const changed = await chooseFilmImage(conversationId, {
      filmVersion: saved.filmVersion,
      node,
      runVersion: saved.runVersion,
      url,
    })
    queryClient.setQueryData(filmQueryKey(conversationId), { film: changed })
  }
  const replace = useFilmReplace({
    disabled: readOnly || selectedTake !== undefined,
    frame,
    onReplace: (target, url) => applyImage(target.node, url),
  })
  const [imageEdit, setImageEdit] = useState<FilmEditSession | null>(null)
  const [seenImageJobs, setSeenImageJobs] = useState<ReadonlySet<string>>(() => new Set())
  const latestImageJob = (node: string) => latestNodeImageJob(imageJobs.data?.items ?? [], node)
  const applyEdited = async (node: string, previous: string | null, url: string | null) => {
    const latest = queryClient.getQueryData<{ film: FilmView }>(filmQueryKey(conversationId))
    const current = latest?.film.groups
      .flatMap((item) => item.frames)
      .find((item) => item.node === node)?.url
    if (current !== previous) throw new UserFacingError('该图片已被更换，无法继续；请确认后重试')
    await applyImage(node, url)
  }
  const reportUploading = useEffectEvent((busy: boolean) =>
    gate.onUploadingChange(REPLACE_UPLOAD, busy),
  )
  useEffect(() => {
    reportUploading(replace.busy)
    return () => reportUploading(false)
  }, [replace.busy])
  const [textUploads, setTextUploads] = useState<ReadonlySet<string>>(() => new Set())
  const onTextUploading = useCallback((key: string, busy: boolean) => {
    setTextUploads((current) => {
      if (current.has(key) === busy) return current
      const next = new Set(current)
      if (busy) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])
  const reportTextUploading = useEffectEvent((busy: boolean) =>
    gate.onUploadingChange(TEXT_UPLOAD, busy),
  )
  const textUploading = textUploads.size > 0
  useEffect(() => {
    reportTextUploading(textUploading)
    return () => reportTextUploading(false)
  }, [textUploading])
  const [aspectSaving, setAspectSaving] = useState(false)
  const reportAspectSaving = useEffectEvent((busy: boolean) =>
    gate.onUploadingChange(ASPECT_SAVE, busy),
  )
  useEffect(() => {
    reportAspectSaving(aspectSaving)
    return () => reportAspectSaving(false)
  }, [aspectSaving])
  const changeAspect = async (aspectRatio: string) => {
    setAspectSaving(true)
    try {
      const saved = await savedFilm()
      const changed = await setFilmAspectRatio(conversationId, {
        aspectRatio,
        filmVersion: saved.filmVersion,
      })
      queryClient.setQueryData(filmQueryKey(conversationId), { film: changed })
    } catch (error) {
      toast.error(errorMessageOf(error, '画幅修改失败'))
    } finally {
      setAspectSaving(false)
    }
  }
  const generateImage = async (target: FilmFrame) => {
    setCardAction({ kind: 'generate', node: target.node })
    try {
      const saved = await savedFilm()
      await generateFilmImage(conversationId, {
        filmVersion: saved.filmVersion,
        node: target.node,
        runVersion: saved.runVersion,
      })
      await queryClient.invalidateQueries({ queryKey: imageEditConversationKey(conversationId) })
      setCardAction(null)
    } catch (error) {
      setCardAction({
        error: errorMessageOf(error, '生成提交失败'),
        kind: 'generate',
        node: target.node,
      })
    }
  }
  const chooseResult = async (target: FilmFrame, url: string) => {
    setCardAction({ kind: 'choose', node: target.node })
    try {
      await applyImage(target.node, url)
      setCardAction(null)
    } catch (error) {
      setCardAction({ error: errorMessageOf(error, '选用失败'), kind: 'choose', node: target.node })
    }
  }

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
  useShotArrowKeys(root, { onGo: goShot, position, total: groups.length })

  const shownRef = useRef<{ group: number; node: string; order: string } | undefined>(undefined)
  const followShown = useEffectEvent(
    (groupIndex: number | undefined, node: string | undefined, order: string | undefined) => {
      const previous = shownRef.current
      shownRef.current =
        groupIndex === undefined || node === undefined || order === undefined
          ? undefined
          : { group: groupIndex, node, order }
      if (
        previous === undefined ||
        group === undefined ||
        previous.group !== groupIndex ||
        previous.order === order ||
        previous.node === node
      )
        return
      const index = group.frames.findIndex((item) => item.node === previous.node)
      if (index >= 0) go({ frame: index + 1 })
    },
  )
  const frameOrder = group?.frames.map((item) => item.node).join('\n')
  useEffect(
    () => followShown(group?.index, frame?.node, frameOrder),
    [group?.index, frame?.node, frameOrder],
  )

  if (view === undefined) {
    return (
      <ReaderNotice
        text={film.isError ? errorMessageOf(film.error, '读取分镜失败') : '正在读取分镜…'}
      />
    )
  }
  if (view.problems > 0) return <FilmProblems count={view.problems} />
  if (group === undefined || selection === undefined)
    return <ReaderNotice text="分镜中暂无镜头组" />

  const select = (content: string, frame?: number) => {
    stage.selectContent()
    go({
      content,
      frame:
        frame ??
        (content === selection.contentId ? selection.frame : segmentFrames(group, content)[0]),
    })
  }
  const videoEditRoot =
    search.video === undefined
      ? undefined
      : generations.data?.find((job) => job.id === search.video)
  const copyBlocked =
    draft.hasUnsavedChanges || draft.state.kind === 'saving' ? '修改尚未保存，无法复制' : undefined
  const missingBlocker = missingFramesText(group)
  const baseBlocker = generationBlockerOf({
    modelsStatus: video.modelsStatus,
    readOnly,
    saveState: draft.state.kind,
    uploading: gate.uploading,
  })
  const generateBlocker = gate.preparing
    ? undefined
    : missingBlocker !== undefined && (baseBlocker === undefined || baseBlocker.transient)
      ? { reason: missingBlocker, transient: false }
      : baseBlocker
  const generateNotice = generationNoticeOf({
    aspectRatio: group.aspectRatio,
    model: video.options.model,
    submitError: draft.hasUnsavedChanges ? undefined : video.errorOf(group.index),
  })
  const generate = () =>
    gate.run(async (mounted) => {
      const saved = await draft.saveNow()
      if (saved === null || !mounted()) return
      const current = saved.groups.find((item) => item.video === group.video)
      if (current === undefined) {
        video.reportError(group.index, '该组已不在分镜中，无法出片；请刷新分镜')
        return
      }
      await video.submit(group.index, (choice) =>
        generateFilmVideo(conversationId, {
          ...choice,
          filmVersion: saved.filmVersion,
          runVersion: saved.runVersion,
          video: current.video,
        }),
      )
    })

  return (
    <>
      <div className="storyboard-workbench" ref={setRoot}>
        <StoryboardToolbar
          copy={{
            blocked: copyBlocked,
            done: '已复制完整提示词',
            label: '复制完整提示词',
            text: group.prompt,
          }}
          groups={groups.map(filmGroupSummary)}
          onGoShot={goShot}
          onWholeFilm={readOnly ? undefined : () => go({ wholeFilm: true })}
          position={position}
          status={
            <SaveStatus
              hasUnsavedChanges={draft.hasUnsavedChanges}
              onRetry={() => void draft.saveNow()}
              state={draft.state}
            />
          }
        />
        <div className="flex min-h-0 w-full min-w-0 flex-1 overflow-hidden">
          <section
            aria-label={`镜头组 ${group.index}`}
            className="storyboard-body"
            key={group.index}
            tabIndex={-1}
          >
            <FilmStage
              edit={{
                badge:
                  frame === undefined || frame.url === null
                    ? undefined
                    : frameBadgeOf(latestImageJob(frame.node), frame.url, seenImageJobs),
                openable:
                  frame !== undefined &&
                  (frame.url !== null || latestImageJob(frame.node) !== undefined),
                onEdit: (open) => {
                  if (frame === undefined) return
                  setImageEdit({
                    node: frame.node,
                    ...(open.kind === 'result' ? { initialKey: open.jobId } : {}),
                    trigger:
                      window.document.activeElement instanceof HTMLElement
                        ? window.document.activeElement
                        : null,
                  })
                },
              }}
              frame={selection.frame}
              generate={{
                busy:
                  cardAction === null || cardAction.error !== undefined ? null : cardAction.kind,
                error: cardAction?.node === frame?.node ? cardAction?.error : undefined,
                job:
                  frame === undefined
                    ? undefined
                    : latestNodeJob(imageJobs.data?.items ?? [], frame.node),
                onChoose: (url) => {
                  if (frame !== undefined) void chooseResult(frame, url)
                },
                onGenerate: () => {
                  if (frame !== undefined) void generateImage(frame)
                },
              }}
              group={group}
              onOpen={(image) => setMedia({ kind: 'image', ...image })}
              readOnly={readOnly}
              replace={replace}
              onStep={(frame) =>
                go({ content: contentOfFrame(group, selection.contentId, frame), frame })
              }
              take={
                selectedTake === undefined
                  ? undefined
                  : {
                      actions: takeActionsOf(selectedTake, { readOnly, refillable: false }),
                      onEditVideo: () => go({ video: selectedTake.job.id }),
                      onRefill: () => {},
                      take: selectedTake,
                    }
              }
            />
            <div aria-hidden className="storyboard-divider" />
            <div className="storyboard-script">
              <FilmScript
                copyBlocked={copyBlocked}
                frame={selectedTake === undefined ? selection.frame : undefined}
                group={group}
                onEdit={draft.update}
                onPickFrame={(position) =>
                  select(contentOfFrame(group, selection.contentId, position), position)
                }
                onPreview={(image) => setMedia({ kind: 'image', ...image })}
                onSelect={select}
                onUploadingChange={onTextUploading}
                readOnly={readOnly}
                selectedId={selectedTake === undefined ? selection.contentId : undefined}
                uploads={uploads}
              />
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
            </div>
          </section>
        </div>
        <VideoGenerationBar
          aspect={{
            description: FILM_ASPECT_DESCRIPTION,
            disabled: readOnly || gate.preparing || aspectSaving,
            onChange: (aspectRatio) => void changeAspect(aspectRatio),
            value: group.aspectRatio,
          }}
          blocker={generateBlocker}
          models={{ items: video.models, status: video.modelsStatus }}
          notice={generateNotice}
          onChange={video.setOptions}
          onGenerate={() => void generate()}
          shotIndex={group.index}
          submitting={gate.preparing}
          value={video.options}
        />
      </div>
      <MediaLightbox media={media} onClose={() => setMedia(null)} />
      {imageEdit === null ? null : (
        <FilmImageEdit
          conversationId={conversationId}
          group={group}
          latestJob={latestImageJob(imageEdit.node)}
          onApply={(previous, url) => applyEdited(imageEdit.node, previous, url)}
          onRegenerate={async (prompt) => {
            const saved = await savedFilm()
            await generateFilmImage(conversationId, {
              filmVersion: saved.filmVersion,
              node: imageEdit.node,
              runVersion: saved.runVersion,
              ...(prompt === undefined ? {} : { prompt }),
            })
            await queryClient.invalidateQueries({
              queryKey: imageEditConversationKey(conversationId),
            })
          }}
          onClose={(seen) => {
            if (seen !== undefined) setSeenImageJobs((current) => new Set(current).add(seen.id))
            setImageEdit(null)
          }}
          session={imageEdit}
        />
      )}
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
      <FilmConflictDialog resolve={draft.resolveConflict} state={draft.state} />
    </>
  )
}

function FilmProblems({ count }: { count: number }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-body font-semibold text-on-surface">
        分镜有 {count} 处问题，需要 AI 导演修改
      </p>
      <p className="text-body-sm text-on-surface-variant">
        请在对话中让 AI 导演检查分镜，修改完成后即可在此使用
      </p>
    </div>
  )
}

function FilmConflictDialog({
  resolve,
  state,
}: {
  resolve: (choice: 'mine' | 'theirs') => void
  state: FilmSaveState
}) {
  const conflicts = state.kind === 'conflict' ? state.conflicts : []
  const gone = conflicts.filter((conflict) => conflict.theirs === undefined)
  const names = (items: typeof conflicts) => items.map((conflict) => conflict.label).join('、')
  const note =
    gone.length === 0
      ? '选择「保留我的修改」可保留当前修改，选择「采用最新版本」可改用最新版本；无冲突的修改将保留'
      : gone.length === conflicts.length
        ? '以上各段已不在最新的分镜中，仅可选择「采用最新版本」'
        : `${names(gone)}已不在最新的分镜中，选择「保留我的修改」仅保留仍存在的段`
  return (
    <DialogRoot
      onOpenChange={(open) => !open && resolve('theirs')}
      open={state.kind === 'conflict'}
    >
      <DialogSurface aria-label="分镜版本冲突">
        <DialogHeader closeLabel="关闭（采用最新版本）" title="分镜版本冲突">
          {names(conflicts)}在编辑期间已被修改
        </DialogHeader>
        <DialogBody>
          <p className="text-body text-on-surface">{note}</p>
        </DialogBody>
        <DialogFooter>
          <span />
          <span className="flex gap-2">
            <Button onClick={() => resolve('theirs')} size="md" variant="ghost">
              采用最新版本
            </Button>
            <Button
              disabled={gone.length === conflicts.length}
              onClick={() => resolve('mine')}
              size="md"
            >
              保留我的修改
            </Button>
          </span>
        </DialogFooter>
      </DialogSurface>
    </DialogRoot>
  )
}
