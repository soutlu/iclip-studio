import { describe, expect, it } from 'vitest'
import { fileKindOf } from './file-kind'

describe('fileKindOf', () => {
  it('按后缀选渲染器族，后缀不分大小写', () => {
    expect(fileKindOf('video/a-1b2c.md')).toBe('markdown')
    expect(fileKindOf('anchors/x.JSON')).toBe('json')
    expect(fileKindOf('notes/todo.txt')).toBe('text')
    expect(fileKindOf('data/table.csv')).toBe('text')
  })

  it('没有后缀的文件按文本；内容以 { 或 [ 开头就按 JSON 排', () => {
    expect(fileKindOf('LICENSE')).toBe('text')
    expect(fileKindOf('manifest', '  {"a": 1}')).toBe('json')
    expect(fileKindOf('.env', 'KEY=1')).toBe('text')
  })
})
