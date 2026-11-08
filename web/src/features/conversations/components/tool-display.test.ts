import { describe, expect, it } from 'vitest'
import { toolCard } from './tool-display'

describe('toolCard', () => {
  it('路径换不成工作区文件（目录、带 ..）：只写文件名，不给可打开的文件', () => {
    expect(
      toolCard({ kind: 'file_io', operation: 'read', path: 'shots/../a.md' }),
    ).not.toHaveProperty('file')
    expect(toolCard({ kind: 'file_io', operation: 'write', path: 'shots/' })).not.toHaveProperty(
      'file',
    )
  })

  it('兜底卡的主语超过 60 字截断加省略号', () => {
    const ref = `kb1.${'x'.repeat(120)}`
    expect(toolCard({ kind: 'generic', summary: '知识库', detail: ref }).detail).toBe(
      `${ref.slice(0, 60)}…`,
    )
  })

  it('读取网页：只留域名与路径，查询串不上界面', () => {
    expect(
      toolCard({ kind: 'url_fetch', url: 'https://example.com/docs/a?token=secret' }).detail,
    ).toBe('example.com/docs/a')
  })
})
