import { act, render } from '@testing-library/react'
import { createRef, type ComponentProps } from 'react'
import { expect, it, vi } from 'vitest'
import { MaterialPreview, type MaterialPreviewControl, type MaterialView } from './material-preview'
import type { MaterialRange } from './materials'

const range: MaterialRange = {
  jobId: 'job',
  takeId: 'take',
  startMs: 1000,
  endMs: 2500,
  shots: [{ startMs: 1000, endMs: 2500 }],
}

const setup = (view: MaterialView) => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  const time = vi.fn()
  const controlRef = createRef<MaterialPreviewControl>()
  const props: ComponentProps<typeof MaterialPreview> = {
    controlRef,
    url: 'https://example.com/take.mp4',
    view,
    label: '素材 · 镜头组 1 · 生成 A · 镜头 2',
    timeMs: view.show === 'end' ? range.endMs : range.startMs,
    onTime: time,
    onPlaying: () => {},
    onNotice: () => {},
  }
  const { container, rerender } = render(<MaterialPreview {...props} />)
  const video = container.querySelector('video')
  if (video === null) throw new Error('没有素材视频')
  return { video, time, controlRef, props, rerender }
}

it('选中时媒体定到选区开头往后 0.001 秒，拖结尾一端时定到出点往前 0.001 秒；对外报的时间不变', () => {
  const { video, time, props, rerender } = setup({ range, show: 'start' })
  expect(video.currentTime).toBeCloseTo(1.001, 6)
  expect(time).toHaveBeenLastCalledWith(1000)

  rerender(<MaterialPreview {...props} view={{ range, show: 'end' }} />)
  expect(video.currentTime).toBeCloseTo(2.499, 6)
  expect(time).toHaveBeenLastCalledWith(2500)
})

it('停在出点时播放从选区开头往后 0.001 秒重播', () => {
  const { video, controlRef } = setup({ range, show: 'end' })
  expect(video.currentTime).toBeCloseTo(2.499, 6)
  act(() => controlRef.current?.toggle())
  expect(video.currentTime).toBeCloseTo(1.001, 6)
})
