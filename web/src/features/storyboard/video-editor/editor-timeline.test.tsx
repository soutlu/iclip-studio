import { fireEvent, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { renderWithTooltip } from '@/testing/render'
import { clipItem } from './draft'
import { EditorTimeline, type TimelineEntry } from './editor-timeline'

afterEach(() => vi.restoreAllMocks())

it('标尺拖动只定位播放头，保留原选区和片段顺序；键盘滑块更改仍可定位', () => {
  const clips = [
    clipItem({ sourceJobId: 'source', start: 0, end: 2 }),
    clipItem({ sourceJobId: 'source', start: 2, end: 4 }),
  ]
  const entries: TimelineEntry[] = clips.map((clip, index) => ({
    id: clip.id,
    at: index * 2,
    duration: 2,
    parts: [{ mediaUrl: 'https://example.com/video.mp4', start: clip.start, end: clip.end }],
    clip,
    changed: false,
    runningSince: undefined,
    ...(index === 1 ? { versionLabel: 'V2' } : {}),
  }))
  const seek = vi.fn()
  const scrub = vi.fn()
  const select = vi.fn()
  const click = vi.fn()
  const move = vi.fn()
  const trim = vi.fn()
  renderWithTooltip(
    <EditorTimeline
      draft={clips}
      entries={entries}
      scale={4}
      total={4}
      currentTime={0}
      selection={[clips[1]?.id ?? '']}
      editable
      peaksOf={() => ({ kind: 'silent' })}
      onSeek={seek}
      onClickSegment={click}
      onSelect={select}
      onScrub={scrub}
      selectionBoxRef={null}
      onTrim={trim}
      onTrimPreview={() => {}}
      onMove={move}
      onDelete={() => {}}
    />,
  )
  const ruler = Object.assign(screen.getByRole('slider', { name: '时间线播放位置' }), {
    setPointerCapture: () => undefined,
    hasPointerCapture: () => false,
    releasePointerCapture: () => undefined,
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: 100, y: 0, width: 400, height: 200 }),
  )
  fireEvent.pointerMove(ruler, { pointerId: 1, clientX: 350, pointerType: 'mouse' })
  expect(screen.getByText('00:02.50')).toBeVisible()
  expect(seek).not.toHaveBeenCalled()
  expect(scrub).not.toHaveBeenCalled()
  fireEvent.scroll(screen.getByRole('region', { name: '时间线轨道，窄屏可横向滚动' }))
  expect(screen.queryByText('00:02.50')).toBeNull()
  fireEvent.pointerMove(ruler, { pointerId: 1, clientX: 350, pointerType: 'mouse' })
  fireEvent.pointerLeave(ruler)
  expect(screen.queryByText('00:02.50')).toBeNull()
  fireEvent.pointerDown(ruler, { button: 0, pointerId: 1, clientX: 200 })
  expect(seek).toHaveBeenLastCalledWith(1)
  fireEvent.pointerMove(ruler, { pointerId: 1, clientX: 350 })
  expect(seek).toHaveBeenLastCalledWith(2.5)
  fireEvent.pointerUp(ruler, { pointerId: 1, clientX: 350 })
  fireEvent.pointerMove(ruler, { pointerId: 1, clientX: 450 })
  expect(seek).toHaveBeenLastCalledWith(2.5)
  expect(scrub).toHaveBeenCalledTimes(1)
  expect(select).not.toHaveBeenCalled()
  expect(click).not.toHaveBeenCalled()
  expect(move).not.toHaveBeenCalled()
  expect(trim).not.toHaveBeenCalled()
  fireEvent.change(ruler, { target: { value: '3' } })
  expect(seek).toHaveBeenLastCalledWith(3)
  expect(screen.getByRole('button', { name: /^第 2 段/ })).toHaveAttribute('aria-pressed', 'true')

  expect(within(screen.getByRole('button', { name: /^第 1 段/ })).queryByText('V1')).toBeNull()
  expect(within(screen.getByRole('button', { name: /^第 2 段/ })).getByText('V2')).toBeVisible()
})

it('多选时只在选区最外两端出抓手，拖动时外框和气泡按整个选区算，键盘微调照旧', () => {
  const clips = [
    clipItem({ sourceJobId: 'source', start: 0, end: 1 }),
    clipItem({ sourceJobId: 'source', start: 1, end: 2 }),
    clipItem({ sourceJobId: 'source', start: 2, end: 4 }),
  ]
  const entries: TimelineEntry[] = clips.map((clip) => ({
    id: clip.id,
    at: clip.start,
    duration: clip.end - clip.start,
    parts: [{ mediaUrl: 'https://example.com/video.mp4', start: clip.start, end: clip.end }],
    clip,
    changed: false,
    runningSince: undefined,
  }))
  const trim = vi.fn()
  const preview = vi.fn()
  const { container } = renderWithTooltip(
    <EditorTimeline
      draft={clips}
      entries={entries}
      scale={4}
      total={4}
      currentTime={0}
      selection={[clips[0]?.id ?? '', clips[1]?.id ?? '']}
      editable
      peaksOf={() => ({ kind: 'silent' })}
      onSeek={() => {}}
      onClickSegment={() => {}}
      onSelect={() => {}}
      onScrub={() => {}}
      selectionBoxRef={null}
      onTrim={trim}
      onTrimPreview={preview}
      onMove={() => {}}
      onDelete={() => {}}
    />,
  )
  expect(screen.getAllByRole('slider', { name: /^裁剪(开头|结尾)$/ })).toHaveLength(2)
  const start = screen.getByRole('slider', { name: '裁剪开头' })
  const end = Object.assign(screen.getByRole('slider', { name: '裁剪结尾' }), {
    setPointerCapture: () => undefined,
    hasPointerCapture: () => false,
    releasePointerCapture: () => undefined,
  })
  // 第 1 段开头、第 2 段结尾；第 1、2 段之间没有抓手。
  expect(start.style.left).toBe('0%')
  expect(end.style.left).toBe('50%')
  const box = container.querySelector<HTMLElement>('.video-editor-timeline-box')
  expect(box?.style.width).toBe('calc(50% - 2px)')

  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: 100, y: 0, width: 400, height: 200 }),
  )
  fireEvent.pointerDown(end, { button: 0, pointerId: 1, clientX: 300 })
  fireEvent.pointerMove(end, { pointerId: 1, clientX: 250 })
  expect(screen.getByRole('status')).toHaveTextContent('裁剪后 1.5 秒 · 缩短 0.5 秒')
  expect(box?.style.width).toBe('calc(37.5% - 2px)')
  expect(preview).toHaveBeenLastCalledWith(1.5, 'end')
  // 拖过第 2 段的开头也只停在它的最短长度上，不会裁到第 1 段。
  fireEvent.pointerMove(end, { pointerId: 1, clientX: 120 })
  expect(screen.getByRole('status')).toHaveTextContent('裁剪后 1.2 秒 · 缩短 0.8 秒')
  fireEvent.pointerUp(end, { pointerId: 1, clientX: 120 })
  expect(trim).toHaveBeenLastCalledWith('end', 1.2)
  expect(screen.queryByRole('status')).toBeNull()

  fireEvent.keyDown(start, { key: 'ArrowRight' })
  expect(trim).toHaveBeenLastCalledWith('start', 0.1)
  expect(preview).toHaveBeenLastCalledWith(0.1, 'start')
})
