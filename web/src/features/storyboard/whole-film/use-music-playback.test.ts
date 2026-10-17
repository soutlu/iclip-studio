import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { stubWebAudio } from '@/testing/web-audio'
import { useMusicPlayback } from './use-music-playback'

afterEach(() => vi.unstubAllGlobals())

it('完整混音按画面时钟定位，微小抖动不重启；seek、静音、暂停和卸载释放各自资源', () => {
  const audio = stubWebAudio({ duration: 10 })
  const buffer = new OfflineAudioContext(2, 1, 48_000).createBuffer(2, 480_000, 48_000)
  const initial = { buffer, duration: 10, playing: false, muted: true, clock: 2 }
  const { result, rerender, unmount } = renderHook((options) => useMusicPlayback(options), {
    initialProps: initial,
  })
  act(() => result.current.prime())
  rerender({ ...initial, playing: true })
  expect(audio.played).toHaveLength(1)
  expect(audio.played[0]).toMatchObject({ offset: 2, duration: 8 })
  expect(audio.master.at(-1)?.value).toBe(0)
  audio.advance(0.5)
  rerender({ ...initial, playing: true, muted: false, clock: 2.52 })
  expect(audio.played).toHaveLength(1)
  expect(audio.master.at(-1)?.value).toBe(1)
  rerender({ ...initial, playing: true, clock: 6 })
  expect(audio.played[0]?.stopped).toBe(true)
  expect(audio.played[1]).toMatchObject({ offset: 6, duration: 4 })
  rerender({ ...initial, clock: 6 })
  expect(audio.played[1]?.stopped).toBe(true)
  rerender({ ...initial, playing: true, clock: 8 })
  expect(audio.played[2]).toMatchObject({ offset: 8, duration: 2 })
  unmount()
  expect(audio.played[2]?.stopped).toBe(true)
  expect(audio.closed).toBe(1)
})

it('无音轨和超出结尾不创建播放源', () => {
  const audio = stubWebAudio({ duration: 4 })
  const { rerender, unmount } = renderHook(
    (clock) =>
      useMusicPlayback({ buffer: undefined, duration: 4, playing: true, muted: false, clock }),
    { initialProps: 0 },
  )
  rerender(4)
  expect(audio.played).toEqual([])
  unmount()
  expect(audio.closed).toBe(0)
})
