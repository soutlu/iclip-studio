import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { canvasForVideo } from './canvas-size'
import type { CatalogItem } from './composition/catalog'
import type { FilmClip } from './composition/film'
import { shownIn } from './dubbing'
import type { DropGhost } from './film-timeline'
import { itemDurationMs, playheadSpot } from './items'
import type { ShownLocale } from './locales'
import { videoAudioQuery, videoSizeQuery } from './material-media'
import { NO_PICKS, type PickedSpan } from './materials'
import { snapDropToBeats, type BeatGrid } from './music-beats'
import {
  landingOn,
  musicRowTarget,
  rowOpeningAmong,
  rowsOf,
  type RowTarget,
  type Zone,
} from './placement'
import type { FilmView, NewAudio, useFilmSession } from './use-film-session'
import { piecesOf, type useMaterials } from './use-materials'
import type { usePreviewPlayback } from './use-preview-playback'
import type { useTimelineZoom } from './use-timeline-zoom'
import { ownedIn } from './voice-lines'

const PICK_FIRST_TEXT = '尚未选中镜头，无法加入轨道；请先在「镜头」页签中选中镜头范围'
const ADDING_ITEM_TEXT = '上一个元素或模板正在加入轨道，请稍后再试'
const ADDING_PICKS_TEXT = '选中的镜头正在加入轨道，请稍后再试'

/**
 * 把素材、元素、模板和音频加入轨道：拖着时算落点（吸附开关、落点预览 `ghost`），松手或点按钮时写进工程，
 * 要新开一行时连同别的片段一起重新编号。加入成功后退出素材预览。
 */
