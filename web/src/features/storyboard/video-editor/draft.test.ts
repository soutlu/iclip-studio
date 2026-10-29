import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import {
  canCompose,
  composeSegmentsOf,
  compositeSegmentsOf,
  draftItemsOf,
  EMPTY_DRAFT,
  isUsableDraft,
  keepPlace,
  outputOf,
  pickPart,
  putShot,
  restoreDraft,
  runTrimSpecOf,
  shotOn,
  snapAhead,
  snapNear,
  trimItem,
  trimSpecOf,
  trimTo,
  unpickPart,
  type Draft,
  type DraftSource,
  type ReadyEdit,
} from './draft'
import { shotsOf } from './edit-blocks'

// 原片 6 秒、6 个镜头，各 1 秒。A、B 都从镜头 4–5 生成，各切成两段；C 从镜头 2 生成，只有一段。
const edit = (
  id: string,
  order: number,
  from: number,
  to: number,
  cuts: number[],
  duration: number,
): ReadyEdit => ({
  id,
  order,
  from,
  to,
  mediaUrl: `https://oss.example/${id}.mp4`,
  duration,
  parts: cuts.map((b0, at) => ({ seg: at + 1, b0, b1: cuts[at + 1] ?? duration })),
})
const A = edit('a', 0, 4, 5, [0, 1.2], 2.5)
const B = edit('b', 1, 4, 5, [0, 1], 2)
const C = edit('c', 2, 2, 2, [0], 1.5)
const source: DraftSource = {
  rootId: 'root',
  rootUrl: 'https://oss.example/root.mp4',
  duration: 6,
  shots: shotsOf({ keyframes: [0, 1, 2, 3, 4, 5], duration: 6 }),
  edits: [A, B, C],
}

const names = (draft: Draft) =>
  draftItemsOf(source, draft).map((item) =>
    item.kind === 'shot' ? `${item.no}` : `${item.edit.id.toUpperCase()}${item.seg}`,
  )
const pickAll = (draft: Draft, target: ReadyEdit) =>
  target.parts.reduce((next, part) => pickPart(source, next, target.id, part.seg), draft)

describe('排序', () => {
  it('镜头 4–5 的 A、B 各两段都选用：A1、B1、A2、B2；再打开镜头 5，它排在 A2、B2 后面', () => {
    const both = pickAll(pickAll(EMPTY_DRAFT, A), B)
    expect(names(both)).toEqual(['1', '2', '3', 'A1', 'B1', 'A2', 'B2', '6'])
    expect(names(putShot(source, both, 5, true))).toEqual([
      '1',
      '2',
      '3',
      'A1',
      'B1',
      'A2',
      'B2',
      '5',
      '6',
    ])
  })

  it('只选用 A，再打开镜头 4：它排在 A1 后面、A2 前面', () => {
    expect(names(putShot(source, pickAll(EMPTY_DRAFT, A), 4, true))).toEqual([
      '1',
      '2',
      '3',
      'A1',
      '4',
      'A2',
      '6',
    ])
  })

  it('块首尾相接从 0 起，编辑段按它用到的长度', () => {
    const items = draftItemsOf(source, pickAll(EMPTY_DRAFT, A))
    expect(items.map(({ at, d }) => [at, d])).toEqual([
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1.2],
      [4.2, 1.3],
      [5.5, 1],
    ])
  })
})

describe('镜头的开关', () => {
  it('选用的编辑段覆盖的镜头默认关；第一次选用时清掉这些镜头上用户「开」的明确开关，用户关掉的不动', () => {
    const opened = putShot(source, putShot(source, EMPTY_DRAFT, 5, true), 3, false)
    const picked = pickPart(source, opened, A.id, 1)
    expect(shotOn(source, picked, 4)).toBe(false)
    expect(shotOn(source, picked, 5)).toBe(false)
    expect(shotOn(source, picked, 3)).toBe(false)
    // 再打开镜头 5 后又选用 A 的另一段：A 已在草稿里，不再清
    const reopened = putShot(source, picked, 5, true)
    expect(shotOn(source, pickPart(source, reopened, A.id, 2), 5)).toBe(true)
  })

  it('取消选用后镜头回来；另一条选用的编辑段仍覆盖、或用户手动关的不回来', () => {
    const both = pickPart(source, pickPart(source, EMPTY_DRAFT, A.id, 1), B.id, 1)
    const withoutA = unpickPart(both, A.id, 1)
    expect(shotOn(source, withoutA, 4)).toBe(false)
    const none = unpickPart(withoutA, B.id, 1)
    expect(shotOn(source, none, 4)).toBe(true)
    const closed = putShot(source, pickPart(source, EMPTY_DRAFT, A.id, 1), 5, false)
    expect(shotOn(source, unpickPart(closed, A.id, 1), 5)).toBe(false)
  })
})

