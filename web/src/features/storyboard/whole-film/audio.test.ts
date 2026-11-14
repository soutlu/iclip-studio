import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { audio, component, picture } from '@/testing/whole-film'
import {
  audioPlayheadSpot,
  audioTitleOf,
  durationLabel,
  filterAudio,
  firstAudioBlockOf,
} from './audio'
import { rowOpening } from './placement'

const generated = (prompt: string) =>
  makeGenerationJob({ kind: 'audio', request: { prompt, model: 'music' } })

describe('音频的名字和筛选', () => {
  it('生成的音乐叫它的描述，上传的写上传时间，没有描述的叫「生成的音乐」', () => {
    expect(audioTitleOf(generated('轻快原声吉他'))).toBe('轻快原声吉他')
    expect(audioTitleOf(makeGenerationJob({ kind: 'audio', request: {} }))).toBe('生成的音乐')
    expect(
      audioTitleOf(
        makeGenerationJob({
          kind: 'audio',
          operation: 'upload',
          createdAt: '2026-09-01T12:05:00Z',
        }),
      ),
    ).toMatch(/^上传的音乐 · .*2026/)
  })

  it('按名字筛，去掉两头空白、西文不分大小写，按原来的先后', () => {
    const jobs = [generated('City Night 夜景'), generated('轻快吉他'), generated('city walk')]
    expect(filterAudio(jobs, '  CITY ').map(audioTitleOf)).toEqual(['City Night 夜景', 'city walk'])
    expect(filterAudio(jobs, '吉他').map(audioTitleOf)).toEqual(['轻快吉他'])
    expect(filterAudio(jobs, '钢琴')).toEqual([])
    expect(filterAudio(jobs, '')).toEqual(jobs)
  })

  it('时长写成分:秒', () => {
    expect(durationLabel(30_000)).toBe('00:30')
    expect(durationLabel(168_400)).toBe('02:48')
  })
})

describe('成片里用着的音频', () => {
  it('用着这条音频的片段里开始得最早的那个；别的记录、视频片段不算', () => {
    const blocks = [
      audio({ id: 'late', start: 5000 }),
      picture({ jobId: 'other' }),
      audio({ id: 'early', start: 1000, track: 1 }),
      audio({ id: 'else', jobId: 'other-audio', start: 0 }),
    ]
    expect(firstAudioBlockOf(blocks, audio().jobId)?.id).toBe('early')
    expect(firstAudioBlockOf(blocks, 'missing')).toBeUndefined()
  })
})

describe('音频点「加到播放头」时放在哪', () => {
  it('还没有声音行：在时间线最下面新开第一条声音行，从播放头开始', () => {
    expect(audioPlayheadSpot([], 1500, 30_000)).toEqual({
      row: { zone: 'audio', insertAt: 0 },
      start: 1500,
    })
    const visual = [picture(), component({ track: 1 })]
    const spot = audioPlayheadSpot(visual, 1500, 30_000)
    expect(spot).toEqual({ row: { zone: 'audio', insertAt: 2 }, start: 1500 })
    expect(rowOpening(visual, 'audio', 2).track).toBe(0)
  })

  it('声音区第一行在这段时间空着：放进这一行（行号按它自己的）', () => {
    const blocks = [
      picture({ duration: 9000 }),
      audio({ id: 'a', track: 2, start: 0, duration: 1000 }),
      audio({ id: 'b', track: 2, start: 9000, duration: 1000 }),
      audio({ id: 'c', track: 3, start: 1000, duration: 6000 }),
    ]
    expect(audioPlayheadSpot(blocks, 1000, 8000)).toEqual({
      row: { zone: 'audio', track: 2 },
      start: 1000,
    })
  })

  it('声音区第一行在这段时间有片段：在它下面紧挨着新开一行，下面的声音行往后顺延', () => {
    const blocks = [
      picture({ duration: 9000 }),
      component({ track: 1 }),
      audio({ id: 'a', track: 0, start: 0, duration: 1000 }),
      audio({ id: 'b', track: 1, start: 0, duration: 9000 }),
    ]
    const spot = audioPlayheadSpot(blocks, 999, 5000)
    expect(spot).toEqual({ row: { zone: 'audio', insertAt: 3 }, start: 999 })
    const opened = rowOpening(blocks, 'audio', 3)
    expect(opened.track).toBe(1)
    expect(opened.renumber).toEqual(new Map([['b', 2]]))
    // 正好接在第一行的片段后面不算占着
    expect(audioPlayheadSpot(blocks, 1000, 5000).row).toEqual({ zone: 'audio', track: 0 })
  })
})
