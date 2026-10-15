import { expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import type { GenerationJob } from '../storyboard.api'
import { chooseClipVersion, selectedClips, selectedGroup, selectedSource } from './clip-selection'
import { groupsForBase } from './clip-versions'
import {
  clipItem,
  draftDuration,
  isUnchanged,
  keyframeSegments,
  splitAt,
  trimClip,
  type Draft,
} from './draft'

const base = keyframeSegments('base', { keyframes: [0, 2, 4, 6], duration: 8 })
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('缺少预期的片段或选区')
  return value
}
const edit = (id: string, start: number, end: number, duration: number): GenerationJob =>
  makeGenerationJob({
    id,
    sourceJobId: 'base',
    rootJobId: 'base',
    rangeStartMs: start * 1000,
    rangeEndMs: end * 1000,
    durationMs: duration * 1000,
    outputUrl: `https://oss.example/${id}.mp4`,
  })
const first = edit('E1', 2, 4, 3)
const second = edit('E2', 2, 6, 5)
const result = clipItem({ sourceJobId: first.id, start: 0, end: 3 })
const draft = [required(base[0]), result, required(base[2]), required(base[3])]
const selectionOf = (value: Draft) => value.map((item) => item.id)

it('生成结果与相邻原片混选，版本组使用基底范围，参考素材保留实际顺序与时长', () => {
  const selected = [result.id, required(base[2]).id]
  expect(selectedSource(draft, selected)).toBeUndefined()
  expect(selectedClips(draft, selected)).toEqual([
    { sourceJobId: 'E1', start: 0, end: 3 },
    { sourceJobId: 'base', start: 4, end: 6 },
  ])
  expect(selectedGroup(draft, selected, 'base', [first])).toEqual({
    key: 'base@2000-6000',
    baseJobId: 'base',
    start: 2,
    end: 6,
    edits: [],
  })
  expect(selectedGroup(draft, selected, 'base', [first, second])?.edits).toEqual([second])
})

it('扩大范围后可选 E2 或恢复整个范围的 V1，不重复原片或丢弃较小范围的历史', () => {
  const selected = [result.id, required(base[2]).id]
  const replaced = required(
    chooseClipVersion(draft, selected, { sourceJobId: 'E2', start: 0, end: 5 }),
  )
  expect(selectedClips(replaced.draft, selectionOf(replaced.draft))).toEqual([
    { sourceJobId: 'base', start: 0, end: 2 },
    { sourceJobId: 'E2', start: 0, end: 5 },
    { sourceJobId: 'base', start: 6, end: 8 },
  ])
  expect(draftDuration(replaced.draft)).toBe(9)
  const group = required(selectedGroup(replaced.draft, replaced.selection, 'base', [first, second]))
  const restored = required(
    chooseClipVersion(replaced.draft, replaced.selection, {
      sourceJobId: group.baseJobId,
      start: group.start,
      end: group.end,
    }),
  )
  expect(isUnchanged(restored.draft, base)).toBe(true)
  expect(draftDuration(restored.draft)).toBe(8)
  expect(groupsForBase('base', [first, second]).map((item) => item.key)).toEqual([
    'base@2000-4000',
    'base@2000-6000',
  ])
  const split = required(splitAt(restored.draft, 4))
  expect(
    selectedGroup(split.draft, [required(split.draft[1]).id], 'base', [first, second])?.edits,
  ).toEqual([first])
})

it('裁剪生成结果只归属映射后的子范围，切回 V1 不重新插入被裁掉的内容', () => {
  const trimmed = trimClip(draft, result.id, 'start', 1.5)
  const group = required(selectedGroup(trimmed.draft, trimmed.selection, 'base', [first]))
  expect(group).toMatchObject({ start: 3, end: 4, edits: [] })
  const restored = required(
    chooseClipVersion(trimmed.draft, trimmed.selection, {
      sourceJobId: 'base',
      start: group.start,
      end: group.end,
    }),
  )
  expect(selectedClips(restored.draft, selectionOf(restored.draft))).toEqual([
    { sourceJobId: 'base', start: 0, end: 2 },
    { sourceJobId: 'base', start: 3, end: 4 },
    { sourceJobId: 'base', start: 4, end: 6 },
    { sourceJobId: 'base', start: 6, end: 8 },
  ])
  expect(draftDuration(restored.draft)).toBe(7)
})

it('拆分 E1 后左右部分独立查候选，选回两半才查到原来的完整组', () => {
  const split = required(splitAt(draft, 3.5))
  const left = required(split.draft[1])
  const right = required(split.draft[2])
  const partial = edit('partial', 2, 3, 0.8)
  expect(selectedGroup(split.draft, [left.id], 'base', [first, partial])?.edits).toEqual([partial])
  expect(selectedGroup(split.draft, [right.id], 'base', [first, partial])).toMatchObject({
    start: 3,
    end: 4,
    edits: [],
  })
  const both = [left.id, right.id]
  expect(selectedSource(split.draft, both)).toEqual({ sourceJobId: 'E1', start: 0, end: 3 })
  expect(selectedGroup(split.draft, both, 'base', [first, partial])?.edits).toEqual([first])
  const restored = required(
    chooseClipVersion(split.draft, [left.id], {
      sourceJobId: 'base',
      start: 2,
      end: 3,
    }),
  )
  expect(selectedClips(restored.draft, [required(restored.draft[1]).id, right.id])).toEqual([
    { sourceJobId: 'base', start: 2, end: 3 },
    { sourceJobId: 'E1', start: 1.5, end: 3 },
  ])
})

it('混选的基底范围必须连续且保持先后，不把重排或删段后的缺口伪装成原片连续区间', () => {
  const reordered = [required(base[2]), result]
  expect(selectedGroup(reordered, selectionOf(reordered), 'base', [first])).toBeUndefined()
  const gap = [required(base[0]), required(base[2])]
  expect(selectedClips(gap, selectionOf(gap))).toHaveLength(2)
  expect(selectedGroup(gap, selectionOf(gap), 'base', [first])).toBeUndefined()
  expect(selectedClips(base, [required(base[0]).id, required(base[2]).id])).toBeUndefined()
  expect(selectedGroup(base, [], 'base', [first])).toBeUndefined()
})
