import { HF_AUDIO_AUTOMATION_ATTR } from '@hyperframes/core/audio-automation'
import { HF_AUDIO_FX_ATTR } from '@hyperframes/core/audio-fx'
import { writeClipTiming } from '@hyperframes/core/composition-contract'
import { relinkSplitHalves } from '@hyperframes/core/media-link'
import type { Composition } from '@hyperframes/sdk'
import { splitAutomation } from './clip-automation'
import type { Cut } from './clip-edit'
import type { FilmClip } from './composition/film'
import {
  LOCALE_BINDINGS,
  localeBindingsAttribute,
  localeBindingsOf,
  localeVariableId,
} from './composition/locale-text'
import { rootOf } from './film-view'
import { newClipId } from './film-writes'

const HF_ID = 'data-hf-id'

/**
 * 要加进根下的一个后半段：它的编号，切的是哪个片段（`of`），写在根下第几个，元素的整段 HTML；`variables` 是
 * 随语言的字段换成的新根变量（原来的 → 新的），要照原来的声明、各语言的值复制一份。
 */
type SplitHalf = {
  id: string
  of: string
  index: number
  html: string
  variables: readonly (readonly [from: string, to: string])[]
}

export const SPLIT_FAILED_TEXT = '片段包含无法复制的内容，无法切开'

/** 有一个后半段没能原样加进去（引擎不收这段 HTML）：整次切开退回去。 */
export class HalfRejected extends Error {}

/**
 * 切开以后的各个后半段：在当前主文件的一份副本里把原元素整个复制一份（属性、样式、子元素都带上），
 * 换上新的编号、后半段的起止和入点，紧跟在原元素后面；链接名照引擎的规则重新取，随语言的字段换成按新编号取的
 * 根变量，不和前半段共用。按在根下的先后排，依次加进去时前面加的不会挪动后面要加的位置。找不到根或片段时是 null。
 */
/** 片段在切点切开时前后两半的曲线（见 `splitAutomation`）；没有曲线时是 null。 */
export const automationHalves = (attribute: (name: string) => string | undefined, cut: Cut) =>
  splitAutomation(
    attribute(HF_AUDIO_AUTOMATION_ATTR),
    attribute(HF_AUDIO_FX_ATTR),
    cut.first.duration / 1000,
  )

export function splitHalves(
  engine: Composition,
  cuts: readonly Cut[],
  clips: readonly FilmClip[],
): readonly SplitHalf[] | null {
  const rootId = rootOf(engine)?.id
  const copy = new DOMParser().parseFromString(engine.serialize(), 'text/html')
  const root = [...copy.querySelectorAll(`[${HF_ID}]`)].find(
    (element) => element.getAttribute(HF_ID) === rootId,
  )
  if (root === undefined) return null
  const kinds = new Map(clips.map((clip) => [clip.id, clip.kind]))
  const halves: { element: Element; of: string; variables: [string, string][] }[] = []
  for (const cut of cuts) {
    const original = [...root.children].find((child) => child.getAttribute(HF_ID) === cut.id)
    if (original === undefined) return null
    const half = original.cloneNode(true) as Element
    const id = newClipId()
    half.id = id
    half.setAttribute(HF_ID, id)
    // 子元素的编号交给引擎重新取，免得和原元素里的重复
    for (const child of half.querySelectorAll(`[${HF_ID}]`)) child.removeAttribute(HF_ID)
    writeClipTiming(half, { start: cut.second.start / 1000, duration: cut.second.duration / 1000 })
    const inPoint = String(cut.second.mediaStart / 1000)
    if (kinds.get(cut.id) === 'host') half.setAttribute('data-playback-start', inPoint)
    else half.setAttribute('data-media-start', inPoint)
    const lanes = automationHalves((name) => original.getAttribute(name) ?? undefined, cut)
    if (lanes !== null) half.setAttribute(HF_AUDIO_AUTOMATION_ATTR, lanes.second)
    const bindings = Object.entries(
      localeBindingsOf(half.getAttribute(LOCALE_BINDINGS) ?? undefined),
    ).map(([field, from]) => [field, from, localeVariableId(id, field)] as const)
    const renamed = localeBindingsAttribute(
      Object.fromEntries(bindings.map(([field, , to]) => [field, to])),
    )
    if (renamed !== null) half.setAttribute(LOCALE_BINDINGS, renamed)
    original.after(half)
    halves.push({
      element: half,
      of: cut.id,
      variables: bindings.map(([, from, to]) => [from, to]),
    })
  }
  relinkSplitHalves(
    copy,
    halves.map((half) => half.element.id),
  )
  return halves
    .map(({ element, of, variables }) => ({
      id: element.id,
      of,
      index: [...root.children].indexOf(element),
      html: element.outerHTML,
      variables,
    }))
    .toSorted((left, right) => left.index - right.index)
}
