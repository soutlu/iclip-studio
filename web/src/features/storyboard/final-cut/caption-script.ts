import { diffArrays } from 'diff'
import { historyShotOf, type GenerationJob } from '../storyboard.api'

/**
 * 识别出来的字幕对照台词：从素材片的出片记录里取台词，把听到的词和台词对齐，给每句字幕记下它对应的那段台词，
 * 再随时比出字幕的字和台词哪里不一样。只标不改：字幕的字始终是识别出来（或用户改过）的样子。
 */

// 镜头文字里花括号只用来写台词，出片时换成「{台词原文}」；全角括号「｛｝」不是台词
const SCRIPT_LINE = /\{([^{}]*)\}/g

/**
 * 素材片 `job` 的台词：只认从镜头组出的片（`metadata.film_node` 是字符串，且记录里存着结构化的镜头），按镜头
 * 时间线的先后、每镜文字里从左到右取花括号里的字（去掉首尾空白，空的不要）。不是这种记录、或一句台词都没有时
 * 是 null。编辑、合成出来的记录没有镜头，声音是重新生成或重新剪过的，不对照。
 */
export function scriptLinesOf(job: GenerationJob): string[] | null {
  if (typeof job.metadata?.['film_node'] !== 'string') return null
  const shot = historyShotOf(job)
  if (shot === undefined) return null
  const lines = shot.timeline.flatMap((item) =>
    [...item.prompt.matchAll(SCRIPT_LINE)].flatMap(([, line = '']) => {
      const text = line.trim()
      return text === '' ? [] : [text]
    }),
  )
  return lines.length === 0 ? null : lines
}

