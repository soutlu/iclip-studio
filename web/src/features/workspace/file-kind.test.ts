import { describe, expect, it } from 'vitest'
import { fileIconOf, formatBytes, formatWhen, groupByDirectory, splitFileName } from './file-kind'

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

describe('splitFileName', () => {
  it.each([
    ['video_shot.json', 'video_', 'shot.json'],
    ['extraction.final.json', 'extraction.f', 'inal.json'],
    ['abcde.md', 'a', 'bcde.md'],
  ])('%s 拆成可截的开头与固定的末 4 字加扩展名', (name, head, tail) => {
    expect(splitFileName(name)).toEqual({ head, tail })
  })

  it.each(['README', '.gitignore', 'shot.json', 'a.md'])(
    '%s 没有扩展名或主名不超过 4 字，不拆，整名按末尾截断',
    (name) => {
      expect(splitFileName(name)).toEqual({ head: name, tail: '' })
    },
  )
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

describe('fileIconOf', () => {
  it.each([
    ['storyboard.md', 'file'],
    ['frames/extraction.JSON', 'file-json'],
    ['口播文案.txt', 'file-plain'],
    ['frames/a.png', 'file-image'],
    ['clips/x.mp4', 'file-video'],
    ['data/table.csv', 'file-other'],
    ['LICENSE', 'file-other'],
  ])('%s 用 %s', (path, icon) => {
    expect(fileIconOf(path)).toBe(icon)
  })
})
