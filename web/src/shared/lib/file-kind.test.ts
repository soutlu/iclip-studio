import { describe, expect, it } from 'vitest'
import { fileKindOf } from './file-kind'

describe('fileKindOf', () => {
  it('按后缀选渲染器族，类型字样就是后缀本身', () => {
    expect(fileKindOf('video/a-1b2c.md')).toMatchObject({ kind: 'markdown', label: 'MD' })
    expect(fileKindOf('anchors/x.JSON')).toMatchObject({ kind: 'json', label: 'JSON' })
    expect(fileKindOf('notes/todo.txt')).toMatchObject({ kind: 'text', label: 'TXT' })
    expect(fileKindOf('data/table.csv')).toMatchObject({ kind: 'text', label: 'CSV' })
  })

  it('没有后缀的文件叫文本；内容以 { 或 [ 开头就按 JSON 排', () => {
    expect(fileKindOf('LICENSE')).toMatchObject({ kind: 'text', label: '文本' })
    expect(fileKindOf('manifest', '  {"a": 1}')).toMatchObject({ kind: 'json', label: '文本' })
    expect(fileKindOf('.env', 'KEY=1')).toMatchObject({ kind: 'text' })
  })
})
