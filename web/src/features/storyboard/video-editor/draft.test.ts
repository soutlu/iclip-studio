import { describe, expect, it } from 'vitest'
import { commit, redo, undo } from '../edit-history'
import {
  canRemove,
  canSplitAt,
  clickSelect,
  clipItem,
  compositeSegments,
  draftDuration,
  isUnchanged,
  keyframeSegments,
  moveItems,
  mergeSelection,
  parseStoredDraft,
  rebuildDraft,
  removeItems,
  resolveHistory,
  serializeDraft,
  splitAt,
  startDraftHistory as startHistory,
  stepSelect,
  trimClip,
  type Draft,
  type DraftClip,
  type EditOutcome,
} from './draft'

const V = 'v1'
/** 一条 6 秒的成片，每秒一个关键帧：第 1–6 段各 1 秒。 */
const segments = keyframeSegments(V, { keyframes: [0, 1, 2, 3, 4, 5], duration: 6 })
const ids = (draft: Draft) => draft.map((item) => item.id)
const seg = (at: number): DraftClip => {
  const found = segments[at]
  if (found === undefined) throw new Error(`没有第 ${at + 1} 段`)
  return found
}
const clips = (draft: Draft) =>
  draft.map((item) =>
    item.kind === 'clip'
      ? [item.sourceJobId, item.start, item.end]
      : ['pending', item.editJobId, item.replaced.length],
  )

/** 上一版已保存的占位，继续保留它绑定的编辑任务。 */
const storedPending = (draft: Draft, selection: readonly string[], editJobId: string): Draft => {
  const from = draft.findIndex((item) => item.id === selection[0])
  const replaced = draft.slice(from, from + selection.length).filter((item) => item.kind === 'clip')
  return [
    ...draft.slice(0, from),
    { kind: 'pending', id: `pending@${editJobId}`, editJobId, replaced },
    ...draft.slice(from + selection.length),
  ]
}

describe('keyframeSegments', () => {
  it('按关键帧切成 [k_i, k_i+1)，最后一段到片尾；第一个关键帧不在 0 上时片头也算一段', () => {
    expect(
      clips(keyframeSegments(V, { keyframes: [0.5, 1.917, 1.917, 4.208], duration: 5.25 })),
    ).toEqual([
      [V, 0, 0.5],
      [V, 0.5, 1.917],
      [V, 1.917, 4.208],
      [V, 4.208, 5.25],
    ])
  })

  it('初始草稿就是分段，没有改动', () => {
    expect(isUnchanged(segments, segments)).toBe(true)
    expect(isUnchanged(segments.slice(1), segments)).toBe(false)
  })
})

describe('选中', () => {
  const first = seg(0).id
  const second = seg(1).id
  const third = seg(2).id
  const fifth = seg(4).id

  it.each([
    { name: '没选时点一段选中它', from: [], click: second, expected: [second] },
    { name: '点后面相邻的段连进来', from: [second], click: third, expected: [second, third] },
    {
      name: '点前面相邻的段连进来',
      from: [second, third],
      click: first,
      expected: [first, second, third],
    },
    {
      name: '点选区开头的段去掉它',
      from: [first, second, third],
      click: first,
      expected: [second, third],
    },
    { name: '点选区结尾的段去掉它', from: [second, third], click: third, expected: [second] },
    { name: '只选了一段时再点它就不选了', from: [second], click: second, expected: [] },
    { name: '点不相邻的段从那段重新选', from: [first, second], click: fifth, expected: [fifth] },
  ])('$name', ({ from, click, expected }) => {
    expect(clickSelect(segments, from, click)).toEqual(expected)
  })

  it('占位点不动，也连不进选区', () => {
    const draft = storedPending(segments, [second, third], 'e1')
    const pending = draft[1]?.id ?? ''
    expect(clickSelect(draft, [first], pending)).toEqual([first])
  })

  it('左右键挪到相邻的段只选它；Shift 以另一端为锚点扩展、收缩', () => {
    expect(stepSelect(segments, [second], second, 1, false)).toEqual({
      focus: third,
      selection: [third],
    })
    const grown = stepSelect(segments, [second], second, 1, true)
    expect(grown).toEqual({ focus: third, selection: [second, third] })
    expect(stepSelect(segments, grown.selection, third, -1, true)).toEqual({
      focus: second,
      selection: [second],
    })
    // 到头不动。
    expect(stepSelect(segments, [first], first, -1, false)).toEqual({
      focus: first,
      selection: [first],
    })
  })
})

