import { act, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { renderWithTooltip } from '@/testing/render'
import type { GenerationJob } from '../storyboard.api'
import {
  draftItemsOf,
  EMPTY_DRAFT,
  isPicked,
  pickPart,
  previewPick,
  putShot,
  readyEditsOf,
  shotOn,
  trimItem,
  type Draft,
  type DraftSource,
} from './draft'
import { editBlocksOf, laneEditsOf, shotsOf, type KeyframeRead } from './edit-blocks'
import {
  ClipsTimeline,
  VersionsTimeline,
  type Selection,
  type TrimChange,
  type TrimPreview,
  type VersionRow,
} from './editor-timeline'

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
  onTrim: vi.fn<(change: TrimChange) => void>(),
  onTrimPreview: vi.fn<(preview: TrimPreview | undefined) => void>(),
})

/** 修剪草稿里 `change.id` 那一块之后的草稿，同编辑器。 */
const trimmed = (draft: Draft, change: TrimChange) => {
  const item = draftItemsOf(source, draft).find((candidate) => candidate.id === change.id)
  if (item === undefined) throw new Error('草稿里没有这一块')
  return trimItem(draft, item, change)
}

type Handlers = Pick<ComponentProps<typeof ClipsTimeline>, keyof ReturnType<typeof handlers>>

