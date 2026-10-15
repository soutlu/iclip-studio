import { assert, describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { parseStoredFilm, serializeStoredFilm, splitAt, trimSegment } from './film-draft'
import { burnedSubtitles, projectSubtitles, type SubtitleSource } from './film-subtitles'
import { draftFromVersion } from './film-versions'

const source: SubtitleSource = {
  kind: 'ready',
  jobId: 'sub-a',
  sentences: [{ startMs: 0, endMs: 4000, text: '原来的口播' }],
}
const restore = (subtitles: { startMs: number; endMs: number; text: string }[]) => {
  let id = 0
  const stored = draftFromVersion(
    makeGenerationJob({
      operation: 'compose',
      request: { segments: [{ sourceJobId: 'A', startMs: 0, endMs: 5000 }], subtitles },
    }),
    {
      groupOf: () => 'group',
      generatedMusic: new Set(),
      newId: () => `id-${++id}`,
    },
  )
  assert(stored !== undefined)
  return stored.film
}
const captions = (film: ReturnType<typeof restore>) =>
  burnedSubtitles(projectSubtitles(film, () => source).subtitles)

describe('从已合成版本恢复字幕', () => {
  it('清空的识别字幕不会重新出现', () => {
    expect(captions(restore([]))).toEqual([])
  })
  it('与识别句起点相同的手动字幕保留自己的结尾', () => {
    expect(captions(restore([{ startMs: 0, endMs: 2000, text: '标题' }]))).toEqual([
      { at: 0, end: 2, text: '标题' },
    ])
  })
  it('来源重新识别也不改动版本里的字幕；裁剪、拆分后字幕仍跟随画面', () => {
    const film = restore([{ startMs: 1000, endMs: 4000, text: '保留的文字' }])
    const first = film.segments[0]
    assert(first !== undefined)
    const cut = trimSegment(film, first.id, 'start', 2)
    expect(captions(cut)).toEqual([{ at: 0, end: 2, text: '保留的文字' }])
    const split = splitAt(film, 2, 'right')
    assert(split !== undefined)
    expect(captions(split)).toEqual([
      { at: 1, end: 2, text: '保留的文字' },
      { at: 2, end: 4, text: '保留的文字' },
    ])
  })
  it('模板快照和字幕快照经过浏览器存取后仍可恢复，停用不会丢失历史地址', () => {
    const request = {
      segments: [{ sourceJobId: 'A', startMs: 0, endMs: 5000 }],
      subtitles: [],
      intro: {
        templateId: 'intro',
        url: 'https://example.com/intro.mp4',
        durationMs: 2000,
        width: 720,
        height: 1280,
        hasAudio: true,
      },
    }
    let id = 0
    const stored = draftFromVersion(makeGenerationJob({ operation: 'compose', request }), {
      groupOf: () => 'group',
      generatedMusic: new Set(),
      newId: () => `id-${++id}`,
    })
    assert(stored !== undefined)
    const reloaded = parseStoredFilm(serializeStoredFilm(stored))
    assert(reloaded !== undefined)
    expect(reloaded.film.intro).toEqual({ ...request.intro, name: '片头' })
    expect(captions(reloaded.film)).toEqual([])
  })
})
