import { useCallback } from 'react'
import { HF_AUDIO_AUTOMATION_ATTR, type HfAutomation } from '@hyperframes/core/audio-automation'
import { HF_AUDIO_CARVE_ATTR } from '@hyperframes/core/audio-carve'
import { HF_AUDIO_FX_ATTR } from '@hyperframes/core/audio-fx'
import { HF_AUDIO_GROUP_ATTR } from '@hyperframes/core/audio-groups'
import { VOICE_GROUP } from './audio-role'
import {
  automationOf,
  automationText,
  carveAttributes,
  type CarveMeasurement,
  type CarveSettings,
} from './carve'
import type { ComponentCatalog } from './composition/catalog'
import { audioElement, type ClipAttribute } from './composition/film'
import { mainOf } from './film-files'
import { clipsOf, rootOf } from './film-view'
import { keepingLinks, LINK, newClipId, newLinkName, setOwnTiming } from './film-writes'
import { levellerAttributes, type LevellerMeasurement } from './leveller'
import { fxEditAttributes, type ChainChange } from './mix-fx'
import type { AttributeChanges } from './original-sound'
import { originalRowFor } from './placement'
import { detachedVideoChanges, mergedVideoChanges, type SoundPair } from './sound-pair'
import type { ProjectSession } from './use-film-project'

/**
 * 片段的声音编辑（见 `useFilmSession`）：改属性、压低、平稳音量、效果链和音量曲线，把视频片段的原声分离出来、
 * 合并回去、开关联动和对齐口型，每次都算一步撤销。
 */
