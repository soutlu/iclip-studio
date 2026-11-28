import { useState } from 'react'
import { useAudioPeaks } from '../editing/media-analysis'
import { useStableValue } from '../editing/use-stable-value'
import {
  linkedPartners,
  playheadSplit,
  SPLIT_REFUSAL_TEXT,
  type Cut,
  type Links,
  type SourceLength,
} from './clip-edit'
import type { FilmClip } from './composition/film'
import { takeDurationMs } from './material-media'
import type { AttributeChanges } from './original-sound'
import { aroundPlayhead } from './selection'
import type { useFilmSession } from './use-film-session'
import type { useMaterials } from './use-materials'
import type { usePreviewPlayback } from './use-preview-playback'
import type { useSideSelection } from './use-side-selection'

/**
 * 时间线、「属性」、右键菜单、工具条和快捷键共用的片段操作：在时间线上换选中、切开、删除、隐藏、改属性，
 * 以及视频片段、音频片段素材的总长。改工程之前都先退出素材预览。
 */
export function useClipCommands({
  session,
  clips,
  links,
  selection,
  player,
  materials,
  notice,
}: {
  session: ReturnType<typeof useFilmSession>
  clips: readonly FilmClip[]
  links: Links
  selection: ReturnType<typeof useSideSelection>
  player: ReturnType<typeof usePreviewPlayback>
  materials: ReturnType<typeof useMaterials>
  notice: (message: string) => void
}) {
  const { setSelectedIds, selectedClips, selected, clearSelection, openSideTab } = selection
  const { playhead, playheadNow } = player
  const { leaveMaterial, keyframes } = materials
  /** 在时间线上换选中：选中了片段时回到 final-cut 的预览（素材预览里看不到选中的片段，画面上也改不了它）。 */
  const selectOnTimeline = (ids: ReadonlySet<string>) => {
    if (ids.size > 0) leaveMaterial()
    setSelectedIds(ids)
  }
  const selectAround = (side: 'left' | 'right') =>
    selectOnTimeline(new Set(aroundPlayhead(clips, playheadNow(), side)))
  /** 双击时间线片段：单独选中该片段，并将右栏切换至「属性」页签（右栏收起时自动展开）。 */
  const inspectClip = (id: string) => {
    selectOnTimeline(new Set([id]))
    openSideTab('props')
  }
  const split = (cuts: readonly Cut[]) => {
    if (cuts.length === 0) return
    leaveMaterial()
    session.split(cuts)
  }
  // 在播放头处切开选中的片段：S、工具条的下拉都按它
  const playheadCut = playheadSplit(selectedClips, playhead, clips, links)
  const splitAtPlayhead = () => {
    const cut = playheadSplit(selectedClips, playheadNow(), clips, links)
    if ('cuts' in cut) split(cut.cuts)
    else if (cut.refusal === 'many') notice(SPLIT_REFUSAL_TEXT.many)
  }
  // 视频片段、音频片段素材的总长：时间线上拖着裁和「属性」里输入时间都按它收住结尾
  const audioPeaks = useAudioPeaks(
    useStableValue(
      [...new Set(clips.filter((clip) => clip.kind === 'audio').map((clip) => clip.src))].sort(),
    ),
  )
  const sourceMs: SourceLength = (clip) => {
    if (clip.kind === 'video') return takeDurationMs(keyframes.get(clip.src))
    const state = clip.kind === 'audio' ? audioPeaks.get(clip.src) : undefined
    return state?.kind === 'ready' ? Math.round(state.peaks.duration * 1000) : undefined
  }
  const [ripple, setRipple] = useState(true)
  // 删掉联动着的片段时，联动的伙伴一起删。被拒（字幕会重叠）时选中照旧，删掉了才清选中
  const removeSelected = () => {
    leaveMaterial()
    if (session.removeClips([...selected, ...linkedPartners(selected, clips)], ripple))
      clearSelection()
  }
  // 「属性」和时间线上片段的右键菜单共用这几个操作
  const hideClip = (id: string, hidden: boolean) => {
    leaveMaterial()
    session.setHidden([id], hidden)
  }
  // 改速度时联动的伙伴一起改；音量、淡入淡出、静音各管各的
  const setClipAttributes = (id: string, changes: AttributeChanges) => {
    leaveMaterial()
    const partners = 'data-playback-rate' in changes ? linkedPartners([id], clips) : []
    session.setAttributes([id, ...partners], changes)
  }
  return {
    selectOnTimeline,
    selectAround,
    inspectClip,
    split,
    playheadCut,
    splitAtPlayhead,
    audioPeaks,
    sourceMs,
    ripple,
    setRipple,
    removeSelected,
    hideClip,
    setClipAttributes,
  }
}
