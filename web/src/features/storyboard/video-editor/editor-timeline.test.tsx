import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { renderWithTooltip } from '@/testing/render'
import type { GenerationJob } from '../storyboard.api'
import {
  draftItemsOf,
  EMPTY_DRAFT,
  isPicked,
  pickPart,
  putShot,
  readyEditsOf,
  shotOn,
  trimItem,
  type Draft,
  type DraftSource,
} from './draft'
import { editBlocksOf, laneEditsOf, shotsOf, type KeyframeRead } from './edit-blocks'
import { ClipsTimeline, VersionsTimeline, type Selection, type VersionRow } from './editor-timeline'

afterEach(() => vi.restoreAllMocks())

const shots = shotsOf({ keyframes: [0, 1, 2, 3, 4, 5], duration: 6 })
let minute = 0
const edit = ([start, end]: [number, number], spec: Partial<GenerationJob> = {}) => {
  minute += 1
  return makeGenerationJob({
    id: `edit-${minute}`,
    rootJobId: 'root',
    sourceJobId: 'root',
    rangeStartMs: start * 1000,
    rangeEndMs: end * 1000,
    outputUrl: `https://oss.example/edit-${minute}.mp4`,
    createdAt: `2026-10-28T10:${String(minute).padStart(2, '0')}:00Z`,
    ...spec,
  })
}

// first、second 都从镜头 4–5 生成：first 2 秒、两段，second 1.5 秒、一段；running 在跑；failed 不上轨。
const first = edit([3, 5])
const second = edit([3, 5])
const running = edit([5, 6], { status: 'submitted', outputUrl: null })
const failed = edit([0, 1], { status: 'failed', errorMessage: '模型超时' })
const reads: Record<string, KeyframeRead> = {
  [first.outputUrl ?? '']: { data: { keyframes: [0, 1], duration: 2 }, isError: false },
  [second.outputUrl ?? '']: { data: { keyframes: [0], duration: 1.5 }, isError: false },
}
const blocks = editBlocksOf(
  laneEditsOf('root', [first, second, running, failed], shots),
  (url) => reads[url],
)
const source: DraftSource = {
  rootId: 'root',
  rootUrl: 'https://oss.example/root.mp4',
  duration: 6,
  shots,
  edits: readyEditsOf(blocks),
}
const pickedFirst = pickPart(source, pickPart(source, EMPTY_DRAFT, first.id, 1), first.id, 2)

const handlers = () => ({
  onSeek: vi.fn(),
  onSelectRun: vi.fn(),
  onTrimRun: vi.fn(),
  onSelectDraft: vi.fn(),
  onSelectRunning: vi.fn(),
  onToggleShot: vi.fn(),
  onClickPart: vi.fn(),
  onTogglePart: vi.fn(),
  onTrim: vi.fn(),
})

const timeline = (draft: Draft, selection: Selection, on: ReturnType<typeof handlers>) => (
  <ClipsTimeline
    blocks={blocks}
    clock={0}
    clockOn={selection?.kind === 'run' ? 'source' : 'draft'}
    duration={6}
    isPicked={(editId, seg) => isPicked(draft, editId, seg)}
    items={draftItemsOf(source, draft)}
    onScrub={() => {}}
    peaksOf={() => ({ kind: 'silent' })}
    rootUrl={source.rootUrl}
    selection={selection}
    selectionBoxRef={null}
    shotOn={(no) => shotOn(source, draft, no)}
    shots={shots}
    {...on}
  />
)

const renderTimeline = (draft: Draft = EMPTY_DRAFT, selection: Selection = undefined) => {
  const on = handlers()
  const view = renderWithTooltip(timeline(draft, selection, on))
  return {
    on,
    rerender: (next: Draft, nextSelection: Selection = selection) =>
      view.rerender(timeline(next, nextSelection, on)),
  }
}

const draftTrack = () => screen.getByRole('group', { name: '草稿' })
const original = () => screen.getByRole('group', { name: '原片' })
const lane = () => screen.getByRole('group', { name: '编辑片段' })
const shot = (no: number) =>
  within(original()).getByRole('button', { name: new RegExp(`^镜头 ${no} ·`) })
const names = (group: HTMLElement) =>
  within(group)
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label'))