export function useSoundEdits(catalog: ComponentCatalog, { projectRef, edit }: ProjectSession) {
  /**
   * 在几个片段上都改同样的几个属性（null 是去掉），算一步撤销。不在工程里的片段跳过；
   * 属性都已经是这些值时不动工程。
   */
  const setAttributes = useCallback(
    (ids: readonly string[], changes: Readonly<Partial<Record<ClipAttribute, string | null>>>) => {
      const project = projectRef.current
      if (project === null) return
      const engine = mainOf(project)
      const changed = ids.flatMap((id) => {
        const element = engine.getElement(id)
        if (element === null) return []
        return Object.entries(changes)
          .filter(([name, value]) => (element.attributes[name] ?? null) !== value)
          .map(([name, value]) => ({ id, name, value: value ?? null }))
      })
      if (changed.length === 0) return
      edit((current) => {
        for (const { id, name, value } of changed) current.setAttribute(id, name, value)
      })
    },
    [edit, projectRef],
  )

  /**
   * 写片段 `id` 的压低设置 `settings` 和它生成的效果链、曲线（`measured` 见 `carveAttributes`），`grouped` 里的
   * 片段一起放进人声组（见 `carvePlan`），算一步撤销。片段不在工程里、属性都已经是这些值时不动工程。
   */
  const setCarve = useCallback(
    (
      id: string,
      settings: CarveSettings,
      measured: CarveMeasurement | null,
      grouped: readonly string[],
    ) => {
      const project = projectRef.current
      const element = project === null ? null : mainOf(project).getElement(id)
      if (element === null) return
      const { chain, automation } = carveAttributes(
        element.attributes[HF_AUDIO_FX_ATTR],
        element.attributes[HF_AUDIO_AUTOMATION_ATTR],
        measured,
      )
      const changed = Object.entries({
        [HF_AUDIO_CARVE_ATTR]: JSON.stringify(settings),
        [HF_AUDIO_FX_ATTR]: chain,
        [HF_AUDIO_AUTOMATION_ATTR]: automation,
      }).filter(([name, value]) => (element.attributes[name] ?? null) !== value)
      if (changed.length === 0 && grouped.length === 0) return
      edit((main) => {
        for (const [name, value] of changed) main.setAttribute(id, name, value)
        for (const voice of grouped) main.setAttribute(voice, HF_AUDIO_GROUP_ATTR, VOICE_GROUP)
      })
    },
    [edit, projectRef],
  )

  /**
   * 给片段 `id` 写上平稳音量生成的效果链节点和曲线（见 `levellerAttributes`），算一步撤销；`measured` 是 null 时
   * 关掉（去掉生成的节点、曲线）。答复写没写：量出来声音已经平稳、没什么可调时不写，答 false。
   */
  const setLeveller = useCallback(
    (id: string, measured: LevellerMeasurement | null) => {
      const project = projectRef.current
      const element = project === null ? null : mainOf(project).getElement(id)
      if (element === null) return false
      const written = levellerAttributes(
        element.attributes[HF_AUDIO_FX_ATTR],
        element.attributes[HF_AUDIO_AUTOMATION_ATTR],
        measured,
      )
      if (written === null) return false
      const changed = Object.entries({
        [HF_AUDIO_FX_ATTR]: written.chain,
        [HF_AUDIO_AUTOMATION_ATTR]: written.automation,
      }).filter(([name, value]) => (element.attributes[name] ?? null) !== value)
      if (changed.length > 0)
        edit((main) => {
          for (const [name, value] of changed) main.setAttribute(id, name, value)
        })
      return true
    },
    [edit, projectRef],
  )

  /**
   * 按 `change` 改片段 `id` 的效果链（音色风格、均衡、升降调、自己加的效果，见 `fxEditAttributes`），算一步撤销。
   * 片段不在工程里、改完和原来一样时不动工程。
   */
  const setFx = useCallback(
    (id: string, change: ChainChange) => {
      const project = projectRef.current
      const element = project === null ? null : mainOf(project).getElement(id)
      if (element === null) return
      const written = fxEditAttributes(
        element.attributes[HF_AUDIO_FX_ATTR],
        element.attributes[HF_AUDIO_AUTOMATION_ATTR],
        change,
      )
      const changed = Object.entries({
        [HF_AUDIO_FX_ATTR]: written.chain,
        [HF_AUDIO_AUTOMATION_ATTR]: written.automation,
      }).filter(([name, value]) => (element.attributes[name] ?? null) !== value)
      if (changed.length === 0) return
      edit((main) => {
        for (const [name, value] of changed) main.setAttribute(id, name, value)
      })
    },
    [edit, projectRef],
  )

  /**
   * 按 `change` 改片段 `id` 的曲线 `data-automation`（波形音量关键帧，见 `volume-envelope.ts`），算一步撤销；
   * 改完一条曲线都没有时去掉这个属性。片段不在工程里、改完和原来一样时不动工程。
   */
  const setAutomation = useCallback(
    (id: string, change: (automation: HfAutomation) => HfAutomation) => {
      const project = projectRef.current
      const element = project === null ? null : mainOf(project).getElement(id)
      if (element === null) return
      const before = element.attributes[HF_AUDIO_AUTOMATION_ATTR] ?? null
      const after = automationText(change(automationOf(before ?? undefined)))
      if (after === before) return
      edit((main) => {
        main.setAttribute(id, HF_AUDIO_AUTOMATION_ATTR, after)
      })
    },
    [edit, projectRef],
  )

  /**
   * 把视频片段 `videoId` 的原声分离成一个音频片段，算一步撤销：视频片段关掉原声、声音属性搬走，原声片段
   * 和它同一个地址、同样的起止、入点、速度，写在文件里紧挨着它前面，放进「原声」行（见 `originalRowFor`）；
   * 两段写上同一个新的链接名，也当出处，联动着。返回原声片段的编号；片段不是视频片段时不动工程，整步不做时
   * （见 `edit`）也没有编号。
   */
  const detach = useCallback(
    (videoId: string): string | undefined => {
      const project = projectRef.current
      const engine = project === null ? undefined : mainOf(project)
      const root = engine === undefined ? undefined : rootOf(engine)
      if (engine === undefined || root === undefined) return undefined
      const clips = clipsOf(engine, catalog)
      const video = clips.find((clip) => clip.id === videoId)
      if (video?.kind !== 'video') return undefined
      const name = newLinkName(engine)
      const { track, renumber } = originalRowFor(clips, video)
      const index = root.children.findIndex((child) => child.id === videoId)
      let added: string | undefined
      const applied = edit((current) => {
        for (const [id, next] of renumber) current.setTiming(id, { trackIndex: next })
        added = current.addElement(
          root.id,
          index,
          audioElement({
            id: newClipId(),
            label: `${video.label} · 原声`,
            src: video.src,
            start: video.start,
            duration: video.duration,
            mediaStart: video.mediaStart,
            playbackRate: video.playbackRate,
            volume: video.volume,
            fadeIn: video.fadeIn,
            fadeOut: video.fadeOut,
            track,
            loop: false,
            hidden: video.hidden,
            link: name,
            syncOrigin: name,
            dub: null,
            // 分离出来的还是这段视频的声音，声音角色跟着它
            audioGroup: video.audioGroup,
            fxCarve: null,
            fxChain: null,
            automation: null,
          }),
        )
        for (const [attribute, value] of Object.entries(detachedVideoChanges(name)))
          current.setAttribute(videoId, attribute, value ?? null)
      })
      return applied ? added : undefined
    },
    [catalog, edit, projectRef],
  )

  /**
   * 把分离出来的原声合并回视频片段，算一步撤销：原声上的声音属性写回视频片段，视频片段打开原声、去掉链接名
   * 和出处，原声片段删掉。能不能合并由调用方按 `mergeBlocked` 先查。答复合并了没有（见 `edit`）。
   */
  const merge = useCallback(
    ({ video, audio }: SoundPair): boolean => {
      const project = projectRef.current
      const element = project === null ? null : mainOf(project).getElement(audio.id)
      if (element === null) return false
      const changes: AttributeChanges = mergedVideoChanges(element.attributes)
      return edit((current) => {
        for (const [attribute, value] of Object.entries(changes))
          current.setAttribute(video.id, attribute, value ?? null)
        current.removeElement(audio.id)
      })
    },
    [edit, projectRef],
  )

  /** 打开（两段写上一个新的链接名）或关掉（两段去掉链接名）一对的联动，算一步撤销。 */
  const setLinked = useCallback(
    ({ video, audio }: SoundPair, linked: boolean) => {
      edit((engine) => {
        const name = linked ? newLinkName(engine) : null
        for (const id of [video.id, audio.id]) engine.setAttribute(id, LINK, name)
      })
    },
    [edit],
  )

  /** 对齐口型：只把原声片段 `audioId` 挪到 `startMs`（由 `resyncPlan` 算好），联动不变，算一步撤销。 */
  const resync = useCallback(
    (audioId: string, startMs: number) => {
      edit((engine) =>
        keepingLinks(engine, () => setOwnTiming(engine, audioId, { start: startMs / 1000 })),
      )
    },
    [edit],
  )

  return {
    setAttributes,
    setCarve,
    setLeveller,
    setFx,
    setAutomation,
    detach,
    merge,
    setLinked,
    resync,
  }
}
