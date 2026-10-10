/** 制作页的组合根：读 AI 导演的工程、草稿、出片与路由参数在这里，分给顶栏、舞台、文案列（末尾是本组成片）、出片栏与浮层。
 *
 * 路由参数沿用分镜页的：`shot` 是第几组，`content` 是选中的段，`frame` 是舞台上那张图在这组 `frames` 里的位置，
 * `video` 是视频编辑器开在哪条出片上。两个文件检查出问题时整页只写问题数，等 AI 导演改好。
 * 出片、换图、生图都先把改了的字存下，再按存好的那一版发，发出去的和文件里的一样；画幅照文件，只显示。
 * 生成的图不会自动用上：生成卡或编辑器里点「选用这张」才写进运行文件。这组参考图列表里有没选用的就不能出片，
 * 出片栏的状态行写缺哪几张。顶栏「复制完整提示词」复制后端拼好的这组正文（`group.prompt`）。
 * 在用或生成过的那张能开图片编辑器（`FilmImageEdit`），编辑与重新生成的结果在舞台上挂「有新结果」，点开就是那条。 */

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
import {
  chooseFilmImage,
  filmQueryKey,
  generateFilmImage,
  generateFilmVideo,
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
  /** 视频编辑器开在哪条出片记录上；换组就关掉。 */
  video?: string | undefined
}

/** 出片闸门按组号记上传；换图不属于哪一组，用组号从 1 起之外的 0。 */
const REPLACE_UPLOAD = 0

/** 文案列里往字里插入的图在上传：同样不属于哪一组，用 -1。 */
const TEXT_UPLOAD = -1

export function FilmReader(props: ArtifactRendererProps) {
  return <FilmWorkspace key={props.conversationId} {...props} />
}

function FilmWorkspace({ conversationId, readOnly }: ArtifactRendererProps) {
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
  // 选中的成片不在本组列表里了就回到图。
  const selectedTake = takes?.find((take) => take.job.id === stage.takeId)
  // 生成卡上的提交：哪张图、在生成还是在选用，与没被收下的原话（挨着按钮说，不弹全局提示）。
  const [cardAction, setCardAction] = useState<{
    node: string
    kind: 'generate' | 'choose'
    error?: string
  } | null>(null)

  /** 先存改了的字，按存好的那一版发；没存下就不发。 */
  const savedFilm = async () => {
    const saved = await draft.saveNow()
    if (saved === null) throw new UserFacingError('修改尚未保存，无法继续；请处理保存问题后重试')
    return saved
  }
  /** 给一张图换地址（null 是取消生成图的选用）：先存改了的字，按存好的那一版换，答复的整页直接放进缓存。 */
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
    // 舞台在放成片时看不到图，不收拖放与粘贴。
    disabled: readOnly || selectedTake !== undefined,
    frame,
    onReplace: (target, url) => applyImage(target.node, url),
  })
  // 图片编辑器开在哪张图上；关窗时点开看过的那条结果记成看过，舞台上不再挂它的角标（只记本次会话）。
  const [imageEdit, setImageEdit] = useState<FilmEditSession | null>(null)
  const [seenImageJobs, setSeenImageJobs] = useState<ReadonlySet<string>>(() => new Set())
  const latestImageJob = (node: string) => latestNodeImageJob(imageJobs.data?.items ?? [], node)
  /** 编辑器里选用与撤销：这张图此刻已经不是 `previous` 了（别人刚换过）就不换，免得盖掉。null 是没有选用。 */
  const applyEdited = async (node: string, previous: string | null, url: string | null) => {
    const latest = queryClient.getQueryData<{ film: FilmView }>(filmQueryKey(conversationId))
    const current = latest?.film.groups
      .flatMap((item) => item.frames)
      .find((item) => item.node === node)?.url
    if (current !== previous) throw new UserFacingError('该图片已被更换，无法继续；请确认后重试')
    await applyImage(node, url)
  }
  // 有图在换时先别出片：发出去的参考图要是换好的那张。换图一次只有一张、与组无关，记在一个不会是组号的键上。
  const reportUploading = useEffectEvent((busy: boolean) =>
    gate.onUploadingChange(REPLACE_UPLOAD, busy),
  )
  useEffect(() => {
    reportUploading(replace.busy)
    return () => reportUploading(false)
  }, [replace.busy])
  // 字里在传的图：哪几个编辑器有图在传；传完之前不出片，传好的图落进字里才会存下。
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
  /** 生成卡上「选用这张」：把那次生成出来的图登记进运行文件并选用，舞台换成它。 */
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

  // 正看着的那张图在 `frames` 里挪了位置（选用机位图插进列表、取消选用移出列表，后面的跟着挪）：舞台跟着那张图走，
  // 不停在原来的位置上换成别的图。只在同一组里跟，换组时位置本来就重来；那张图不在这组了就交给选段的规则落位。
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

  // 选段不指定图时：选的还是这段就停在当前图，换了段就到它挂的第一张。舞台回到图。
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
  // 提交途中按钮自己写着「提交中」，不另说原因。参考图有没选用的一直挡着（后端也会拒），排在保存、上传这些暂态之前，
  // 免得每次自动保存时原因从状态行上消失；只读与冲突、保存失败照旧先说。
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
    // 改过之后原因就过期了，等下一次出片再说；存盘状态那一格有自己的提示，不重复说。
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
          // 后端拼好的正文，与这组出片时发的逐字相同；有没存下的改动时（保存中、保存失败、版本冲突）它还是旧的，
          // 存好之前不让复制，几种情况同一句原因。
          copy={{
            blocked:
              draft.hasUnsavedChanges || draft.state.kind === 'saving'
                ? '修改尚未保存，无法复制'
                : undefined,
            done: '已复制完整提示词',
            label: '复制完整提示词',
            text: group.prompt,
          }}
          groups={groups.map(filmGroupSummary)}
          onGoShot={goShot}
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
          {/* 可聚焦，点舞台空白处也算焦点在工作台里，↑↓ 切组才收得到。 */}
          <section
            aria-label={`镜头组 ${group.index}`}
            className="storyboard-body"
            // 换组整块重挂：编辑器、箭头与滚动位置都属于原来那组。
            key={group.index}
            tabIndex={-1}
          >
            <FilmStage
              edit={{
                badge:
                  frame === undefined || frame.url === null
                    ? undefined
                    : frameBadgeOf(latestImageJob(frame.node), frame.url, seenImageJobs),
                // 生成过没选用的也要能打开：版本条里选一版就是选用。
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
                      // 制作页没有回填，按钮不出现。
                      onRefill: () => {},
                      take: selectedTake,
                    }
              }
            />
            <div aria-hidden className="storyboard-divider" />
            <div className="storyboard-script">
              <FilmScript
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
                // 放成片时文案列不标选中：点哪段（包括原来选中的那段）都回到图。
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
          aspect={{ kind: 'fixed', value: group.aspectRatio }}
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
          root={videoEditRoot}
          shotIndex={videoEditRoot?.shotIndex ?? undefined}
        />
      )}
      <FilmConflictDialog resolve={draft.resolveConflict} state={draft.state} />
    </>
  )
}

/** 两个文件检查出问题：只写有几处，改法交给 AI 导演。 */
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

/** 写回时撞上别人的改动，且改的是同一段：留我的还是用最新的。新版本里已经没有的段只能用最新的。 */
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
