import { describe, expect, it } from 'vitest'
import type {
  WholeFilmCaptionEdit,
  WholeFilmComponentClip,
  WholeFilmVideoClip,
} from '@/shared/api/generated'
import { captionWords, joinWords, placeCaptions, type SubtitleRecord } from './captions'

const video = (
  spec: Partial<WholeFilmVideoClip> & Pick<WholeFilmVideoClip, 'id' | 'start' | 'duration'>,
): WholeFilmVideoClip => ({
  type: 'video',
  playbackStart: 0,
  sourceJobId: 'job-a',
  volume: 1,
  ...spec,
})

const word = (startMs: number, endMs: number, text: string, punctuation = '') => ({
  startMs,
  endMs,
  text,
  punctuation,
})

const RECORD: SubtitleRecord = {
  subtitleJobId: 'sub-a',
  sentences: [
    {
      startMs: 0,
      endMs: 1200,
      text: '我们一起去，',
      speaker: null,
      words: [word(0, 400, '我们'), word(400, 1200, '一起去', '，')],
    },
    {
      startMs: 1500,
      endMs: 3500,
      text: '很方便的。',
      speaker: null,
      words: [word(1500, 2200, '很方便'), word(2200, 3500, '的', '。')],
    },
  ],
}

const place = (
  layer0: (WholeFilmVideoClip | WholeFilmComponentClip)[],
  subtitles: Record<string, SubtitleRecord | null>,
  edits: WholeFilmCaptionEdit[] = [],
) => placeCaptions({ layer0, captions: { component: 'default-caption', edits } }, subtitles)