describe('裁剪', () => {
  it('只在原有范围里收缩，最短 0.2 秒；本来不足 0.2 秒的只能拉长', () => {
    const draft = keyframeSegments(V, { keyframes: [0, 3, 3.1], duration: 6 })
    const long = draft[0]?.id ?? ''
    const trimmed = trimClip(draft, long, 'end', 1.234)
    expect(clips(trimmed.draft)[0]).toEqual([V, 0, 1.234])
    expect(trimmed.selection).toEqual([trimmed.draft[0]?.id])
    // 拉回去不能超过它当初的终点；收得太狠停在最短时长。
    const back = trimClip(trimmed.draft, trimmed.selection[0] ?? '', 'end', 9)
    expect(clips(back.draft)[0]).toEqual([V, 0, 3])
    expect(clips(trimClip(draft, long, 'start', 2.95).draft)[0]).toEqual([V, 2.8, 3])
    // 0.1 秒的那段缩不了。
    const short = draft[1]?.id ?? ''
    expect(clips(trimClip(draft, short, 'start', 3.05).draft)[1]).toEqual([V, 3, 3.1])
  })

  it('1 秒的关键帧段也能裁，最短裁到 0.2 秒；裁回原样就等于没改', () => {
    const trimmed = trimClip(segments, seg(1).id, 'end', 1.5)
    expect(clips(trimmed.draft)[1]).toEqual([V, 1, 1.5])
    expect(isUnchanged(trimmed.draft, segments)).toBe(false)
    expect(clips(trimClip(segments, seg(1).id, 'end', 1.05).draft)[1]).toEqual([V, 1, 1.2])
    const restored = trimClip(trimmed.draft, trimmed.selection[0] ?? '', 'end', 2)
    expect(isUnchanged(restored.draft, segments)).toBe(true)
  })
})

describe('调序、拆分、删除', () => {
  it('挪到某一项之前，选中跟着走', () => {
    const moved = moveItems(segments, [seg(4).id, seg(5).id], 1)
    expect(clips(moved.draft).map(([, start]) => start)).toEqual([0, 4, 5, 1, 2, 3])
    expect(moved.selection).toEqual([seg(4).id, seg(5).id])
    expect(ids(moveItems(segments, [seg(0).id], 6).draft).at(-1)).toBe(seg(0).id)
  })

  it('占位挪不动', () => {
    const draft = storedPending(segments, [seg(1).id], 'e1')
    expect(moveItems(draft, [draft[1]?.id ?? ''], 0).draft).toBe(draft)
  })

  it('在播放头处一分为二，两半的原有范围以拆点为界', () => {
    const split = splitAt(segments, 2.4)
    expect(split === undefined ? [] : clips(split.draft)).toEqual([
      [V, 0, 1],
      [V, 1, 2],
      [V, 2, 2.4],
      [V, 2.4, 3],
      [V, 3, 4],
      [V, 4, 5],
      [V, 5, 6],
    ])
    const left = split?.draft[2]
    // 左半拉不过拆点，不会盖住右半的内容。
    expect(left?.kind === 'clip' ? left.origin : undefined).toEqual({ start: 2, end: 2.4 })
    const stretched = trimClip(split?.draft ?? [], left?.id ?? '', 'end', 3)
    expect(clips(stretched.draft)[2]).toEqual([V, 2, 2.4])
  })

  it('播放头在段的边上、贴着边或落在占位上时不拆', () => {
    expect(canSplitAt(segments, 2)).toBe(false)
    expect(canSplitAt(segments, 2.05)).toBe(false)
    expect(canSplitAt(storedPending(segments, [seg(2).id], 'e1'), 2.5)).toBe(false)
  })

  it('删掉选中的段，后面的跟上，总长变短；删光不行', () => {
    const removed = removeItems(segments, [seg(1).id, seg(2).id])
    expect(draftDuration(removed.draft)).toBe(4)
    expect(removed.selection).toEqual([])
    expect(canRemove(segments, ids(segments))).toBe(false)
  })
})

