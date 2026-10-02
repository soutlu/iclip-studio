import { describe, expect, it } from 'vitest'
import type { ToolCallFrame } from '@/shared/transcript/vendor'
import {
  diffLinesOf,
  fileChangeOf,
  fileTextOf,
  toolBodyText,
  toolCard,
  toolMedia,
  toolOutcome,
  toolPanel,
  toolSearchCount,
} from './tool-display'

const toolFrame = (fields: Partial<ToolCallFrame>): ToolCallFrame => ({
  frameId: 'f1',
  kind: 'tool',
  name: 'generate_shot_frames',
  state: 'done',
  toolCallId: 'call_1',
  ...fields,
})

const MEDIA = { items: [{ caption: 'S01', url: 'https://example.com/a.png' }] }

describe('toolCard', () => {
  it.each([
    ['read', '读取文件', 'file'],
    ['write', '写入文件', 'file'],
    ['edit', '编辑文件', 'edit'],
  ] as const)(
    '文件操作 %s：标题「%s」，主语只写文件名，另给规范化后的工作区路径',
    (operation, label, icon) => {
      expect(toolCard({ kind: 'file_io', operation, path: '/shots//a.md' })).toEqual({
        detail: 'a.md',
        file: 'shots/a.md',
        icon,
        label,
        operation,
      })
    },
  )

  it.each([
    ['glob', '浏览目录', 'folder'],
    ['grep', '搜索内容', 'search'],
  ] as const)(
    '文件操作 %s 不作用在一份文件上：主语照给，没有可打开的文件',
    (operation, label, icon) => {
      expect(toolCard({ kind: 'file_io', operation, path: 'shots/' })).toEqual({
        detail: 'shots/',
        icon,
        label,
        operation,
      })
    },
  )

  it('路径换不成工作区文件（目录、带 ..）：只写文件名，不给可打开的文件', () => {
    expect(toolCard({ kind: 'file_io', operation: 'read', path: 'shots/../a.md' })).toEqual({
      detail: 'a.md',
      icon: 'file',
      label: '读取文件',
      operation: 'read',
    })
    expect(toolCard({ kind: 'file_io', operation: 'write', path: 'shots/' })).not.toHaveProperty(
      'file',
    )
  })

  it('检索：标题「搜索工作区」，主语是那个词，聚合时按搜索归类', () => {
    expect(toolCard({ kind: 'search', query: '亚麻衬衫' })).toMatchObject({
      detail: '亚麻衬衫',
      label: '搜索工作区',
      operation: 'grep',
    })
  })

  it('读取网页：只留域名与路径，查询串不上界面', () => {
    expect(
      toolCard({ kind: 'url_fetch', url: 'https://example.com/docs/a?token=secret' }),
    ).toMatchObject({ detail: 'example.com/docs/a', label: '读取网页' })
  })

  it('查阅规范：主语只写读的是哪一份文档，skill 名不上界面；没点具体哪一份就没有主语', () => {
    expect(
      toolCard({ args: '镜头节奏.md', kind: 'skill_call', skill_name: '分镜脚本' }),
    ).toMatchObject({ detail: '镜头节奏.md', label: '查阅规范' })
    expect(toolCard({ kind: 'skill_call', skill_name: '分镜脚本' })).toEqual({
      icon: 'reference',
      label: '查阅规范',
    })
  })

  it('委派任务：主语是派下去的那句话，超长截断', () => {
    const prompt = '把这段素材'.repeat(20)
    const card = toolCard({ agent_name: 'storyboard', kind: 'agent_call', prompt })

    expect(card.label).toBe('委派任务')
    expect(card.detail).toHaveLength(61)
    expect(card.detail?.endsWith('…')).toBe(true)
  })

  it('兜底卡：标题与主语分开给，服务端给 null 的主语当没有；媒体类结果用图片图标', () => {
    expect(
      toolCard({ detail: '镜头 1、2', kind: 'generic', summary: '生成画面' }, 'media_grid'),
    ).toEqual({
      detail: '镜头 1、2',
      icon: 'image',
      label: '生成画面',
    })
    expect(toolCard({ detail: null, kind: 'generic', summary: '拆解视频' })).toEqual({
      icon: 'task',
      label: '拆解视频',
    })
  })

  it('认不出的 kind 退回「调用工具」', () => {
    expect(toolCard({ kind: 'shell_exec', script: 'ls' })).toEqual({
      icon: 'task',
      label: '调用工具',
    })
  })
})

