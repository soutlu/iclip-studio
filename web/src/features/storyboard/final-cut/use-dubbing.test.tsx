import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { DubbingIn } from '@/shared/api/generated/types.gen'
import { makeGenerationJob } from '@/testing/generation-job'
import { server } from '@/testing/mocks/server'
import type { GenerationJob } from '../storyboard.api'
import { useDubbing, type DubbingDone, type DubbingTarget } from './use-dubbing'

const CONVERSATION = '6b0f3a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'
const TAKE = '0f1e2d3c-4b5a-4968-8776-655443322110'
const SRC = 'https://media.test/videos/a.mp4'
const EMMA = '9a8b7c6d-5e4f-4321-8abc-def012345678'

describe('useDubbing', () => {
  it('同一条素材片两个音色各发一次：各次请求带自己的参考音频（原声的带说话时段），结果各归各的', async () => {
    const records: GenerationJob[] = []
    const sent: DubbingIn[] = []
    server.use(
      http.get('*/api/generations', () => HttpResponse.json({ items: records })),
      http.post('*/api/generations/dubbings', async ({ request }) => {
        const body = (await request.json()) as DubbingIn
        sent.push(body)
        const id = crypto.randomUUID()
        const voice = body.reference.kind === 'original' ? 'original' : 'emma'
        records.unshift(
          makeGenerationJob({
            id,
            kind: 'dubbing',
            sourceJobId: TAKE,
            outputUrl: `https://media.test/dub-${voice}.m4a`,
            durationMs: 4_000,
          }),
        )
        return HttpResponse.json(
          {
            generation: makeGenerationJob({
              id,
              kind: 'dubbing',
              status: 'submitted',
              sourceJobId: TAKE,
              outputUrl: null,
            }),
          },
          { status: 202 },
        )
      }),
    )
    const spans = [
      { startMs: 0, endMs: 500 },
      { startMs: 1_000, endMs: 1_500 },
    ]
    const targets: DubbingTarget[] = [
      {
        src: SRC,
        sourceJobId: TAKE,
        voice: null,
        lines: [{ caption: 'c1', startMs: 0, endMs: 500, text: 'one', slotEndMs: 1_000 }],
        spans,
      },
      {
        src: SRC,
        sourceJobId: TAKE,
        voice: EMMA,
        lines: [{ caption: 'c2', startMs: 1_000, endMs: 1_500, text: 'two' }],
        spans,
      },
    ]
    const onDone = vi.fn<(done: DubbingDone) => void>()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useDubbing(CONVERSATION, onDone), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })

    await act(() => result.current.start('en', targets, (setting) => setting))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))

    expect(
      sent
        .map(({ sourceJobId, lines, reference }) => ({ sourceJobId, lines, reference }))
        .toSorted((left, right) => (left.lines[0]?.startMs ?? 0) - (right.lines[0]?.startMs ?? 0)),
    ).toEqual([
      {
        sourceJobId: TAKE,
        lines: [{ startMs: 0, endMs: 500, text: 'one', slotEndMs: 1_000 }],
        // 原声的音色带着整条素材片的说话时段，资料库的音色不带
        reference: { kind: 'original', spans },
      },
      {
        sourceJobId: TAKE,
        lines: [{ startMs: 1_000, endMs: 1_500, text: 'two' }],
        reference: { kind: 'reference_audio', referenceId: EMMA },
      },
    ])
    const done = onDone.mock.calls[0]?.[0]
    expect(
      done?.results.map(({ target, outcome }) => ({
        voice: target.voice,
        url: outcome.kind === 'ready' ? outcome.job.outputUrl : outcome.message,
      })),
    ).toEqual([
      { voice: null, url: 'https://media.test/dub-original.m4a' },
      { voice: EMMA, url: 'https://media.test/dub-emma.m4a' },
    ])
    expect(result.current.generating).toBe(0)
  })
})
