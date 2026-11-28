import { useCallback } from 'react'
import type { ComponentCatalog } from './composition/catalog'
import type { FilmClip } from './composition/film'
import { voiceModeOf, type VoiceMode, type VoiceSetting } from './composition/voices'
import { dubsOf, type NewDub } from './dubbing'
import { mainOf, sceneOf } from './film-files'
import { allClipsOf, clipsOf, rootOf, voiceModesIn } from './film-view'
import { addDubElements, voiceChange, writeVoice } from './film-writes'
import type { Language } from './locales'
import type { ProjectSession } from './use-film-project'

/**
 * 各语言的人声设置和配音片段（见 `useFilmSession`）：改原声还是配音、改音色和不配音的句子、写进生成好的配音，
 * 都算一步撤销。
 */
export function useVoiceEdits(catalog: ComponentCatalog, { projectRef, edit }: ProjectSession) {
  /**
   * 把语言 `locale`（原文是 null）的人声设置改成 `mode`（见 `voices.ts`），音色不动，算一步撤销；已经是这样时不动
   * 工程。不生成配音。
   */
  const setVoiceMode = useCallback(
    (locale: Language, mode: VoiceMode) => {
      const project = projectRef.current
      if (project === null || voiceModeOf(voiceModesIn(mainOf(project)), locale) === mode) return
      edit((main) => writeVoice(main, locale, (setting) => ({ ...setting, mode })))
    },
    [edit, projectRef],
  )

  /**
   * 只改语言 `locale`（原文是 null）的人声设置（`update`：换默认音色、改一句的选择……），不生成配音；同时删掉这种
   * 语言里配 `unvoiced` 这几句字幕的配音片段（设成不配音的句子），算一步撤销；什么都不变时不动工程。
   */
  const changeVoice = useCallback(
    (
      locale: Language,
      update: (setting: VoiceSetting) => VoiceSetting,
      unvoiced: readonly string[] = [],
    ) => {
      const project = projectRef.current
      const main = project === null ? undefined : mainOf(project)
      if (main === undefined) return
      const removed = dubsOf(clipsOf(main, catalog), locale, unvoiced)
      if (removed.length === 0 && voiceChange(main, locale, update) === undefined) return
      edit((engine) => {
        for (const id of removed) engine.removeElement(id)
        writeVoice(engine, locale, update)
      })
    },
    [catalog, edit, projectRef],
  )

  /**
   * 写进语言 `locale`（原文是 null）生成好的配音，算一步撤销：`plan` 拿到这一刻的片段（含字幕和所有语言的配音片段），
   * 答复要换掉的配音片段、要加的素材片的配音片段（`added`）和旁白句的配音片段（`narrated`），都带着合成时的记录。
   * 换掉的先删；加的两种各一批，先后各自放进第一条这几段时间都空着的「配音」行（见 `addDubElements`：压在新片段
   * 开始上的已有配音片段先收短），写在根下第一个。人声设置不动。答复加了几个；一个都不加时不动工程，答 0。
   */
  const addDubs = useCallback(
    (
      locale: Language,
      plan: (clips: readonly FilmClip[]) => {
        removed: readonly string[]
        added: readonly NewDub[]
        narrated: readonly NewDub[]
      },
    ): number => {
      const project = projectRef.current
      const main = project === null ? undefined : mainOf(project)
      const root = main === undefined ? undefined : rootOf(main)
      if (project === null || main === undefined || root === undefined) return 0
      const { removed, added, narrated } = plan(allClipsOf(main, sceneOf(project), catalog))
      if (added.length + narrated.length === 0) return 0
      edit((engine) => {
        for (const id of removed) engine.removeElement(id)
        addDubElements(engine, catalog, root.id, locale, added)
        addDubElements(engine, catalog, root.id, locale, narrated)
      })
      return added.length + narrated.length
    },
    [catalog, edit, projectRef],
  )

  return { setVoiceMode, changeVoice, addDubs }
}
