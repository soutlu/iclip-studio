import { useEffect, useState } from 'react'
import {
  CAPTION_REFUSAL_TEXT,
  captionSpot,
  NEW_CAPTION_TEXT,
  RECOGNITION_REFUSAL_TEXT,
  recognitionTargets,
  recognizedCaptions,
  type Sentence,
} from './caption-edit'
import type { ComponentCatalog } from './component-catalog'
import type { CaptionClip, FilmClip } from './composition/film'
import { phraseWith, SOURCE_LOCALE, SOURCE_NAME, type ShownLocale } from './locales'
import {
  pendingTranslations,
  TRANSLATION_LIMITS,
  translateBlocked,
  translationsToWrite,
} from './translation'
import { useCaptionRecognition, type RecognitionOutcome } from './use-caption-recognition'
import { useCaptionScripts } from './use-caption-scripts'
import type { FilmView, useFilmSession } from './use-film-session'
import type { useMaterials } from './use-materials'
import type { useSideSelection } from './use-side-selection'
import { useTranslation } from './use-translation'

const READING_TAKES_TEXT = '正在读取素材片，请稍后再识别字幕'
const RECOGNIZING_TEXT = '正在识别字幕，请等待识别完成'
const ELSEWHERE_TEXT = '字幕归口播起始的片段，未新增字幕'
/** 「识别」旁的识别结果提示停留多久；鼠标移开时提前收起。 */
const RECOGNIZE_NOTE_MS = 4_000

/**
 * 「字幕」页签顶部的几件事：在播放头处加一句、识别字幕、与原始台词对照，以及其它语言下的「翻译」。
 * 识别和翻译期间不阻塞编辑，完成后按写入那一刻的工程写进去，结果经 `notice` 提示。
 */
