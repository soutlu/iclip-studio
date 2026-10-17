import type { SubtitleSentence, WholeFilmDocument } from '@/shared/api/generated'

/** 一条成片的字幕记录；时间是成片素材里的毫秒。旧记录的句子没有 `words`。 */
export interface SubtitleRecord {
  subtitleJobId: string
  sentences: SubtitleSentence[]
}

/** 整片时间（毫秒）上的一个词；`text` 含紧跟的标点。 */
export interface PlacedWord {
  text: string
  start: number
  end: number
}

/**
 * 放进整片的一句字幕：识别出的一句在某段画面里的部分。一句跨过段的边界时，前后两段各得一份。
 * 时间是整片毫秒；`text` 是这一份里的词按中文排版拼起来的文字。
 */
export interface PlacedCaption {
  clipId: string
  subtitleJobId: string
  sentenceIndex: number
  start: number
  end: number
  text: string
  words: PlacedWord[]
}

/** 交给字幕组件的一个词：时间是整片秒数，同一 `sentence` 的词是一组。 */
export interface CaptionWord {
  text: string
  start: number
  end: number
  sentence: number
}

// 拉丁字母、数字连成一个词；其余每个非空白字符单独算一个（中文按字）。
const TOKEN = /[\p{Script=Latin}\p{Nd}'’]+|\S/gu
const PUNCTUATION = /^[\p{P}\p{S}]+$/u
const LATIN_EDGE_END = /[\p{Script=Latin}\p{Nd}]$/u
const LATIN_EDGE_START = /^[\p{Script=Latin}\p{Nd}]/u

/** 词按中文排版拼接：两侧都是拉丁字母或数字时才加空格。字幕组件用同一条规则。 */
export function joinWords(words: readonly { text: string }[]): string {
  let text = ''
  for (const { text: piece } of words) {
    if (text && LATIN_EDGE_END.test(text) && LATIN_EDGE_START.test(piece)) text += ' '
    text += piece
  }
  return text
}

/**
 * 改过字的句子、没有逐词时间的旧句子：在这句原来的起止内按字数平均分配。
 * 标点不单独占时间：句中、句末的并到前一个词，句首的并到后一个词。
 */
function spreadByCharacters(text: string, startMs: number, endMs: number): PlacedWord[] {
  const tokens: { text: string; weight: number }[] = []
  let leading = ''
  for (const [token] of text.matchAll(TOKEN)) {
    const previous = tokens.at(-1)
    if (!PUNCTUATION.test(token)) tokens.push({ text: leading + token, weight: [...token].length })
    else if (previous) previous.text += token
    else leading += token
    if (!PUNCTUATION.test(token)) leading = ''
  }
  const total = tokens.reduce((sum, token) => sum + token.weight, 0)
  const span = endMs - startMs
  let done = 0
  return tokens.map((token) => {
    const start = startMs + Math.round((done / total) * span)
    done += token.weight
    return { text: token.text, start, end: startMs + Math.round((done / total) * span) }
  })
}

function sentenceWords(sentence: SubtitleSentence, editedText: string | undefined): PlacedWord[] {
  if (editedText !== undefined) {
    return spreadByCharacters(editedText, sentence.startMs, sentence.endMs)
  }
  const words = sentence.words ?? []
  if (words.length === 0) return spreadByCharacters(sentence.text, sentence.startMs, sentence.endMs)
  return words.map((word) => ({
    text: word.text + (word.punctuation ?? ''),
    start: word.startMs,
    end: word.endMs,
  }))
}

/**
 * 字幕放进整片：每段画面取它素材范围 `[playbackStart, playbackStart + duration)` 里的词，换算成整片时间。
 * 词按中点归属，跨段的句子在边界上按词截断，截在段内；改过字的句子（按字幕记录与句序对上）与没有
 * 逐词时间的句子在原起止内按字数平均分配。没有字幕记录的段、片头片尾没有字幕。按整片时间先后排列。
 */
export function placeCaptions(
  draft: Pick<WholeFilmDocument, 'layer0' | 'captions'>,
  subtitles: Readonly<Record<string, SubtitleRecord | null | undefined>>,
): PlacedCaption[] {
  const result: PlacedCaption[] = []
  for (const clip of draft.layer0) {
    if (clip.type !== 'video') continue
    const record = subtitles[clip.sourceJobId]
    if (!record) continue
    const from = clip.playbackStart
    const to = from + clip.duration
    const offset = clip.start - from
    record.sentences.forEach((sentence, sentenceIndex) => {
      if (sentence.endMs < from || sentence.startMs >= to) return
      const edit = draft.captions.edits.find(
        (item) =>
          item.subtitleJobId === record.subtitleJobId && item.sentenceIndex === sentenceIndex,
      )
      const words = sentenceWords(sentence, edit?.text)
        .filter((word) => {
          const middle = (word.start + word.end) / 2
          return middle >= from && middle < to
        })
        .map((word) => ({
          text: word.text,
          start: Math.max(word.start, from) + offset,
          end: Math.min(word.end, to) + offset,
        }))
      const first = words[0]
      const last = words.at(-1)
      if (!first || !last) return
      result.push({
        clipId: clip.id,
        subtitleJobId: record.subtitleJobId,
        sentenceIndex,
        start: first.start,
        end: last.end,
        text: joinWords(words),
        words,
      })
    })
  }
  return result
}

/** 字幕组件的 `words` 变量：放进整片的每一份句子是一组，时间换成秒。 */
export function captionWords(placed: readonly PlacedCaption[]): CaptionWord[] {
  return placed.flatMap((caption, sentence) =>
    caption.words.map((word) => ({
      text: word.text,
      start: word.start / 1000,
      end: word.end / 1000,
      sentence,
    })),
  )
}
