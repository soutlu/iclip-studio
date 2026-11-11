import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PERMISSION } from '@/shared/auth'
import { loginAs, mockAuthUser } from '@/testing/mocks/handlers'
import { setMockMcpConnections } from '@/testing/mocks/mcp-connections'
import { renderWithProviders } from '@/testing/render'
import { ConversationComposer } from './conversation-composer'

describe('ConversationComposer', () => {
  it('不能上传附件的用户没有「+」，Agent 有使用自有账户的服务时照样有连接器', async () => {
    loginAs(mockAuthUser, {
      permissions: mockAuthUser.permissions.filter(
        (permission) => permission !== PERMISSION.uploadsWrite,
      ),
    })
    setMockMcpConnections({ agents: { replica: ['pickfu'] } })
    await renderWithProviders(
      <ConversationComposer
        connections={{ agentId: 'replica' }}
        contextTokens={undefined}
        maxContextTokens={undefined}
        onSend={vi.fn()}
      />,
    )

    expect(await screen.findByRole('button', { name: '连接器' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '添加附件' })).not.toBeInTheDocument()
  })
})
