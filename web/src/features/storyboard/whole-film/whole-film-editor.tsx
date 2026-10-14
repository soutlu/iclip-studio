/** 整片编辑器：视频编辑器的整片模式。把这段对话读得到的成片（自己的与继承的）放进素材区，从各条素材上挑段、
 * 在成片轨上交叉剪辑成一条整片；字幕取各段来源的口播识别结果，跟着画面走，只能改字；背景音乐上传或生成，
 * 自动对齐切点、口播处压低，预览时跟着画面放（见 use-film-music）。
 *
 * 编辑只存在浏览器里（ADR-0003），按对话一份。界面上不调声音；合成提交还没接上，「合成成片」先灰着。 */

import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { videoSnapshotUrl } from '@/shared/lib/media-url'
import { Button, IconButton } from '@/shared/ui/button'
import { DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { InlineAlert } from '@/shared/ui/inline-alert'
import { toast } from '@/shared/ui/toast'
import { VersionThumb } from '../components/version-thumb'
import { groupConversationVideos } from '../conversation-videos/video-groups'
import { useShotGenerations } from '../storyboard.api'
import { EditorPreview, type EditorPreviewHandle } from '../video-editor/editor-preview'
import { Thumbnail } from '../video-editor/editor-version-strip'
import { layoutPlay } from '../video-editor/play-layout'
import { useAudioPeaks, type PeaksState } from '../video-editor/use-media-analysis'
import { useMediaDurations } from '../video-editor/use-media-durations'
import { useStableValue } from '../video-editor/use-stable-value'
import {
  addManualSubtitle,
  canSplitAt,
  EMPTY_FILM,
  filmDuration,
  fitsInFilm,
  insertClockOf,
  insertSegment,
  MAX_FILM_SECONDS,
  moveSegment,
  putLane,
  removeManualSubtitle,
  removeSegment,
  segmentAt,
  segmentDuration,
  setManualText,
  setSentenceText,
  splitAt,
  trimSegment,
  type FilmState,
} from './film-draft'
import { MusicCard, SegmentCard, SubtitleCard } from './film-card'
import { MusicMenu } from './film-music-menu'
import {
  materialCatalog,
  materialName,
  type Material,
  type MaterialDuration,
} from './film-materials'
import { AddMenu, AddVideoRow } from './film-menus'
import {
  captionAt,
  latestSubtitles,
  projectSubtitles,
  subtitleSourceOf,
  type SubtitleSource,
} from './film-subtitles'
import { FilmTimeline, type FilmSelection, type LaneView, type MaterialPick } from './film-timeline'
import { useFilmDraft } from './use-film-draft'
import { useFilmMusic } from './use-film-music'
import { seedSubtitleJob, submitSubtitle, useConversationSubtitles } from './whole-film.api'
import './whole-film.css'

/** 时间线至少按这么多秒排：空轨、短片时刻度不至于太密。 */
const MIN_SCALE_SECONDS = 20
const LOADING_PEAKS: PeaksState = { kind: 'loading' }
const STORAGE_FAILURE = '当前浏览器无法保存草稿，关闭编辑器后整片内容将丢失'
const UNCOMPOSED_LABEL = '未合成'
const seconds = (value: number) => value.toFixed(1)
const posterOf = (url: string | undefined, at = 0) =>
  url === undefined ? undefined : videoSnapshotUrl(url, 320, at)

/** 按键落在输入框里时让给输入框自己（Cmd/Ctrl+Z 在那里是撤销打字）。 */
const isTextEntry = (target: EventTarget) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && target.type !== 'range'))

type Props = {
  conversationId: string
  /** 本对话此刻挂的需求单：重新识别字幕、生成音乐都归属到它；还没读到时这两样先不能提交。 */
  taskId: string | null | undefined
  onClose: () => void
}

const NO_TASK_YET = '任务信息读取中，请稍后重试'

