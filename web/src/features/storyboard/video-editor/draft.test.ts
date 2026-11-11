import { describe, expect, it } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import {
  canCompose,
  composeSegmentsOf,
  compositeSegmentsOf,
  defaultDraft,
  draftItemsOf,
  isUsableDraft,
  keepPlace,
  moveBefore,
  outputOf,
  pickPart,
  previewPick,
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
  type DraftEntry,
  type DraftSource,
  type ReadyEdit,
} from './draft'
import { shotsOf } from './edit-blocks'

const edit = (
  id: string,
  from: number,
  to: number,
  cuts: number[],
  duration: number,
): ReadyEdit => ({
  id,
  from,
  to,
  mediaUrl: `https://oss.example/${id}.mp4`,
  duration,
  parts: cuts.map((b0, at) => ({ seg: at + 1, b0, b1: cuts[at + 1] ?? duration })),
})
const A = edit('a', 4, 5, [0, 1.2], 2.5)
const B = edit('b', 4, 5, [0, 1], 2)
const C = edit('c', 2, 2, [0], 1.5)
const source: DraftSource = {
  rootId: 'root',
  rootUrl: 'https://oss.example/root.mp4',
  duration: 6,
  shots: shotsOf({ keyframes: [0, 1, 2, 3, 4, 5], duration: 6 }),
  edits: [A, B, C],
}
const START = defaultDraft(source)

const names = (draft: Draft) =>
  draftItemsOf(source, draft).map((item) =>
    item.kind === 'shot' ? `${item.no}` : `${item.edit.id.toUpperCase()}${item.seg}`,
  )
const pickAll = (draft: Draft, target: ReadyEdit) =>
  target.parts.reduce((next, part) => pickPart(source, next, target.id, part.seg), draft)