beforeEach(() => {
  // jsdom 不排版：轨道区按 600px 宽算，6 秒的原片每秒 100px。
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: 100, y: 0, width: 600, height: 200 }),
  )
})

describe('三条轨', () => {
  it('草稿按排序首尾相接，块名写来源与时长；原片轨是全部镜头，每块带开关', () => {
    renderTimeline(pickedFirst)
    expect(names(draftTrack())).toEqual([
      '镜头 1 · 1.0 秒 · 原片',
      '镜头 2 · 1.0 秒 · 原片',
      '镜头 3 · 1.0 秒 · 原片',
      '镜头 4–5 第 1 次生成的编辑片段 · 第 1 段 · 1.0 秒 · 已选用',
      '镜头 4–5 第 1 次生成的编辑片段 · 第 2 段 · 1.0 秒 · 已选用',
      '镜头 6 · 1.0 秒 · 原片',
    ])
    expect(within(original()).getAllByRole('button', { name: /^镜头 \d ·/ })).toHaveLength(6)
    // 选用的编辑段覆盖的镜头默认关
    const off = within(original()).getByRole('button', { name: '开启镜头 4' })
    expect(off).toHaveAttribute('aria-pressed', 'false')
    expect(within(original()).getByRole('button', { name: '关闭镜头 3' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('编辑轨：完成的按段，每段一只眼睛；在跑的整条一块；失败的不在轨上；空着的镜头位置是占位', () => {
    renderTimeline(pickedFirst)
    expect(names(lane())).toEqual([
      '生成镜头 1',
      '生成镜头 2',
      '生成镜头 3',
      '镜头 4–5 第 1 次生成的编辑片段 · 第 1 段 · 1.0 秒',
      '取消选用这一段',
      '镜头 4–5 第 1 次生成的编辑片段 · 第 2 段 · 1.0 秒',
      '取消选用这一段',
      '镜头 4–5 第 2 次生成的编辑片段 · 1.5 秒',
      '选用这一段',
      '镜头 6 · 生成中',
    ])
    expect(
      within(
        screen.getByRole('group', { name: '镜头 4–5 第 2 次生成的编辑片段 · 1.5 秒' }),
      ).getByRole('button', { name: '选用这一段' }),
    ).toHaveAttribute('aria-pressed', 'false')
  })

  it('两种眼睛只开关、不改选中；点完成的段交给编辑器，点在跑的选中它', async () => {
    const user = userEvent.setup()
    const { on } = renderTimeline(pickedFirst)
    await user.click(within(original()).getByRole('button', { name: '开启镜头 4' }))
    expect(on.onToggleShot).toHaveBeenLastCalledWith(4)
    await user.click(
      within(screen.getByRole('group', { name: /第 2 次/ })).getByRole('button', {
        name: '选用这一段',
      }),
    )
    expect(on.onTogglePart).toHaveBeenLastCalledWith(second.id, 1)
    expect(on.onSelectRun).not.toHaveBeenCalled()
    expect(on.onSelectDraft).not.toHaveBeenCalled()
    await user.click(within(lane()).getByRole('button', { name: /第 1 次.*第 2 段/ }))
    expect(on.onClickPart).toHaveBeenLastCalledWith(first.id, 2)
    await user.click(within(lane()).getByRole('button', { name: '镜头 6 · 生成中' }))
    expect(on.onSelectRunning).toHaveBeenLastCalledWith(running.id)
  })

  it('原片轨和编辑轨在开关、选用、修剪前后位置都不变', () => {
    const { rerender } = renderTimeline()
    const placements = () =>
      [original(), lane()].flatMap((group) =>
        [...group.children].map((child) => child.getAttribute('style')),
      )
    const before = placements()
    const changed = putShot(source, pickedFirst, 2, false)
    const item = draftItemsOf(source, changed).find((candidate) => candidate.id === `${first.id}#1`)
    if (item === undefined) throw new Error('草稿里没有这一段')
    rerender(trimItem(changed, item, { t0: 0.2, t1: 1 }))
    // jsdom 不排版，只能比较每块的摆放参数前后一致
    expect(placements()).toEqual(before)
  })
})

describe('原片轨的选区', () => {
  const run = (start: number, end: number): Selection => ({ kind: 'run', start, end })
  const handle = (name: '裁剪开头' | '裁剪结尾') => screen.getByRole('slider', { name })

  it('点镜头按整镜头选它；Shift 扩选、点两端去掉；点占位同点镜头', async () => {
    const user = userEvent.setup()
    const { on } = renderTimeline(EMPTY_DRAFT, run(2, 3))
    await user.click(shot(2))
    expect(on.onSelectRun).toHaveBeenLastCalledWith({ start: 1, end: 2 })
    await user.keyboard('{Shift>}')
    await user.click(shot(4))
    expect(on.onSelectRun).toHaveBeenLastCalledWith({ start: 2, end: 4 })
    await user.click(shot(3))
    expect(on.onSelectRun).toHaveBeenLastCalledWith(undefined)
    await user.keyboard('{/Shift}')
    await user.click(within(lane()).getByRole('button', { name: '生成镜头 3' }))
    expect(on.onSelectRun).toHaveBeenLastCalledWith({ start: 2, end: 3 })
  })

  it('选区停在镜头中间时碰到的镜头都按下；Shift 扩选、方向键都回到镜头分界', async () => {
    const user = userEvent.setup()
    const { on } = renderTimeline(EMPTY_DRAFT, run(2.4, 4.5))
    expect([1, 2, 3, 4, 5, 6].map((no) => shot(no).getAttribute('aria-pressed'))).toEqual([
      'false',
      'false',
      'true',
      'true',
      'true',
      'false',
    ])
    await user.keyboard('{Shift>}')
    await user.click(shot(6))
    await user.keyboard('{/Shift}')
    expect(on.onSelectRun).toHaveBeenLastCalledWith({ start: 2, end: 6 })
    fireEvent.keyDown(shot(5), { key: 'ArrowRight', shiftKey: true })
    expect(on.onSelectRun).toHaveBeenLastCalledWith({ start: 2, end: 6 })
    fireEvent.keyDown(shot(3), { key: 'ArrowLeft' })
    expect(on.onSelectRun).toHaveBeenLastCalledWith({ start: 1, end: 2 })
  })

  it('选中后两端出修剪把手；方向键每次 0.1 秒、Shift 每次 1 秒，只吸前方的边界', () => {
    const { on, rerender } = renderTimeline(EMPTY_DRAFT)
    expect(screen.queryByRole('slider', { name: '裁剪结尾' })).toBeNull()
    rerender(EMPTY_DRAFT, run(1, 3))
    fireEvent.keyDown(handle('裁剪结尾'), { key: 'ArrowRight' })
    expect(on.onTrimRun).toHaveBeenLastCalledWith({ edge: 'end', start: 1, end: 3.1 })
    fireEvent.keyDown(handle('裁剪开头'), { key: 'ArrowLeft' })
    expect(on.onTrimRun).toHaveBeenLastCalledWith({ edge: 'start', start: 0.9, end: 3 })
    fireEvent.keyDown(handle('裁剪结尾'), { key: 'ArrowLeft', shiftKey: true })
    expect(on.onTrimRun).toHaveBeenLastCalledWith({ edge: 'end', start: 1, end: 2 })
    // 往右一步越过了镜头分界 3：停在 3；从分界上出发不吸回去（见上面 3 → 3.1）
    rerender(EMPTY_DRAFT, run(1, 2.95))
    fireEvent.keyDown(handle('裁剪结尾'), { key: 'ArrowRight' })
    expect(on.onTrimRun).toHaveBeenLastCalledWith({ edge: 'end', start: 1, end: 3 })
  })

  it('拖把手可以停在镜头中间，越过分界时离分界 8px 以内吸上去，最短 1 秒', () => {
    const { on } = renderTimeline(EMPTY_DRAFT, run(1, 3))
    const end = Object.assign(handle('裁剪结尾'), {
      setPointerCapture: () => undefined,
      hasPointerCapture: () => true,
      releasePointerCapture: () => undefined,
    })
    // 每秒 100px：结尾 3 秒在 x=400
    fireEvent.pointerDown(end, { pointerId: 1, button: 0, clientX: 400 })
    expect(on.onTrimRun).toHaveBeenLastCalledWith({ edge: 'end', start: 1, end: 3 })
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 355 })
    expect(on.onTrimRun).toHaveBeenLastCalledWith({ edge: 'end', start: 1, end: 2.55 })
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 495 })
    expect(on.onTrimRun).toHaveBeenLastCalledWith({ edge: 'end', start: 1, end: 4 })
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 470 })
    expect(on.onTrimRun).toHaveBeenLastCalledWith({ edge: 'end', start: 1, end: 3.7 })
    // 拖到 0.5 秒：选区不能短于 1 秒，停在 2
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 150 })
    expect(on.onTrimRun).toHaveBeenLastCalledWith({ edge: 'end', start: 1, end: 2 })
    fireEvent.pointerUp(end, { pointerId: 1 })
    expect(on.onSelectRun).not.toHaveBeenCalled()
  })
})

