import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { addMockConversation } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import {
  useConversationTask,
  useRenameConversation,
  useSetConversationMembership,
} from './conversations.api'

const TASK_ID = '7a5c0000-0000-4000-8000-000000000001'

const rowReads: string[] = []
const recordRowRead = ({ request }: { request: Request }) => {
  if (request.method === 'GET') rowReads.push(new URL(request.url).pathname)
}

afterEach(() => {
  server.events.removeListener('request:start', recordRowRead)
  rowReads.length = 0
})

describe('useConversationTask', () => {
  it('改归属、改名之后需求单跟上服务端的值，这一行不随列表刷新重读', async () => {
    const conversation = addMockConversation('挂需求单的对话')
    server.events.on('request:start', recordRowRead)
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    })
    const { result } = renderHook(
      () => ({
        membership: useSetConversationMembership(),
        rename: useRenameConversation(),
        task: useConversationTask(conversation.id),
      }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      },
    )
    await waitFor(() => expect(result.current.task).toEqual({ kind: 'ready', taskId: null }))

    await act(() =>
      result.current.membership.mutateAsync({ conversationId: conversation.id, taskId: TASK_ID }),
    )
    await act(() =>
      result.current.rename.mutateAsync({ conversationId: conversation.id, title: '改过名的对话' }),
    )

    expect(result.current.task).toEqual({ kind: 'ready', taskId: TASK_ID })
    expect(
      rowReads.filter((path) => path.endsWith(`/conversations/${conversation.id}`)),
    ).toHaveLength(1)
  })
})
