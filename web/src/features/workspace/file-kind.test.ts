import { describe, expect, it } from 'vitest'
import { formatBytes, formatWhen, groupByDirectory } from './file-kind'

describe('groupByDirectory', () => {
  it('根目录在前，其余目录按路径排，同目录内按文件名排', () => {
    const groups = groupByDirectory([
      { path: 'video/b.md' },
      { path: 'frames/grids/z.json' },
      { path: 'video_shot.json' },
      { path: 'frames/extraction.json' },
      { path: 'video/a.md' },
      { path: 'storyboard.md' },
    ])

    expect(groups.map((group) => [group.dir, group.files.map((file) => file.path)])).toEqual([
      ['', ['storyboard.md', 'video_shot.json']],
      ['frames', ['frames/extraction.json']],
      ['frames/grids', ['frames/grids/z.json']],
      ['video', ['video/a.md', 'video/b.md']],
    ])
  })
})

describe('格式化', () => {
  it('大小按 B / KB / MB 给一位小数', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(4577)).toBe('4.5 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })

  it('当天只给时分，往前的日子带月日，无效时间给空串', () => {
    const now = new Date(2026, 8, 5, 20, 0)
    expect(formatWhen(new Date(2026, 8, 5, 12, 40).toISOString(), now)).toBe('12:40')
    expect(formatWhen(new Date(2026, 8, 1, 9, 5).toISOString(), now)).toBe('9月1日 09:05')
    expect(formatWhen('not-a-date', now)).toBe('')
  })
})
