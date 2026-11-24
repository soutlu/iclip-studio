import { describe, expect, it } from 'vitest'
import { caption, video } from '@/testing/final-cut'
import { makeGenerationJob } from '@/testing/generation-job'
import type { Sentence } from './caption-edit'
import { captionScripts, scriptLinesOf } from './caption-script'
import type { FilmClip, VideoClip } from './composition/film'

const TAKE = 'take-1'
const SRC = 'https://media.test/take-1.mp4'

const clip = (overrides: Partial<VideoClip> = {}) =>
  video({ id: 'clip-1', src: SRC, start: 0, duration: 6_000, ...overrides })

const line = (id: string, start: number, duration: number, text: string, owner: string | null) =>
  caption({ id, variable: id, start, duration, text, owner })

const said = (startMs: number, endMs: number, text: string): Sentence => ({ startMs, endMs, text })

const notesOf = (
  clips: readonly FilmClip[],
  lines: readonly string[] | undefined,
  sentences: readonly Sentence[] | undefined,
) =>
  captionScripts(
    clips,
    (src) => (src === SRC ? TAKE : undefined),
    new Map(lines === undefined ? [] : [[TAKE, lines]]),
    new Map(sentences === undefined ? [] : [[TAKE, sentences]]),
  )

/** 照服务端存的样子：从镜头组出的片在 `metadata.film_node` 记着镜头组，`request.shot` 里台词写在花括号里。 */
const filmTake = (prompts: readonly string[], metadata: Record<string, unknown> | null) =>
  makeGenerationJob({
    id: TAKE,
    metadata,
    request: {
      model: 'seedance-2.5-flash',
      shot: {
        global_settings: '画面风格\n写实',
        timeline: prompts.map((prompt, index) => ({
          timestamps: [index * 3, index * 3 + 3],
          prompt,
          image_indexes: [],
        })),
      },
    },
  })

describe('素材片的台词', () => {
  it('按镜头先后、每镜从左到右取花括号里的字，去掉首尾空白，空的不要', () => {
    const job = filmTake(
      ['她看向镜头说{今天我们去海边。}然后笑了', '{ 带上帽子。 }{}他点头｛不是台词｝'],
      { film_node: 'video-1' },
    )
    expect(scriptLinesOf(job)).toEqual(['今天我们去海边。', '带上帽子。'])
  })

  it('一句台词都没有：null', () => {
    expect(scriptLinesOf(filmTake(['她看向镜头', '他点头'], { film_node: 'video-1' }))).toBeNull()
  })

  it('不是从镜头组出的片（没有 film_node，或没有结构化的镜头）：null', () => {
    expect(scriptLinesOf(filmTake(['{今天我们去海边。}'], null))).toBeNull()
    expect(
      scriptLinesOf(makeGenerationJob({ id: TAKE, metadata: { film_node: 'video-1' } })),
    ).toBeNull()
  })
})