/** 切词得到的一个单位：比较用的字（归一化后），和它在原文里占的范围 `[from, to)`。 */
type Unit = { key: string; from: number; to: number }

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u
const APOSTROPHE = /['’]/u

/** 一个字是不是中日韩的字（汉字、平假名、片假名、谚文）。 */
export const isCjk = (char: string): boolean => CJK.test(char)

/** 比较用的写法：NFKC、转小写；弯撇号和直撇号当成一样。 */
const keyOf = (raw: string) => raw.normalize('NFKC').toLowerCase().replaceAll('’', "'")

/**
 * 把 `text` 切成单位：中日韩的字每字一个；其余连着的字母、数字（夹在其间的撇号 `'` `’` 算词内）是一个；
 * 标点、空白只是分隔。单位记着在原文里的位置，显示时按位置从原文里截，比较时用归一化的写法。
 */
export function unitsOf(text: string): Unit[] {
  const chars = [...text]
  const units: Unit[] = []
  let at = 0
  let word: { from: number } | null = null
  const close = (to: number) => {
    if (word !== null) units.push({ key: keyOf(text.slice(word.from, to)), from: word.from, to })
    word = null
  }
  for (const [index, char] of chars.entries()) {
    const next = chars[index + 1] ?? ''
    if (isCjk(char)) {
      close(at)
      units.push({ key: keyOf(char), from: at, to: at + char.length })
    } else if (WORD_CHAR.test(char)) word ??= { from: at }
    else if (!(word !== null && APOSTROPHE.test(char) && WORD_CHAR.test(next) && !isCjk(next)))
      close(at)
    at += char.length
  }
  close(at)
  return units
}

/** 两段字接起来：接缝两边都不是中日韩的字、也都不是空白时中间加一个空格，否则直接连。 */
export function joinText(left: string, right: string): string {
  const last = [...left].at(-1)
  const first = [...right][0]
  if (last === undefined || first === undefined) return left + right
  const spaced = !isCjk(last) && !isCjk(first) && !/\s/u.test(last) && !/\s/u.test(first)
  return spaced ? `${left} ${right}` : left + right
}

/** 听到的一句：原文，和每个词在原文里占的范围 `[from, to)`（按先后）。 */
export type HeardSentence = { text: string; words: readonly { from: number; to: number }[] }

/** 听到的一个词：第几句的第几个词。 */
export type WordRef = { sentence: number; word: number }

/**
 * 一条素材片听到的话和它的台词对齐的结果：`lines` 是台词，`units` 是台词的全部单位（带第几句台词），
 * `attached` 是每句里每个词挂上的台词单位（`units` 里的序号）。
 */
export type ScriptMatch = {
  lines: readonly string[]
  units: readonly (Unit & { line: number })[]
  attached: readonly (readonly number[])[][]
}

/**
 * 把一条素材片听到的所有单位（各句按先后，单位归覆盖它起点的那个词）和整组台词的所有单位对齐，每个台词单位
 * 挂到一个听到的词上：一样的挂配对的那个词；说成了别的（相邻的多说和漏说）挂多说那一段的第一个词；只在台词里
 * 有的（漏说）挂它前面最近的词，前面没有时挂后面最近的。一个词都没听到时什么都不挂。
 */
export function matchScript(
  lines: readonly string[],
  heard: readonly HeardSentence[],
): ScriptMatch {
  const units = lines.flatMap((line, index) =>
    unitsOf(line).map((unit) => ({ ...unit, line: index })),
  )
  const said = heard.flatMap((sentence, index) =>
    unitsOf(sentence.text).flatMap((unit) => {
      const word = sentence.words.findIndex(({ from, to }) => from <= unit.from && unit.from < to)
      return word === -1 ? [] : [{ key: unit.key, ref: { sentence: index, word } }]
    }),
  )
  const attached = heard.map((sentence) => sentence.words.map((): number[] => []))
  const attach = (heardAt: number | undefined, scriptAt: number) => {
    const ref = heardAt === undefined ? undefined : said[heardAt]?.ref
    if (ref !== undefined) attached[ref.sentence]?.[ref.word]?.push(scriptAt)
  }
  const changes = diffArrays(
    said.map((unit) => unit.key),
    units.map((unit) => unit.key),
  )
  let heardAt = 0
  let scriptAt = 0
  for (const [index, change] of changes.entries()) {
    const count = change.value.length
    if (change.removed) heardAt += count
    else if (!change.added) {
      for (let offset = 0; offset < count; offset += 1) attach(heardAt + offset, scriptAt + offset)
      heardAt += count
      scriptAt += count
    } else {
      // 多说、漏说相邻时算说成了别的，先后两种顺序都认
      const before = changes[index - 1]
      const after = changes[index + 1]
      const target =
        before?.removed === true
          ? heardAt - before.value.length
          : after?.removed === true
            ? heardAt
            : heardAt > 0
              ? heardAt - 1
              : said.length > 0
                ? 0
                : undefined
      for (let offset = 0; offset < count; offset += 1) attach(target, scriptAt + offset)
      scriptAt += count
    }
  }
  return { lines, units, attached }
}

/**
 * 一句字幕对应的台词：它所含的词（`words`）挂上的台词单位，每句台词从第一个单位截到最后一个单位、再带上紧跟
 * 其后的标点，跨几句台词时按 `joinText` 接起来。一个单位都没挂上时是空串（这句全是台词里没有的话）。
 */
export function scriptExcerpt(match: ScriptMatch, words: readonly WordRef[]): string {
  const picked = [
    ...new Set(words.flatMap((ref) => match.attached[ref.sentence]?.[ref.word] ?? [])),
  ].toSorted((left, right) => left - right)
  const spans = new Map<number, { from: number; to: number; last: number }>()
  for (const index of picked) {
    const unit = match.units[index]
    if (unit === undefined) continue
    const span = spans.get(unit.line)
    spans.set(unit.line, { from: span?.from ?? unit.from, to: unit.to, last: index })
  }
  return [...spans.entries()].reduce((joined, [line, span]) => {
    const text = match.lines[line] ?? ''
    const next = match.units[span.last + 1]
    const rest = text.slice(span.to, next?.line === line ? next.from : text.length)
    const punctuation = /^\S*/u.exec(rest)?.[0] ?? ''
    return joinText(joined, text.slice(span.from, span.to) + punctuation)
  }, '')
}

/** 字幕和台词比出来的一段：一样的、多说的（字幕有、台词没有）、漏说的（台词有、字幕没有），字照原文写法。 */
export type ScriptPart = { kind: 'same' | 'extra' | 'missing'; text: string }

/**
 * 字幕的字 `text` 和它对应的台词 `script` 各自切词后对齐，比出哪里不一样（说成了别的就是一段多说加一段漏说）。
 * 都一样时是 null。不一样时按先后给出各段：字幕那边的段从字幕原文里截、带着它后面的标点空白，漏说的段从台词
 * 原文里截，和前后之间按 `joinText` 的规则补空格。
 */
export function scriptMarks(text: string, script: string): ScriptPart[] | null {
  const said = unitsOf(text)
  const wanted = unitsOf(script)
  const changes = diffArrays(
    said.map((unit) => unit.key),
    wanted.map((unit) => unit.key),
  )
  if (changes.every((change) => !change.added && !change.removed)) return null
  const parts: ScriptPart[] = []
  const push = (kind: ScriptPart['kind'], piece: string) => {
    if (piece === '') return
    // 字幕那边相邻的段在原文里本来就连着；只有台词里截来的段和前后之间要看是否补空格
    const previous = parts.at(-1)
    if (previous !== undefined && (kind === 'missing' || previous.kind === 'missing')) {
      const spaced = joinText(previous.text, piece).slice(previous.text.length, -piece.length)
      if (spaced !== '') parts.push({ kind: 'same', text: spaced })
    }
    parts.push({ kind, text: piece })
  }
  push('same', text.slice(0, said[0]?.from ?? text.length))
  let saidAt = 0
  let wantedAt = 0
  for (const change of changes) {
    const count = change.value.length
    if (change.added) {
      const first = wanted[wantedAt]
      const last = wanted[wantedAt + count - 1]
      if (first !== undefined && last !== undefined)
        push('missing', script.slice(first.from, last.to))
      wantedAt += count
      continue
    }
    const first = said[saidAt]
    const last = said[saidAt + count - 1]
    if (first !== undefined && last !== undefined) {
      push(change.removed ? 'extra' : 'same', text.slice(first.from, last.to))
      push('same', text.slice(last.to, said[saidAt + count]?.from ?? text.length))
    }
    saidAt += count
    if (!change.removed) wantedAt += count
  }
  return parts
}
