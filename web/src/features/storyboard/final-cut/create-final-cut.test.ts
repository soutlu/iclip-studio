import { QueryClient } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '@/testing/mocks/server'
import { mockProjectMain, putMockProjectMain } from '@/testing/mocks/whole-film'
import { createFinalCut } from './create-final-cut'

const CONVERSATION = '6a1f3c2e-4b5d-4e6f-8a7b-9c0d1e2f3a4b'
const CREATE_URL = '*/api/conversations/:conversationId/final-cut/files'
const EXISTING = '<!doctype html><html><body>别处建的</body></html>'

const queryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })

describe('createFinalCut', () => {
  it('按 1080×1920 的空模版建主文件，答复主文件在工作区里的路径', async () => {
    const created: { path: string; content: string }[] = []
    server.use(
      http.post(CREATE_URL, async ({ request }) => {
        created.push((await request.clone().json()) as { path: string; content: string })
        return undefined
      }),
    )

    await expect(createFinalCut(CONVERSATION, queryClient())).resolves.toBe('final-cut/index.html')

    expect(created.map((file) => file.path)).toEqual(['index.html'])
    const [{ content } = { content: '' }] = created
    expect(content).toContain('data-width="1080" data-height="1920"')
    expect(content).toMatch(/id="film"[^>]*data-duration="0"/)
    expect(content).not.toMatch(/<(video|audio) |class="clip/)
    expect(mockProjectMain(CONVERSATION)).toEqual({ content, version: 1 })
  })

  it('别处已经建好了（409）：当建好了，不动那一份', async () => {
    putMockProjectMain(CONVERSATION, EXISTING)

    await expect(createFinalCut(CONVERSATION, queryClient())).resolves.toBe('final-cut/index.html')

    expect(mockProjectMain(CONVERSATION)).toEqual({ content: EXISTING, version: 1 })
  })

  it('建失败：抛出「final-cut 新建失败」和服务端给的原因', async () => {
    server.use(
      http.post(CREATE_URL, () => HttpResponse.json({ detail: '工作区已满' }, { status: 503 })),
    )

    await expect(createFinalCut(CONVERSATION, queryClient())).rejects.toThrow(
      /^final-cut 新建失败.*工作区已满/,
    )
    expect(mockProjectMain(CONVERSATION)).toBeUndefined()
  })
})