const timeline = (draft: Draft, selection: Selection, on: Handlers) => (
  <ClipsTimeline
    blocks={blocks}
    clock={0}
    clockOn={selection?.kind === 'run' ? 'source' : 'draft'}
    duration={6}
    isPicked={(editId, seg) => isPicked(draft, editId, seg)}
    items={draftItemsOf(source, draft)}
    onScrub={() => {}}
    peaksOf={() => ({ kind: 'silent' })}
    previewPick={(editId, seg) => previewPick(source, draft, editId, seg)}
    previewTrim={(change) => draftItemsOf(source, trimmed(draft, change))}
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

/** 同编辑器：修剪提交时写回草稿，与松手同一次渲染。 */
function Editing({
  initial,
  selection,
  on,
}: {
  initial: Draft
  selection: Selection
  on: ReturnType<typeof handlers>
}) {
  const [draft, setDraft] = useState(initial)
  return timeline(draft, selection, {
    ...on,
    onTrim: (change: TrimChange) => {
      on.onTrim(change)
      setDraft(trimmed(draft, change))
    },
  })
}

const renderEditing = (initial: Draft, selection: Selection) => {
  const on = handlers()
  renderWithTooltip(<Editing initial={initial} on={on} selection={selection} />)
  return { on }
}

/** jsdom 没有指针捕获：给按下的元素补上。 */
const grab = (element: HTMLElement) =>
  Object.assign(element, {
    setPointerCapture: () => undefined,
    hasPointerCapture: () => true,
    releasePointerCapture: () => undefined,
  })

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

  it('拖把手可以停在镜头中间，越过分界时离分界 8px 以内吸上去，最短 1 秒；拖动中只预览，松手才提交一次', () => {
    const { on } = renderTimeline(EMPTY_DRAFT, run(1, 3))
    const end = grab(handle('裁剪结尾'))
    const previewed = () => {
      const preview = on.onTrimPreview.mock.lastCall?.[0]
      return preview?.kind === 'run' ? preview.run : undefined
    }
    // 每秒 100px：结尾 3 秒在 x=400；按下就把舞台换到这一端（原片时间，结尾取结尾前那一帧）
    fireEvent.pointerDown(end, { pointerId: 1, button: 0, clientX: 400 })
    expect(on.onTrimPreview).toHaveBeenLastCalledWith({
      kind: 'run',
      run: { edge: 'end', start: 1, end: 3 },
      seek: { clock: 3, boundary: 'end' },
      shown: 3,
    })
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 355 })
    expect(previewed()).toEqual({ edge: 'end', start: 1, end: 2.55 })
    expect(handle('裁剪结尾')).toHaveAttribute('aria-valuenow', '2.55')
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 495 })
    expect(previewed()).toEqual({ edge: 'end', start: 1, end: 4 })
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 470 })
    expect(previewed()).toEqual({ edge: 'end', start: 1, end: 3.7 })
    // 拖到 0.5 秒：选区不能短于 1 秒，停在 2
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 150 })
    expect(previewed()).toEqual({ edge: 'end', start: 1, end: 2 })
    expect(on.onTrimRun).not.toHaveBeenCalled()

    fireEvent.pointerUp(end, { pointerId: 1 })
    expect(on.onTrimRun).toHaveBeenCalledTimes(1)
    expect(on.onTrimRun).toHaveBeenCalledWith({ edge: 'end', start: 1, end: 2 })
    expect(on.onTrimPreview).toHaveBeenLastCalledWith(undefined)
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

  it('拖动把手按指针换算时间，离边界 8px 以内吸上去；拖动中只预览，松手才提交一次', () => {
    const { on } = renderTimeline(pickedFirst, selected)
    const end = grab(handle('裁剪结尾'))
    fireEvent.pointerDown(end, { pointerId: 1, button: 0, clientX: 500 })
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 450 })
    expect(handle('裁剪结尾')).toHaveAttribute('aria-valuenow', '1.5')
    // 第 2 段在合成 4 秒处，裁到 0.5 秒：后面的块跟着往前，舞台停在它的结尾
    expect(on.onTrimPreview).toHaveBeenLastCalledWith({
      kind: 'draft',
      items: draftItemsOf(
        source,
        trimmed(pickedFirst, { ...selected, edge: 'end', t0: 1, t1: 1.5 }),
      ),
      seek: { clock: 4.5, boundary: 'end' },
      shown: 4.5,
    })
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 495 })
    expect(handle('裁剪结尾')).toHaveAttribute('aria-valuenow', '2')
    expect(on.onTrim).not.toHaveBeenCalled()
    fireEvent.pointerUp(end, { pointerId: 1 })
    expect(on.onTrim).toHaveBeenCalledTimes(1)
    expect(on.onTrim).toHaveBeenCalledWith({ id: selected.id, edge: 'end', t0: 1, t1: 2 })
  })

  it('指针被系统取消：什么都不提交，把手回到按下前的位置', () => {
    const { on } = renderTimeline(pickedFirst, selected)
    const end = grab(handle('裁剪结尾'))
    fireEvent.pointerDown(end, { pointerId: 1, button: 0, clientX: 500 })
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 450 })
    fireEvent.pointerCancel(end, { pointerId: 1 })
    expect(handle('裁剪结尾')).toHaveAttribute('aria-valuenow', '2')
    expect(on.onTrimPreview).toHaveBeenLastCalledWith(undefined)
    fireEvent.pointerUp(end, { pointerId: 1 })
    expect(on.onTrim).not.toHaveBeenCalled()
  })
})

const linkedDraft = () =>
  within(draftTrack())
    .getAllByRole('button')
    .filter((button) => button.parentElement?.hasAttribute('data-linked') === true)
    .map((button) => button.getAttribute('aria-label'))
const section = () => screen.getByRole('region', { name: '视频编辑时间线' })
const draftBlock = (name: RegExp) => within(draftTrack()).getByRole('button', { name })
const groupOf = (button: HTMLElement) => {
  const group = button.parentElement
  if (group === null) throw new Error('块没有外层')
  return group
}