describe('fileChangeOf', () => {
  it('编辑给前后文，写入给整份内容，别的没有', () => {
    expect(
      fileChangeOf({
        after: '黄昏',
        before: '夜景',
        kind: 'file_io',
        operation: 'edit',
        path: 'a.md',
      }),
    ).toEqual({ after: '黄昏', before: '夜景', path: 'a.md' })
    expect(
      fileChangeOf({ content: '# 封面', kind: 'file_io', operation: 'write', path: 'a.md' }),
    ).toEqual({
      content: '# 封面',
      path: 'a.md',
    })
    expect(fileChangeOf({ kind: 'file_io', operation: 'read', path: 'a.md' })).toBeUndefined()
    expect(fileChangeOf({ kind: 'search', query: '夜景' })).toBeUndefined()
  })
})

describe('toolSearchCount', () => {
  it('检索：命中数，没命中也说', () => {
    const match = { file: 'a.md', line: 3, text: '夜景' }
    expect(
      toolSearchCount(
        toolFrame({
          metadata: { matches: [match, match], query: '夜景', truncated: false },
          view: 'search_results',
        }),
      ),
    ).toBe('2 处命中')
    expect(
      toolSearchCount(
        toolFrame({
          metadata: { matches: [], query: '雨', truncated: false },
          view: 'search_results',
        }),
      ),
    ).toBe('无命中')
  })

  it('行数、增删数、张数与工具自带角标都不上行尾', () => {
    const meta = { lines: 142, path: 'a.md', truncated: false }
    expect(toolSearchCount(toolFrame({ metadata: meta, view: 'file_content' }))).toBeUndefined()
    expect(toolSearchCount(toolFrame({ metadata: MEDIA, view: 'media_grid' }))).toBeUndefined()
    expect(
      toolSearchCount(toolFrame({ metadata: { added: 3, chip: '4.2 KB', removed: 1 } })),
    ).toBeUndefined()
  })
})

describe('toolOutcome', () => {
  const approval = (state: 'approved' | 'rejected') =>
    new Map([['appr_1', { interactionId: 'appr_1', interactionKind: 'approval' as const, state }]])
  const rejected = approval('rejected')

  it('协议给的三态原样用', () => {
    for (const state of ['running', 'done', 'error'] as const) {
      expect(toolOutcome(toolFrame({ state }), rejected)).toBe(state)
    }
  })

  it('error 且它的审批交互记着 rejected，是被拒绝', () => {
    expect(toolOutcome(toolFrame({ approvalId: 'appr_1', state: 'error' }), rejected)).toBe(
      'denied',
    )
  })

  it('审批没被拒绝（或查不到）的 error 仍是失败', () => {
    expect(
      toolOutcome(toolFrame({ approvalId: 'appr_1', state: 'error' }), approval('approved')),
    ).toBe('error')
    expect(toolOutcome(toolFrame({ approvalId: 'appr_1', state: 'error' }), new Map())).toBe(
      'error',
    )
  })
})

describe('fileTextOf', () => {
  it('去掉每行的行号与制表符，丢掉写给模型的续读提示', () => {
    expect(
      fileTextOf(
        '     1\t# 分镜\n     2\t\n     3\t\t缩进的行\n[还有 6 行没读，用 offset=4 接着读]',
      ),
    ).toBe('# 分镜\n\n\t缩进的行')
  })
})

describe('diffLinesOf', () => {
  it('首尾相同的行是上下文，中间旧的算删、新的算加', () => {
    expect(diffLinesOf('镜头 2\n景别：近景\n收尾', '镜头 2\n景别：中景\n运镜：横移\n收尾')).toEqual(
      [
        { kind: 'context', text: '镜头 2' },
        { kind: 'removed', text: '景别：近景' },
        { kind: 'added', text: '景别：中景' },
        { kind: 'added', text: '运镜：横移' },
        { kind: 'context', text: '收尾' },
      ],
    )
  })

  it('整段替换：全部旧行删、全部新行加', () => {
    expect(diffLinesOf('夜景', '黄昏')).toEqual([
      { kind: 'removed', text: '夜景' },
      { kind: 'added', text: '黄昏' },
    ])
  })
})

