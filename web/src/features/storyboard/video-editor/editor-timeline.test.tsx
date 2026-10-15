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