describe('placeCaptions', () => {
  it('取段内的句子与词，换算成整片毫秒，文字带上紧跟的标点', () => {
    const placed = place([video({ id: 'a', start: 2000, duration: 4000 })], { 'job-a': RECORD })
    expect(placed).toEqual([
      {
        clipId: 'a',
        subtitleJobId: 'sub-a',
        sentenceIndex: 0,
        start: 2000,
        end: 3200,
        text: '我们一起去，',
        words: [
          { text: '我们', start: 2000, end: 2400 },
          { text: '一起去，', start: 2400, end: 3200 },
        ],
      },
      {
        clipId: 'a',
        subtitleJobId: 'sub-a',
        sentenceIndex: 1,
        start: 3500,
        end: 5500,
        text: '很方便的。',
        words: [
          { text: '很方便', start: 3500, end: 4200 },
          { text: '的。', start: 4200, end: 5500 },
        ],
      },
    ])
  })

  it('跨段的句子在切点按词的中点截断，前后两段各得一份，时间收在各自段内', () => {
    // 同一条成片切成两段：[0, 2000) 与 [2000, 3500)；「的」中点 2850 落在后一段。
    const placed = place(
      [
        video({ id: 'a', start: 0, duration: 2000 }),
        video({ id: 'b', start: 2000, duration: 1500, playbackStart: 2000 }),
      ],
      { 'job-a': RECORD },
    )
    expect(
      placed.map(({ clipId, sentenceIndex, start, end, text }) => ({
        clipId,
        sentenceIndex,
        start,
        end,
        text,
      })),
    ).toEqual([
      { clipId: 'a', sentenceIndex: 0, start: 0, end: 1200, text: '我们一起去，' },
      { clipId: 'a', sentenceIndex: 1, start: 1500, end: 2000, text: '很方便' },
      { clipId: 'b', sentenceIndex: 1, start: 2200, end: 3500, text: '的。' },
    ])
  })

  it('素材入点之前与出点之后的词不进整片', () => {
    const placed = place([video({ id: 'a', start: 0, duration: 1000, playbackStart: 1500 })], {
      'job-a': RECORD,
    })
    expect(placed.map((caption) => caption.words)).toEqual([
      [{ text: '很方便', start: 0, end: 700 }],
    ])
  })

  it('改过字的句子在原起止内按字数平均分配：拉丁字母连成一个词，标点并到前一个词', () => {
    const placed = place([video({ id: 'a', start: 0, duration: 4000 })], { 'job-a': RECORD }, [
      { subtitleJobId: 'sub-a', sentenceIndex: 1, text: '真 OK！好' },
    ])
    // 「真」「OK！」「好」字数 1:2:1，平分 1500–3500。
    expect(placed[1]?.words).toEqual([
      { text: '真', start: 1500, end: 2000 },
      { text: 'OK！', start: 2000, end: 3000 },
      { text: '好', start: 3000, end: 3500 },
    ])
    expect(placed[1]?.text).toBe('真OK！好')
  })

  it('句首的标点并到后一个词，不单独占时间', () => {
    const placed = place([video({ id: 'a', start: 0, duration: 4000 })], { 'job-a': RECORD }, [
      { subtitleJobId: 'sub-a', sentenceIndex: 1, text: '“好看”' },
    ])
    expect(placed[1]?.words).toEqual([
      { text: '“好', start: 1500, end: 2500 },
      { text: '看”', start: 2500, end: 3500 },
    ])
  })

  it('改成空白或只剩标点的句子不再出现', () => {
    const placed = place([video({ id: 'a', start: 0, duration: 4000 })], { 'job-a': RECORD }, [
      { subtitleJobId: 'sub-a', sentenceIndex: 0, text: '  ' },
      { subtitleJobId: 'sub-a', sentenceIndex: 1, text: '……' },
    ])
    expect(placed).toEqual([])
  })

  it('改动只对同一条字幕记录生效，重跑识别换了记录后不再套用', () => {
    const placed = place([video({ id: 'a', start: 0, duration: 4000 })], { 'job-a': RECORD }, [
      { subtitleJobId: 'sub-old', sentenceIndex: 0, text: '旧改动' },
    ])
    expect(placed[0]?.text).toBe('我们一起去，')
  })

  it('没有逐词时间的旧记录按句子文字平均分配', () => {
    const old: SubtitleRecord = {
      subtitleJobId: 'sub-old',
      sentences: [{ startMs: 1000, endMs: 1400, text: '你好呀，朋友', speaker: null }],
    }
    const placed = place([video({ id: 'a', start: 0, duration: 4000 })], { 'job-a': old })
    expect(placed[0]?.words).toEqual([
      { text: '你', start: 1000, end: 1080 },
      { text: '好', start: 1080, end: 1160 },
      { text: '呀，', start: 1160, end: 1240 },
      { text: '朋', start: 1240, end: 1320 },
      { text: '友', start: 1320, end: 1400 },
    ])
  })

  it('组件段与没有字幕记录的段不出字幕', () => {
    const intro: WholeFilmComponentClip = {
      id: 'intro',
      type: 'component',
      start: 0,
      duration: 2000,
      playbackStart: 0,
      component: 'logo',
      variables: {},
    }
    const placed = place(
      [
        intro,
        video({ id: 'a', start: 2000, duration: 1000, sourceJobId: 'job-none' }),
        video({ id: 'b', start: 3000, duration: 4000 }),
      ],
      { 'job-a': RECORD, 'job-none': null },
    )
    expect(placed.map((caption) => [caption.clipId, caption.start])).toEqual([
      ['b', 3000],
      ['b', 4500],
    ])
  })
})

describe('captionWords', () => {
  it('每一份句子是一组，时间换成秒', () => {
    const placed = place(
      [
        video({ id: 'a', start: 0, duration: 2000 }),
        video({ id: 'b', start: 2000, duration: 1500, playbackStart: 2000 }),
      ],
      { 'job-a': RECORD },
    )
    expect(
      captionWords(placed).map(({ text, start, sentence }) => [text, start, sentence]),
    ).toEqual([
      ['我们', 0, 0],
      ['一起去，', 0.4, 0],
      ['很方便', 1.5, 1],
      ['的。', 2.2, 2],
    ])
  })
})

describe('joinWords', () => {
  it.each([
    [['我们', '一起去，'], '我们一起去，'],
    [['Hello', 'world.'], 'Hello world.'],
    [['用', 'iPhone', '拍'], '用iPhone拍'],
    [['3', 'cm'], '3 cm'],
  ])('%j → %s', (words, text) => {
    expect(joinWords(words.map((piece) => ({ text: piece })))).toBe(text)
  })
})
