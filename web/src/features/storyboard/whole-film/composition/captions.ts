import type { SubtitleSentence, WholeFilmDocument } from '@/shared/api/generated'

export interface SubtitleRecord {
  subtitleJobId: string
  sentences: SubtitleSentence[]
}

export interface PlacedWord {
  text: string
  start: number
  end: number
}

export interface PlacedCaption {
  clipId: string
  subtitleJobId: string
  sentenceIndex: number
  start: number
  end: number
  text: string
  words: PlacedWord[]
}

export interface CaptionWord {
  text: string
  start: number
  end: number
  sentence: number
}

const TOKEN = /[\p{Script=Latin}\p{Nd}'’]+|\S/gu
const PUNCTUATION = /^[\p{P}\p{S}]+$/u
const LATIN_EDGE_END = /[\p{Script=Latin}\p{Nd}]$/u
const LATIN_EDGE_START = /^[\p{Script=Latin}\p{Nd}]/u

export function joinWords(words: readonly { text: string }[]): string {
  let text = ''
  for (const { text: piece } of words) {
    if (text && LATIN_EDGE_END.test(text) && LATIN_EDGE_START.test(piece)) text += ' '
    text += piece
  }
  return text
}

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
