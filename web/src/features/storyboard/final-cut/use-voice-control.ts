import type { FilmClip } from './composition/film'
import {
  voiceOfLine,
  voiceSettingOf,
  withLineVoice,
  type LineVoice,
  type VoiceMode,
  type VoiceModes,
} from './composition/voices'
import {
  dubbingPlanOf,
  dubbingRefusalText,
  dubbingRequests,
  dubClips,
  dubsOf,
  lineRefusals,
  lineRefusalText,
  narrationDubs,
} from './dubbing'
import { languageName, phraseAround, SOURCE_LOCALE, type ShownLocale } from './locales'
import { useDubbing, type DubbingDone } from './use-dubbing'
import type { useFilmSession } from './use-film-session'
import type { DubAction, VoiceControl } from './voice-choices'
import { lineStates, voiceSummary, voicingOf, type Voicing } from './voice-lines'

const READING_TAKES_TEXT = '正在读取素材片，请稍后再生成配音'
const NO_TAKES_TEXT = '未找到视频片段对应的素材片记录，无法生成配音'
const NOTHING_TO_DUB_TEXT = '没有要配音的字幕'
const NOTHING_PENDING_TEXT = '没有待重配的字幕'
const ORIGINAL_MODE_TEXT = '当前为原声，切换到配音后再生成'
const BUSY_TEXT = '正在生成配音，请等待生成完成'

type Session = Pick<ReturnType<typeof useFilmSession>, 'setVoiceMode' | 'changeVoice' | 'addDubs'>

type VoiceControlInput = {
  conversationId: string
  /** 工程现在的片段（含所有语言的配音片段）、人声设置和显示着的语言；工程还没打开时是 null。 */
  film: { clips: readonly FilmClip[]; voiceModes: VoiceModes; locale: ShownLocale } | null
  /** 素材片的总长（毫秒），读不到时是 undefined。 */
  sourceMs: (src: string) => number | undefined
  /** 素材片地址对上的生成记录编号；对不上时是 undefined。 */
  takeOf: (src: string) => string | undefined
  /** 素材片的生成记录还在读。 */
  takesPending: boolean
  /** 素材片在提示里的名字。 */
  sourceName: (src: string) => string | undefined
  session: Session
  notice: (message: string) => void
  /** 改工程以前要做的（比如退出素材预览）。 */
  beforeEdit: () => void
}

/** 只把属于视频片段的句子都配上（音色随便取一个），看哪些句子排得进素材片的请求。 */
const everyOwnedVoiced = (voicing: Voicing): Voicing => ({
  ...voicing,
  voice: (caption) =>
    voicing.owned.has(caption.id) ? { kind: 'voiced', voice: null } : voicing.voice(caption),
})

/**
 * 「字幕」页签的人声设置和配音（见 `VoiceControl`），当前显示的语言的，原文也有；工程还没打开时是 undefined。
 * 合成走 `useDubbing`：按句子挑、按素材片和音色分组发起，旁白句各发一次（见 `dubbingPlanOf`），全部有了结果后按
 * 那时的 final-cut 一步建成配好的那几句的配音片段（换掉它们原来的，带着合成时的记录），人声设置不动。
 */