describe('修剪', () => {
  const itemOf = (draft: Draft, id: string) => {
    const item = draftItemsOf(source, draft).find((candidate) => candidate.id === id)
    if (item === undefined) throw new Error(`草稿里没有 ${id}`)
    return item
  }
  const none = (time: number) => time

  it('编辑段只改这一段用到的起止，限在关键帧边界之间，最短 0.5 秒；后面的块跟着移', () => {
    const draft = pickPart(source, EMPTY_DRAFT, A.id, 2)
    const item = itemOf(draft, 'a#2')
    const spec = trimSpecOf(item)
    expect(trimTo(spec, 'start', 0.2, none)).toEqual({ t0: 1.2, t1: 2.5 })
    expect(trimTo(spec, 'start', 2.4, none)).toEqual({ t0: 2, t1: 2.5 })
    expect(trimTo(spec, 'end', 9, none)).toEqual({ t0: 1.2, t1: 2.5 })
    const trimmed = trimItem(draft, item, trimTo(spec, 'end', 2, none))
    expect(itemOf(trimmed, 'a#2').d).toBe(0.8)
    expect(itemOf(trimmed, 'shot-6').at).toBe(3.8)
  })

  it('原片块限在镜头之内，最短 0.5 秒；拉回整段时删掉修剪记录', () => {
    const item = itemOf(EMPTY_DRAFT, 'shot-2')
    const spec = trimSpecOf(item)
    expect(trimTo(spec, 'start', 0.5, none)).toEqual({ t0: 1, t1: 2 })
    expect(trimTo(spec, 'start', 1.9, none)).toEqual({ t0: 1.5, t1: 2 })
    const cut = trimItem(EMPTY_DRAFT, item, { t0: 1.3, t1: 2 })
    expect(cut.cuts).toEqual([{ no: 2, t0: 1.3, t1: 2 }])
    expect(trimItem(cut, itemOf(cut, 'shot-2'), { t0: 1, t1: 2 }).cuts).toEqual([])
  })

  it('关掉再打开回到整段：原片镜头的修剪丢掉，编辑段重新选用回到边界', () => {
    const cut = trimItem(EMPTY_DRAFT, itemOf(EMPTY_DRAFT, 'shot-2'), { t0: 1.3, t1: 2 })
    const reopened = putShot(source, putShot(source, cut, 2, false), 2, true)
    expect(itemOf(reopened, 'shot-2')).toMatchObject({ t0: 1, t1: 2 })
    const picked = pickPart(source, EMPTY_DRAFT, A.id, 1)
    const short = trimItem(picked, itemOf(picked, 'a#1'), { t0: 0.3, t1: 1.2 })
    const again = pickPart(source, unpickPart(short, A.id, 1), A.id, 1)
    expect(itemOf(again, 'a#1')).toMatchObject({ t0: 0, t1: 1.2 })
  })

  it('拖动时离边界 8px 以内吸上去；方向键只吸前方的边界', () => {
    expect(snapNear([1, 2], 100)(1.95)).toBe(2)
    expect(snapNear([1, 2], 100)(1.9)).toBe(1.9)
    // 往右一步越过了 2：停在 2
    expect(snapAhead([1, 2], 1.95, 1, 100)(2.05)).toBe(2)
    // 刚离开 1 往右：不吸回 1
    expect(snapAhead([1, 2], 1, 1, 100)(1.1)).toBe(1.1)
  })

  it('原片选区在整条原片之内，可以停在镜头中间、越过镜头分界，最短 1 秒，吸附镜头分界与片尾', () => {
    const spec = runTrimSpecOf({ start: 1, end: 3 }, source.shots, source.duration)
    expect(spec.snaps).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(trimTo(spec, 'end', 2.5, none)).toEqual({ t0: 1, t1: 2.5 })
    expect(trimTo(spec, 'end', 4.6, none)).toEqual({ t0: 1, t1: 4.6 })
    expect(trimTo(spec, 'end', 1.3, none)).toEqual({ t0: 1, t1: 2 })
    expect(trimTo(spec, 'end', 9, none)).toEqual({ t0: 1, t1: 6 })
    expect(trimTo(spec, 'start', -1, none)).toEqual({ t0: 0, t1: 3 })
    expect(trimTo(spec, 'end', 3.96, snapNear(spec.snaps, 100))).toEqual({ t0: 1, t1: 4 })
  })

  it('原片选区本身不到 1 秒时只能拉长', () => {
    const spec = runTrimSpecOf({ start: 0, end: 0.5 }, source.shots, source.duration)
    expect(trimTo(spec, 'end', 0.2, none)).toEqual({ t0: 0, t1: 0.5 })
    expect(trimTo(spec, 'end', 1.4, none)).toEqual({ t0: 0, t1: 1.4 })
  })
})