describe('修剪', () => {
  const selected: Selection = { kind: 'draft', id: `${first.id}#2` }
  const handle = (name: '裁剪开头' | '裁剪结尾') => screen.getByRole('slider', { name })

  it('选中草稿块才出两端的把手；方向键每次 0.1 秒、Shift 每次 1 秒，停在最短 0.5 秒', () => {
    const { on, rerender } = renderTimeline(pickedFirst)
    expect(screen.queryByRole('slider', { name: '裁剪结尾' })).toBeNull()
    rerender(pickedFirst, selected)
    fireEvent.keyDown(handle('裁剪结尾'), { key: 'ArrowLeft' })
    expect(on.onTrim).toHaveBeenLastCalledWith({ id: selected.id, edge: 'end', t0: 1, t1: 1.9 })
    fireEvent.keyDown(handle('裁剪结尾'), { key: 'ArrowLeft', shiftKey: true })
    expect(on.onTrim).toHaveBeenLastCalledWith({ id: selected.id, edge: 'end', t0: 1, t1: 1.5 })
    fireEvent.keyDown(handle('裁剪开头'), { key: 'ArrowLeft' })
    // 开头已在这一段的关键帧边界上，不能再往前
    expect(on.onTrim).toHaveBeenLastCalledWith({ id: selected.id, edge: 'start', t0: 1, t1: 2 })
  })

  it('拖动把手按指针换算时间，离边界 8px 以内吸上去', () => {
    const { on } = renderTimeline(pickedFirst, selected)
    const end = Object.assign(handle('裁剪结尾'), {
      setPointerCapture: () => undefined,
      hasPointerCapture: () => true,
      releasePointerCapture: () => undefined,
    })
    fireEvent.pointerDown(end, { pointerId: 1, button: 0, clientX: 500 })
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 450 })
    expect(on.onTrim).toHaveBeenLastCalledWith({ id: selected.id, edge: 'end', t0: 1, t1: 1.5 })
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 495 })
    expect(on.onTrim).toHaveBeenLastCalledWith({ id: selected.id, edge: 'end', t0: 1, t1: 2 })
    fireEvent.pointerUp(end, { pointerId: 1 })
  })
})

