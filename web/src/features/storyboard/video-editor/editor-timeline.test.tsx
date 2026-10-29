import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { renderWithTooltip } from '@/testing/render'
import type { GenerationJob } from '../storyboard.api'
import { pickedBlocksOf, unitsOf, type Selection } from './composition'
import { editBlocksOf, laneEditsOf, shotsOf } from './edit-blocks'
import { ClipsTimeline, VersionsTimeline, type VersionRow } from './editor-timeline'

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

const picked = edit([3, 5])
const other = edit([3, 5])
const running = edit([5, 6], { status: 'submitted', outputUrl: null })
const failed = edit([0, 1], { status: 'failed', errorMessage: '模型超时' })
const blocks = editBlocksOf(laneEditsOf('root', [picked, other, running, failed], shots), {
  [picked.outputUrl ?? '']: 4,
  [other.outputUrl ?? '']: 2,
})
const units = unitsOf(shots, pickedBlocksOf(blocks, [picked.id]))

const renderTimeline = (selection: Selection = undefined) => {
  const onSelectUnits = vi.fn()
  const onClickBlock = vi.fn()
  const onSeek = vi.fn()
  renderWithTooltip(
    <ClipsTimeline
      anchor={0}
      blocks={blocks}
      duration={6}
      onClickBlock={onClickBlock}
      onScrub={() => {}}
      onSeek={onSeek}
      onSelectUnits={onSelectUnits}
      peaksOf={() => ({ kind: 'silent' })}
      rootUrl="https://oss.example/root.mp4"
      selection={selection}
      selectionBoxRef={null}
      shots={shots}
      units={units}
    />,
  )
  return { onSelectUnits, onClickBlock, onSeek }
}

const original = () => screen.getByRole('group', { name: '原片' })
const lane = () => screen.getByRole('group', { name: '编辑片段' })
const shot = (no: number) =>
  within(original()).getByRole('button', { name: new RegExp(`^镜头 ${no} ·`) })

describe('原片轨', () => {
  it('每个镜头一块，被选用替换的镜头标出来', () => {
    renderTimeline()
    expect(within(original()).getAllByRole('button')).toHaveLength(6)
    expect(shot(4)).toHaveAccessibleName('镜头 4 · 3–4 秒 · 已换成编辑片段')
    expect(shot(3)).toHaveAccessibleName('镜头 3 · 2–3 秒')
  })

  it('点镜头只选它；Shift 按单位扩选，被替换的镜头算整条编辑片段', async () => {
    const user = userEvent.setup()
    const { onSelectUnits } = renderTimeline({ kind: 'units', ids: ['shot-3'] })
    await user.click(shot(2))
    expect(onSelectUnits).toHaveBeenLastCalledWith(['shot-2'])
    await user.keyboard('{Shift>}')
    await user.click(shot(4))
    expect(onSelectUnits).toHaveBeenLastCalledWith(['shot-3', picked.id])
    await user.click(shot(6))
    expect(onSelectUnits).toHaveBeenLastCalledWith(['shot-6'])
    await user.keyboard('{/Shift}')
    await user.click(shot(5))
    expect(onSelectUnits).toHaveBeenLastCalledWith([picked.id])
  })

  it('选着的单位按下标出；方向键挪到相邻单位，Shift 扩选', () => {
    const { onSelectUnits } = renderTimeline({ kind: 'units', ids: ['shot-3', picked.id] })
    expect(shot(3)).toHaveAttribute('aria-pressed', 'true')
    expect(shot(5)).toHaveAttribute('aria-pressed', 'true')
    expect(shot(2)).toHaveAttribute('aria-pressed', 'false')
    fireEvent.keyDown(shot(4), { key: 'ArrowRight', shiftKey: true })
    expect(onSelectUnits).toHaveBeenLastCalledWith(['shot-3', picked.id, 'shot-6'])
    fireEvent.keyDown(shot(3), { key: 'ArrowLeft' })
    expect(onSelectUnits).toHaveBeenLastCalledWith(['shot-2'])
  })
})

describe('编辑轨', () => {
  it('同样镜头的几次各占一行，名字带第几次与实际时长；在跑的说状态，失败的不在轨上', () => {
    renderTimeline()
    const names = within(lane())
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'))
    expect(names).toEqual([
      // 第一行空着的镜头 1–3 是占位，镜头 1 生成失败的那次不占位置
      '生成镜头 1',
      '生成镜头 2',
      '生成镜头 3',
      '镜头 4–5 · 第 1 次 · 4.0 秒 · 已选用',
      '镜头 4–5 · 第 2 次 · 2.0 秒 · 未选用',
      '镜头 6 · 生成中',
    ])
  })

  it('点占位与点那个镜头一样选中它；点编辑片段交给编辑器', async () => {
    const user = userEvent.setup()
    const { onSelectUnits, onClickBlock } = renderTimeline()
    await user.click(within(lane()).getByRole('button', { name: '生成镜头 3' }))
    expect(onSelectUnits).toHaveBeenLastCalledWith(['shot-3'])
    await user.click(within(lane()).getByRole('button', { name: /第 2 次/ }))
    expect(onClickBlock).toHaveBeenLastCalledWith(other.id)
    await user.click(within(lane()).getByRole('button', { name: '镜头 6 · 生成中' }))
    expect(onClickBlock).toHaveBeenLastCalledWith(running.id)
  })
})

it('标尺拖动只定位播放头，不改选区', () => {
  const { onSeek, onSelectUnits } = renderTimeline({ kind: 'units', ids: ['shot-2'] })
  const ruler = Object.assign(screen.getByRole('slider', { name: '时间线播放位置' }), {
    setPointerCapture: () => undefined,
    hasPointerCapture: () => false,
    releasePointerCapture: () => undefined,
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    DOMRect.fromRect({ x: 100, y: 0, width: 600, height: 200 }),
  )
  fireEvent.pointerDown(ruler, { pointerId: 1, button: 0, clientX: 400 })
  expect(onSeek).toHaveBeenLastCalledWith(3)
  fireEvent.change(ruler, { target: { value: '4.5' } })
  expect(onSeek).toHaveBeenLastCalledWith(4.5)
  expect(onSelectUnits).not.toHaveBeenCalled()
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