describe('关联描边', () => {
  it('悬停草稿块描出来源；悬停编辑轨的段描出草稿里那块；悬停原片镜头描出它在草稿里那块', () => {
    renderTimeline(pickedFirst)
    expect(screen.queryAllByTestId('timeline-link')).toHaveLength(0)
    fireEvent.pointerMove(draftBlock(/第 2 段/))
    expect(screen.getAllByTestId('timeline-link')).toHaveLength(1)
    fireEvent.pointerLeave(section())
    expect(screen.queryAllByTestId('timeline-link')).toHaveLength(0)

    fireEvent.pointerMove(within(lane()).getByRole('button', { name: /第 1 次.*第 1 段/ }))
    expect(linkedDraft()).toEqual(['镜头 4–5 第 1 次生成的编辑片段 · 第 1 段 · 1.0 秒 · 已选用'])
    // 另描出原片轨上这条编辑片段的生成区间，以及这一段自己（连线的另一端）
    expect(screen.getAllByTestId('timeline-link')).toHaveLength(2)

    fireEvent.pointerMove(shot(2))
    expect(linkedDraft()).toEqual(['镜头 2 · 1.0 秒 · 原片'])
  })

  it('块重画、横向滚动之后按指针下的元素重算悬停，不等指针再动', () => {
    const { rerender } = renderTimeline(pickedFirst)
    fireEvent.pointerMove(shot(2))
    expect(linkedDraft()).toEqual(['镜头 2 · 1.0 秒 · 原片'])
    // 开关之后指针下换成了镜头 3
    const atPointer = vi.spyOn(document, 'elementFromPoint').mockReturnValue(shot(3))
    rerender(putShot(source, pickedFirst, 1, false))
    expect(linkedDraft()).toEqual(['镜头 3 · 1.0 秒 · 原片'])
    atPointer.mockReturnValue(shot(6))
    fireEvent.scroll(screen.getByRole('region', { name: '时间线轨道，可横向滚动' }))
    expect(linkedDraft()).toEqual(['镜头 6 · 1.0 秒 · 原片'])
  })

  it('选中草稿块常驻描出来源；原片轨有选区时常驻描出这些镜头在草稿里的块', () => {
    const { rerender } = renderTimeline(pickedFirst, { kind: 'draft', id: 'shot-2' })
    expect(screen.getAllByTestId('timeline-link')).toHaveLength(1)
    rerender(pickedFirst, { kind: 'run', start: 1.5, end: 3 })
    expect(screen.queryAllByTestId('timeline-link')).toHaveLength(0)
    expect(linkedDraft()).toEqual(['镜头 2 · 1.0 秒 · 原片', '镜头 3 · 1.0 秒 · 原片'])
  })
})

/**
 * jsdom 不排版：轨道区按它铺的秒数每秒 100px、从 x=100 起；块按摆放参数（--at、--len 秒）横排，编辑轨的块
 * （带 --row）在 y=132 起按行往下（行高 36、块高 30），其余在草稿那一条（y=28，高 44）；别的元素铺满 600×200。
 */
const layOut = () =>
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const content = Number.parseFloat(this.style.getPropertyValue('--content'))
    if (!Number.isNaN(content))
      return DOMRect.fromRect({ x: 100, y: 0, width: content * 100, height: 200 })
    const at = Number.parseFloat(this.style.getPropertyValue('--at'))
    if (Number.isNaN(at)) return DOMRect.fromRect({ x: 100, y: 0, width: 600, height: 200 })
    const len = Number.parseFloat(this.style.getPropertyValue('--len'))
    const row = this.style.getPropertyValue('--row')
    return DOMRect.fromRect({
      x: 100 + at * 100 + 1,
      y: row === '' ? 28 : 132 + Number(row) * 36,
      width: len * 100 - 2,
      height: row === '' ? 44 : 30,
    })
  })

/** 记下每一次 Web Animations 调用：动画的元素与关键帧；动画立即算作播完。 */
const recordAnimations = () => {
  const calls: { node: Element; keyframes: Keyframe[] }[] = []
  vi.spyOn(Element.prototype, 'animate').mockImplementation(function (
    this: Element,
    keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
  ) {
    calls.push({ node: this, keyframes: keyframes as Keyframe[] })
    return {
      cancel: () => {},
      pause: () => {},
      play: () => {},
      finished: Promise.resolve(),
    } as unknown as Animation
  })
  return calls
}

