import { useCallback, useState, type RefObject } from 'react'
import { analyseBeats } from './beat-analysis'
import { projectBeats } from './beat-file'
import { canCarve, CARVE_SAMPLE_RATE } from './carve'
import { cachedDecode, decodeForCarve } from './carve-decode'
import type { SourceLength } from './clip-edit'
import type { FilmClip } from './composition/film'
import type { TimelineHandle } from './film-timeline'
import { createProjectFile, readProjectFile, writeProjectFile } from './final-cut.api'
import { resyncPlan, soundActionFor, type SoundAction, type SoundControls } from './sound-pair'
import type { useFilmSession } from './use-film-session'
import type { useMaterials } from './use-materials'
import { useMusicBeats } from './use-music-beats'
import type { useSideSelection } from './use-side-selection'
import { useSmartMix } from './use-smart-mix'

/**
 * 片段的声音：配乐节拍、选中一段时的智能调音（两者读同一份解码），以及分离音频、合并回视频、联动、对齐口型。
 * `clips` 是时间线上的片段，`allClips` 另含没显示的配音片段；改工程之前都先退出素材预览。
 */
export function useSoundControls({
  conversationId,
  session,
  clips,
  allClips,
  selection,
  materials,
  sourceMs,
  timelineRef,
  notice,
}: {
  conversationId: string
  session: ReturnType<typeof useFilmSession>
  clips: readonly FilmClip[]
  allClips: readonly FilmClip[]
  selection: ReturnType<typeof useSideSelection>
  materials: ReturnType<typeof useMaterials>
  sourceMs: SourceLength
  timelineRef: RefObject<TimelineHandle | null>
  notice: (message: string) => void
}) {
  const { selectedClips, setSelectedIds } = selection
  const { leaveMaterial, audioTracks } = materials
  const [onlySelected] = selectedClips
  // 智能调音和算配乐节拍读同一份声音：同一个地址只读一次。工程里存着节拍文件的配乐不读声音，
  // 只有智能调音真要分析时才读
  const [decodeAudio] = useState(() => cachedDecode(decodeForCarve))
  const readBeats = useCallback(
    (src: string) =>
      projectBeats(src, async (each) => analyseBeats(await decodeAudio(each), CARVE_SAMPLE_RATE), {
        read: (path) => readProjectFile(conversationId, path),
        create: (path, content) => createProjectFile(conversationId, path, content),
        write: (path, content, version) => writeProjectFile(conversationId, path, content, version),
      }),
    [conversationId, decodeAudio],
  )
  const musicBeats = useMusicBeats(clips, readBeats, sourceMs)
  // 「属性」页签不在时也要管：选中一段配乐就按它的规则默认打开压低
  const smartMix = useSmartMix({
    clip:
      selectedClips.length === 1 && onlySelected !== undefined && canCarve(onlySelected)
        ? onlySelected
        : undefined,
    clips: allClips,
    decode: decodeAudio,
    writeCarve: session.setCarve,
    writeLeveller: session.setLeveller,
    writeRole: (id, role) => {
      leaveMaterial()
      session.setAttributes([id], { 'data-audio-group': role })
    },
    writeFx: (id, change) => {
      leaveMaterial()
      session.setFx(id, change)
    },
    writeAutomation: (id, change) => {
      leaveMaterial()
      session.setAutomation(id, change)
    },
    onNotice: notice,
  })
  const silentSource = (src: string) => audioTracks.get(src) === false
  const revealClip = (id: string) => {
    setSelectedIds(new Set([id]))
    timelineRef.current?.reveal(id)
  }
  // 分离音频、合并回视频、联动、对齐口型：「属性」、右键菜单、工具条和 ⇧⌘B 都走这里
  const soundControls: SoundControls = {
    run: (action) => {
      if (action.kind === 'none' || action.blocked !== undefined) return
      leaveMaterial()
      if (action.kind === 'merge') {
        if (session.merge(action.pair)) setSelectedIds(new Set([action.pair.video.id]))
        return
      }
      const added = session.detach(action.video.id)
      if (added !== undefined) setSelectedIds(new Set([added]))
    },
    link: (pair, linked) => {
      leaveMaterial()
      session.setLinked(pair, linked)
    },
    resync: (pair) => {
      const plan = resyncPlan(pair, clips)
      if ('refusal' in plan) {
        notice(plan.refusal)
        return
      }
      leaveMaterial()
      session.resync(pair.audio.id, plan.start)
      if (plan.displaced) notice('原声那一行的对齐位置已被占用，已移到最近的空位')
    },
    locate: revealClip,
  }
  const soundAction: SoundAction = soundActionFor(selectedClips, clips, silentSource)
  const runSoundAction = () => {
    if (soundAction.blocked !== undefined) notice(soundAction.blocked)
    else soundControls.run(soundAction)
  }
  return {
    musicBeats,
    smartMix,
    silentSource,
    revealClip,
    soundControls,
    soundAction,
    runSoundAction,
  }
}
