import { describe, expect, it } from 'vitest'
import { workspacePathOf } from './workspace-path'

describe('workspacePathOf', () => {
  it.each([
    ['video_shot.json', 'video_shot.json'],
    ['/shots//a.md', 'shots/a.md'],
    ['分镜/第一集.md', '分镜/第一集.md'],
    // 组合字符归一成 NFC，与服务端存的键一致。
    ['café.md', 'café.md'],
  ])('%s → %s', (raw, expected) => {
    expect(workspacePathOf(raw)).toBe(expected)
  })

  it.each(['', '/', 'shots/', 'a/../b.md', './a.md', 'a\\b.md', 'a\tb.md'])(
    '%j 不是一份文件',
    (raw) => {
      expect(workspacePathOf(raw)).toBeUndefined()
    },
  )
})
