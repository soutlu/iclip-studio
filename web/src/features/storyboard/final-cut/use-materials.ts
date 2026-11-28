import { useCallback, useMemo, useRef, useState, type RefObject } from 'react'
import { groupConversationVideos } from '../conversation-videos/video-groups'
import { keyframeRanges } from '../editing/keyframe-segments'
import { useStableValue } from '../editing/use-stable-value'
import { useShotGenerations } from '../storyboard.api'
import type { VideoClip } from './composition/film'
import { takeShots, useKeyframeIndexes, useVideoAudio, type KeyframeStates } from './material-media'
import type { MaterialPreviewControl, MaterialView } from './material-preview'
import {
  materialCatalog,
  NO_PICKS,
  orderedPicks,
  shotAt,
  spanPieces,
  withTakePicks,
  type Material,
  type MaterialPicks,
  type MaterialTake,
  type MediaSpan,
  type PickedSpan,
  type TakeFilter,
  type TakePicks,
} from './materials'
import { createPlayheadClock } from './playhead-clock'
import type { PreviewControl } from './preview-player'

const shotNumberOf = (ms: number, url: string, keyframes: KeyframeStates) => {
  const state = keyframes.get(url)
  return state?.kind === 'ready' ? shotAt(keyframeRanges(state.index), ms / 1000) : undefined
}

/** 将选区单段按镜头切点拆分为待入轨片段，附带素材地址与展示名（如「A · 镜头 2」）。 */
export const piecesOf = ({ material, span }: PickedSpan, keyframes: KeyframeStates) =>
  spanPieces(span, takeShots(keyframes.get(material.url))).map((piece) => {
    const shot = shotNumberOf(piece.mediaStart, material.url, keyframes)
    return {
      ...piece,
      src: material.url,
      label: `${material.takeLetter} · ${shot === undefined ? material.version : `镜头 ${shot}`}`,
    }
  })

/** 计算素材预览区间跨越的镜头编号文案（按入轨拆分规则计算）。 */
const shotsLabelOf = (span: MediaSpan, url: string, keyframes: KeyframeStates) => {
  const pieces = spanPieces(span, takeShots(keyframes.get(url)))
  const first = pieces[0]
  const last = pieces.at(-1)
  if (first === undefined || last === undefined) return ''
  const from = shotNumberOf(first.mediaStart, url, keyframes)
  const to = shotNumberOf(last.mediaStart, url, keyframes)
  if (from === undefined || to === undefined) return ''
  return from === to ? ` · 镜头 ${from}` : ` · 镜头 ${from}–${to}`
}

/**
 * final-cut 编辑器里的素材：对话里出的素材片（「镜头」页签按它列）、素材和工程视频片段的镜头索引与音轨、
 * 「镜头」页签的选区、筛选和分组折叠，以及舞台上的素材预览。`videoClips` 是工程里的视频片段，`previewRef`
 * 是 final-cut 的预览（切入素材预览时先暂停它）。
 */
export function useMaterials(
  conversationId: string,
  videoClips: readonly VideoClip[],
  previewRef: RefObject<PreviewControl | null>,
) {
  const [materialView, setMaterialView] = useState<MaterialView | null>(null)
  const [materialMs, setMaterialMs] = useState(0)
  // 供素材预览态下播放控制条订阅的时钟，与 materialMs 同步写入，更新频率跟随素材预览时间回调
  const [materialClock] = useState(createPlayheadClock)
  const followMaterial = (ms: number) => {
    setMaterialMs(ms)
    materialClock.set(ms)
  }
  const [materialPlaying, setMaterialPlaying] = useState(false)
  const materialPreviewRef = useRef<MaterialPreviewControl | null>(null)
  const leaveMaterial = () => {
    setMaterialView(null)
    setMaterialPlaying(false)
  }

  const videos = useShotGenerations(conversationId)
  const materials = useMemo(
    () => materialCatalog(groupConversationVideos(videos.data ?? [])),
    [videos.data],
  )
  // 「原片截取」标题里写的素材名：视频片段按地址在出片的各个版本里找
  const sourceNames = useMemo(
    () =>
      new Map(
        [...materials.byJob.values()].map((item) => [
          item.url,
          `${item.groupLabel} · ${item.takeLetter} · ${item.versionNumber}`,
        ]),
      ),
    [materials],
  )
  // 识别字幕时视频片段按地址对上素材片；同一个地址对上几条时取素材目录里排在前面的那条
  const takeOfUrl = useMemo(() => {
    const found = new Map<string, string>()
    for (const item of materials.byJob.values())
      if (!found.has(item.url)) found.set(item.url, item.jobId)
    return found
  }, [materials])
  const [pickedVersions, setPickedVersions] = useState<Readonly<Record<string, string>>>({})
  // 「镜头」页签的入轨筛选与分组折叠状态：托管在页签之外（同元素、模板页签的筛选），切走页签后返回仍可保持
  const [takeFilter, setTakeFilter] = useState<TakeFilter>('all')
  const [closedGroups, setClosedGroups] = useState<ReadonlySet<string>>(() => new Set())
  const versionOf = (take: MaterialTake): Material =>
    take.versions.find((item) => item.jobId === pickedVersions[take.id]) ?? take.latest
  // 预加载「镜头」页签当前展示版本及工程视频片段所引用的全部素材（含未展示的旧版本）的镜头索引、总时长与音轨状态：
  // 确保加入轨道时无需额外等待，同时满足裁剪与「原片截取」对素材总时长的依赖
  const videoUrls = useStableValue(
    [
      ...new Set([
        ...materials.groups.flatMap((group) => group.takes.map((take) => versionOf(take).url)),
        ...videoClips.map((clip) => clip.src),
      ]),
    ].sort(),
  )
  const keyframes = useKeyframeIndexes(videoUrls)
  const audioTracks = useVideoAudio(videoUrls)
  const [picks, setPicks] = useState<MaterialPicks>(NO_PICKS)
  const picked = orderedPicks(materials.groups, picks)
  const takeOf = useCallback((src: string) => takeOfUrl.get(src), [takeOfUrl])

  const viewedMaterial = materialView === null ? undefined : materials.byJob.get(materialView.jobId)
  const materialLabel = (material: Material, viewed: MediaSpan) =>
    `素材 · ${material.groupLabel} · ${material.takeLabel}${shotsLabelOf(viewed, material.url, keyframes)}`
  /** 更新「镜头」页签单条原作选区：传入 `view` 时切入素材预览，移除当前预览原作的选区时退回 final-cut 预览。 */
  const changePicks = (takeId: string, next: TakePicks, view: MaterialView | null) => {
    setPicks((current) => withTakePicks(current, takeId, next))
    if (view !== null) {
      previewRef.current?.pause()
      setMaterialView(view)
    } else if (materialView?.jobId === next.jobId) leaveMaterial()
  }

  return {
    materialView,
    materialMs,
    materialClock,
    followMaterial,
    materialPlaying,
    setMaterialPlaying,
    materialPreviewRef,
    leaveMaterial,
    videos,
    materials,
    sourceNames,
    setPickedVersions,
    takeFilter,
    setTakeFilter,
    closedGroups,
    setClosedGroups,
    versionOf,
    keyframes,
    audioTracks,
    picks,
    setPicks,
    picked,
    takeOf,
    viewedMaterial,
    materialLabel,
    changePicks,
  }
}