const reduceMotion = () =>
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: query.includes('reduce'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))

describe('开关后的重排', () => {
  const framesOf = (calls: ReturnType<typeof recordAnimations>, node: Element) =>
    calls.filter((call) => call.node === node).map((call) => call.keyframes)

  it('后面的块从原来的位置平移到新位置，拿掉的块在原地收起；原片轨、编辑轨不动', () => {
    layOut()
    const calls = recordAnimations()
    const { rerender } = renderTimeline()
    rerender(putShot(source, EMPTY_DRAFT, 2, false))
    // 镜头 3 从 2 秒处（左 1 秒 = 100px）滑到 1 秒处
    expect(framesOf(calls, groupOf(draftBlock(/^镜头 3 ·/)))).toEqual([
      [
        { transform: 'translateX(100px)', width: '98px' },
        { transform: 'none', width: '98px' },
      ],
    ])
    expect(framesOf(calls, groupOf(draftBlock(/^镜头 1 ·/)))).toEqual([])
    // 镜头 2 已不在草稿里（不能点），只剩一块在原地从 98px 收到 0
    expect(within(draftTrack()).queryByRole('button', { name: /^镜头 2 ·/ })).toBeNull()
    expect(calls.map((call) => call.keyframes)).toContainEqual([
      { width: '98px' },
      { width: '0px' },
    ])
    expect(calls.every((call) => draftTrack().contains(call.node))).toBe(true)
  })

  it('新加入的块从宽 0 展开到实际宽度，覆盖的镜头收起', () => {
    layOut()
    const calls = recordAnimations()
    const { rerender } = renderTimeline()
    rerender(pickPart(source, EMPTY_DRAFT, second.id, 1))
    expect(framesOf(calls, groupOf(draftBlock(/第 2 次/)))).toEqual([
      [{ width: '0px' }, { width: '148px' }],
    ])
    expect(
      calls.filter((call) => JSON.stringify(call.keyframes.at(-1)) === '{"width":"0px"}'),
    ).toHaveLength(2)
  })

  it('系统要求减少动态效果时不做动画，直接是结果', () => {
    layOut()
    reduceMotion()
    const calls = recordAnimations()
    const { rerender } = renderTimeline()
    rerender(putShot(source, EMPTY_DRAFT, 2, false))
    expect(calls).toEqual([])
    // 没有留着收起的块
    expect(draftTrack().children).toHaveLength(5)
  })

  it('拖修剪把手的过程中草稿怎么变都没有动画', () => {
    layOut()
    const calls = recordAnimations()
    const selected: Selection = { kind: 'draft', id: `${first.id}#2` }
    const { rerender } = renderTimeline(pickedFirst, selected)
    const end = screen.getByRole('slider', { name: '裁剪结尾' })
    fireEvent.pointerDown(end, { pointerId: 1, button: 0, clientX: 500 })
    const item = draftItemsOf(source, pickedFirst).find((candidate) => candidate.id === selected.id)
    if (item === undefined) throw new Error('草稿里没有这一段')
    rerender(trimItem(pickedFirst, item, { t0: 1, t1: 1.5 }))
    rerender(putShot(source, trimItem(pickedFirst, item, { t0: 1, t1: 1.5 }), 2, false))
    fireEvent.pointerUp(end, { pointerId: 1 })
    expect(calls).toEqual([])
  })
})

