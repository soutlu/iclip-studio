import { describe, expect, it } from 'vitest'
import {
  approvalParams,
  isAsciiIdentifier,
  mcpServerIdOf,
  paramImages,
  paramRows,
} from './approval-params'

describe('approvalParams', () => {
  it('对象原样用，JSON 字符串先解析', () => {
    expect(approvalParams({ id: 'r1' })).toEqual({ id: 'r1' })
    expect(approvalParams('{"id":"r1","n":2}')).toEqual({ id: 'r1', n: 2 })
  })

  it.each([
    ['解析不出 JSON 的字符串', 'not json'],
    ['JSON 数组', '[1,2]'],
    ['空对象', {}],
    ['空值', undefined],
  ])('%s 不算参数', (_label, input) => {
    expect(approvalParams(input)).toBeUndefined()
  })
})

describe('paramRows', () => {
  it('嵌套键用「.」连接，数组元素从 1 标序号，只有一个元素时不标，空值不列', () => {
    const rows = paramRows({
      title: '首帧对比',
      size: 50,
      random: true,
      note: null,
      empty: '',
      filters: { region: '华东', tags: ['透气', '易打理'] },
      questions: [{ type: 'ranked', options: [{ label: 'A' }, { label: 'B' }] }],
    })

    expect(rows).toEqual([
      { key: 'title', numeric: false, value: '首帧对比' },
      { key: 'size', numeric: true, value: '50' },
      { key: 'random', numeric: true, value: 'true' },
      { key: 'filters.region', numeric: false, value: '华东' },
      { key: 'filters.tags[1]', numeric: false, value: '透气' },
      { key: 'filters.tags[2]', numeric: false, value: '易打理' },
      { key: 'questions.type', numeric: false, value: 'ranked' },
      { key: 'questions.options[1].label', numeric: false, value: 'A' },
      { key: 'questions.options[2].label', numeric: false, value: 'B' },
    ])
  })
})

describe('paramImages', () => {
  it('任意层级的 http/https 图片地址按出现顺序去重，可带查询串', () => {
    expect(
      paramImages({
        cover: 'https://cdn.example.com/a.png',
        options: [
          { image: 'http://cdn.example.com/b.JPG?w=320' },
          { image: 'https://cdn.example.com/a.png' },
        ],
        page: 'https://cdn.example.com/a.png.html',
        local: 'file:///tmp/c.png',
        video: 'https://cdn.example.com/d.mp4',
      }),
    ).toEqual(['https://cdn.example.com/a.png', 'http://cdn.example.com/b.JPG?w=320'])
  })

  it('最多 4 张', () => {
    const urls = ['a', 'b', 'c', 'd', 'e'].map((name) => `https://cdn.example.com/${name}.webp`)
    expect(paramImages({ urls })).toEqual(urls.slice(0, 4))
  })
})

describe('isAsciiIdentifier', () => {
  it.each([
    ['rpt_7f3c91a2', true],
    ['v1.2-beta', true],
    ['summer linen', false],
    ['首帧对比', false],
    ['', false],
  ])('%s → %s', (text, expected) => {
    expect(isAsciiIdentifier(text)).toBe(expected)
  })
})

describe('mcpServerIdOf', () => {
  it('取 mcp_<服务标识>_<工具名> 里的服务标识；不是 MCP 工具时没有', () => {
    expect(mcpServerIdOf('mcp_user-insights_search_interviews')).toBe('user-insights')
    expect(mcpServerIdOf('write_file')).toBeUndefined()
  })
})