export function WholeFilmEditor({ conversationId, taskId, onClose }: Props) {
  const queryClient = useQueryClient()
  const videos = useShotGenerations(conversationId)
  const subtitlesQuery = useConversationSubtitles(conversationId)
  const previewRef = useRef<EditorPreviewHandle>(null)
  const anchorRef = useRef<HTMLElement>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [playback, setPlayback] = useState({ playing: false, muted: true })
  // 生成面板挂在编辑器里（模态弹窗外的浮层拿不到焦点）。
  const [editorElement, setEditorElement] = useState<HTMLElement | null>(null)
  const [selection, setSelection] = useState<FilmSelection>()
  const [pick, setPick] = useState<MaterialPick>()
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(() => new Set())
  /** 脚注位置上要让人看到的一句话，下一次剪辑时收起。 */
  const [notice, setNotice] = useState<string | null>(null)
  const storageFailedRef = useRef(false)
  const noticeStorageFailure = () => {
    if (storageFailedRef.current) return
    storageFailedRef.current = true
    setNotice(STORAGE_FAILURE)
  }

  const catalog = useMemo(
    () =>
      videos.data === undefined ? undefined : materialCatalog(groupConversationVideos(videos.data)),
    [videos.data],
  )
  const known = useMemo(
    () => (catalog === undefined ? undefined : new Set(catalog.byJob.keys())),
    [catalog],
  )
  const draft = useFilmDraft({
    conversationId,
    known,
    onNotice: setNotice,
    onStorageFailure: noticeStorageFailure,
  })
  const film = draft?.film ?? EMPTY_FILM
  const { segments } = film
  const total = filmDuration(segments)
  const materialOf = (jobId: string) => catalog?.byJob.get(jobId)

  // 素材多长：记录上有就用，没有就开播放器去探。
  const probeUrls = useStableValue(
    catalog === undefined
      ? []
      : [...catalog.byJob.values()].flatMap((item) =>
          item.knownDuration === undefined ? [item.url] : [],
        ),
  )
  const durations = useMediaDurations(probeUrls)
  const durationOf = (material: Material): MaterialDuration =>
    material.knownDuration ?? durations[material.url]

  const lanes: LaneView[] = (draft?.lanes ?? []).flatMap((lane) => {
    const material = materialOf(lane.jobId)
    const group = catalog?.groups.find((item) => item.id === lane.groupId)
    if (material === undefined || group === undefined) return []
    return [
      {
        lane,
        label: group.label,
        material,
        versions: group.versions,
        duration: durationOf(material),
      },
    ]
  })
  const scale = Math.max(MIN_SCALE_SECONDS, total, ...lanes.map((view) => view.duration ?? 0))

  const peakUrls = useStableValue([
    ...new Set([
      ...lanes.map((view) => view.material.url),
      ...segments.flatMap((segment) => materialOf(segment.sourceJobId)?.url ?? []),
    ]),
  ])
  const peaks = useAudioPeaks(peakUrls)

  // ---------- 字幕 ----------

  const latest = useMemo(
    () => (subtitlesQuery.data === undefined ? undefined : latestSubtitles(subtitlesQuery.data)),
    [subtitlesQuery.data],
  )
  const sourceOf = (jobId: string): SubtitleSource | undefined =>
    latest === undefined ? undefined : subtitleSourceOf(latest.get(jobId))
  const { subtitles, statuses } = projectSubtitles(film, sourceOf)

  // ---------- 预览 ----------

  const current = useStableValue(
    layoutPlay(
      segments.flatMap((segment) => {
        const url = materialOf(segment.sourceJobId)?.url
        return url === undefined ? [] : [{ mediaUrl: url, start: segment.start, end: segment.end }]
      }),
    ),
  )
  const firstUrl = current[0]?.mediaUrl

  // ---------- 选中 ----------

  // 选中的段或字幕不在了（撤销、删掉、换了识别结果）就当没选。
  const selectedIndex =
    selection?.kind === 'segment'
      ? segments.findIndex((segment) => segment.id === selection.id)
      : -1
  const selectedSegment = segments[selectedIndex]
  const subtitleIndex =
    selection?.kind === 'subtitle' ? subtitles.findIndex((item) => item.key === selection.key) : -1
  const selectedSubtitle = subtitles[subtitleIndex]

  // ---------- 操作 ----------

  const apply = (
    next: FilmState | ((present: FilmState) => FilmState) | undefined,
    typing?: string,
  ) => {
    if (next === undefined || draft === undefined) return
    draft.apply(next, typing)
    if (typing === undefined) setNotice(null)
  }

  // ---------- 音乐 ----------

  const music = useFilmMusic({
    conversationId,
    taskId,
    film,
    total,
    subtitles,
    apply,
    onNotice: setNotice,
    playback,
    currentTime,
  })
  // 音乐读出来了才选得中；拿掉、换了还在读的就当没选。
  const musicSelected = selection?.kind === 'music' && music.card !== undefined
  const shownSelection: FilmSelection =
    selectedSegment !== undefined || selectedSubtitle !== undefined || musicSelected
      ? selection
      : undefined

  const insert = (target: MaterialPick, index: number) => {
    const duration = segmentDuration(target)
    if (!fitsInFilm(segments, duration)) {
      setNotice(
        `整片已有 ${seconds(total)} 秒，放不下这 ${seconds(duration)} 秒；请先删减成片轨上的段`,
      )
      return
    }
    const next = insertSegment(film, target, index, crypto.randomUUID())
    if (next === undefined) return
    apply(next)
    // 播放头移到新段的结尾：接着按回车插入，下一段就排在它后面。
    const end = insertClockOf(segments, index) + duration
    requestAnimationFrame(() => previewRef.current?.previewAt(end, 'end'))
  }

  const retry = async (sourceJobId: string) => {
    if (retrying.has(sourceJobId)) return
    if (taskId === undefined) {
      setNotice(NO_TASK_YET)
      return
    }
    setRetrying((busy) => new Set(busy).add(sourceJobId))
    try {
      const job = await submitSubtitle({ conversationId, sourceJobId, taskId })
      seedSubtitleJob(queryClient, conversationId, job)
    } catch (error) {
      toast.error(errorMessageOf(error, '字幕识别提交失败'))
    } finally {
      setRetrying((busy) => {
        const next = new Set(busy)
        next.delete(sourceJobId)
        return next
      })
    }
  }

  const addMaterial = (material: Material) => {
    if (draft === undefined) return
    draft.setLanes(putLane(draft.lanes, { groupId: material.groupId, jobId: material.jobId }))
    if (pick?.groupId === material.groupId && pick.sourceJobId !== material.jobId)
      setPick(undefined)
  }

  const switchVersion = (view: LaneView, material: Material) => {
    if (material.jobId === view.material.jobId) return
    addMaterial(material)
    setNotice(
      `已换成 ${material.version}，之后从这条素材轨挑的段用 ${material.version}；成片轨上已有的段不变`,
    )
  }

  const addSubtitleBlocked =
    draft === undefined || segmentAt(segments, currentTime) !== undefined
      ? undefined
      : '播放头处没有画面，无法添加字幕；请把播放头移到成片轨的段上'
  const addSubtitle = () => {
    const id = crypto.randomUUID()
    const next = addManualSubtitle(film, currentTime, id)
    if (next === undefined) return
    apply(next)
    setSelection({ kind: 'subtitle', key: id })
  }

  const removeSelected = () => {
    if (selectedSegment === undefined) return
    apply(removeSegment(film, selectedSegment.id))
    setSelection(undefined)
  }

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isTextEntry(event.target) || !(event.metaKey || event.ctrlKey)) return
    if (event.key.toLowerCase() !== 'z' || draft === undefined) return
    event.preventDefault()
    if (event.shiftKey) {
      if (draft.canRedo) draft.redo()
    } else if (draft.canUndo) draft.undo()
  }

  // ---------- 脚注 ----------

  const footnote = (() => {
    if (notice !== null) return notice
    if (draft === undefined) return ''
    if (pick !== undefined)
      return '拖动两端调整选区，按住选区拖到上面的成片轨；也可按回车插入到播放头处'
    if (selectedSegment !== undefined)
      return `选中第 ${selectedIndex + 1} 段：拖动两端可裁剪，按住中间拖动可调整顺序`
    if (selectedSubtitle !== undefined)
      return `选中第 ${subtitleIndex + 1} 条字幕：在卡片中改字，时间跟着画面走`
    const aboutMusic = music.footnote(musicSelected)
    if (aboutMusic !== undefined) return aboutMusic
    if (lanes.length === 0 && segments.length === 0) return '时间线为空，请从「添加」放入视频'
    if (segments.length === 0) return '在素材轨上拖选一段，拖到上面的成片轨'
    return '素材轨底部的细条是已用进成片轨的区间；声音在合成时统一处理'
  })()

  // ---------- 渲染 ----------

  const toolButtons = (
    <>
      <span aria-hidden="true" className="video-editor-bar-divider" />
      <IconButton
        disabled={draft?.canUndo !== true}
        label="撤销"
        name="undo"
        onClick={() => draft?.undo()}
        size="sm"
      />
      <IconButton
        disabled={draft?.canRedo !== true}
        label="重做"
        name="redo"
        onClick={() => draft?.redo()}
        size="sm"
      />
      <span aria-hidden="true" className="video-editor-bar-divider" />
      <Button
        className="video-editor-bar-button video-editor-tool"
        disabled={draft === undefined || !canSplitAt(segments, currentTime)}
        leadingIcon="split"
        onClick={() => apply(splitAt(film, currentTime, crypto.randomUUID()))}
        size="md"
        variant="ghost"
      >
        <span className="video-editor-tool-label">拆分</span>
      </Button>
      <Button
        className="video-editor-bar-button video-editor-tool"
        disabled={selectedSegment === undefined}
        leadingIcon="delete"
        onClick={removeSelected}
        size="md"
        variant="ghost"
      >
        <span className="video-editor-tool-label">删除</span>
      </Button>
      {catalog === undefined || draft === undefined ? null : (
        <AddMenu catalog={catalog} durationOf={durationOf} onAdd={addMaterial} />
      )}
    </>
  )

  const readout = (
    <span className="video-editor-readout">
      共 <b>{seconds(total)}</b> 秒 · 上限 {MAX_FILM_SECONDS} 秒
    </span>
  )

  const timeline =
    videos.isError && catalog === undefined ? (
      <p className="video-editor-timeline-loading" role="alert">
        {errorMessageOf(videos.error, '读取视频记录失败')}
        <Button onClick={() => void videos.refetch()} size="md" variant="ghost">
          重试
        </Button>
      </p>
    ) : catalog === undefined || draft === undefined ? (
      <p className="video-editor-timeline-loading" role="status">
        正在读取成片…
      </p>
    ) : (
      <FilmTimeline
        addSubtitleBlocked={addSubtitleBlocked}
        addVideo={<AddVideoRow catalog={catalog} durationOf={durationOf} onAdd={addMaterial} />}
        anchorRef={anchorRef}
        currentTime={currentTime}
        durationOf={durationOf}
        lanes={lanes}
        materialOf={materialOf}
        onAddSubtitle={addSubtitle}
        onDelete={(id) => {
          apply(removeSegment(film, id))
          setSelection(undefined)
        }}
        onInsert={insert}
        onMove={(id, before) => apply(moveSegment(film, id, before))}
        onPick={(next) => {
          setPick(next)
          if (next !== undefined) setSelection(undefined)
        }}
        onRetry={(sourceJobId) => void retry(sourceJobId)}
        // 拖动时收起字幕卡与音乐卡；选中的段留着（拖的可能就是它的两端）。
        onScrub={() => setSelection((value) => (value?.kind === 'segment' ? value : undefined))}
        onSeek={(time) => previewRef.current?.previewAt(time)}
        onSelect={(next) => {
          setSelection(next)
          if (next !== undefined) setPick(undefined)
        }}
        music={music.view}
        musicAdd={<MusicMenu container={editorElement} {...music.menu} />}
        onMoveMusic={music.move}
        onRemoveMusic={() => {
          music.remove()
          setSelection(undefined)
        }}
        onSwitchVersion={switchVersion}
        onTrim={(id, edge, value) => apply(trimSegment(film, id, edge, value))}
        onTrimPreview={(clock, edge) => previewRef.current?.previewAt(clock, edge)}
        peaksOf={(url) => peaks.get(url) ?? LOADING_PEAKS}
        pick={pick}
        retrying={retrying}
        scale={scale}
        segments={segments}
        selection={shownSelection}
        statuses={statuses}
        subtitles={subtitles}
        total={total}
      />
    )

  const segmentMaterial =
    selectedSegment === undefined ? undefined : materialOf(selectedSegment.sourceJobId)
  const subtitleMaterial =
    selectedSubtitle === undefined
      ? undefined
      : materialOf(
          segments.find((segment) => segment.id === selectedSubtitle.segmentId)?.sourceJobId ?? '',
        )
  const card =
    selectedSegment !== undefined && segmentMaterial !== undefined ? (
      <SegmentCard
        anchorRef={anchorRef}
        end={selectedSegment.end}
        frame={videoSnapshotUrl(segmentMaterial.url, 60, selectedSegment.start)}
        key={selectedSegment.id}
        onClose={() => setSelection(undefined)}
        position={selectedIndex + 1}
        source={materialName(segmentMaterial)}
        start={selectedSegment.start}
      />
    ) : selectedSubtitle !== undefined ? (
      <SubtitleCard
        anchorRef={anchorRef}
        key={selectedSubtitle.key}
        onClose={() => setSelection(undefined)}
        onRemove={
          selectedSubtitle.kind === 'manual'
            ? () => {
                apply(removeManualSubtitle(film, selectedSubtitle.textKey))
                setSelection(undefined)
              }
            : undefined
        }
        onText={(text) =>
          apply(
            selectedSubtitle.kind === 'manual'
              ? setManualText(film, selectedSubtitle.textKey, text)
              : setSentenceText(film, selectedSubtitle.textKey, text),
            selectedSubtitle.textKey,
          )
        }
        position={subtitleIndex + 1}
        source={
          selectedSubtitle.kind === 'manual' || subtitleMaterial === undefined
            ? undefined
            : materialName(subtitleMaterial)
        }
        text={selectedSubtitle.text}
      />
    ) : musicSelected && music.card !== undefined ? (
      <MusicCard
        anchorRef={anchorRef}
        detail={music.card.detail}
        lines={music.card.lines}
        onClose={() => setSelection(undefined)}
        onRegenerate={music.card.onRegenerate}
        onRemove={() => {
          music.remove()
          setSelection(undefined)
        }}
        title={music.card.title}
      />
    ) : null

  const versions = (
    <div aria-label="视频版本" className="video-editor-versions" role="group">
      <VersionThumb
        label={UNCOMPOSED_LABEL}
        disabled
        name={`${UNCOMPOSED_LABEL}的整片`}
        onClick={() => {}}
        selected
      >
        <Thumbnail key={firstUrl} src={posterOf(firstUrl)} />
      </VersionThumb>
    </div>
  )

  return (
    <DialogRoot open onOpenChange={(open) => !open && onClose()}>
      <DialogSurface
        aria-describedby={undefined}
        className="video-editor-dialog"
        onEscapeKeyDown={(event) => {
          // 有选中或选区时 Escape 先收起它们，再按一次才关编辑器。
          if (shownSelection === undefined && pick === undefined) return
          event.preventDefault()
          setSelection(undefined)
          setPick(undefined)
        }}
        onInteractOutside={(event) => event.preventDefault()}
        onKeyDown={keyDown}
      >
        <DialogHeader
          actions={
            <Button
              className="video-editor-compose"
              disabled
              leadingIcon="video"
              size="md"
              title={music.composeBlocked ?? '整片合成尚未开放'}
            >
              合成成片
            </Button>
          }
          className="video-editor-header border-0"
          closeLabel="关闭视频编辑"
          title={
            <span className="video-editor-title">
              <span>编辑视频</span>
              <span className="text-body-sm font-normal text-on-surface-muted">整片</span>
            </span>
          }
        />
        <div
          aria-label="整片编辑器"
          className="video-editor whole-film-editor"
          ref={setEditorElement}
        >
          <EditorPreview
            backdrop={{ current: posterOf(firstUrl), original: undefined }}
            barEnd={
              <Button
                className="video-editor-bar-button"
                disabled
                leadingIcon="download"
                size="md"
                title="合成后可下载"
                variant="ghost"
              >
                下载
              </Button>
            }
            caption={captionAt(subtitles, currentTime)}
            contentKey="whole-film"
            current={draft === undefined ? undefined : current}
            currentTime={currentTime}
            emptyMessage="成片轨还是空的"
            footnote={
              <>
                {subtitlesQuery.isError ? (
                  <InlineAlert
                    action={{ label: '重试', onClick: () => void subtitlesQuery.refetch() }}
                    message={errorMessageOf(subtitlesQuery.error, '读取字幕记录失败')}
                  />
                ) : null}
                {videos.isError && catalog !== undefined ? (
                  <InlineAlert
                    action={{ label: '重试', onClick: () => void videos.refetch() }}
                    message={errorMessageOf(videos.error, '读取视频记录失败')}
                  />
                ) : null}
                <p className="video-editor-footnote" role={notice === null ? undefined : 'status'}>
                  {footnote}
                </p>
              </>
            }
            onPlay={() => {
              setSelection(undefined)
              music.prime()
            }}
            onPlaybackChange={setPlayback}
            onTime={setCurrentTime}
            original={undefined}
            overlay={card}
            poster={posterOf(firstUrl)}
            readout={readout}
            ref={previewRef}
            timeline={timeline}
            tools={toolButtons}
            versions={versions}
          />
        </div>
      </DialogSurface>
    </DialogRoot>
  )
}
