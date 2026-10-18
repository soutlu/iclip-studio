import { expect, it } from 'vitest'
import { contextOf, draftOf, video } from '@/testing/whole-film'
import { redo, startHistory, undo } from '../../editing/edit-history'
import { commitEdit } from './history'
import { setClipVolume, splitClip } from './layer0'

const film = () => draftOf([video('v1', 's1', 0, 3_000)])
const context = contextOf({})

it('每次编辑记一步，可撤销、重做', () => {
  const start = startHistory(film())
  const once = commitEdit(start, splitClip(start.present, { timeMs: 1_000 }, context))
  const twice = commitEdit(once, setClipVolume(once.present, { clipId: 'v1', volume: 0 }))
  expect(twice.past).toHaveLength(2)
  expect(undo(twice).present).toEqual(once.present)
  expect(undo(undo(twice)).present).toEqual(start.present)
  expect(redo(undo(twice)).present).toEqual(twice.present)
})

it('被拒的编辑、没有改动的编辑（包括内容相同的新对象）不进历史', () => {
  const start = startHistory(film())
  expect(commitEdit(start, splitClip(start.present, { timeMs: 50 }, context))).toBe(start)
  expect(commitEdit(start, setClipVolume(start.present, { clipId: 'v1', volume: 1 }))).toBe(start)
  expect(commitEdit(start, { ok: true, draft: structuredClone(start.present) })).toBe(start)
  const { canvas, layer0, transitions, captions, music, overlays } = start.present
  const keysReordered = { overlays, music, captions, transitions, layer0, canvas }
  expect(commitEdit(start, { ok: true, draft: keysReordered })).toBe(start)
})
