import { diffArrays } from 'diff'
import { historyShotOf, type GenerationJob } from '../storyboard.api'
import type { Sentence } from './caption-edit'
import type { CaptionClip, FilmClip, VideoClip } from './composition/film'

/**
 * 识别字幕与原始台词对照：从素材片出片记录中提取台词，与语音识别句子按词元对齐，
 * 为每句字幕定位对应台词片段并计算逐段文本差异。
 */

// 镜头描述中的半角花括号专用于标注台词（全角花括号「｛｝」不视为台词）。
const SCRIPT_LINE = /\{([^{}]*)\}/g

/**
 * 提取素材片 `job` 的原始台词列表：仅识别来自镜头组的出片记录（`metadata.film_node` 为字符串且含结构化镜头），
 * 按镜头时间线顺序提取各镜头文本中花括号内的非空内容；不符合条件或无台词时返回 `null`。
 * 编辑段与合成片不含原始镜头结构且音轨已重制，不参与台词对照。
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

/** 分词产出的最小比较单元：归一化后的比较键及其在原文中的字符范围 `[from, to)`。 */
type Unit = { key: string; from: number; to: number }

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u
const APOSTROPHE = /['’]/u

const isCjk = (char: string): boolean => CJK.test(char)

/** 归一化比较键：NFKC 规范化、转小写，并将弯撇号统一为直撇号。 */
const keyOf = (raw: string) => raw.normalize('NFKC').toLowerCase().replaceAll('’', "'")

/**
 * 将 `text` 切分为比较单元：中日韩文字按单字切分；连续的字母、数字（含词内撇号 `'` `’`）合并为一个单元；
 * 标点与空白仅作分隔。各单元记录原文区间用于展示截取，以归一化键参与比对。
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
 * 拼接两段文本：当左侧末尾非中日韩文字且非空白、右侧开头为非中日韩的字母/数字/左括号引号时补入单个空格，
 * 否则直接拼接。
 */
function joinText(left: string, right: string): string {
  const last = [...left].at(-1)
  const first = [...right][0]
  if (last === undefined || first === undefined) return left + right
  const spaced = !isCjk(last) && !/\s/u.test(last) && !isCjk(first) && OPENS_WORD.test(first)
  return spaced ? `${left} ${right}` : left + right
}

/** 附带所在台词行索引的比较单元。 */
type LineUnit = Unit & { line: number }

/**
 * 将选中的台词单元索引 `picked`（升序）还原为连续台词片段：每行从首单元截到末单元并保留紧随标点，
 * 跨行按 `joinText` 拼接；无选中单元时返回空串。
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
 * 为素材片识别出的每句文本匹配对应台词（与 `sentences` 一一对应，无对应台词为空串）。
 * 将识别句序列与台词行序列切词对齐，并将每个台词单元归属至相应识别句：相同单元归属配对句；
 * 替换差异归属对应识别差异的首个单元所在句；仅台词新增的单元默认归属前方最近单元所在句，
 * 若其位于句首或与后方最近单元同属一行台词而与前方不同行（句首漏识别）则归属后方最近句。
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

/** 字幕与台词比对产出的单个片段（相同、仅字幕、仅台词），保留原文拼写。 */
type ScriptPart = { kind: 'same' | 'captionOnly' | 'scriptOnly'; text: string }

/**
 * 对齐字幕文本 `text` 与对应台词 `script` 并计算差异片段；两者词元完全一致时返回 `null`。
 * 有差异时按顺序输出各段：字幕侧片段取自原文并附带其后标点空白（紧接 `scriptOnly` 时后移至该段之后），
 * 台词侧片段取自台词原文并按 `joinText` 规则与相邻段补齐空格。
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
    // 字幕侧相邻片段在原文中原本连续，仅在涉及台词侧插入片段的边界按需补空格。
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

/** 将字幕 `caption` 按所属视频片段 `video` 换算回源素材时间，返回与 `sentences` 重叠最长者的索引；无重叠返回 `undefined`。 */
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

/** 单句字幕的台词对照信息：完整目标台词及逐段差异。 */
export type ScriptNote = { script: string; parts: readonly ScriptPart[] }

/**
 * 计算工程中与原始台词存在差异的字幕映射（字幕 ID → 台词对照）。
 * `takeOf` 按视频地址映射素材片 ID，`linesOf` 为素材片台词列表，`sentencesOf` 为素材片已识别句子列表；
 * 仅收录归属有效视频片段、具备台词与识别记录且文本存在差异的字幕。
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
