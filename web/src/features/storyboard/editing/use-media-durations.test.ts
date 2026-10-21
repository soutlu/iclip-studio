import { fireEvent, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMediaDurations } from './use-media-durations'

const CLIP = 'https://example.com/clip.mp4'
const UPSTREAM = 'https://example.com/upstream.mp4'

/** jsdom 不加载媒体元数据，在浏览器创建视频元素的边界补发元数据事件。 */
const captureProbes = () => {
  const probes: HTMLVideoElement[] = []
  const create = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const element = create(tag)
    if (element instanceof HTMLVideoElement) probes.push(element)
    return element
  })
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  return probes
}

describe('useMediaDurations', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('后端已经量好的地址直接给出来，不再去探', () => {
    const probes = captureProbes()
    const { result } = renderHook(() => useMediaDurations([CLIP], { [CLIP]: 4.213 }))

    expect(result.current[CLIP]).toBe(4.213)
    expect(probes).toEqual([])
  })

  it('后端不知道的地址还要自己探', () => {
    const probes = captureProbes()
    const { result } = renderHook(() => useMediaDurations([CLIP, UPSTREAM], { [CLIP]: 4.213 }))

    expect(probes.map((video) => video.src)).toEqual([UPSTREAM])
    expect(UPSTREAM in result.current).toBe(false)
    const video = probes[0]
    if (video === undefined) throw new Error('缺少媒体探测')
    Object.defineProperty(video, 'duration', { value: 2.75 })
    fireEvent.loadedMetadata(video)
    expect(result.current).toEqual({ [CLIP]: 4.213, [UPSTREAM]: 2.75 })
  })
})
