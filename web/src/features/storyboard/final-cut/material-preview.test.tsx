import { act, fireEvent, render, screen } from '@testing-library/react'
import { createRef, type ComponentProps } from 'react'
import { expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/shared/ui/tooltip'
import type { Edge } from '../editing/timeline-drag'
import { MaterialPreview, type MaterialPreviewControl, type MaterialView } from './material-preview'

const viewAt = (show: Edge): MaterialView => ({
  jobId: 'job',
  span: { startMs: 1000, endMs: 2500 },
  show,
})

const setup = (show: Edge) => {
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  const time = vi.fn()
  const controlRef = createRef<MaterialPreviewControl>()
  const props: ComponentProps<typeof MaterialPreview> = {
    controlRef,
    url: 'https://example.com/take.mp4',
    view: viewAt(show),
    label: '素材 · 镜头组 1 · 出片 A · 镜头 2',
    rate: 1,
    muted: false,
    onLeave: vi.fn(),
    layer: null,
    onTime: time,
    onPlaying: () => {},
    onNotice: () => {},
  }
  const { container, rerender } = render(<MaterialPreview {...props} />, {
    wrapper: TooltipProvider,
  })
  const video = container.querySelector('video')
  if (video === null) throw new Error('没有素材视频')
  return { video, time, controlRef, props, rerender, play, pause }
}

it('放的是哪条素材的哪几个镜头：写在左上角的提示块里，也是区域的无障碍名称；点「回到 final-cut」退出', () => {
  const { video, props } = setup('start')
  const region = screen.getByRole('region', { name: '素材 · 镜头组 1 · 出片 A · 镜头 2' })
  expect(region).toContainElement(video)
  expect(region).toHaveTextContent(/^素材 · 镜头组 1 · 出片 A · 镜头 2$/)

  fireEvent.click(screen.getByRole('button', { name: '回到 final-cut' }))
  expect(props.onLeave).toHaveBeenCalledTimes(1)
})

it('跳转夹在选区里：范围以外停在最近的一端，媒体按那一端的偏移定位；不播放也不暂停', () => {
  const { video, time, controlRef, play, pause } = setup('start')
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
  const { video, controlRef } = setup('start')
  act(() => controlRef.current?.seek(9000))
  act(() => controlRef.current?.toggle())
  expect(video.currentTime).toBeCloseTo(1.001, 6)

  act(() => controlRef.current?.seek(2000))
  act(() => controlRef.current?.toggle())
  expect(video.currentTime).toBeCloseTo(2.001, 6)
})

it('选中时媒体定到选区开头往后 0.001 秒，拖结尾一端时定到出点往前 0.001 秒；对外报的时间不变', () => {
  const { video, time, props, rerender } = setup('start')
  expect(video.currentTime).toBeCloseTo(1.001, 6)
  expect(time).toHaveBeenLastCalledWith(1000)

  rerender(<MaterialPreview {...props} view={viewAt('end')} />)
  expect(video.currentTime).toBeCloseTo(2.499, 6)
  expect(time).toHaveBeenLastCalledWith(2500)
})

it('停在出点时播放从选区开头往后 0.001 秒重播', () => {
  const { video, controlRef } = setup('end')
  expect(video.currentTime).toBeCloseTo(2.499, 6)
  act(() => controlRef.current?.toggle())
  expect(video.currentTime).toBeCloseTo(1.001, 6)
})

it('倍速和静音跟着设置走', () => {
  const { video, props, rerender } = setup('start')
  expect(video.playbackRate).toBe(1)
  expect(video.muted).toBe(false)

  rerender(<MaterialPreview {...props} muted rate={2} />)
  expect(video.playbackRate).toBe(2)
  expect(video.muted).toBe(true)
})

it('播放中等数据时显示正在缓冲，能放了或暂停后收起', () => {
  const { video } = setup('start')
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
