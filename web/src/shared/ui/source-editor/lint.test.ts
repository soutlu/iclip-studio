import { describe, expect, it } from 'vitest'
import { jsonProblems, markdownProblems } from './lint'

const marked = (text: string, problems: ReturnType<typeof markdownProblems>) =>
  problems.map(({ from, message, to }) => ({ message, text: text.slice(from, to) }))

describe('markdownProblems', () => {
  it('干净的原文（含表格、链接、代码、加粗）一条不报', () => {
    const text = [
      '# 照参考片做新视频',
      '',
      '| 镜号 | 景别 | 时长 |',
      '| --- | --- | --- |',
      '| 1 | 特写 | 2 秒 |',
      '',
      '**画面**：第一行，见 [参考片](https://example.com) 与 `shot.json`。',
      '',
      '- 很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的一行',
    ].join('\n')
    expect(markdownProblems(text)).toEqual([])
  })

  it.each([
    [
      '表格列数少了一列，标整行',
      '| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |',
      '| 1 | 2 |',
      '表格本行有 2 列，与表头的 3 列不一致',
    ],
    [
      '表格首尾竖线与其他行不一致',
      '| a | b |\n| --- | --- |\n| 1 | 2',
      '2',
      '表格本行首尾竖线的写法与其他行不一致',
    ],
    ['链接地址为空', '见 [参考片]() 的说明', '[参考片]()', '链接地址为空'],
    [
      '链接括号写反',
      '见 (参考片)[https://example.com] 的说明',
      '(参考片)[https://example.com]',
      '链接的方括号与圆括号顺序颠倒，应写作 [文字](地址)',
    ],
    [
      '行内代码反引号内侧有空格',
      '运行 `npm run build ` 即可',
      '`npm run build `',
      '行内代码的反引号内侧有空格',
    ],
    [
      '链接文字首尾有空格',
      '见 [ 参考片 ](https://example.com)',
      '[ 参考片 ]',
      '链接文字首尾有空格',
    ],
  ])('%s', (_case, text, mark, message) => {
    expect(marked(text, markdownProblems(text))).toEqual([{ message, text: mark }])
  })

  it('加粗符号内侧有空格：两侧各标出写错的那段', () => {
    const text = '这句话里的 ** 加粗 ** 不会生效'
    expect(marked(text, markdownProblems(text))).toEqual([
      { message: '加粗或斜体符号内侧有空格，无法生效', text: '** 加' },
      { message: '加粗或斜体符号内侧有空格，无法生效', text: '粗 **' },
    ])
  })

  it('位置按全文算：前面有别的行时落在对应行', () => {
    const text = '# 标题\n\n正文\n\n[空链接]()'
    const [problem] = markdownProblems(text)
    expect(problem?.from).toBe(text.indexOf('[空链接]()'))
  })
})

describe('jsonProblems', () => {
  it.each([
    ['合法 JSON', '{\n  "shots": [1, 2]\n}'],
    ['还没写内容', '  \n'],
  ])('%s：不报', (_case, text) => {
    expect(jsonProblems(text)).toEqual([])
  })

  it.each([
    ['少了逗号', '{"a": 1 "b": 2}', '"b"', '此处缺少逗号或结束括号'],
    ['数组少了逗号', '[1 2]', '2', '此处缺少逗号或结束括号'],
    ['末尾多一个逗号', '{"a": 1,}', '}', '属性名未使用双引号，或此前多一个逗号'],
    ['字符串没闭合', '{"a": "abc', '"abc', '字符串缺少结束引号'],
    ['内容没写完', '{"a":', ':', '内容不完整，缺少结束括号'],
    [
      '字符串里直接换行',
      '{"a": "第一行\n第二行"}',
      '第二行"',
      '字符串中含有未转义的换行或控制字符',
    ],
    ['单引号属性名', "{'a': 1}", "'a'", '格式错误，此处含有无效字符'],
    ['对象后面还有内容', '{"a": 1} 多余', '多余', '格式错误，此处含有无效字符'],
  ])('%s', (_case, text, mark, message) => {
    const problems = jsonProblems(text)
    expect(marked(text, problems)).toEqual([{ message, text: mark }])
    for (const { from, to } of problems) expect(to).toBeGreaterThan(from)
  })

  it('末尾少了右括号：标出最后一个词，不是零宽', () => {
    const text = '{"a": 1'
    expect(marked(text, jsonProblems(text))).toEqual([
      { message: '此处缺少逗号或结束括号', text: '1' },
    ])
  })
})