describe('合成内容', () => {
  it('同一来源里时间相接的相邻块并成一段', () => {
    expect(composeSegmentsOf(outputOf(draftItemsOf(source, EMPTY_DRAFT)))).toEqual([
      { sourceJobId: 'root', start: 0, end: 6 },
    ])
    const draft = pickAll(EMPTY_DRAFT, A)
    expect(composeSegmentsOf(outputOf(draftItemsOf(source, draft)))).toEqual([
      { sourceJobId: 'root', start: 0, end: 3 },
      { sourceJobId: 'a', start: 0, end: 2.5 },
      { sourceJobId: 'root', start: 5, end: 6 },
    ])
    // A1 与 A2 中间插进镜头 4：不再相接
    expect(
      composeSegmentsOf(outputOf(draftItemsOf(source, putShot(source, draft, 4, true)))),
    ).toEqual([
      { sourceJobId: 'root', start: 0, end: 3 },
      { sourceJobId: 'a', start: 0, end: 1.2 },
      { sourceJobId: 'root', start: 3, end: 4 },
      { sourceJobId: 'a', start: 1.2, end: 2.5 },
      { sourceJobId: 'root', start: 5, end: 6 },
    ])
  })
})

describe('从合成还原', () => {
  const composite = (segments: { sourceJobId: string; start: number; end?: number | null }[]) =>
    makeGenerationJob({ operation: 'compose', request: { segments } })
  const lengthOf = (id: string) =>
    id === 'root' ? 6 : source.edits.find((item) => item.id === id)?.duration
  const restore = (segments: Parameters<typeof composite>[0]) => {
    const parsed = compositeSegmentsOf(composite(segments), lengthOf)
    return parsed === undefined ? undefined : restoreDraft(source, parsed)
  }
  const outputOfDraft = (draft: Draft | undefined) =>
    draft === undefined ? undefined : composeSegmentsOf(outputOf(draftItemsOf(source, draft)))

  it('编辑段写 end: null 时用到结尾，拆到它的各段上', () => {
    const draft = restore([
      { sourceJobId: 'root', start: 0, end: 3 },
      { sourceJobId: 'a', start: 0, end: null },
      { sourceJobId: 'root', start: 5, end: 6 },
    ])
    expect(names(draft ?? EMPTY_DRAFT)).toEqual(['1', '2', '3', 'A1', 'A2', '6'])
  })

  it('分段与修剪：盖到一部分的镜头与段记成修剪，没出现的镜头关着', () => {
    const segments = [
      { sourceJobId: 'root', start: 0.5, end: 3 },
      { sourceJobId: 'a', start: 0, end: 1.2 },
      { sourceJobId: 'root', start: 3, end: 4 },
      { sourceJobId: 'a', start: 1.2, end: 2 },
    ]
    const draft = restore(segments)
    expect(outputOfDraft(draft)).toEqual(segments)
    expect(draft?.cuts).toEqual([{ no: 1, t0: 0.5, t1: 1 }])
    expect(shotOn(source, draft ?? EMPTY_DRAFT, 6)).toBe(false)
  })

  it.each([
    [
      '顺序不符合排序规则',
      [
        { sourceJobId: 'a', start: 0, end: null },
        { sourceJobId: 'root', start: 0, end: 6 },
      ],
    ],
    [
      '同一个镜头出现两次',
      [
        { sourceJobId: 'root', start: 0, end: 2 },
        { sourceJobId: 'root', start: 1, end: 3 },
      ],
    ],
    ['出处不是能选用的编辑片段', [{ sourceJobId: 'gone', start: 0, end: 1 }]],
  ])('%s时用默认草稿', (_, segments) => {
    expect(restore(segments)).toBeUndefined()
  })
})

