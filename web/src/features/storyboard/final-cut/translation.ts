import type { FinalCutTextIn, FinalCutTranslationOut } from '@/shared/api/generated/types.gen'
import { zFinalCutTextIn } from '@/shared/api/generated/zod.gen'
import type { ComponentCatalog } from './composition/catalog'
import { itemNamed, type FilmClip } from './composition/film'
import { fieldText, type LocaleBindings } from './composition/locale-text'
import { phraseWith, translationOf, type LocaleCode, type LocaleValues } from './locales'

/** 一条要翻的原文：`id` 是它的变量（字幕的变量、随语言字段的根变量），`text` 是原文。 */
export type TranslationEntry = FinalCutTextIn

const textLimit = (): number => {
  const max = zFinalCutTextIn.shape.text.maxLength
  if (max === null) throw new Error('合同里一条要翻的原文没有字数上限')
  return max
}

/**
 * 翻译接口一次请求的上限：条数和合计字数来自合同里 `FinalCutTranslationsIn.entries` 的约束和说明，单条字数
 * 直接读合同。字数按 `length` 算，只会比服务端算的多。
 */
export const TRANSLATION_LIMITS = { entries: 200, text: textLimit(), total: 4000 }

export type TranslationLimits = typeof TRANSLATION_LIMITS

/** 收集要翻的文字时看的那一刻的工程：片段（含字幕）、随语言的字段和这种语言的值表。 */
export type TranslationSource = {
  clips: readonly FilmClip[]
  bindings: ReadonlyMap<string, LocaleBindings>
  values: LocaleValues
}

/**
 * 一种语言里要翻的文字：`total` 是能翻的条数（有原文的字幕和随语言的字段，翻没翻都算），`entries` 是其中还没翻
 * 的（值表里没有这个变量），`tooLong` 是还没翻但原文超过单条上限、不发的条数。固定的字段、原文是空白的不算。
 */
export function pendingTranslations(
  source: TranslationSource,
  catalog: ComponentCatalog,
  limits: TranslationLimits = TRANSLATION_LIMITS,
): { entries: TranslationEntry[]; tooLong: number; total: number } {
  const all = new Map<string, string>()
  for (const clip of source.clips) {
    if (clip.kind === 'caption') {
      if (clip.variable !== '') all.set(clip.variable, clip.text)
      continue
    }
    if (clip.kind !== 'host') continue
    const item = itemNamed(catalog, clip.item)
    for (const [fieldId, variable] of Object.entries(source.bindings.get(clip.id) ?? {})) {
      const field = item?.variables.find((candidate) => candidate.id === fieldId)
      if (field !== undefined) all.set(variable, fieldText(clip.values, field))
    }
  }
  const entries: TranslationEntry[] = []
  let tooLong = 0
  let total = 0
  for (const [id, text] of all) {
    if (text.trim() === '') continue
    total += 1
    if (translationOf(source.values, id) !== null) continue
    if (text.length > limits.text) tooLong += 1
    else entries.push({ id, text })
  }
  return { entries, tooLong, total }
}

/** 按接口上限把要翻的文字依次分批：每批不超过上限条数，原文合计不超过上限字数。每条都不超过单条上限。 */
export function translationBatches(
  entries: readonly TranslationEntry[],
  limits: TranslationLimits = TRANSLATION_LIMITS,
): TranslationEntry[][] {
  const batches: TranslationEntry[][] = []
  let batch: TranslationEntry[] = []
  let length = 0
  for (const entry of entries) {
    if (batch.length === limits.entries || length + entry.text.length > limits.total) {
      batches.push(batch)
      batch = []
      length = 0
    }
    batch.push(entry)
    length += entry.text.length
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

/**
 * 翻好以后要写进值表的（变量 → 译文）：只写写入那一刻还没翻、原文和发出时一样的（`pending` 是那一刻的
 * `pendingTranslations(...).entries`）。翻译期间删掉、改成固定、填了这种语言、改了原文的都跳过。
 */
export function translationsToWrite(
  sent: readonly TranslationEntry[],
  translated: readonly FinalCutTranslationOut[],
  pending: readonly TranslationEntry[],
): Map<string, string> {
  const sentText = new Map(sent.map((entry) => [entry.id, entry.text]))
  const pendingText = new Map(pending.map((entry) => [entry.id, entry.text]))
  const writes = new Map<string, string>()
  for (const { id, text } of translated) {
    const original = sentText.get(id)
    if (original !== undefined && pendingText.get(id) === original) writes.set(id, text)
  }
  return writes
}

/**
 * 为什么现在不能点「翻译」；能点时是 undefined。`plan` 是 `pendingTranslations` 的结果，`code` 是要翻成的语言。
 */
export function translateBlocked(
  plan: { entries: readonly unknown[]; tooLong: number; total: number },
  code: LocaleCode,
  translating: boolean,
  limits: TranslationLimits = TRANSLATION_LIMITS,
): string | undefined {
  if (translating) return '翻译中，可继续编辑'
  if (plan.entries.length > 0) return undefined
  if (plan.total === 0) return '暂无可翻译的字幕或文字；请先加字幕，或把贴片、场景的文字改为随语言'
  if (plan.tooLong > 0)
    return `还没翻译的 ${plan.tooLong} 条超过 ${limits.text} 字，无法自动翻译；请手动填写`
  return phraseWith('', code, '的字幕和文字都已翻译；要重新翻译哪一句，请先清空那一句')
}
