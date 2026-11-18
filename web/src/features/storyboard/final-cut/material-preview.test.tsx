import { act, fireEvent, render, screen } from '@testing-library/react'
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
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  const time = vi.fn()
  const controlRef = createRef<MaterialPreviewControl>()
  const props: ComponentProps<typeof MaterialPreview> = {
    controlRef,
    url: 'https://example.com/take.mp4',
    view,
    label: '素材 · 镜头组 1 · 生成 A · 镜头 2',
    rate: 1,
    muted: false,
    onTime: time,
    onPlaying: () => {},
    onNotice: () => {},
  }
  const { container, rerender } = render(<MaterialPreview {...props} />)
  const video = container.querySelector('video')
  if (video === null) throw new Error('没有素材视频')
  return { video, time, controlRef, props, rerender, play, pause }
}

it('画面上不放文字：放的是哪条素材的哪几个镜头写在区域的无障碍名称里', () => {
  const { video } = setup({ range, show: 'start' })
  const region = screen.getByRole('region', { name: '素材 · 镜头组 1 · 生成 A · 镜头 2' })
  expect(region).toContainElement(video)
  expect(region.textContent).toBe('')
})

it('跳转夹在选区里：范围以外停在最近的一端，媒体按那一端的偏移定位；不播放也不暂停', () => {
  const { video, time, controlRef, play, pause } = setup({ range, show: 'start' })
  const calls = () => [play.mock.calls.length, pause.mock.calls.length]
  const before = calls()

  act(() => controlRef.current?.seek(1800))
  expect(video.currentTime).toBeCloseTo(1.801, 6)
  expect(time).toHaveBeenLastCalledWith(1800)

  act(() => controlRef.current?.seek(5000))
  expect(video.currentTime).toBeCloseTo(2.499, 6)
  expect(time).toHaveBeenLastCalledWith(2500)

  act(() => controlRef.current?.seek(0))
  expect(video.currentTime).toBeCloseTo(1.001, 6)
  expect(time).toHaveBeenLastCalledWith(1000)
  expect(calls()).toEqual(before)
})

it('跳到范围结尾后播放从选区开头重播；跳到中间后播放从那里接着放', () => {
  const { video, controlRef } = setup({ range, show: 'start' })
  act(() => controlRef.current?.seek(9000))
  act(() => controlRef.current?.toggle())
  expect(video.currentTime).toBeCloseTo(1.001, 6)

  act(() => controlRef.current?.seek(2000))
  act(() => controlRef.current?.toggle())
  expect(video.currentTime).toBeCloseTo(2.001, 6)
})

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

it('倍速和静音跟着设置走', () => {
  const { video, props, rerender } = setup({ range, show: 'start' })
  expect(video.playbackRate).toBe(1)
  expect(video.muted).toBe(false)

  rerender(<MaterialPreview {...props} muted rate={2} />)
  expect(video.playbackRate).toBe(2)
  expect(video.muted).toBe(true)
})

it('播放中等数据时显示正在缓冲，能放了或暂停后收起', () => {
  const { video } = setup({ range, show: 'start' })
  const buffering = () => screen.queryByRole('status', { name: '正在缓冲' })
  expect(buffering()).not.toBeInTheDocument()

  fireEvent.waiting(video)
  expect(buffering()).toBeVisible()
  fireEvent.playing(video)
  expect(buffering()).not.toBeInTheDocument()

  fireEvent.waiting(video)
  fireEvent.pause(video)
  expect(buffering()).not.toBeInTheDocument()
})