describe('关联描边', () => {
  const linkedDraft = () =>
    within(draftTrack())
      .getAllByRole('button')
      .filter((button) => button.parentElement?.hasAttribute('data-linked') === true)
      .map((button) => button.getAttribute('aria-label'))

  it('悬停草稿块描出来源；悬停编辑轨的段描出草稿里那块；悬停原片镜头描出它在草稿里那块', () => {
    renderTimeline(pickedFirst)
    expect(screen.queryAllByTestId('timeline-link')).toHaveLength(0)
    const draftBlock = within(draftTrack()).getByRole('button', { name: /第 2 段/ })
    fireEvent.pointerEnter(draftBlock.parentElement ?? draftBlock)
    expect(screen.getAllByTestId('timeline-link')).toHaveLength(1)
    fireEvent.pointerLeave(draftBlock.parentElement ?? draftBlock)

    const part = within(lane()).getByRole('button', { name: /第 1 次.*第 1 段/ })
    fireEvent.pointerEnter(part.parentElement ?? part)
    expect(linkedDraft()).toEqual(['镜头 4–5 第 1 次生成的编辑片段 · 第 1 段 · 1.0 秒 · 已选用'])
    // 另描出原片轨上这条编辑片段的生成区间
    expect(screen.getAllByTestId('timeline-link')).toHaveLength(1)
    fireEvent.pointerLeave(part.parentElement ?? part)

    fireEvent.pointerEnter(shot(2).parentElement ?? shot(2))
    expect(linkedDraft()).toEqual(['镜头 2 · 1.0 秒 · 原片'])
  })

  it('选中草稿块常驻描出来源；原片轨有选区时常驻描出这些镜头在草稿里的块', () => {
    const { rerender } = renderTimeline(pickedFirst, { kind: 'draft', id: 'shot-2' })
    expect(screen.getAllByTestId('timeline-link')).toHaveLength(1)
    rerender(pickedFirst, { kind: 'run', start: 1.5, end: 3 })
    expect(screen.queryAllByTestId('timeline-link')).toHaveLength(0)
    expect(linkedDraft()).toEqual(['镜头 2 · 1.0 秒 · 原片', '镜头 3 · 1.0 秒 · 原片'])
  })
})