export function useCaptionTools({
  conversationId,
  film,
  catalog,
  session,
  clips,
  captions,
  locale,
  playhead,
  materials,
  selection,
  collapsed,
  notice,
}: {
  conversationId: string
  film: FilmView | null
  catalog: ComponentCatalog
  session: ReturnType<typeof useFilmSession>
  clips: readonly FilmClip[]
  captions: readonly CaptionClip[]
  locale: ShownLocale
  playhead: number
  materials: ReturnType<typeof useMaterials>
  selection: ReturnType<typeof useSideSelection>
  collapsed: boolean
  notice: (message: string) => void
}) {
  const { leaveMaterial, takeOf, videos } = materials
  const { selectOnly, sideTab, layout } = selection
  // 「字幕」页签里在播放头处加一句：从播放头起 2 秒，碰到后面的字幕时缩短
  const captionAt = captionSpot(captions, playhead)
  const captionBlocked =
    locale.values !== null
      ? phraseWith('当前语言是', locale.code, `，无法加字幕；请先切换到「${SOURCE_NAME}」`)
      : 'refusal' in captionAt
        ? CAPTION_REFUSAL_TEXT[captionAt.refusal]
        : undefined
  // 加上的那一句就是选中的这一句
  const addCaption = async () => {
    if ('refusal' in captionAt) return undefined
    leaveMaterial()
    const [id] =
      (await session.addCaptions(() => [{ ...captionAt, text: NEW_CAPTION_TEXT, owner: null }])) ??
      []
    if (id !== undefined) selectOnly(id)
    return id
  }

  // 「字幕」页签原文下的「识别」：识别期间不阻塞编辑，全部完成后按最新工程状态一次性写入。
  const recognizable = recognitionTargets(clips, takeOf)
  /**
   * 按写入时刻的工程片段 `current` 汇总识别结果：失败片段、待新增字幕、重叠跳过句数、
   * 无口播片段，以及虽有口播但句子均归属其他片段的片段。
   */
  const recognitionResult = (
    current: readonly FilmClip[],
    clipIds: readonly string[],
    outcomes: ReadonlyMap<string, RecognitionOutcome>,
  ) => {
    const wanted = new Set(clipIds)
    // 跳过识别期间已删除或已存在字幕的片段。
    const found = recognitionTargets(current, takeOf)
    const targets = 'targets' in found ? found.targets.filter((t) => wanted.has(t.clipId)) : []
    const failed: string[] = []
    const sentences = new Map<string, readonly Sentence[]>()
    for (const target of targets) {
      const outcome = outcomes.get(target.sourceJobId)
      if (outcome?.kind === 'ready') sentences.set(target.clipId, outcome.sentences)
      else failed.push(target.clipId)
    }
    return { failed, ...recognizedCaptions(current, sentences) }
  }
  // 再点「识别」多半立刻有结果、鼠标还在按钮上，所以这类结果提示挂在按钮旁，到时或鼠标移开就收起
  const [recognizeNote, setRecognizeNote] = useState<string>()
  useEffect(() => {
    if (recognizeNote === undefined) return
    const timer = setTimeout(() => setRecognizeNote(undefined), RECOGNIZE_NOTE_MS)
    return () => clearTimeout(timer)
  }, [recognizeNote])
  const writeRecognized = async (
    clipIds: readonly string[],
    outcomes: ReadonlyMap<string, RecognitionOutcome>,
  ) => {
    let result = recognitionResult(clips, clipIds, outcomes)
    let added = 0
    if (result.captions.length > 0) {
      const ids = await session.addCaptions((current) => {
        result = recognitionResult(current, clipIds, outcomes)
        return result.captions
      })
      added = ids?.length ?? 0
    }
    const labels = (ids: readonly string[]) =>
      ids.map((id) => clips.find((clip) => clip.id === id)?.label ?? id).join('、')
    if (added > 0) notice(`已加入 ${added} 句字幕`)
    if (result.skipped > 0) notice(`${result.skipped} 句与已有字幕重叠，已跳过`)
    if (result.silent.length > 0) notice(`${labels(result.silent)} 未识别到口播内容，未新增字幕`)
    if (added === 0 && result.elsewhere.length > 0) setRecognizeNote(ELSEWHERE_TEXT)
    if (result.failed.length > 0)
      notice(`${labels(result.failed)} 的字幕识别失败，请点击「识别」重试`)
  }
  const recognition = useCaptionRecognition(conversationId, (clipIds, outcomes) => {
    void writeRecognized(clipIds, outcomes)
  })
  const captionScripts = useCaptionScripts({
    conversationId,
    enabled:
      sideTab === 'captions' &&
      !collapsed &&
      !layout.sideCollapsed &&
      locale.code === SOURCE_LOCALE,
    clips,
    takeOf,
    takes: videos.data,
  })
  const recognizeBlocked =
    recognition.recognizing > 0
      ? RECOGNIZING_TEXT
      : videos.isPending
        ? READING_TAKES_TEXT
        : 'refusal' in recognizable
          ? RECOGNITION_REFUSAL_TEXT[recognizable.refusal]
          : undefined
  const recognize = () => {
    if (recognizeBlocked === undefined && 'targets' in recognizable)
      void recognition.start(recognizable.targets)
  }
  // 其它语言下的「翻译」：点的那一刻还没翻的一起发，全部翻好后按写入那一刻的样子一步写进那种语言的值表
  const translation = useTranslation(conversationId)
  const target = locale.values === null ? undefined : locale
  const pending =
    film === null || target === undefined
      ? undefined
      : pendingTranslations(
          { clips: film.clips, bindings: film.bindings, values: target.values },
          catalog,
        )
  const translateBlockedText =
    pending === undefined || target === undefined
      ? undefined
      : translateBlocked(pending, target.code, translation.translating)
  const translate = async () => {
    if (pending === undefined || target === undefined || translateBlockedText !== undefined) return
    const { code } = target
    const { entries, tooLong } = pending
    const outcome = await translation.start(code, entries)
    if (outcome.kind === 'failed') notice(outcome.message)
    if (outcome.kind !== 'done') return
    const written = session.fillLocale(code, (now) =>
      translationsToWrite(entries, outcome.translations, pendingTranslations(now, catalog).entries),
    )
    if (written > 0) notice(`已翻译 ${written} 条`)
    if (written < entries.length)
      notice(`${entries.length - written} 条在翻译期间已修改或删除，未写入译文`)
    if (tooLong > 0) notice(`${tooLong} 条超过 ${TRANSLATION_LIMITS.text} 字，未翻译；请手动填写`)
  }
  return {
    captionBlocked,
    addCaption,
    recognizeNote,
    setRecognizeNote,
    recognition,
    captionScripts,
    recognizeBlocked,
    recognize,
    translation,
    pending,
    translateBlockedText,
    translate,
  }
}
