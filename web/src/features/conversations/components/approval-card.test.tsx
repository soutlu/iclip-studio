import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpConnectionsScope } from '@/shared/mcp-connections'
import type { InteractionState, ToolCallFrame } from '@/shared/transcript/vendor'
import { DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { stubIntersectionObserver } from '@/testing/intersection-observer'
import { setMockMcpConnections } from '@/testing/mocks/mcp-connections'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import type { ApprovalItem } from './approval-batch'
import { ApprovalCard } from './approval-card'

function recordDecisions() {
  const decisions: { interactionId: string; approved: boolean }[] = []
  server.use(
    http.post('*/api/conversations/c1/interactions/:interactionId', async ({ params, request }) => {
      decisions.push({
        approved: ((await request.json()) as { approved: boolean }).approved,
        interactionId: String(params['interactionId']),
      })
      return new HttpResponse(null, { status: 204 })
    }),
  )
  return decisions
}

const mcpItem = (
  interactionId: string,
  title: string,
  input: unknown,
  state: InteractionState = 'pending',
): ApprovalItem => ({
  frame: {
    approvalId: interactionId,
    display: { detail: 'rpt_7f3c91a2', kind: 'generic', summary: `用户洞察 · ${title}` },
    frameId: `f_${interactionId}`,
    input,
    kind: 'tool',
    name: 'mcp_user-insights_publish_report',
    state: 'running',
    toolCallId: `call_${interactionId}`,
  },
  interactionId,
  state,
})

const fileItem = (display: Record<string, unknown>): ApprovalItem => ({
  frame: {
    approvalId: 'i1',
    display: { kind: 'file_io', ...display },
    frameId: 't1.1.f1',
    input: { path: 'a.md' },
    kind: 'tool',
    name: 'write_file',
    state: 'running',
    toolCallId: 'call_1',
  } satisfies ToolCallFrame,
  interactionId: 'i1',
  state: 'pending',
})

const unknownItem: ApprovalItem = { frame: undefined, interactionId: 'i1', state: 'pending' }

type CardOptions = { readOnly?: boolean; connections?: McpConnectionsScope }

const card = (items: readonly ApprovalItem[], options: CardOptions = {}) => (
  <ApprovalCard
    connections={options.connections}
    conversationId="c1"
    items={items}
    onRefresh={() => {}}
    readOnly={options.readOnly ?? false}
  />
)

let viewport: ReturnType<typeof stubIntersectionObserver>

beforeEach(() => {
  viewport = stubIntersectionObserver({ inRange: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ApprovalCard 数字快捷键', () => {
  it('卡片在可视范围内时按 1 即同意', async () => {
    const decisions = recordDecisions()
    await renderWithProviders(card([unknownItem]))

    await userEvent.keyboard('1')

    expect(await screen.findByText('已同意')).toBeVisible()
    expect(decisions).toEqual([{ approved: true, interactionId: 'i1' }])
  })

  it('卡片被滚出可视范围时数字键不替看不见的审批做决定', async () => {
    const decisions = recordDecisions()
    await renderWithProviders(card([unknownItem]))
    await viewport.scroll(false)

    await userEvent.keyboard('12')

    expect(decisions).toEqual([])
    expect(screen.getByRole('button', { name: '同意' })).toBeEnabled()
  })

  it('弹窗盖着卡片时数字键是打给弹窗的，不替看不见的审批做决定', async () => {
    const decisions = recordDecisions()
    await renderWithProviders(
      <>
        {card([unknownItem])}
        <DialogRoot open>
          <DialogSurface aria-describedby={undefined}>
            <DialogHeader closeLabel="关闭" title="编辑图片" />
          </DialogSurface>
        </DialogRoot>
      </>,
    )
    await screen.findByRole('dialog', { name: '编辑图片' })

    await userEvent.keyboard('12')

    expect(decisions).toEqual([])
    expect(screen.getByRole('button', { hidden: true, name: '同意' })).toBeEnabled()
  })

  it('一批里数字键只作用于当前页签那一项', async () => {
    const decisions = recordDecisions()
    await renderWithProviders(
      card([mcpItem('a1', '追加样本', { n: 1 }), mcpItem('a2', '检索访谈', { n: 2 })]),
    )
    await userEvent.click(screen.getByRole('tab', { name: /检索访谈/ }))

    await userEvent.keyboard('2')

    expect(decisions).toEqual([{ approved: false, interactionId: 'a2' }])
  })
})

const stubClipboard = () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  return writeText
}

describe('ApprovalCard 参数', () => {
  it('默认收起，卡头写关键参数；展开后是参数列表，可复制整份参数', async () => {
    const user = userEvent.setup()
    const writeText = stubClipboard()
    const input = {
      reportId: 'rpt_7f3c91a2',
      filters: { region: '华东', tags: ['透气', '易打理'] },
      limit: 5,
    }
    await renderWithProviders(card([mcpItem('a1', '发布报告', input)]))

    const toggle = screen.getByRole('button', { name: '参数' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('rpt_7f3c91a2')).toBeVisible()
    expect(screen.queryByRole('button', { name: '复制参数' })).toBeNull()

    await user.click(toggle)

    const terms = screen
      .getAllByRole('term')
      .map((term) => [term.textContent, term.nextElementSibling?.textContent])
    expect(terms).toEqual([
      ['reportId', 'rpt_7f3c91a2'],
      ['filters.region', '华东'],
      ['filters.tags[1]', '透气'],
      ['filters.tags[2]', '易打理'],
      ['limit', '5'],
    ])

    await user.click(screen.getByRole('button', { name: '复制参数' }))
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(input, null, 2))
  })

  it('JSON 字符串形式的参数照样展开；参数里的图片收起时显示成缩略图，点开放大', async () => {
    const user = userEvent.setup()
    const input = JSON.stringify({
      title: '首帧对比',
      options: [
        { label: 'A', imageUrl: 'https://cdn.example.com/a.png' },
        { label: 'B', imageUrl: 'https://cdn.example.com/b.jpg?w=320' },
      ],
    })
    await renderWithProviders(card([mcpItem('a1', '新建投票', input)]))

    expect(screen.getAllByRole('img', { name: /^参数图片/ })).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: '参数图片 1' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    await user.keyboard('{Escape}')

    await user.click(screen.getByRole('button', { name: '参数' }))

    expect(screen.queryByRole('img', { name: /^参数图片/ })).toBeNull()
    expect(screen.getByText('options[2].imageUrl')).toBeVisible()
    expect(screen.getByText('https://cdn.example.com/b.jpg?w=320')).toBeVisible()
  })

  it('参数解析不出对象时没有「参数」按钮', async () => {
    await renderWithProviders(card([mcpItem('a1', '发布报告', 'not json')]))

    expect(screen.queryByRole('button', { name: '参数' })).toBeNull()
  })
})

describe('ApprovalCard 一批多项', () => {
  it('决定当前项后自动切到下一个未决定的项；已决定的项仍可点开看，不能再改', async () => {
    const decisions = recordDecisions()
    const user = userEvent.setup()
    await renderWithProviders(
      card([mcpItem('a1', '追加样本', { n: 1 }), mcpItem('a2', '检索访谈', { n: 2 })]),
    )
    expect(screen.getByRole('tab', { name: /追加样本/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tab', { name: /用户洞察/ })).toBeNull()
    expect(screen.getByText('1 / 2')).toBeVisible()

    await user.click(screen.getByRole('button', { name: '同意' }))

    expect(await screen.findByRole('tab', { name: /检索访谈/, selected: true })).toBeInTheDocument()
    expect(screen.getByText('2 / 2')).toBeVisible()
    const first = screen.getByRole('tab', { name: /追加样本/ })
    expect(within(first).getByRole('img', { name: '已同意' })).toBeInTheDocument()

    await user.click(first)

    expect(screen.getByText('已同意')).toBeVisible()
    expect(screen.queryByRole('button', { name: '同意' })).toBeNull()
    expect(decisions).toEqual([{ approved: true, interactionId: 'a1' }])
  })

  it('页签的状态读交互状态，默认打开第一个未决定的项', async () => {
    await renderWithProviders(
      card([
        mcpItem('a1', '追加样本', { n: 1 }, 'approved'),
        mcpItem('a2', '检索访谈', { n: 2 }),
        mcpItem('a3', '发布报告', { n: 3 }, 'rejected'),
      ]),
    )

    const [first, second, third] = screen.getAllByRole('tab')
    expect(within(first as HTMLElement).getByRole('img', { name: '已同意' })).toBeInTheDocument()
    expect(within(second as HTMLElement).getByRole('img', { name: '待决定' })).toBeInTheDocument()
    expect(within(third as HTMLElement).getByRole('img', { name: '已拒绝' })).toBeInTheDocument()
    expect(second).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('2 / 3')).toBeVisible()
  })

  it('切换页签时参数不自动展开', async () => {
    const user = userEvent.setup()
    await renderWithProviders(
      card([mcpItem('a1', '追加样本', { n: 1 }), mcpItem('a2', '检索访谈', { n: 2 })]),
    )
    await user.click(screen.getByRole('button', { name: '参数' }))

    await user.click(screen.getByRole('tab', { name: /检索访谈/ }))

    expect(screen.getByRole('button', { name: '参数' })).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('ApprovalCard 账号与只读', () => {
  const insights: McpConnectionsScope = { agentId: 'insights' }

  beforeEach(() => {
    setMockMcpConnections({
      agents: { insights: ['user-insights'] },
      users: {
        tester: { 'user-insights': { account: 'chen@example.com', state: 'connected' } },
      },
    })
  })

  it('MCP 工具在给了连接范围、服务连着账号时，卡脚写这个账号', async () => {
    await renderWithProviders(
      card([mcpItem('a1', '发布报告', { n: 1 })], { connections: insights }),
    )

    expect(await screen.findByText('chen@example.com')).toBeInTheDocument()
  })

  it('没给连接范围时不写账号', async () => {
    await renderWithProviders(card([mcpItem('a1', '发布报告', { n: 1 })]))

    expect(screen.queryByText('chen@example.com')).toBeNull()
  })

  it('不是 MCP 工具时不写账号', async () => {
    await renderWithProviders(
      card([fileItem({ content: '正文', operation: 'write', path: 'a.md' })], {
        connections: insights,
      }),
    )

    expect(screen.getByRole('button', { name: '同意' })).toBeInTheDocument()
    expect(screen.queryByText('chen@example.com')).toBeNull()
  })

  it('只读时没有按钮也没有账号，写「等待任务属主决定」', async () => {
    const decisions = recordDecisions()
    await renderWithProviders(
      card([mcpItem('a1', '发布报告', { n: 1 })], { connections: insights, readOnly: true }),
    )

    expect(screen.getByText('等待任务属主决定')).toBeVisible()
    expect(screen.queryByRole('button', { name: '同意' })).toBeNull()
    expect(screen.queryByRole('button', { name: '拒绝' })).toBeNull()
    await userEvent.keyboard('1')
    expect(decisions).toEqual([])
    expect(screen.queryByText('chen@example.com')).toBeNull()
  })
})

const stubContentHeight = (px: number) => {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => px,
  })
}

describe('ApprovalCard 写入预览', () => {
  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
  })

  it('超过十二行先收起，展开全部与收起来回切换；文件卡没有「参数」', async () => {
    stubContentHeight(40 * 21)
    await renderWithProviders(
      card([fileItem({ content: '很长的一段', operation: 'write', path: 'a.md' })]),
    )
    const preview = screen.getByRole('region', { name: '改动预览' })
    expect(screen.queryByRole('button', { name: '参数' })).toBeNull()

    const expand = screen.getByRole('button', { name: '展开全部' })
    expect(expand).toHaveAttribute('aria-expanded', 'false')
    expect(expand).toHaveAttribute('aria-controls', preview.id)

    await userEvent.click(expand)
    const collapse = screen.getByRole('button', { name: '收起' })
    expect(collapse).toHaveAttribute('aria-expanded', 'true')

    await userEvent.click(collapse)
    expect(screen.getByRole('button', { name: '展开全部' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  })

  it('编辑只列改了的行，相同的首尾行留作上下文', async () => {
    stubContentHeight(4 * 21)
    await renderWithProviders(
      card([
        fileItem({
          after: '镜头 2\n景别：中景\n时长 4 秒',
          before: '镜头 2\n景别：近景\n时长 4 秒',
          operation: 'edit',
          path: 'shots/分镜表.md',
        }),
      ]),
    )

    const preview = screen.getByRole('region', { name: '改动预览' })
    expect(preview).toHaveTextContent(/^镜头 2−删去：景别：近景\+新写：景别：中景时长 4 秒$/)
    expect(screen.getByText('分镜表.md')).toBeVisible()
  })
})