describe('提交后的选区分组', () => {
  it('连续同来源的多段归成一段，保留原片画面与选中', () => {
    const grouped = mergeSelection(segments, [seg(1).id, seg(2).id])
    expect(clips(grouped.draft)).toEqual([
      [V, 0, 1],
      [V, 1, 3],
      [V, 3, 4],
      [V, 4, 5],
      [V, 5, 6],
    ])
    expect(grouped.selection).toEqual([`${V}@1-3`])
    expect(isUnchanged(grouped.draft, segments)).toBe(true)
    expect(compositeSegments(grouped.draft)).toHaveLength(5)
  })

  it('只选一段不改内容或选区，非连续与不同来源的段不合并', () => {
    const single = [seg(1).id]
    expect(mergeSelection(segments, single)).toEqual({ draft: segments, selection: single })
    const reordered = [seg(1), seg(0)]
    expect(mergeSelection(reordered, ids(reordered)).draft).toBe(reordered)
    const mixed = [seg(0), clipItem({ sourceJobId: 'edit', start: 1, end: 2 })]
    expect(mergeSelection(mixed, ids(mixed)).draft).toBe(mixed)
    expect(isUnchanged(reordered, segments.slice(0, 2))).toBe(false)
  })
})

describe('已有存储中的占位', () => {
  const draft = storedPending(segments, [seg(1).id, seg(2).id], 'e1')

  it('保存过的占位保留被换下的段，继续等待结果', () => {
    expect(clips(draft)).toEqual([
      [V, 0, 1],
      ['pending', 'e1', 2],
      [V, 3, 4],
      [V, 4, 5],
      [V, 5, 6],
    ])
    expect(compositeSegments(draft)).toBeUndefined()
    expect(canRemove(draft, [draft[1]?.id ?? ''])).toBe(false)
  })

  it.each<[string, EditOutcome | undefined, unknown[]]>([
    ['完成后换成那条编辑段整条', { kind: 'done', duration: 3.0004 }, ['e1', 0, 3]],
    ['还在跑原样锁着', { kind: 'running' }, ['pending', 'e1', 2]],
    ['列表里还没有那条记录也锁着', undefined, ['pending', 'e1', 2]],
  ])('%s', (_name, outcome, expected) => {
    const settled = resolveHistory(startHistory(draft), () => outcome)
    expect(clips(settled.history.present.draft)[1]).toEqual(expected)
  })

  it('失败换回原来的段，并说出原因', () => {
    const settled = resolveHistory(startHistory(draft), () => ({ kind: 'failed', message: '超时' }))
    expect(ids(settled.history.present.draft)).toEqual(ids(segments))
    expect(settled.failures).toEqual(['超时'])
  })

  it('撤销栈里每一步都落定，没东西可落定时原样返回', () => {
    const history = commit(startHistory(draft), {
      draft: removeItems(draft, [seg(0).id]).draft,
      selection: [],
    })
    const settled = resolveHistory(history, () => ({ kind: 'done', duration: 2 }))
    expect(clips(settled.history.present.draft)[0]).toEqual(['e1', 0, 2])
    expect(clips(undo(settled.history).present.draft)[1]).toEqual(['e1', 0, 2])
    expect(resolveHistory(settled.history, () => undefined).history).toBe(settled.history)
  })
})