it('标尺按合成时间定位，不改选区', () => {
  const { on } = renderTimeline(EMPTY_DRAFT, { kind: 'run', start: 1, end: 2 })
  const ruler = Object.assign(screen.getByRole('slider', { name: '时间线播放位置' }), {
    setPointerCapture: () => undefined,
    hasPointerCapture: () => false,
    releasePointerCapture: () => undefined,
  })
  fireEvent.pointerDown(ruler, { pointerId: 1, button: 0, clientX: 400 })
  expect(on.onSeek).toHaveBeenLastCalledWith(3)
  fireEvent.change(ruler, { target: { value: '4.5' } })
  expect(on.onSeek).toHaveBeenLastCalledWith(4.5)
  expect(on.onSelectRun).not.toHaveBeenCalled()
})

describe('版本视图', () => {
  const version = (jobId: string, label: string, duration: number): VersionRow => ({
    jobId,
    label,
    original: jobId === 'root',
    mediaUrl: `https://oss.example/${jobId}.mp4`,
    shots: shotsOf({ keyframes: [0, 2], duration }),
    duration,
  })
  const versions = [version('root', 'V1 原片', 6), version('v2', 'V2', 9), version('v3', 'V3', 7)]

  const renderVersions = (composing?: { duration: number | undefined }) => {
    const onSelect = vi.fn()
    const onSeek = vi.fn()
    renderWithTooltip(
      <VersionsTimeline
        composing={composing}
        currentTime={2}
        onScrub={() => {}}
        onSeek={onSeek}
        onSelect={onSelect}
        peaksOf={() => ({ kind: 'silent' })}
        versions={versions}
        viewedId="v2"
      />,
    )
    return { onSelect, onSeek }
  }
  const rows = () =>
    within(screen.getByRole('group', { name: '视频版本' }))
      .getAllByRole('button')
      .map((row) => row.getAttribute('aria-label'))

  it('每个版本一行，最新的在最上；正在合成的一行在最上面、不能点；看的那一版按下', () => {
    renderVersions({ duration: undefined })
    expect(rows()).toEqual(['合成中', 'V3', 'V2', 'V1 原片'])
    expect(screen.getByRole('button', { name: '合成中' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'V2' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'V3' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('点一行选它；标尺按最长那一版的比例，只能定位到正在看的这一版的结尾', async () => {
    const user = userEvent.setup()
    const { onSelect, onSeek } = renderVersions()
    await user.click(screen.getByRole('button', { name: 'V1 原片' }))
    expect(onSelect).toHaveBeenLastCalledWith('root')
    const ruler = screen.getByRole('slider', { name: '时间线播放位置' })
    expect(ruler).toHaveAttribute('max', '9')
    fireEvent.change(ruler, { target: { value: '8' } })
    expect(onSeek).toHaveBeenLastCalledWith(8)
  })

  it('Tab 进到正在看的那一行，上下方向键换行，Enter 或空格选中', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderVersions({ duration: 5 })
    await user.tab()
    await user.tab()
    expect(screen.getByRole('button', { name: 'V2' })).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('button', { name: 'V3' })).toHaveFocus()
    // 在跑的那一行不能选，方向键跳过它。
    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('button', { name: 'V3' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onSelect).toHaveBeenLastCalledWith('v3')
    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(screen.getByRole('button', { name: 'V1 原片' })).toHaveFocus()
    await user.keyboard(' ')
    expect(onSelect).toHaveBeenLastCalledWith('root')
  })
})