export function useVoiceControl({
  conversationId,
  film,
  sourceMs,
  takeOf,
  takesPending,
  sourceName,
  session,
  notice,
  beforeEdit,
}: VoiceControlInput) {
  const writeDubs = ({ locale, results, narrations }: DubbingDone) => {
    const spoken = narrations.flatMap(({ line, outcome }) =>
      line.caption === null || outcome.kind !== 'ready' || outcome.job.outputUrl === null
        ? []
        : [
            {
              line,
              audio: {
                url: outcome.job.outputUrl,
                durationMs: outcome.job.durationMs,
                speed: outcome.job.dubbedLines?.[0]?.speed ?? 1,
                trimmed: (outcome.job.dubbedLines ?? []).some((each) => each.trimmed),
              },
            },
          ],
    )
    const ready = results.flatMap(({ target: request, outcome }) => {
      const url = outcome.kind === 'ready' ? outcome.job.outputUrl : null
      return outcome.kind !== 'ready' || url === null
        ? []
        : [
            {
              request,
              track: {
                url,
                durationMs: outcome.job.durationMs,
                lines: outcome.job.dubbedLines ?? [],
              },
            },
          ]
    })
    // 合成期间改成不配音的句子：那时已经删了它的配音片段，配好的这段也不写回去
    const settingNow = film === null ? undefined : voiceSettingOf(film.voiceModes, locale)
    const voiced = ({ caption }: { caption: string }) =>
      settingNow === undefined || voiceOfLine(settingNow, caption) !== undefined
    let trimmed = 0
    const added = session.addDubs(locale, (current) => {
      const made = ready
        .flatMap(({ request, track }) => dubClips(current, request, track))
        .filter(voiced)
      const narrated = narrationDubs(current, spoken).filter(voiced)
      trimmed = [...made, ...narrated].filter((dub) => dub.trimmed).length
      return {
        removed: dubsOf(current, locale, [
          ...ready.flatMap(({ request }) => request.lines.map((line) => line.caption)),
          ...spoken.flatMap(({ line }) => (line.caption === null ? [] : [line.caption])),
        ]),
        added: made,
        narrated,
      }
    })
    if (added > 0) notice(phraseAround(`已生成 ${added} 句`, languageName(locale), '配音'))
    if (trimmed > 0) notice(`${trimmed} 条配音时长超出上限，已截短`)
    for (const { target: request, outcome } of results)
      if (outcome.kind === 'failed')
        notice(`${sourceName(request.src) ?? '素材片'} 的配音生成失败：${outcome.message}`)
    for (const { line, outcome } of narrations)
      if (line.caption !== null && outcome.kind === 'failed')
        notice(`旁白的配音生成失败：${outcome.message}`)
  }

  const dubbing = useDubbing(conversationId, writeDubs)
  const busy = dubbing.running === null ? undefined : BUSY_TEXT

  if (film === null) return undefined
  const { clips, voiceModes, locale } = film
  const code = locale.code
  const setting = voiceSettingOf(voiceModes, code)
  const voicing = voicingOf(clips, voiceModes, locale)

  /** 按 `voicing` 排好、`picked` 挑中的配音：素材片的请求对上各自素材片的生成记录，加上旁白句；`requested` 是对上之前一共几次。 */
  const planOf = (picked?: (caption: string) => boolean) => {
    const plan = dubbingPlanOf(clips, voicing, sourceMs, picked)
    if ('refusal' in plan) return plan
    const takes = plan.requests.flatMap((request) => {
      const sourceJobId = takeOf(request.src)
      return sourceJobId === undefined ? [] : [{ ...request, sourceJobId }]
    })
    return {
      work: { takes, narrations: plan.narrations },
      requested: plan.requests.length + plan.narrations.length,
    }
  }
  /** 照 `plan` 发起前为什么不能发起；`empty` 是一句要配的都没有时的说法。 */
  const planBlocked = (plan: ReturnType<typeof planOf>, empty: string) =>
    takesPending
      ? READING_TAKES_TEXT
      : 'refusal' in plan
        ? dubbingRefusalText(plan.refusal, code)
        : plan.requested === 0
          ? empty
          : plan.work.takes.length + plan.work.narrations.length === 0
            ? NO_TAKES_TEXT
            : undefined
  const action = (plan: ReturnType<typeof planOf>, blocked: string | undefined): DubAction => ({
    blocked,
    run: () => {
      if (blocked === undefined && 'work' in plan) void dubbing.start(code, plan.work)
    },
  })

  // 各句为什么合成不了：每句都配音时排不进素材片的请求、素材片对不上的，没有字的
  const dubbable = dubbingRequests(clips, everyOwnedVoiced(voicing), sourceMs)
  const refusals = lineRefusals(
    clips,
    voicing,
    new Set(
      'refusal' in dubbable
        ? []
        : dubbable.requests
            .filter((request) => takeOf(request.src) !== undefined)
            .flatMap(({ lines }) => lines.map((line) => line.caption)),
    ),
    (src) => takeOf(src) !== undefined,
  )
  const lines = lineStates({
    clips,
    locale: code,
    voicing,
    lines: setting.lines,
    running: dubbing.running?.locale === code ? dubbing.running.lines : new Set(),
    refusal: (caption) => {
      const refusal = refusals.get(caption)
      if (refusal === undefined) return undefined
      return takesPending && refusal !== 'untranslated'
        ? READING_TAKES_TEXT
        : lineRefusalText(refusal, code)
    },
    busy,
  })
  const summary = voiceSummary(
    clips,
    code,
    lines,
    dubbing.running?.locale === code ? dubbing.running.remaining : 0,
  )
  // 外语原声时放的是原文的声音，不在这种语言下合成
  const modeBlocked =
    code !== SOURCE_LOCALE && setting.mode === 'original' ? ORIGINAL_MODE_TEXT : undefined
  const everyPlan = planOf()
  const pendingPlan = planOf((caption) => lines.get(caption)?.pending === true)

  const voice: VoiceControl = {
    locale: code,
    mode: setting.mode,
    onMode: (mode: VoiceMode) => {
      beforeEdit()
      session.setVoiceMode(code, mode)
    },
    voice: setting.voice,
    onVoice: (chosen) => {
      beforeEdit()
      session.changeVoice(code, (current) => ({ ...current, mode: 'dub', voice: chosen }))
    },
    lines,
    onLine: (caption: string, line: LineVoice | null) => {
      if (lines.get(caption)?.chooseBlocked !== undefined) return
      beforeEdit()
      session.changeVoice(
        code,
        (current) => withLineVoice(current, caption, line),
        line !== null && 'dub' in line ? [caption] : [],
      )
    },
    summary,
    generate: action(everyPlan, busy ?? modeBlocked ?? planBlocked(everyPlan, NOTHING_TO_DUB_TEXT)),
    fill: action(
      pendingPlan,
      busy ??
        modeBlocked ??
        (summary.pending === 0
          ? NOTHING_PENDING_TEXT
          : planBlocked(pendingPlan, NOTHING_PENDING_TEXT)),
    ),
    dubLine: (caption) => {
      if (lines.get(caption)?.blocked !== undefined) return
      const plan = planOf((each) => each === caption)
      if ('work' in plan) void dubbing.start(code, plan.work)
    },
  }
  return voice
}