describe('撤销栈', () => {
  it('编辑进栈，撤销连同当时的选中一起回去，重做再来；新编辑清掉重做', () => {
    const start = {
      ...startHistory(segments),
      present: { draft: segments, selection: [seg(1).id] },
    }
    const removed = commit(start, removeItems(segments, [seg(1).id]))
    const back = undo(removed)
    expect(back.present).toEqual({ draft: segments, selection: [seg(1).id] })
    expect(redo(back).present.draft).toBe(removed.present.draft)
    expect(commit(back, { draft: segments.slice(2), selection: [] }).future).toEqual([])
    expect(undo(startHistory(segments)).present.draft).toBe(segments)
  })
})

describe('初次打开时组织原片区间', () => {
  const edit = (id: string, startMs: number, endMs: number, createdAt: string, failed = false) => ({
    id,
    rangeStartMs: startMs,
    rangeEndMs: endMs,
    createdAt: `2026-09-15T${createdAt}Z`,
    failed,
  })

  it('重叠时最新成功或在途区间优先，只组织原片，不自动采用生成结果', () => {
    const draft = rebuildDraft(segments, [
      edit('old', 1000, 3000, '10:00:00'),
      edit('new', 2000, 4000, '10:05:00'),
      edit('apart', 5000, 6000, '10:01:00'),
      edit('broken', 0, 1000, '10:06:00', true),
      edit('off-grid', 0, 1500, '10:07:00'),
    ])
    expect(clips(draft)).toEqual([
      [V, 0, 1.5],
      [V, 1.5, 2],
      [V, 2, 4],
      [V, 4, 5],
      [V, 5, 6],
    ])
    expect(isUnchanged(draft, segments)).toBe(true)
  })

  it('同一段再生成过，仍使用原片 V1', () => {
    const draft = rebuildDraft(segments, [
      edit('first', 1000, 2000, '10:00:00'),
      edit('again', 1000, 2000, '10:03:00'),
    ])
    expect(clips(draft)[1]).toEqual([V, 1, 2])
  })

  it('仅失败的重叠区间不覆盖已经成功的区间', () => {
    const draft = rebuildDraft(segments, [
      edit('done', 1000, 3000, '10:00:00'),
      edit('failed-later', 2000, 4000, '10:05:00', true),
    ])
    expect(clips(draft)[1]).toEqual([V, 1, 3])
    expect(isUnchanged(draft, segments)).toBe(true)
  })

  it('区间不必命中关键帧，扩大区间覆盖旧分组但原片只出现一次', () => {
    const draft = rebuildDraft(segments, [
      edit('small', 1250, 2500, '10:00:00'),
      edit('wide', 1250, 4250, '10:05:00'),
      edit('adjacent', 4250, 5500, '10:06:00'),
      edit('outside', 5500, 6500, '10:07:00'),
    ])
    expect(clips(draft)).toEqual([
      [V, 0, 1],
      [V, 1, 1.25],
      [V, 1.25, 4.25],
      [V, 4.25, 5.5],
      [V, 5.5, 6],
    ])
    expect(draftDuration(draft)).toBe(6)
    expect(isUnchanged(draft, segments)).toBe(true)
  })
})

describe('存放', () => {
  it('写进去再读出来是同一份：拆过的段带着原有范围，占位带着被换下的段与等的那次合成', () => {
    const split = splitAt(segments, 0.6)?.draft ?? []
    const draft = storedPending(split, [seg(2).id], 'e1')
    expect(draft[0]?.kind === 'clip' ? draft[0].origin : undefined).toEqual({ start: 0, end: 0.6 })
    const raw = serializeDraft({ draft, composite: 'm1' })
    expect(parseStoredDraft(raw)).toEqual({ draft, composite: 'm1' })
  })

  it.each([
    ['不是 JSON', '{'],
    ['格式版本不对', JSON.stringify({ version: 0, items: [] })],
    ['空草稿', JSON.stringify({ version: 1, items: [] })],
    [
      '起止越出原有范围',
      JSON.stringify({ version: 1, items: [{ sourceJobId: V, start: 0, end: 2, origin: [0, 1] }] }),
    ],
  ])('%s读不出来', (_name, raw) => {
    expect(parseStoredDraft(raw)).toBeUndefined()
  })
})
