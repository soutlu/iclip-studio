import { useEffect, useRef, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import type {
  FinalCutTranslationOut,
  FinalCutTranslationsIn,
} from '@/shared/api/generated/types.gen'
import { translateTexts } from './final-cut.api'
import { translationBatches, type TranslationEntry } from './translation'

/** 一次翻译的结果：全部翻好了（`done`）、有一批失败了（`failed`，说明原因），或者没发（正在翻、编辑器关了）。 */
export type TranslationOutcome =
  | { kind: 'done'; translations: readonly FinalCutTranslationOut[] }
  | { kind: 'failed'; message: string }
  | { kind: 'skipped' }

/**
 * 「翻译」：把要翻的文字按接口上限分批，依次发给翻译接口（付费），有一批失败就不再发后面的。发起只在 `start`
 * 里做；翻译中再调 `start` 不发、答 `skipped`。编辑器关掉时停下还没发完的，也答 `skipped`。
 */
export function useTranslation(conversationId: string) {
  const [translating, setTranslating] = useState(false)
  // 状态要到下一次渲染才变：连点两下时靠它挡住第二次发起
  const busyRef = useRef(false)
  const controllerRef = useRef<AbortController | null>(null)
  useEffect(() => () => controllerRef.current?.abort(), [])

  const start = async (
    locale: FinalCutTranslationsIn['targetLocale'],
    entries: readonly TranslationEntry[],
  ): Promise<TranslationOutcome> => {
    if (busyRef.current || entries.length === 0) return { kind: 'skipped' }
    busyRef.current = true
    setTranslating(true)
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const translations: FinalCutTranslationOut[] = []
      for (const batch of translationBatches(entries)) {
        const answer = await translateTexts(
          conversationId,
          { targetLocale: locale, entries: batch },
          controller.signal,
        )
        translations.push(...answer.translations)
      }
      return { kind: 'done', translations }
    } catch (error) {
      if (controller.signal.aborted) return { kind: 'skipped' }
      return { kind: 'failed', message: errorMessageOf(error, '翻译失败，请重试') }
    } finally {
      busyRef.current = false
      controllerRef.current = null
      setTranslating(false)
    }
  }

  return { translating, start }
}
