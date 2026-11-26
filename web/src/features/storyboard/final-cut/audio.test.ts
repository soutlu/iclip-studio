import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { audio, host, video } from '@/testing/final-cut'
import type { MediaUpload } from '@/shared/api/media-upload'
import {
  audioPlayheadSpot,
  conversationAudio,
  filterAudio,
  firstAudioClipOf,
  generatedAudio,
} from './audio'
import { rowOpening } from './placement'

const generated = (prompt: string, createdAt = '2026-09-01T12:00:00Z') =>
  makeGenerationJob({ kind: 'audio', request: { prompt, model: 'music' }, createdAt })

const uploaded = (createdAt: string, durationMs: number | null = null): MediaUpload => ({
  contentType: 'audio/mpeg',
  conversationId: crypto.randomUUID(),
  createdAt,
  durationMs,
  height: null,
  id: crypto.randomUUID(),
  kind: 'audio',
  sizeBytes: 1024,
  url: `https://cdn.test/${createdAt}.mp3`,
  width: null,
})

describe('音频的名字和筛选', () => {
  it('生成的音乐叫它的描述，上传的写上传时间，没有描述的叫「生成的音乐」', () => {
    const [song, untitled, upload] = conversationAudio(
      [
        generated('轻快原声吉他', '2026-09-01T12:10:00Z'),
        makeGenerationJob({ kind: 'audio', request: {}, createdAt: '2026-09-01T12:06:00Z' }),
      ],
      [uploaded('2026-09-01T12:05:00Z')],
    )
    expect(song?.title).toBe('轻快原声吉他')
    expect(untitled?.title).toBe('生成的音乐')
    expect(upload?.title).toMatch(/^上传的音乐 · .*2026/)
  })

  it('生成的和上传的合成一张表，新的在前；上传的总是已就绪、不能重新生成，有时长才带上', () => {
    const early = uploaded('2026-09-01T11:00:00Z', 30_000)
    const late = uploaded('2026-09-01T13:00:00Z')
    const song = generated('轻快吉他', '2026-09-01T12:00:00Z')

    const merged = conversationAudio([song], [early, late])

    expect(merged.map((item) => item.id)).toEqual([late.id, song.id, early.id])
    expect(merged.map((item) => [item.generated, item.status, item.url, item.durationMs])).toEqual([
      [false, 'completed', late.url, null],
      [true, song.status, song.outputUrl, song.durationMs],
      [false, 'completed', early.url, 30_000],
    ])
  })

  it('按名字筛，去掉两头空白、西文不分大小写，按原来的先后', () => {
    const items = [generated('City Night 夜景'), generated('轻快吉他'), generated('city walk')].map(
      generatedAudio,
    )
    expect(filterAudio(items, '  CITY ').map((item) => item.title)).toEqual([
      'City Night 夜景',
      'city walk',
    ])
    expect(filterAudio(items, '吉他').map((item) => item.title)).toEqual(['轻快吉他'])
    expect(filterAudio(items, '钢琴')).toEqual([])
    expect(filterAudio(items, '')).toEqual(items)
  })
})

describe('final-cut 里用着的音频', () => {
  it('用着这条音频（按地址对上）的片段里开始得最早的那个；别的地址、视频片段不算', () => {
    const clips = [
      audio({ id: 'late', start: 5000 }),
      video({ src: audio().src }),
      audio({ id: 'early', start: 1000, track: 1 }),
      audio({ id: 'else', src: 'https://media.test/audio/other.mp3', start: 0 }),
    ]
    expect(firstAudioClipOf(clips, audio().src)?.id).toBe('early')
    expect(firstAudioClipOf(clips, 'missing')).toBeUndefined()
  })
})

describe('音频点「加到播放头」时放在哪', () => {
  it('还没有声音行：在时间线最下面新开第一条声音行，从播放头开始', () => {
    expect(audioPlayheadSpot([], 1500, 30_000)).toEqual({
      row: { zone: 'audio', insertAt: 0 },
      start: 1500,
    })
    const visual = [video(), host({ track: 1 })]
    const spot = audioPlayheadSpot(visual, 1500, 30_000)
    expect(spot).toEqual({ row: { zone: 'audio', insertAt: 2 }, start: 1500 })
    expect(rowOpening(visual, 'audio', 2).track).toBe(0)
  })

  it('声音区第一行在这段时间空着：放进这一行（行号按它自己的）', () => {
    const clips = [
      video({ duration: 9000 }),
      audio({ id: 'a', track: 2, start: 0, duration: 1000 }),
      audio({ id: 'b', track: 2, start: 9000, duration: 1000 }),
      audio({ id: 'c', track: 3, start: 1000, duration: 6000 }),
    ]
    expect(audioPlayheadSpot(clips, 1000, 8000)).toEqual({
      row: { zone: 'audio', track: 2 },
      start: 1000,
    })
  })

  it('声音区第一行在这段时间有片段：在它下面紧挨着新开一行，下面的声音行往后顺延', () => {
    const clips = [
      video({ duration: 9000 }),
      host({ track: 1 }),
      audio({ id: 'a', track: 0, start: 0, duration: 1000 }),
      audio({ id: 'b', track: 1, start: 0, duration: 9000 }),
    ]
    const spot = audioPlayheadSpot(clips, 999, 5000)
    expect(spot).toEqual({ row: { zone: 'audio', insertAt: 3 }, start: 999 })
    const opened = rowOpening(clips, 'audio', 3)
    expect(opened.track).toBe(1)
    expect(opened.renumber).toEqual(new Map([['b', 2]]))
    // 正好接在第一行的片段后面不算占着
    expect(audioPlayheadSpot(clips, 1000, 5000).row).toEqual({ zone: 'audio', track: 0 })
  })

  it('配乐不进原声行：放进原声行下面的第一条配乐行；它占着时在它下面新开一行；没有配乐行时在原声行下面新开一行', () => {
    const spoken = audio({ id: 'v', track: 0, start: 0, duration: 1000, syncOrigin: 'lk-1' })
    const music = audio({ id: 'm', track: 1, start: 5000, duration: 1000 })
    // 画面一行、原声一行、配乐一行：原声行这时空着也不进去
    expect(audioPlayheadSpot([video(), spoken, music], 2000, 1000).row).toEqual({
      zone: 'audio',
      track: 1,
    })
    expect(audioPlayheadSpot([video(), spoken, music], 4500, 1000).row).toEqual({
      zone: 'audio',
      insertAt: 3,
    })
    expect(audioPlayheadSpot([video(), spoken], 2000, 1000).row).toEqual({
      zone: 'audio',
      insertAt: 2,
    })
  })
})