export function useTrackPlacement({
  session,
  film,
  clips,
  allClips,
  locale,
  zoom,
  musicBeats,
  player,
  materials,
  notice,
}: {
  session: ReturnType<typeof useFilmSession>
  film: FilmView | null
  clips: readonly FilmClip[]
  allClips: readonly FilmClip[]
  locale: ShownLocale
  zoom: ReturnType<typeof useTimelineZoom>
  musicBeats: ReadonlyMap<string, BeatGrid>
  player: ReturnType<typeof usePreviewPlayback>
  materials: ReturnType<typeof useMaterials>
  notice: (message: string) => void
}) {
  const { timelineRef, scale } = zoom
  const { playhead, playheadNow } = player
  const { keyframes, leaveMaterial, setPicks, picked } = materials
  const queryClient = useQueryClient()
  const [ghost, setGhost] = useState<DropGhost | null>(null)
  const [snap, setSnap] = useState(true)
  /**
   * 拖着的素材、组件、块或音频（长 `duration` 毫秒，放进 `zone` 区）会落在哪：开着吸附时先吸到别的片段的两端或
   * 播放头上，都没吸上再吸配乐的节拍，然后避开同一行的片段。
   */
  const landingAt = (clientX: number, clientY: number, duration: number, zone: Zone = 'visual') => {
    const point = timelineRef.current?.locate(clientX, clientY, zone) ?? null
    if (point === null) return null
    // 拖进声音区的只有配乐：不进配音行、原声行
    const row = zone === 'audio' ? musicRowTarget(rowsOf(clips), point.row) : point.row
    const snapped = snap
      ? snapDropToBeats(point.timeMs, duration, clips, playhead, musicBeats, scale.pps)
      : { ms: point.timeMs, guideMs: null }
    // 新开的一行上没有别的片段，放在哪里都不会重叠
    const start = 'track' in row ? landingOn(clips, row, snapped.ms, duration).start : snapped.ms
    return {
      row,
      start,
      duration,
      guideMs: start === snapped.ms ? snapped.guideMs : null,
    }
  }

  /** `row` 这一行是几号；要新开一行时，连同别的片段要换成的行号。`movedId` 是要搬过去的那个片段。 */
  const trackFor = (row: RowTarget, movedId?: string) =>
    'track' in row
      ? { track: row.track, renumber: undefined }
      : rowOpeningAmong(
          allClips,
          shownIn(locale.code, film?.voiceMode ?? 'original', ownedIn(allClips)),
          row.zone,
          row.insertAt,
          movedId,
        )

  // 防止前一次入轨尚未完成时重入，避免快速连点导致同一批片段重复加入
  const addingPicksRef = useRef(false)
  /**
   * 将选中的素材区间批量首尾相接加入轨道（记为一步撤销）：传入 `at` 时从指定轨道与时刻起排，否则追加至主轨末尾；返回是否成功加入。
   */
  const place = (
    chosen: readonly PickedSpan[],
    at?: { row: RowTarget; start: number },
  ): Promise<boolean> => {
    if (chosen.length === 0) return Promise.resolve(false)
    if (addingPicksRef.current) {
      notice(ADDING_PICKS_TEXT)
      return Promise.resolve(false)
    }
    // 仅在确认素材包含音轨时标记为有声；无音轨或检测失败一律按静音写入（素材区预加载多半已命中缓存）
    const audible = new Map(
      [...new Set(chosen.map(({ material }) => material.url))].map((url) => [
        url,
        queryClient.fetchQuery(videoAudioQuery(url)).then(
          (found) => found,
          () => false,
        ),
      ]),
    )
    // 时间线尚无任何视频片段（含隐藏片段）时，自动将画布尺寸适配为首个加入片段的画幅；读不到宽高时保持不变
    const first = chosen[0]?.material.url
    const canvas =
      first === undefined || clips.some((clip) => clip.kind === 'video')
        ? undefined
        : queryClient.fetchQuery(videoSizeQuery(first)).then(
            (size) => (size === null ? undefined : canvasForVideo(size)),
            () => undefined,
          )
    const pieces = chosen.flatMap((each) => piecesOf(each, keyframes))
    const add = async () => {
      const sounding = new Set<string>()
      for (const [url, found] of audible) if (await found) sounding.add(url)
      const spot = at === undefined ? undefined : trackFor(at.row)
      const added = session.addVideos(
        pieces.map((piece) => ({ ...piece, muted: !sounding.has(piece.src) })),
        spot === undefined || at === undefined ? undefined : { track: spot.track, start: at.start },
        spot?.renumber,
        await canvas,
      )
      if (added) leaveMaterial()
      return added
    }
    addingPicksRef.current = true
    return add().finally(() => {
      addingPicksRef.current = false
    })
  }
  /** 将当前选区加入轨道（落位规则同 `place`），成功后清空选区。 */
  const placePicks = (chosen: readonly PickedSpan[], at?: { row: RowTarget; start: number }) =>
    void place(chosen, at).then((added) => {
      if (added) setPicks(NO_PICKS)
    })
  const insert = () => {
    if (picked.length === 0) notice(PICK_FIRST_TEXT)
    else placePicks(picked)
  }

  // 防止前一条元素或模板尚未落位时重入，避免并发调用均按旧时间线状态计算落点
  const addingItemRef = useRef(false)
  /** 将组件库单个条目加入轨道的 `at` 位置。 */
  const placeItem = (item: CatalogItem, at: { row: RowTarget; start: number }) => {
    if (addingItemRef.current) {
      notice(ADDING_ITEM_TEXT)
      return
    }
    addingItemRef.current = true
    const spot = trackFor(at.row)
    void session
      .addItem(item, {}, { track: spot.track, start: at.start }, spot.renumber)
      .then((added) => {
        if (added) leaveMaterial()
      })
      .finally(() => {
        addingItemRef.current = false
      })
  }
  const addAtPlayhead = (item: CatalogItem) =>
    placeItem(item, playheadSpot(clips, item, playheadNow(), itemDurationMs(item, clips)))

  /** 将单条完整音频加入轨道的 `at` 位置。 */
  const placeAudio = (audio: NewAudio, at: { row: RowTarget; start: number }) => {
    const spot = trackFor(at.row)
    if (session.addAudio(audio, { track: spot.track, start: at.start }, spot.renumber))
      leaveMaterial()
  }
  return {
    ghost,
    setGhost,
    snap,
    setSnap,
    landingAt,
    trackFor,
    place,
    placePicks,
    insert,
    placeItem,
    addAtPlayhead,
    placeAudio,
  }
}
