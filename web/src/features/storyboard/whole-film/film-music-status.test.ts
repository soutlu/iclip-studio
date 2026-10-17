import { describe, expect, it } from 'vitest'
import {
  composableMusic,
  isMusicPending,
  musicBlockedReason,
  musicTrackLabel,
  type MusicStatus,
} from './film-music-status'

const ready = (shortBy: number): MusicStatus => ({
  kind: 'ready',
  title: '夏日节拍.wav',
  song: { duration: 2, grid: null },
  peaks: { rate: 50, peaks: [] },
  placement: { start: 0, userPlaced: false, available: 2, shortBy, onBeat: [], cutCount: 0 },
  previewCurve: [],
  plan: { audioJobId: 'music', start: 0, curve: [{ atMs: 0, gain: 0.5 }] },
})

describe('音乐状态派生的轨道文案与合成阻止原因', () => {
  it.each<[string, MusicStatus, string | undefined, string | undefined]>([
    ['没有音乐', { kind: 'none' }, undefined, undefined],
    ['上传中', { kind: 'uploading' }, '正在上传音乐…', '音乐上传中，暂时无法合成'],
    ['提交生成中', { kind: 'submitting' }, '正在提交音乐生成…', '音乐生成提交中，暂时无法合成'],
    ['生成中', { kind: 'generating' }, '音乐生成中，完成后自动对齐', '音乐生成中，暂时无法合成'],
    ['读取中', { kind: 'reading' }, '正在读取音乐…', '音乐读取中，暂时无法合成'],
    [
      '失败',
      { kind: 'failed', message: '音乐读取失败', onRetry: undefined },
      '音乐读取失败',
      '音乐不可用，无法合成；请重试、更换或删除音乐',
    ],
    ['可用', ready(0), undefined, undefined],
    ['比成片短', ready(4), undefined, '音乐比成片短 4.0 秒，无法合成；请重新生成或更换音乐'],
  ])('%s', (_, status, track, blocked) => {
    expect(musicTrackLabel(status)).toBe(track)
    expect(musicBlockedReason(status)).toBe(blocked)
  })

  it('只有在等待中的状态让预览声音等待，只有够长的可用音乐进入合成请求', () => {
    expect(
      (['uploading', 'submitting', 'generating', 'reading'] as const).every((kind) =>
        isMusicPending({ kind }),
      ),
    ).toBe(true)
    expect(isMusicPending({ kind: 'none' })).toBe(false)
    expect(isMusicPending(ready(0))).toBe(false)
    expect(composableMusic(ready(0))).toEqual({
      audioJobId: 'music',
      start: 0,
      curve: [{ atMs: 0, gain: 0.5 }],
    })
    expect(composableMusic(ready(4))).toBeNull()
  })
})
