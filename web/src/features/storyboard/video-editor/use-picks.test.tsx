import { act, renderHook, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster } from '@/shared/ui/toast'
import { makeGenerationJob } from '@/testing/generation-job'
import { editBlocksOf, laneEditsOf, shotsOf, type EditBlock } from './edit-blocks'
import { picksStorageKey, usePicks } from './use-picks'

const shots = shotsOf({ keyframes: [0, 1, 2, 3], duration: 4 })
const edit = (id: string, [start, end]: [number, number], createdAt: string) =>
  makeGenerationJob({
    id,
    rootJobId: 'root',
    sourceJobId: 'root',
    rangeStartMs: start * 1000,
    rangeEndMs: end * 1000,
    outputUrl: `https://oss.example/${id}.mp4`,
    createdAt,
  })
const lane = laneEditsOf(
  'root',
  [
    edit('a', [0, 2], '2026-10-28T10:01:00Z'),
    edit('b', [1, 3], '2026-10-28T10:02:00Z'),
    edit('c', [3, 4], '2026-10-28T10:03:00Z'),
  ],
  shots,
)
// c 的时长还在读。
const blocks = editBlocksOf(lane, {
  'https://oss.example/a.mp4': 2,
  'https://oss.example/b.mp4': 2,
})
const key = picksStorageKey('conversation', 'root')

const renderPicks = (
  initial: { blocks: readonly EditBlock[]; ready: boolean } = { blocks, ready: true },
) =>
  renderHook(
    (props: { blocks: readonly EditBlock[]; ready: boolean }) =>
      usePicks({
        conversationId: 'conversation',
        rootJobId: 'root',
        fallback: ['b'],
        ...props,
      }),
    {
      initialProps: initial,
      wrapper: ({ children }: { children: ReactNode }) => (
        <>
          {children}
          <Toaster />
        </>
      ),
    },
  )

beforeEach(() => window.localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('usePicks', () => {
  it('存着的选用都可用就用它', () => {
    window.localStorage.setItem(key, JSON.stringify(['a']))
    expect(renderPicks().result.current.picks).toEqual(['a'])
  })

  it.each<[string, string]>([
    ['读不懂', '{not json'],
    ['形状不对', JSON.stringify({ picks: ['a'] })],
    ['互相重叠', JSON.stringify(['a', 'b'])],
    ['有一条还没读出时长', JSON.stringify(['c'])],
    ['有一条不在轨上', JSON.stringify(['gone'])],
  ])('存着的选用%s时用最近一次合成推出的', (_, stored) => {
    window.localStorage.setItem(key, stored)
    expect(renderPicks().result.current.picks).toEqual(['b'])
  })

  it('没存过就用最近一次合成推出的；读好之前不定、也不写进浏览器', () => {
    const { result, rerender } = renderPicks({ blocks, ready: false })
    expect(result.current.picks).toEqual([])
    rerender({ blocks, ready: true })
    expect(result.current.picks).toEqual(['b'])
    expect(window.localStorage.getItem(key)).toBeNull()
  })

  it('定下后不再跟着最近一次合成变；选用、取消才改并存进浏览器', () => {
    const { result } = renderPicks()
    act(() => result.current.pick('a'))
    expect(result.current.picks).toEqual(['a'])
    expect(JSON.parse(window.localStorage.getItem(key) ?? '')).toEqual(['a'])
    act(() => result.current.unpick('a'))
    expect(result.current.picks).toEqual([])
    expect(JSON.parse(window.localStorage.getItem(key) ?? '')).toEqual([])
  })

  it('存不进浏览器时提示一次，选用照常生效', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const { result } = renderPicks()
    act(() => result.current.pick('a'))
    act(() => result.current.unpick('a'))
    expect(result.current.picks).toEqual([])
    expect(
      await screen.findByText('当前浏览器无法保存选用的编辑片段，关闭编辑器后选用将丢失'),
    ).toBeVisible()
    expect(screen.getAllByText(/无法保存选用的编辑片段/)).toHaveLength(1)
  })
})