describe('排序', () => {
  it('镜头 4–5 的 A、B 各两段都选用：A1、B1、A2、B2；再打开镜头 5，它排在 A2、B2 后面', () => {
    const both = pickAll(pickAll(START, A), B)
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
    expect(names(putShot(source, pickAll(START, A), 4, true))).toEqual([
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
    const items = draftItemsOf(source, pickAll(START, A))
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

describe('挪动草稿里的块', () => {
  it('挪到指定那块前面，不指定就挪到末尾', () => {
    expect(names(moveBefore(START, 'shot-5', 'shot-2'))).toEqual(['1', '5', '2', '3', '4', '6'])
    expect(names(moveBefore(START, 'shot-2', undefined))).toEqual(['1', '3', '4', '5', '6', '2'])
    const picked = pickAll(START, A)
    expect(names(moveBefore(picked, 'a#2', 'shot-1'))).toEqual(['A2', '1', '2', '3', 'A1', '6'])
  })

  it('位置没变、块不在草稿里、要排到自己前面时草稿原样不动', () => {
    expect(moveBefore(START, 'shot-2', 'shot-3')).toBe(START)
    expect(moveBefore(START, 'shot-6', undefined)).toBe(START)
    expect(moveBefore(START, 'shot-9', 'shot-1')).toBe(START)
    expect(moveBefore(START, 'shot-2', 'shot-2')).toBe(START)
  })

  it('合成按挪过的先后拼，只调了先后也能合成，换浏览器能照这次合成还原', () => {
    const draft = moveBefore(START, 'shot-5', 'shot-2')
    const pieces = outputOf(draftItemsOf(source, draft))
    const segments = composeSegmentsOf(pieces)
    expect(segments).toEqual([
      { sourceJobId: 'root', start: 0, end: 1 },
      { sourceJobId: 'root', start: 4, end: 5 },
      { sourceJobId: 'root', start: 1, end: 4 },
      { sourceJobId: 'root', start: 5, end: 6 },
    ])
    expect(canCompose({ source, pieces, latest: undefined, composing: false, busy: false })).toBe(
      true,
    )
    expect(names(restoreDraft(source, segments) ?? START)).toEqual(names(draft))
  })
})

describe('先后排过以后，新进草稿的块放哪', () => {
  const arrange = (draft: Draft, order: readonly string[]): Draft => {
    const labels = names(draft)
    return {
      ...draft,
      entries: order.flatMap((label) => draft.entries.filter((_, at) => labels[at] === label)),
    }
  }
  const moved = arrange(START, ['1', '5', '2', '3', '4', '6'])

  it('选用的编辑段落在它替换的镜头那里；取消选用后镜头回到编辑段那里', () => {
    const picked = pickPart(source, moved, C.id, 1)
    expect(names(picked)).toEqual(['1', '5', 'C1', '3', '4', '6'])
    expect(names(unpickPart(source, picked, C.id, 1))).toEqual(['1', '5', '2', '3', '4', '6'])
  })

  it('关掉再打开的镜头排在往前最近一个镜头的块后面，前面没有块就排最前', () => {
    const reopen = (draft: Draft, no: number) =>
      putShot(source, putShot(source, draft, no, false), no, true)
    expect(names(reopen(moved, 4))).toEqual(['1', '5', '2', '3', '4', '6'])
    expect(names(reopen(putShot(source, moved, 3, false), 4))).toEqual(['1', '5', '2', '4', '6'])
    expect(names(reopen(arrange(START, ['6', '5', '2']), 2))).toEqual(['2', '6', '5'])
  })

  it('重新打开的镜头排在同一镜头的编辑段后面，编辑段挪到哪就跟到哪', () => {
    const front = arrange(pickAll(START, A), ['A1', '1', '2', '3', 'A2', '6'])
    expect(names(putShot(source, front, 4, true))).toEqual(['A1', '4', '1', '2', '3', 'A2', '6'])
  })

  it('离开过草稿的块再回来排默认位置，不回到拖过去的地方', () => {
    const front = arrange(START, ['5', '1', '2', '3', '4', '6'])
    const picked = pickPart(source, front, A.id, 1)
    expect(names(picked)).toEqual(['1', '2', '3', 'A1', '6'])
    expect(names(unpickPart(source, picked, A.id, 1))).toEqual(['1', '2', '3', '4', '5', '6'])
  })
})

describe('镜头的开关', () => {
  it('选用的编辑段覆盖的镜头默认关；第一次选用时清掉这些镜头上用户「开」的明确开关，用户关掉的不动', () => {
    const opened = putShot(source, putShot(source, START, 5, true), 3, false)
    const picked = pickPart(source, opened, A.id, 1)
    expect(shotOn(picked, 4)).toBe(false)
    expect(shotOn(picked, 5)).toBe(false)
    expect(shotOn(picked, 3)).toBe(false)
    const reopened = putShot(source, picked, 5, true)
    expect(shotOn(pickPart(source, reopened, A.id, 2), 5)).toBe(true)
  })

  it('取消选用后镜头回来；另一条选用的编辑段仍覆盖、或用户手动关的不回来', () => {
    const both = pickPart(source, pickPart(source, START, A.id, 1), B.id, 1)
    const withoutA = unpickPart(source, both, A.id, 1)
    expect(shotOn(withoutA, 4)).toBe(false)
    const none = unpickPart(source, withoutA, B.id, 1)
    expect(shotOn(none, 4)).toBe(true)
    const closed = putShot(source, pickPart(source, START, A.id, 1), 5, false)
    expect(shotOn(unpickPart(source, closed, A.id, 1), 5)).toBe(false)
  })
})

describe('拖到草稿上预演选用', () => {
  const preview = (draft: Draft, target: ReadyEdit, seg: number) => {
    const items = previewPick(source, draft, target.id, seg)
    if (items === undefined) throw new Error('这一段不能预演')
    return items.map((item) =>
      item.kind === 'shot' ? `${item.no}` : `${item.edit.id.toUpperCase()}${item.seg}`,
    )
  }

  it('按排序插进去，开着的镜头和修剪都留着；松手选用后覆盖的镜头才关', () => {
    const shot4 = draftItemsOf(source, START).find((item) => item.id === 'shot-4')
    if (shot4 === undefined) throw new Error('草稿里没有镜头 4')
    const cut = trimItem(START, shot4, { t0: 3.2, t1: 4 })
    expect(preview(cut, A, 1)).toEqual(['1', '2', '3', '4', 'A1', '5', '6'])
    const items = previewPick(source, cut, A.id, 1) ?? []
    expect(items.find((item) => item.id === 'shot-4')?.t0).toBe(3.2)
    expect(items.find((item) => item.id === 'a#1')).toMatchObject({ at: 3.8, d: 1.2 })
    expect(names(pickPart(source, cut, A.id, 1))).toEqual(['1', '2', '3', 'A1', '6'])
  })

  it('同一位置上重新打开过的镜头、已选用的段照排序让位', () => {
    const withA1 = pickPart(source, START, A.id, 1)
    const reopened = putShot(source, withA1, 4, true)
    expect(preview(reopened, B, 1)).toEqual(['1', '2', '3', 'A1', '4', 'B1', '6'])
  })

  it('已在草稿里的段没有预演', () => {
    expect(previewPick(source, pickPart(source, START, C.id, 1), C.id, 1)).toBeUndefined()
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
    const draft = pickPart(source, START, A.id, 2)
    const item = itemOf(draft, 'a#2')
    const spec = trimSpecOf(item)
    expect(trimTo(spec, 'start', 0.2, none)).toEqual({ t0: 1.2, t1: 2.5 })
    expect(trimTo(spec, 'start', 2.4, none)).toEqual({ t0: 2, t1: 2.5 })
    expect(trimTo(spec, 'end', 9, none)).toEqual({ t0: 1.2, t1: 2.5 })
    const trimmed = trimItem(draft, item, trimTo(spec, 'end', 2, none))
    expect(itemOf(trimmed, 'a#2').d).toBe(0.8)
    expect(itemOf(trimmed, 'shot-6').at).toBe(3.8)
  })

  it('原片块限在镜头之内，最短 0.5 秒；拉回整段就和没修剪过一样', () => {
    const item = itemOf(START, 'shot-2')
    const spec = trimSpecOf(item)
    expect(trimTo(spec, 'start', 0.5, none)).toEqual({ t0: 1, t1: 2 })
    expect(trimTo(spec, 'start', 1.9, none)).toEqual({ t0: 1.5, t1: 2 })
    const cut = trimItem(START, item, { t0: 1.3, t1: 2 })
    expect(itemOf(cut, 'shot-2')).toMatchObject({ t0: 1.3, t1: 2, d: 0.7 })
    expect(trimItem(cut, itemOf(cut, 'shot-2'), { t0: 1, t1: 2 })).toEqual(START)
  })

  it('关掉再打开回到整段：原片镜头的修剪丢掉，编辑段重新选用回到边界', () => {
    const cut = trimItem(START, itemOf(START, 'shot-2'), { t0: 1.3, t1: 2 })
    const reopened = putShot(source, putShot(source, cut, 2, false), 2, true)
    expect(itemOf(reopened, 'shot-2')).toMatchObject({ t0: 1, t1: 2 })
    const picked = pickPart(source, START, A.id, 1)
    const short = trimItem(picked, itemOf(picked, 'a#1'), { t0: 0.3, t1: 1.2 })
    const again = pickPart(source, unpickPart(source, short, A.id, 1), A.id, 1)
    expect(itemOf(again, 'a#1')).toMatchObject({ t0: 0, t1: 1.2 })
  })

  it('拖动时离边界 8px 以内吸上去；方向键只吸前方的边界', () => {
    expect(snapNear([1, 2], 100)(1.95)).toBe(2)
    expect(snapNear([1, 2], 100)(1.9)).toBe(1.9)
    expect(snapAhead([1, 2], 1.95, 1, 100)(2.05)).toBe(2)
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
    expect(composeSegmentsOf(outputOf(draftItemsOf(source, START)))).toEqual([
      { sourceJobId: 'root', start: 0, end: 6 },
    ])
    const draft = pickAll(START, A)
    expect(composeSegmentsOf(outputOf(draftItemsOf(source, draft)))).toEqual([
      { sourceJobId: 'root', start: 0, end: 3 },
      { sourceJobId: 'a', start: 0, end: 2.5 },
      { sourceJobId: 'root', start: 5, end: 6 },
    ])
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
    expect(names(draft ?? START)).toEqual(['1', '2', '3', 'A1', 'A2', '6'])
  })

  it('分段与修剪：盖到一部分的镜头与段只用盖到的部分，没出现的镜头关着', () => {
    const segments = [
      { sourceJobId: 'root', start: 0.5, end: 3 },
      { sourceJobId: 'a', start: 0, end: 1.2 },
      { sourceJobId: 'root', start: 3, end: 4 },
      { sourceJobId: 'a', start: 1.2, end: 2 },
    ]
    const draft = restore(segments)
    expect(outputOfDraft(draft)).toEqual(segments)
    expect(draftItemsOf(source, draft ?? START)[0]).toMatchObject({ id: 'shot-1', t0: 0.5, t1: 1 })
    expect(shotOn(draft ?? START, 6)).toBe(false)
  })

  it('块的先后照合成里的顺序，和原片镜头的先后不一样也照样还原', () => {
    const segments = [
      { sourceJobId: 'root', start: 4, end: 5 },
      { sourceJobId: 'a', start: 0, end: 2.5 },
      { sourceJobId: 'root', start: 0, end: 4 },
    ]
    const draft = restore(segments)
    expect(names(draft ?? START)).toEqual(['5', 'A1', 'A2', '1', '2', '3', '4'])
    expect(outputOfDraft(draft)).toEqual(segments)
  })

  it.each([
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
  const shot = (no: number, t0: number, t1: number): DraftEntry => ({ kind: 'shot', no, t0, t1 })
  const part = (editId: string, seg: number, t0: number, t1: number): DraftEntry => ({
    kind: 'edit',
    editId,
    seg,
    t0,
    t1,
  })

  it.each([
    ['段号不存在', [part('a', 3, 0, 1)], []],
    ['编辑片段不在', [part('gone', 1, 0, 1)], []],
    ['起止超出边界', [part('a', 1, 0, 2)], []],
    ['镜头号不存在', [shot(9, 0, 1)], []],
    ['修剪超出镜头', [shot(2, 0.5, 2)], []],
    ['同一块出现两次', [shot(2, 1, 2), shot(2, 1, 2)], []],
    ['关掉的镜头号不存在', [], [9]],
    ['关掉的镜头还在草稿里', [shot(2, 1, 2)], [2]],
  ])('%s时不用', (_, entries, closed) => {
    expect(isUsableDraft(source, { entries, closed })).toBe(false)
  })

  it('每一处都对得上就用', () => {
    expect(isUsableDraft(source, putShot(source, pickAll(START, A), 4, true))).toBe(true)
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
      START,
    )
    expect(check(closed)).toBe(false)
    expect(check(START)).toBe(false)
    const draft = pickAll(START, A)
    expect(check(draft)).toBe(true)
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
    const pieces = outputOf(draftItemsOf(source, pickAll(START, A)))
    expect(canCompose({ source, pieces, latest: undefined, composing: true, busy: false })).toBe(
      false,
    )
    expect(canCompose({ source, pieces, latest: undefined, composing: false, busy: true })).toBe(
      false,
    )
  })
})

describe('播放头留位', () => {
  const before = draftItemsOf(source, START)

  it('留在原来那一块的同一位置', () => {
    const after = draftItemsOf(source, putShot(source, START, 2, false))
    expect(keepPlace(before, after, 3.4)).toBe(2.4)
  })

  it('那一块没了，停在原来位置上现在那一块的开头', () => {
    const after = draftItemsOf(source, pickAll(START, A))
    expect(keepPlace(before, after, 3.5)).toBe(3)
  })

  it('原来在末尾就留在新的末尾', () => {
    const after = draftItemsOf(source, pickAll(START, A))
    expect(keepPlace(before, after, 6)).toBe(6.5)
  })
})
