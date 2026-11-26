import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useAudition } from './use-audition'

const A = { id: 'a', url: 'http://localhost/a.mp3' }
const B = { id: 'b', url: 'http://localhost/b.mp3' }

const stubMedia = (play: () => Promise<void> = () => Promise.resolve()) => {
  const played: string[] = []
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    played.push(this.getAttribute('src') ?? '')
    return play()
  })
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  return { pause, played }
}

describe('useAudition', () => {
  it('同一条再点是暂停、再点续放；暂停时还是当前这条，只是没在出声；换一条从头放', async () => {
    const { pause, played } = stubMedia()
    const { result } = renderHook(() => useAudition({ active: true, onError: () => {} }))

    await act(async () => result.current.toggle(A.id, A.url))
    expect(result.current).toMatchObject({ current: 'a', playing: 'a' })

    await act(async () => result.current.toggle(A.id, A.url))
    expect(result.current).toMatchObject({ current: 'a', playing: null })
    expect(pause).toHaveBeenCalledTimes(1)

    await act(async () => result.current.toggle(A.id, A.url))
    expect(result.current).toMatchObject({ current: 'a', playing: 'a' })
    expect(played).toEqual([A.url, A.url])

    await act(async () => result.current.toggle(B.id, B.url))
    expect(result.current).toMatchObject({ current: 'b', playing: 'b' })
    expect(played).toEqual([A.url, A.url, B.url])
  })

  it('stop 停下并清掉当前这条；所在的地方藏起来时也停', async () => {
    const { pause } = stubMedia()
    const { result, rerender } = renderHook(
      ({ active }) => useAudition({ active, onError: () => {} }),
      { initialProps: { active: true } },
    )
    await act(async () => result.current.toggle(A.id, A.url))
    act(() => result.current.stop())
    expect(result.current).toMatchObject({ current: null, playing: null })

    await act(async () => result.current.toggle(B.id, B.url))
    rerender({ active: false })
    expect(result.current).toMatchObject({ current: null, playing: null })
    expect(pause).toHaveBeenCalledTimes(2)
  })

  it('放不出来时调 onError，当前这条留着（好让试听条显示失败）；被暂停打断的不算失败', async () => {
    const onError = vi.fn()
    let reject: (error: unknown) => void = () => {}
    stubMedia(
      () =>
        new Promise((_, fail) => {
          reject = fail
        }),
    )
    const { result } = renderHook(() => useAudition({ active: true, onError }))

    act(() => result.current.toggle(A.id, A.url))
    act(() => result.current.toggle(A.id, A.url))
    await act(async () => reject(new DOMException('interrupted', 'AbortError')))
    expect(onError).not.toHaveBeenCalled()

    act(() => result.current.toggle(B.id, B.url))
    await act(async () => reject(new DOMException('unsupported', 'NotSupportedError')))
    expect(onError).toHaveBeenCalledTimes(1)
    expect(result.current).toMatchObject({ current: 'b', playing: null })
  })
})