describe('拖草稿块的左把手', () => {
  // 第 2 段开头剪到 1.5 秒：它在 4–4.5 秒，镜头 6 接在 4.5 秒
  const selected: Selection = { kind: 'draft', id: `${first.id}#2` }
  const partOf = (draft: Draft) => {
    const item = draftItemsOf(source, draft).find((candidate) => candidate.id === selected.id)
    if (item === undefined) throw new Error('草稿里没有这一段')
    return item
  }
  const cut = trimItem(pickedFirst, partOf(pickedFirst), { t0: 1.5, t1: 2 })
  const leftOf = (name: RegExp) => groupOf(draftBlock(name)).getBoundingClientRect().left
  const pressStart = () => grab(screen.getByRole('slider', { name: '裁剪开头' }))

  it('拖动中左边沿跟着指针，这块的右边沿与后面的块不动，往左拉长时盖到前一块上；松手后首尾接上并滑过去', () => {
    layOut()
    const calls = recordAnimations()
    const { on } = renderEditing(cut, selected)
    const right = () => groupOf(draftBlock(/第 2 段/)).getBoundingClientRect().right
    const rightBefore = right()
    const shot6 = leftOf(/^镜头 6 ·/)
    const start = pressStart()
    fireEvent.pointerDown(start, { pointerId: 1, button: 0, clientX: 500 })
    // 每秒 100px：往左 50px 是开头早 0.5 秒
    fireEvent.pointerMove(start, { pointerId: 1, clientX: 450 })
    expect(on.onTrim).not.toHaveBeenCalled()
    // 左边沿到 3.5 秒，盖住第 1 段末尾半秒；右边沿与镜头 6 停在按下时的位置
    expect(leftOf(/第 2 段/)).toBe(100 + 350 + 1)
    expect(leftOf(/第 2 段/)).toBeLessThan(
      groupOf(draftBlock(/第 1 段/)).getBoundingClientRect().right,
    )
    expect(right()).toBe(rightBefore)
    expect(leftOf(/^镜头 6 ·/)).toBe(shot6)
    // 舞台停在这块的开头（合成 4 秒），工具条时间写把手所在的标尺位置 3.5 秒
    expect(on.onTrimPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ seek: { clock: 4 }, shown: 3.5 }),
    )
    expect(calls).toEqual([])

    fireEvent.pointerUp(start, { pointerId: 1 })
    expect(on.onTrim).toHaveBeenCalledTimes(1)
    expect(on.onTrim).toHaveBeenCalledWith({ id: selected.id, edge: 'start', t0: 1, t1: 2 })
    // 首尾接上：第 2 段回到 4 秒、镜头 6 到 5 秒，都从拖动中的位置滑过来
    expect(leftOf(/第 2 段/)).toBe(100 + 400 + 1)
    expect(leftOf(/^镜头 6 ·/)).toBe(100 + 500 + 1)
    const slides = (name: RegExp) =>
      calls.filter((call) => call.node === groupOf(draftBlock(name))).map((call) => call.keyframes)
    expect(slides(/第 2 段/)).toEqual([[{ translate: '-50px 0' }, { translate: '0 0' }]])
    expect(slides(/^镜头 6 ·/)).toEqual([[{ translate: '-50px 0' }, { translate: '0 0' }]])
    expect(slides(/第 1 段/)).toEqual([])
  })

  it('往里裁时同样只动左边沿；右把手照旧是右边沿动、后面的块跟着移', () => {
    layOut()
    const { on } = renderEditing(pickedFirst, selected)
    const shot6 = leftOf(/^镜头 6 ·/)
    const start = pressStart()
    fireEvent.pointerDown(start, { pointerId: 1, button: 0, clientX: 500 })
    fireEvent.pointerMove(start, { pointerId: 1, clientX: 530 })
    expect(leftOf(/第 2 段/)).toBe(100 + 430 + 1)
    expect(leftOf(/^镜头 6 ·/)).toBe(shot6)
    fireEvent.pointerUp(start, { pointerId: 1 })
    expect(on.onTrim).toHaveBeenLastCalledWith({ id: selected.id, edge: 'start', t0: 1.3, t1: 2 })
    expect(leftOf(/^镜头 6 ·/)).toBe(100 + 470 + 1)

    const end = grab(screen.getByRole('slider', { name: '裁剪结尾' }))
    fireEvent.pointerDown(end, { pointerId: 2, button: 0, clientX: 500 })
    fireEvent.pointerMove(end, { pointerId: 2, clientX: 480 })
    expect(leftOf(/第 2 段/)).toBe(100 + 400 + 1)
    expect(leftOf(/^镜头 6 ·/)).toBe(100 + 450 + 1)
    // 右把手：工具条时间与舞台都在这块的结尾
    expect(on.onTrimPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ seek: { clock: 4.5, boundary: 'end' }, shown: 4.5 }),
    )
    fireEvent.pointerUp(end, { pointerId: 2 })
    expect(on.onTrim).toHaveBeenLastCalledWith({ id: selected.id, edge: 'end', t0: 1.3, t1: 1.8 })
  })
})