describe('字幕对照台词', () => {
  const LINES = ['We open at nine.', 'See you there.']
  const SENTENCES = [said(1_000, 4_000, 'We open at nine.'), said(4_500, 6_000, 'See you there.')]

  it('开头被裁掉的句子：字幕从片段开头起、字是整句，对照的是整句台词；一致时不在结果里', () => {
    const trimmed = clip({ mediaStart: 2_500, duration: 3_500 })
    expect(
      notesOf([trimmed, line('cap-1', 0, 1_500, 'We open at nine.', 'clip-1')], LINES, SENTENCES),
    ).toEqual(new Map())
    expect(
      notesOf([trimmed, line('cap-1', 0, 1_500, 'We open at ten.', 'clip-1')], LINES, SENTENCES),
    ).toEqual(
      new Map([
        [
          'cap-1',
          {
            script: 'We open at nine.',
            parts: [
              { kind: 'same', text: 'We open at ' },
              { kind: 'captionOnly', text: 'ten' },
              { kind: 'same', text: ' ' },
              { kind: 'scriptOnly', text: 'nine' },
              { kind: 'same', text: '.' },
            ],
          },
        ],
      ]),
    )
  })

  it('被别的字幕挤短了的那句：仍然对整句台词', () => {
    const notes = notesOf(
      [
        clip(),
        line('cap-1', 1_000, 1_500, 'We open at ten.', 'clip-1'),
        line('manual', 2_500, 1_500, '手动加的', null),
      ],
      LINES,
      SENTENCES,
    )
    expect([...notes.keys()]).toEqual(['cap-1'])
    expect(notes.get('cap-1')?.script).toBe('We open at nine.')
  })

  it('一句台词被识别成两句：每句对上台词里它那一段', () => {
    const notes = notesOf(
      [
        clip(),
        line('cap-1', 0, 2_000, 'We open at nine,', 'clip-1'),
        line('cap-2', 2_000, 2_000, 'see you their.', 'clip-1'),
      ],
      ['We open at nine, see you there.'],
      [said(0, 2_000, 'We open at nine,'), said(2_000, 4_000, 'see you their.')],
    )
    expect([...notes.keys()]).toEqual(['cap-2'])
    expect(notes.get('cap-2')?.script).toBe('see you there.')
  })

  it('两句台词被识别成一句：对两句台词接起来的整段；中文按字比，标点不算差异', () => {
    const lines = ['今天我们去海边。', '带上帽子。']
    const sentences = [said(0, 4_000, '今天我们去海边带上鞋子')]
    const notes = notesOf(
      [clip(), line('cap-1', 0, 4_000, '今天我们去海边带上鞋子', 'clip-1')],
      lines,
      sentences,
    )
    expect(notes.get('cap-1')).toEqual({
      script: '今天我们去海边。带上帽子。',
      parts: [
        { kind: 'same', text: '今天我们去海边带上' },
        { kind: 'captionOnly', text: '鞋' },
        { kind: 'scriptOnly', text: '帽' },
        { kind: 'same', text: '子' },
      ],
    })
    expect(
      notesOf(
        [clip(), line('cap-1', 0, 4_000, '今天我们去海边，带上帽子', 'clip-1')],
        lines,
        sentences,
      ),
    ).toEqual(new Map())
  })

  it('两句英文台词被识别成一句：两行台词之间补空格接起来', () => {
    const notes = notesOf(
      [clip(), line('cap-1', 0, 4_000, 'We open at nine see you their', 'clip-1')],
      LINES,
      [said(0, 4_000, 'We open at nine see you their')],
    )
    expect(notes.get('cap-1')?.script).toBe('We open at nine. See you there.')
  })

  it('句子交界处只在台词里有的词：跟它同一行台词的那句走，开头漏的归后一句，结尾漏的归前一句', () => {
    const lines = ['Hello there friend.', 'We open at nine.']
    const captions = (first: string, second: string) => [
      clip(),
      line('cap-1', 0, 1_000, first, 'clip-1'),
      line('cap-2', 1_000, 2_000, second, 'clip-1'),
    ]
    const sentences = (first: string, second: string) => [
      said(0, 1_000, first),
      said(1_000, 3_000, second),
    ]
    const headLost = notesOf(
      captions('Hello there friend.', 'open at nine.'),
      lines,
      sentences('Hello there friend.', 'open at nine.'),
    )
    expect([...headLost.keys()]).toEqual(['cap-2'])
    expect(headLost.get('cap-2')?.script).toBe('We open at nine.')

    const tailLost = notesOf(
      captions('Hello there.', 'We open at nine.'),
      lines,
      sentences('Hello there.', 'We open at nine.'),
    )
    expect([...tailLost.keys()]).toEqual(['cap-1'])
    expect(tailLost.get('cap-1')?.script).toBe('Hello there friend.')
  })

  it('大小写、标点、弯撇号和直撇号、连字符不算差异；They’re 是一个词', () => {
    const lines = ['They’re open 24-hour, every day.']
    const sentences = [said(0, 3_000, "they're open 24 hour every day")]
    expect(
      notesOf(
        [clip(), line('cap-1', 0, 3_000, "they're open 24 hour every day", 'clip-1')],
        lines,
        sentences,
      ),
    ).toEqual(new Map())
    expect(
      notesOf(
        [clip(), line('cap-1', 0, 3_000, 'They are open 24 hour every day', 'clip-1')],
        lines,
        sentences,
      ).get('cap-1')?.parts,
    ).toEqual([
      { kind: 'captionOnly', text: 'They are' },
      { kind: 'same', text: ' ' },
      { kind: 'scriptOnly', text: 'They’re' },
      { kind: 'same', text: ' open 24 hour every day' },
    ])
  })

  it('速度不是 1 的片段：字幕时间按入点和速度换算回素材时间再找句子', () => {
    // 片段从 1 秒起、两倍速、入点 2 秒：字幕 2–3 秒对的是素材 4–6 秒
    const fast = clip({ start: 1_000, duration: 2_000, mediaStart: 2_000, playbackRate: 2 })
    const notes = notesOf(
      [fast, line('cap-1', 2_000, 1_000, 'Second line hear.', 'clip-1')],
      ['First line here.', 'Second line here.'],
      [said(2_000, 3_500, 'First line here.'), said(4_000, 6_000, 'Second line hear.')],
    )
    expect(notes.get('cap-1')?.script).toBe('Second line here.')
  })

  it('素材片没有台词、没有识别结果，字幕没有所属片段、和哪句都不重叠，对应的台词是空串：都不在结果里', () => {
    const differs = [clip(), line('cap-1', 1_000, 3_000, 'We open at ten.', 'clip-1')]
    expect(notesOf(differs, undefined, SENTENCES)).toEqual(new Map())
    expect(notesOf(differs, LINES, undefined)).toEqual(new Map())
    expect(
      notesOf([clip(), line('cap-1', 1_000, 3_000, 'We open at ten.', null)], LINES, SENTENCES),
    ).toEqual(new Map())
    expect(
      notesOf([clip(), line('cap-1', 0, 900, 'We open at ten.', 'clip-1')], LINES, SENTENCES),
    ).toEqual(new Map())
    expect(
      notesOf(
        [clip(), line('cap-2', 1_000, 1_000, 'Totally unrelated words', 'clip-1')],
        ['Hello there.'],
        [said(0, 1_000, 'Hello there.'), said(1_000, 2_000, 'Totally unrelated words')],
      ),
    ).toEqual(new Map())
  })

  it('字幕改成和台词一样以后不在结果里', () => {
    const before = notesOf(
      [clip(), line('cap-1', 1_000, 3_000, 'We open at ten.', 'clip-1')],
      LINES,
      SENTENCES,
    )
    expect(before.get('cap-1')?.script).toBe('We open at nine.')
    const after = notesOf(
      [clip(), line('cap-1', 1_000, 3_000, before.get('cap-1')?.script ?? '', 'clip-1')],
      LINES,
      SENTENCES,
    )
    expect(after).toEqual(new Map())
  })
})
