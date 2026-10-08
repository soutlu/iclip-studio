import { describe, expect, it } from 'vitest'
import { taskCellOf } from './task-cell'

const PREVIEW = { title: '夏季上新', requirement: '用自然光展示亚麻衬衫的质感', imageUrl: null }

describe('taskCellOf', () => {
  it('没关联需求单时说未关联，不看读取状态', () => {
    expect(taskCellOf(null, undefined, '候选名', 'error')).toBe('未关联')
  })

  it('预览到了就用预览的标题', () => {
    expect(taskCellOf('t1', PREVIEW, '候选名', 'ready')).toBe(PREVIEW.title)
  })

  it.each([
    { state: 'loading', text: '正在读取需求单…' },
    { state: 'error', text: '需求单信息暂不可用' },
    { state: 'forbidden', text: '当前账号没有查看需求单权限' },
    { state: 'ready', text: '需求单暂不可用' },
  ] as const)('预览没到时按 $state 说话，能用候选标题顶一下', ({ state, text }) => {
    expect(taskCellOf('t1', undefined, undefined, state)).toBe(text)
    expect(taskCellOf('t1', undefined, '候选名', state)).toBe('候选名')
  })
})