describe('toolPanel', () => {
  const read = (fields: Partial<ToolCallFrame>) =>
    toolFrame({
      display: { kind: 'file_io', operation: 'read', path: 'notes/拍摄需求.md' },
      metadata: { lines: 2, path: 'notes/拍摄需求.md', truncated: false },
      output: '     1\t# 需求\n     2\t30 秒竖屏',
      view: 'file_content',
      ...fields,
    })

  it('读文件：去掉行号的文件内容，md 按 Markdown 排', () => {
    expect(toolPanel(read({}), 'done')).toEqual({
      kind: 'file',
      markdown: true,
      text: '# 需求\n30 秒竖屏',
    })
  })

  it('写文件：要写的整份内容；不是 md 就按原文', () => {
    const frame = toolFrame({
      display: { content: '{"a":1}', kind: 'file_io', operation: 'write', path: 'a.json' },
    })
    expect(toolPanel(frame, 'done')).toEqual({ kind: 'file', markdown: false, text: '{"a":1}' })
  })

  it('编辑文件：给改动前后的片段', () => {
    const frame = toolFrame({
      display: { after: '黄昏', before: '夜景', kind: 'file_io', operation: 'edit', path: 'a.md' },
    })
    expect(toolPanel(frame, 'done')).toEqual({ after: '黄昏', before: '夜景', kind: 'diff' })
  })

  it('失败：错误原文；运行中与被拒绝没有面板', () => {
    const failed = read({ error: '运行中断，这次调用没有结果', state: 'error' })
    expect(toolPanel(failed, 'error')).toEqual({
      kind: 'error',
      text: '运行中断，这次调用没有结果',
    })
    expect(toolPanel(read({ state: 'running' }), 'running')).toBeUndefined()
    expect(toolPanel(failed, 'denied')).toBeUndefined()
  })

  it('检索：有命中才有面板', () => {
    const match = { file: 'a.md', line: 3, text: '夜景' }
    const search = (matches: (typeof match)[]) =>
      toolFrame({ metadata: { matches, query: '夜景', truncated: false }, view: 'search_results' })
    expect(toolPanel(search([match]), 'done')).toEqual({
      kind: 'matches',
      matches: [match],
      truncated: false,
    })
    expect(toolPanel(search([]), 'done')).toBeUndefined()
  })

  it('其余工具：多行结果给原文，一句话的结果没有面板', () => {
    expect(toolPanel(toolFrame({ output: 'a\nb' }), 'done')).toEqual({ kind: 'text', text: 'a\nb' })
    expect(toolPanel(toolFrame({ output: '完成' }), 'done')).toBeUndefined()
  })
})

describe('toolMedia', () => {
  it('渲染器是媒体墙、调用跑完了、形状对得上，才给出这一排图', () => {
    expect(toolMedia(toolFrame({ metadata: MEDIA, view: 'media_grid' }))).toEqual(MEDIA.items)
  })

  it('还在跑的时候不画图', () => {
    expect(toolMedia(toolFrame({ metadata: MEDIA, state: 'running', view: 'media_grid' }))).toEqual(
      [],
    )
  })

  it('没点媒体墙这个渲染器就不画图', () => {
    expect(toolMedia(toolFrame({ metadata: MEDIA }))).toEqual([])
  })

  it('形状对不上就当一张都没有', () => {
    expect(toolMedia(toolFrame({ metadata: { items: 'a.png' }, view: 'media_grid' }))).toEqual([])
  })
})

describe('toolBodyText', () => {
  it('多行字符串结果能展开；一句话的结果卡头已经说完，不展开', () => {
    expect(toolBodyText(toolFrame({ output: 'a.md\t12 字节\nb.md\t3 字节' }))).toBe(
      'a.md\t12 字节\nb.md\t3 字节',
    )
    expect(toolBodyText(toolFrame({ output: '已写入 a.md（12 字节）' }))).toBeUndefined()
    expect(toolBodyText(toolFrame({ output: { message: '完成' } }))).toBeUndefined()
  })

  it('工具声明正文不给看，就算多行也不展开', () => {
    expect(
      toolBodyText(toolFrame({ metadata: { body: 'none' }, output: '# 规范\n\n第一条…' })),
    ).toBeUndefined()
  })
})
