import { diffArrays } from 'diff'
import { historyShotOf, type GenerationJob } from '../storyboard.api'
import type { Sentence } from './caption-edit'
import type { CaptionClip, FilmClip, VideoClip } from './composition/film'

/**
 * 识别出来的字幕对照台词：从素材片的出片记录里取台词，按句和识别结果对齐，给每句字幕找到它对应的那段台词，
 * 再比出字幕的字和台词哪里不一样。
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

const isCjk = (char: string): boolean => CJK.test(char)

/** 比较用的写法：NFKC、转小写；弯撇号和直撇号当成一样。 */
const keyOf = (raw: string) => raw.normalize('NFKC').toLowerCase().replaceAll('’', "'")

/**
 * 把 `text` 切成单位：中日韩的字每字一个；其余连着的字母、数字（夹在其间的撇号 `'` `’` 算词内）是一个；
 * 标点、空白只是分隔。单位记着在原文里的位置，显示时按位置从原文里截，比较时用归一化的写法。
 */
function unitsOf(text: string): Unit[] {
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

const OPENS_WORD = /[\p{L}\p{N}\p{M}\p{Ps}\p{Pi}]/u

/**
 * 两段字接起来：接缝左边不是中日韩的字也不是空白、右边是字母数字或左括号引号（也不是中日韩的字）时中间加一个空格，
 * 否则直接连。
 */
function joinText(left: string, right: string): string {
  const last = [...left].at(-1)
  const first = [...right][0]
  if (last === undefined || first === undefined) return left + right
  const spaced = !isCjk(last) && !/\s/u.test(last) && !isCjk(first) && OPENS_WORD.test(first)
  return spaced ? `${left} ${right}` : left + right
}

/** 台词的一个单位，带它在第几行台词里。 */
type LineUnit = Unit & { line: number }

/**
 * 台词单位 `picked`（`units` 里的序号，从小到大）合成的一段台词：每行从第一个单位截到最后一个、带上紧跟的标点，
 * 跨行按 `joinText` 接。一个都没有时是空串。
 */
function excerptOf(
  lines: readonly string[],
  units: readonly LineUnit[],
  picked: readonly number[],
): string {
  const spans = new Map<number, { from: number; to: number; last: number }>()
  for (const index of picked) {
    const unit = units[index]
    if (unit === undefined) continue
    const span = spans.get(unit.line)
    spans.set(unit.line, { from: span?.from ?? unit.from, to: unit.to, last: index })
  }
  return [...spans.entries()].reduce((joined, [line, span]) => {
    const text = lines[line] ?? ''
    const next = units[span.last + 1]
    const rest = text.slice(span.to, next?.line === line ? next.from : text.length)
    const punctuation = /^\S*/u.exec(rest)?.[0] ?? ''
    return joinText(joined, text.slice(span.from, span.to) + punctuation)
  }, '')
}

/**
 * 一条素材片识别出的每一句对应的台词（和 `sentences` 一一对应；空串是没有对应的台词）。各句的字按先后切成单位，
 * 和整组台词 `lines` 的单位对齐，每个台词单位挂到一句上：一样的挂配对单位所在的句；相邻的两段差异挂字幕那一段
 * 第一个单位所在的句；只在台词里有的挂前面最近的单位所在的句，它和后面最近的单位在同一行台词、和前面的不在
 * 同一行时（一句话开头的词没识别出来），或者前面没有时，挂后面最近的。
 */
function sentenceScripts(lines: readonly string[], sentences: readonly Sentence[]): string[] {
  const units = lines.flatMap((line, index) =>
    unitsOf(line).map((unit) => ({ ...unit, line: index })),
  )
  const heard = sentences.flatMap((sentence, index) =>
    unitsOf(sentence.text).map((unit) => ({ key: unit.key, sentence: index })),
  )
  const attached = sentences.map((): number[] => [])
  const attach = (heardAt: number, scriptAt: number) => {
    const sentence = heard[heardAt]?.sentence
    if (sentence !== undefined) attached[sentence]?.push(scriptAt)
  }
  const changes = diffArrays(
    heard.map((unit) => unit.key),
    units.map((unit) => unit.key),
  )
  let heardAt = 0
  let scriptAt = 0
  for (const [index, change] of changes.entries()) {
    const count = change.value.length
    if (change.removed) {
      heardAt += count
      continue
    }
    if (!change.added) {
      for (let offset = 0; offset < count; offset += 1) attach(heardAt + offset, scriptAt + offset)
      heardAt += count
      scriptAt += count
      continue
    }
    const before = changes[index - 1]
    const after = changes[index + 1]
    const replaced =
      before?.removed === true
        ? heardAt - before.value.length
        : after?.removed === true
          ? heardAt
          : undefined
    const previousLine = units[scriptAt - 1]?.line
    const nextLine = units[scriptAt + count]?.line
    for (let offset = 0; offset < count; offset += 1) {
      const line = units[scriptAt + offset]?.line
      const toNext = heardAt === 0 || (line === nextLine && line !== previousLine)
      attach(replaced ?? (toNext ? heardAt : heardAt - 1), scriptAt + offset)
    }
    scriptAt += count
  }
  return attached.map((picked) => excerptOf(lines, units, picked))
}

/** 字幕和台词比出来的一段：一样的、只在字幕里的、只在台词里的，字照原文写法。 */
type ScriptPart = { kind: 'same' | 'captionOnly' | 'scriptOnly'; text: string }

/**
 * 字幕的字 `text` 和它对应的台词 `script` 各自切词后对齐，比出哪里不一样。都一样时是 null。不一样时按先后给出
 * 各段：字幕那边的段从字幕原文里截、带着它后面的标点空白（紧跟着只在台词里的段时，标点空白挪到那段后面），只在
 * 台词里的段从台词原文里截，和前后之间按 `joinText` 的规则补空格。
 */
function scriptMarks(text: string, script: string): ScriptPart[] | null {
  const said = unitsOf(text)
  const wanted = unitsOf(script)
  const changes = diffArrays(
    said.map((unit) => unit.key),
    wanted.map((unit) => unit.key),
  )
  if (changes.every((change) => !change.added && !change.removed)) return null
  const parts: ScriptPart[] = []
  const append = (kind: ScriptPart['kind'], piece: string) => {
    const previous = parts.at(-1)
    if (previous?.kind === kind) parts[parts.length - 1] = { kind, text: previous.text + piece }
    else if (piece !== '') parts.push({ kind, text: piece })
  }
  const push = (kind: ScriptPart['kind'], piece: string) => {
    if (piece === '') return
    // 字幕那边相邻的段在原文里本来就连着；只有台词里截来的段和前后之间要看是否补空格
    const previous = parts.at(-1)
    if (previous !== undefined && (kind === 'scriptOnly' || previous.kind === 'scriptOnly'))
      append('same', joinText(previous.text, piece).slice(previous.text.length, -piece.length))
    append(kind, piece)
  }
  push('same', text.slice(0, said[0]?.from ?? text.length))
  let saidAt = 0
  let wantedAt = 0
  let held = ''
  for (const [index, change] of changes.entries()) {
    const count = change.value.length
    if (change.added) {
      const first = wanted[wantedAt]
      const last = wanted[wantedAt + count - 1]
      if (first !== undefined && last !== undefined)
        push('scriptOnly', script.slice(first.from, last.to))
      push('same', held)
      held = ''
      wantedAt += count
      continue
    }
    const first = said[saidAt]
    const last = said[saidAt + count - 1]
    if (first !== undefined && last !== undefined) {
      push(change.removed ? 'captionOnly' : 'same', text.slice(first.from, last.to))
      const gap = text.slice(last.to, said[saidAt + count]?.from ?? text.length)
      if (change.removed && changes[index + 1]?.added === true) held = gap
      else push('same', gap)
    }
    saidAt += count
    if (!change.removed) wantedAt += count
  }
  return parts
}

/** 字幕 `caption` 对应 `sentences` 里的第几句：起止按视频片段 `video` 换算回素材时间后重叠最长的那句；都不重叠时是 undefined。 */
function sentenceOf(
  caption: CaptionClip,
  video: VideoClip,
  sentences: readonly Sentence[],
): number | undefined {
  const toMedia = (ms: number) => video.mediaStart + (ms - video.start) * video.playbackRate
  const from = toMedia(caption.start)
  const to = toMedia(caption.start + caption.duration)
  let found: number | undefined
  let longest = 0
  for (const [index, sentence] of sentences.entries()) {
    const overlap = Math.min(to, sentence.endMs) - Math.max(from, sentence.startMs)
    if (overlap > longest) {
      longest = overlap
      found = index
    }
  }
  return found
}

/** 一句字幕的台词对照：对应的台词，和字幕与它比出来的各段。 */
export type ScriptNote = { script: string; parts: readonly ScriptPart[] }

/**
 * final-cut 里和台词不一样的字幕：字幕编号 → 对照。`takeOf` 把视频片段的地址对上素材片，`linesOf` 是素材片 →
 * 台词，`sentencesOf` 是素材片 → 识别出的句子。只收有所属片段、素材片有台词也有识别结果、对应的台词不是空串、
 * 而且字和台词有差异的字幕。
 */
export function captionScripts(
  clips: readonly FilmClip[],
  takeOf: (src: string) => string | undefined,
  linesOf: ReadonlyMap<string, readonly string[]>,
  sentencesOf: ReadonlyMap<string, readonly Sentence[]>,
): ReadonlyMap<string, ScriptNote> {
  const videos = new Map(
    clips.flatMap((clip) => (clip.kind === 'video' ? [[clip.id, clip] as const] : [])),
  )
  const aligned = new Map<string, string[]>()
  const notes = new Map<string, ScriptNote>()
  for (const caption of clips) {
    if (caption.kind !== 'caption' || caption.owner === null) continue
    const video = videos.get(caption.owner)
    const take = video === undefined ? undefined : takeOf(video.src)
    const lines = take === undefined ? undefined : linesOf.get(take)
    const sentences = take === undefined ? undefined : sentencesOf.get(take)
    if (video === undefined || take === undefined || lines === undefined || sentences === undefined)
      continue
    const scripts = aligned.get(take) ?? sentenceScripts(lines, sentences)
    aligned.set(take, scripts)
    const index = sentenceOf(caption, video, sentences)
    const script = index === undefined ? '' : (scripts[index] ?? '')
    const parts = script === '' ? null : scriptMarks(caption.text, script)
    if (parts !== null) notes.set(caption.id, { script, parts })
  }
  return notes
}
