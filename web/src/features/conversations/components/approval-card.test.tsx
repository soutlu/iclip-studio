import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolCallFrame } from '@/shared/transcript/vendor'
import { DialogHeader, DialogRoot, DialogSurface } from '@/shared/ui/dialog'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { ApprovalCard } from './approval-card'

/** 记录这张卡向服务端提交了几次决定。 */
function countDecisions() {
  const decisions: boolean[] = []
  server.use(
    http.post('*/api/conversations/c1/interactions/i1', async ({ request }) => {
      decisions.push(((await request.json()) as { approved: boolean }).approved)
      return new HttpResponse(null, { status: 204 })
    }),
  )
  return decisions
}

const card = (
  <ApprovalCard
    conversationId="c1"
    frame={undefined}
    interactionId="i1"
    onRefresh={() => {}}
    readOnly={false}
  />
)

describe('ApprovalCard 数字快捷键', () => {
  it('卡片在前时按 1 即同意', async () => {
    const decisions = countDecisions()
    await renderWithProviders(card)

    await userEvent.keyboard('1')

    expect(await screen.findByText('已同意')).toBeVisible()
    expect(decisions).toEqual([true])
  })

  it('弹窗盖着卡片时数字键是打给弹窗的，不替看不见的审批做决定', async () => {
    const decisions = countDecisions()
    await renderWithProviders(
      <>
        {card}
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
    // 弹窗打开期间卡片被标成 aria-hidden，查询要带 hidden 才找得到。
    expect(screen.getByRole('button', { hidden: true, name: '同意' })).toBeEnabled()
  })
})

const fileFrame = (display: Record<string, unknown>): ToolCallFrame => ({
  approvalId: 'i1',
  display: { kind: 'file_io', ...display },
  frameId: 't1.1.f1',
  kind: 'tool',
  name: 'write_file',
  state: 'running',
  toolCallId: 'call_1',
})

const cardFor = (frame: ToolCallFrame) => (
  <ApprovalCard
    conversationId="c1"
    frame={frame}
    interactionId="i1"
    onRefresh={() => {}}
    readOnly={false}
  />
)

/** jsdom 不排版，scrollHeight 恒为 0；按用例给出预览正文排出来的高度（jsdom 下行高按 21px 估）。 */
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

  it('Markdown 排成文档，卡头只给文件名', async () => {
    stubContentHeight(3 * 21)
    await renderWithProviders(
      cardFor(
        fileFrame({ content: '# 封面\n\n主图在左。', operation: 'write', path: 'shots/cover.md' }),
      ),
    )

    const preview = screen.getByRole('region', { name: '改动预览' })
    expect(within(preview).getByRole('heading', { name: '封面' })).toBeVisible()
    expect(screen.getByText('cover.md')).toBeVisible()
    expect(screen.queryByText('shots/cover.md')).toBeNull()
  })

  it('不是 Markdown 的文件按原文显示，不排版', async () => {
    stubContentHeight(3 * 21)
    await renderWithProviders(
      cardFor(fileFrame({ content: '# 不是标题', operation: 'write', path: 'notes/a.txt' })),
    )

    const preview = screen.getByRole('region', { name: '改动预览' })
    expect(within(preview).queryByRole('heading')).toBeNull()
    expect(within(preview).getByText('# 不是标题')).toBeVisible()
  })

  it('十二行以内整段显示，不给展开', async () => {
    stubContentHeight(12 * 21)
    await renderWithProviders(
      cardFor(fileFrame({ content: '短短一段', operation: 'write', path: 'a.md' })),
    )

    expect(screen.getByRole('region', { name: '改动预览' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '展开全部' })).toBeNull()
  })

  it('超过十二行先收起，展开全部与收起来回切换', async () => {
    stubContentHeight(40 * 21)
    await renderWithProviders(
      cardFor(fileFrame({ content: '很长的一段', operation: 'write', path: 'a.md' })),
    )
    const preview = screen.getByRole('region', { name: '改动预览' })

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
      cardFor(
        fileFrame({
          after: '镜头 2\n景别：中景\n时长 4 秒',
          before: '镜头 2\n景别：近景\n时长 4 秒',
          operation: 'edit',
          path: 'shots/分镜表.md',
        }),
      ),
    )

    const preview = screen.getByRole('region', { name: '改动预览' })
    expect(preview).toHaveTextContent(/^镜头 2−删去：景别：近景\+新写：景别：中景时长 4 秒$/)
    expect(screen.getByText('分镜表.md')).toBeVisible()
  })
})
