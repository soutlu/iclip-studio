import { useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { useAudition } from '@/shared/ui/audition'
import { isDubClip, type FilmClip } from './composition/film'
import { useLibraryVoices } from './final-cut.api'
import type { Language, ShownLocale } from './locales'
import type { SideTab } from './side-tabs'
import type { useVoiceControl } from './use-voice-control'
import type { VoicePickRequest, VoicePickTarget } from './voice-picker'

/**
 * 右栏的选音浮层与试听：浮层给谁选、贴着哪里弹，字幕页签单句试听和浮层样音共用的一个试听，以及资料库的音色。
 * `locale` 是显示着的语言，`sideTab`、`sideVisible` 是右栏停在哪个页签、看不看得见；换了语言、页签或右栏
 * 看不见时浮层收起。`clips` 是时间线上的片段，`allClips` 另含没显示的配音片段。
 */
export function useVoicePicking({
  voice,
  locale,
  sideTab,
  sideVisible,
  clips,
  allClips,
  notice,
}: {
  voice: ReturnType<typeof useVoiceControl>
  locale: ShownLocale
  sideTab: SideTab
  sideVisible: boolean
  clips: readonly FilmClip[]
  allClips: readonly FilmClip[]
  notice: (message: string) => void
}) {
  // 右栏共用的试听：字幕页签的单句试听和选音浮层的样音同一时间只放一条；右栏看不见、离开字幕页签且浮层收着时停下
  const [voicePick, setVoicePick] = useState<
    (VoicePickRequest & { locale: Language; tab: SideTab }) | null
  >(null)
  // 换了语言、换了页签、右栏看不见时浮层收起
  const shownPick =
    voicePick !== null &&
    voicePick.locale === locale.code &&
    voicePick.tab === sideTab &&
    sideVisible &&
    voice !== undefined
      ? voicePick
      : null
  if (voicePick !== null && shownPick === null) setVoicePick(null)
  const sideAudition = useAudition({
    active: sideVisible && (sideTab === 'captions' || shownPick !== null),
    onError: () => notice('试听失败，请重试'),
  })
  /**
   * 打开选音浮层（见 `VoicePicker`）：给这种语言的默认音色（`{ target: 'language' }`）或某一句
   * （`{ target: 'line', caption: 字幕编号 }`）选，贴着 `anchor` 弹在右栏内容区里。右栏任何页签都能唤起。
   */
  const openVoicePicker = (pick: VoicePickTarget, anchor: HTMLElement) => {
    sideAudition.stop()
    setVoicePick({ pick, anchor, locale: locale.code, tab: sideTab })
  }
  const closeVoicePicker = () => {
    sideAudition.stop()
    setVoicePick(null)
  }
  // 当前语言下各句的配音片段：字幕页签的单句试听放它
  const shownDubs = new Map(
    allClips.flatMap((clip) =>
      isDubClip(clip) && clip.dub.locale === locale.code ? [[clip.dub.caption, clip] as const] : [],
    ),
  )
  // 配音时（默认音色胶囊）、有句子自己选过音色时、浮层开着时、时间线上有用资料库音色配的配音片段时（顶行写音色名和
  // 小封面）要读资料库的音色
  const libraryVoices = useLibraryVoices(
    voice?.mode === 'dub' ||
      [...(voice?.lines.values() ?? [])].some((line) => line.own !== undefined) ||
      shownPick !== null ||
      clips.some((clip) => isDubClip(clip) && clip.dub.voice !== null),
  )
  const voicesProblem = libraryVoices.isError
    ? {
        message: errorMessageOf(libraryVoices.error, '读取音色失败'),
        onRetry: () => void libraryVoices.refetch(),
      }
    : undefined
  return {
    shownPick,
    sideAudition,
    openVoicePicker,
    closeVoicePicker,
    shownDubs,
    libraryVoices,
    voicesProblem,
  }
}
