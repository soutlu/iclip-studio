import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { addMockConversation } from '@/testing/mocks/conversations'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { GenerateMusic } from './music-panel'

describe('生成音乐浮层', () => {
  it('点触发按钮向上弹出；填好描述提交到这段对话，提交后收起', async () => {
    const user = userEvent.setup()
    const conversation = addMockConversation('整片配乐')
    const bodies: unknown[] = []
    server.use(
      http.post('*/api/generations/music', async ({ request }) => {
        bodies.push(await request.clone().json())
        return undefined
      }),
    )
    await renderWithProviders(
      <GenerateMusic conversationId={conversation.id} onNotice={vi.fn()}>
        <button type="button">打开</button>
      </GenerateMusic>,
    )

    await user.click(screen.getByRole('button', { name: '打开' }))
    const popover = await screen.findByRole('dialog', { name: '生成音乐' })
    expect(popover).toHaveAttribute('data-side', 'top')
    await user.type(screen.getByLabelText('音乐描述'), '轻快的原声吉他')
    const submit = screen.getByRole('button', { name: '生成' })
    await waitFor(() => expect(submit).not.toHaveAttribute('aria-disabled'))
    await user.click(submit)

    await waitFor(() => expect(popover).not.toBeInTheDocument())
    expect(bodies).toEqual([
      { conversationId: conversation.id, prompt: '轻快的原声吉他', taskId: null },
    ])
  })
})