describe('存着的草稿能不能用', () => {
  it.each([
    ['段号不存在', { ...EMPTY_DRAFT, picks: [{ editId: 'a', seg: 3, t0: 0, t1: 1, seq: 1 }] }],
    ['编辑片段不在', { ...EMPTY_DRAFT, picks: [{ editId: 'gone', seg: 1, t0: 0, t1: 1, seq: 1 }] }],
    ['起止超出边界', { ...EMPTY_DRAFT, picks: [{ editId: 'a', seg: 1, t0: 0, t1: 2, seq: 1 }] }],
    ['镜头号不存在', { ...EMPTY_DRAFT, toggles: [{ no: 9, on: false as const }] }],
    ['修剪超出镜头', { ...EMPTY_DRAFT, cuts: [{ no: 2, t0: 0.5, t1: 2 }] }],
  ])('%s时不用', (_, draft) => {
    expect(isUsableDraft(source, draft)).toBe(false)
  })

  it('每一处都对得上就用', () => {
    expect(isUsableDraft(source, putShot(source, pickAll(EMPTY_DRAFT, A), 4, true))).toBe(true)
  })
})

describe('能否合成', () => {
  const check = (draft: Draft, latest?: { sourceJobId: string; start: number; end: number }[]) =>
    canCompose({
      source,
      pieces: outputOf(draftItemsOf(source, draft)),
      latest,
      composing: false,
      busy: false,
    })

  it('为空、等于整条原片、等于最近一次合成时都不能', () => {
    const closed = source.shots.reduce(
      (draft, shot) => putShot(source, draft, shot.no, false),
      EMPTY_DRAFT,
    )
    expect(check(closed)).toBe(false)
    expect(check(EMPTY_DRAFT)).toBe(false)
    const draft = pickAll(EMPTY_DRAFT, A)
    expect(check(draft)).toBe(true)
    // 最近一次合成里原片分成了相接的两段：先合并再比
    expect(
      check(draft, [
        { sourceJobId: 'root', start: 0, end: 1 },
        { sourceJobId: 'root', start: 1, end: 3 },
        { sourceJobId: 'a', start: 0, end: 2.5 },
        { sourceJobId: 'root', start: 5, end: 6 },
      ]),
    ).toBe(false)
  })

  it('正在合成、正在提交时不能', () => {
    const pieces = outputOf(draftItemsOf(source, pickAll(EMPTY_DRAFT, A)))
    expect(canCompose({ source, pieces, latest: undefined, composing: true, busy: false })).toBe(
      false,
    )
    expect(canCompose({ source, pieces, latest: undefined, composing: false, busy: true })).toBe(
      false,
    )
  })
})

describe('播放头留位', () => {
  const before = draftItemsOf(source, EMPTY_DRAFT)

  it('留在原来那一块的同一位置', () => {
    const after = draftItemsOf(source, putShot(source, EMPTY_DRAFT, 2, false))
    expect(keepPlace(before, after, 3.4)).toBe(2.4)
  })

  it('那一块没了，停在原来位置上现在那一块的开头', () => {
    const after = draftItemsOf(source, pickAll(EMPTY_DRAFT, A))
    // 原来在镜头 4 的 3.5 秒，现在那里是 A1（3 秒起）
    expect(keepPlace(before, after, 3.5)).toBe(3)
  })

  it('原来在末尾就留在新的末尾', () => {
    const after = draftItemsOf(source, pickAll(EMPTY_DRAFT, A))
    expect(keepPlace(before, after, 6)).toBe(6.5)
  })
})