describe('连线', () => {
  const connector = () => screen.queryByTestId('timeline-connector')
  const ends = () => {
    const circles = connector()?.querySelectorAll('circle') ?? []
    return [...circles].map((circle) => [
      Number(circle.getAttribute('cx')),
      Number(circle.getAttribute('cy')),
    ])
  }
  const partGroup = (name: RegExp) => groupOf(within(lane()).getByRole('button', { name }))

  it('悬停草稿里的编辑段或编辑轨上它那一段时出现，从草稿块底边中点连到那一段顶边中点', () => {
    layOut()
    renderTimeline(pickedFirst)
    fireEvent.pointerMove(draftBlock(/第 2 段/))
    // 轨道区从 (100, 0) 起
    const from = groupOf(draftBlock(/第 2 段/)).getBoundingClientRect()
    const to = partGroup(/第 1 次.*第 2 段/).getBoundingClientRect()
    expect(ends()).toEqual([
      [from.left + from.width / 2 - 100, from.bottom],
      [to.left + to.width / 2 - 100, to.top],
    ])
    fireEvent.pointerLeave(section())
    expect(connector()).toBeNull()
    fireEvent.pointerMove(within(lane()).getByRole('button', { name: /第 1 次.*第 1 段/ }))
    expect(connector()).not.toBeNull()
  })

  it('原片镜头、没在草稿里的段悬停不出；选中不常驻', () => {
    const { rerender } = renderTimeline(pickedFirst)
    fireEvent.pointerMove(draftBlock(/^镜头 2 ·/))
    expect(connector()).toBeNull()
    fireEvent.pointerMove(within(lane()).getByRole('button', { name: /第 2 次/ }))
    expect(connector()).toBeNull()
    fireEvent.pointerLeave(section())
    rerender(pickedFirst, { kind: 'draft', id: `${first.id}#2` })
    expect(connector()).toBeNull()
  })

  it('开关之后自动出现，停约 1 秒后淡出消失；悬停在它的一端时一直留着', async () => {
    vi.useFakeTimers()
    try {
      recordAnimations()
      const { rerender } = renderTimeline()
      rerender(pickPart(source, EMPTY_DRAFT, second.id, 1))
      expect(connector()).not.toBeNull()
      await act(() => vi.advanceTimersByTimeAsync(900))
      expect(connector()).not.toBeNull()
      await act(() => vi.advanceTimersByTimeAsync(400))
      expect(connector()).toBeNull()

      // 再切换一次，指针停在草稿里那一块上
      rerender(EMPTY_DRAFT)
      rerender(pickPart(source, EMPTY_DRAFT, second.id, 1))
      fireEvent.pointerMove(draftBlock(/第 2 次/))
      await act(() => vi.advanceTimersByTimeAsync(3000))
      expect(connector()).not.toBeNull()
      fireEvent.pointerLeave(section())
      expect(connector()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('拿掉一段时连到它收起的位置，随收起一起淡出', async () => {
    const { rerender } = renderTimeline(pickPart(source, EMPTY_DRAFT, second.id, 1))
    rerender(EMPTY_DRAFT)
    expect(connector()).toHaveClass('is-out')
    await act(() => Promise.resolve())
    expect(connector()).toBeNull()
  })
})

describe('拖放', () => {
  const press = (target: HTMLElement, clientX: number, clientY: number) =>
    fireEvent.pointerDown(target, { pointerId: 1, button: 0, clientX, clientY })
  const move = (target: HTMLElement, clientX: number, clientY: number) =>
    fireEvent.pointerMove(target, { pointerId: 1, clientX, clientY })
  const release = (target: HTMLElement, clientX: number, clientY: number) =>
    fireEvent.pointerUp(target, { pointerId: 1, clientX, clientY })
  // 草稿那一条铺满 y 0–200（见 beforeEach）：y=300 在草稿外
  const secondPart = () => within(lane()).getByRole('button', { name: /第 2 次/ })

  it('编辑段拖到草稿上：按排序会放进去的位置出落点占位，松手等于选用，不算点击', () => {
    const { on } = renderTimeline()
    press(secondPart(), 450, 160)
    move(secondPart(), 300, 60)
    // 镜头 4–5 生成的第 1 段排在镜头 4 后面：4.0 秒处，1.5 秒长
    expect(screen.getByRole('status')).toHaveTextContent('插入 4.0 秒 · 1.5 秒')
    // 松手前不改草稿
    expect(names(draftTrack())).toHaveLength(6)
    release(secondPart(), 300, 60)
    fireEvent.click(secondPart())
    expect(on.onTogglePart).toHaveBeenCalledExactlyOnceWith(second.id, 1)
    expect(on.onClickPart).not.toHaveBeenCalled()
    expect(on.onSelectDraft).not.toHaveBeenCalled()
  })

  it('拖到草稿以外松手取消；没超过拖动阈值算点击', () => {
    const { on } = renderTimeline()
    press(secondPart(), 450, 160)
    move(secondPart(), 300, 60)
    move(secondPart(), 300, 300)
    expect(screen.queryByRole('status')).toBeNull()
    release(secondPart(), 300, 300)
    fireEvent.click(secondPart())
    expect(on.onTogglePart).not.toHaveBeenCalled()
    expect(on.onClickPart).not.toHaveBeenCalled()

    press(secondPart(), 450, 160)
    move(secondPart(), 453, 160)
    release(secondPart(), 453, 160)
    fireEvent.click(secondPart())
    expect(on.onClickPart).toHaveBeenCalledExactlyOnceWith(second.id, 1)
    expect(on.onTogglePart).not.toHaveBeenCalled()
  })

  it('已在草稿里的段拖上来只描出它那块，不出落点占位；松手什么都不改', () => {
    const { on } = renderTimeline(pickedFirst)
    const part = within(lane()).getByRole('button', { name: /第 1 次.*第 2 段/ })
    press(part, 450, 160)
    move(part, 300, 60)
    expect(screen.queryByRole('status')).toBeNull()
    expect(linkedDraft()).toEqual(['镜头 4–5 第 1 次生成的编辑片段 · 第 2 段 · 1.0 秒 · 已选用'])
    release(part, 300, 60)
    expect(on.onTogglePart).not.toHaveBeenCalled()
  })

  it('草稿块拖出草稿等于拿掉（关掉它的眼睛），还在草稿上松手取消', () => {
    const { on } = renderTimeline(pickedFirst)
    const shotBlock = draftBlock(/^镜头 2 ·/)
    press(shotBlock, 250, 60)
    move(shotBlock, 400, 60)
    release(shotBlock, 400, 60)
    expect(on.onToggleShot).not.toHaveBeenCalled()
    press(shotBlock, 250, 60)
    move(shotBlock, 250, 300)
    release(shotBlock, 250, 300)
    expect(on.onToggleShot).toHaveBeenCalledExactlyOnceWith(2)

    const partBlock = draftBlock(/第 2 段/)
    press(partBlock, 550, 60)
    move(partBlock, 550, 300)
    release(partBlock, 550, 300)
    expect(on.onTogglePart).toHaveBeenCalledExactlyOnceWith(first.id, 2)
    fireEvent.click(partBlock)
    expect(on.onSelectDraft).not.toHaveBeenCalled()
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
