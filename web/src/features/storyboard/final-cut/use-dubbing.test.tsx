import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { DubbingIn, SpeechIn } from '@/shared/api/generated/types.gen'
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

    await act(() => result.current.start('en', { takes: targets, narrations: [] }))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))

    expect(
      sent
        .map(({ sourceJobId, locale, lines, reference }) => ({
          sourceJobId,
          locale,
          lines,
          reference,
        }))
        .toSorted((left, right) => (left.lines[0]?.startMs ?? 0) - (right.lines[0]?.startMs ?? 0)),
    ).toEqual([
      {
        sourceJobId: TAKE,
        locale: 'en',
        lines: [{ startMs: 0, endMs: 500, text: 'one', slotEndMs: 1_000 }],
        // 原声的音色带着整条素材片的说话时段，资料库的音色不带
        reference: { kind: 'original', spans },
      },
      {
        sourceJobId: TAKE,
        locale: 'en',
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
    expect(result.current.running).toBeNull()
  })

  it('原文下给素材片配音：不写语言；还在合成时记着这批的句子和还没有结果的句数，同一时间只跑一批', async () => {
    const sent: DubbingIn[] = []
    const records = new Map<string, GenerationJob>()
    server.use(
      http.get('*/api/generations', () => HttpResponse.json({ items: [...records.values()] })),
      http.post('*/api/generations/dubbings', async ({ request }) => {
        const body = (await request.json()) as DubbingIn
        sent.push(body)
        const id = crypto.randomUUID()
        records.set(
          id,
          makeGenerationJob({
            id,
            kind: 'dubbing',
            status: 'submitted',
            sourceJobId: body.sourceJobId,
            outputUrl: null,
          }),
        )
        return HttpResponse.json({ generation: records.get(id) }, { status: 202 })
      }),
    )
    const finish = (sourceJobId: string) => {
      for (const [id, job] of records)
        if (job.sourceJobId === sourceJobId)
          records.set(id, {
            ...job,
            status: 'completed',
            outputUrl: `https://media.test/${id}.m4a`,
          })
    }
    const OTHER = '1f2e3d4c-5b6a-4978-8877-665544332211'
    const target = (sourceJobId: string, captions: string[]): DubbingTarget => ({
      src: SRC,
      sourceJobId,
      voice: null,
      lines: captions.map((caption, index) => ({
        caption,
        startMs: index * 1_000,
        endMs: index * 1_000 + 500,
        text: caption,
      })),
      spans: [],
    })
    const onDone = vi.fn<(done: DubbingDone) => void>()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => useDubbing(CONVERSATION, onDone), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })

    await act(() =>
      result.current.start(null, {
        takes: [target(TAKE, ['c1', 'c2']), target(OTHER, ['c3'])],
        narrations: [],
      }),
    )
    expect(sent.map((body) => 'locale' in body)).toEqual([false, false])
    expect(result.current.running).toEqual({
      locale: null,
      lines: new Set(['c1', 'c2', 'c3']),
      remaining: 3,
    })
    // 在跑时再发起不做事
    await act(() => result.current.start(null, { takes: [target(TAKE, ['c9'])], narrations: [] }))
    expect(sent).toHaveLength(2)

    finish(TAKE)
    await act(() => client.invalidateQueries())
    await waitFor(() => expect(result.current.running?.remaining).toBe(1))
    expect(result.current.running?.lines).toEqual(new Set(['c1', 'c2', 'c3']))
    expect(onDone).not.toHaveBeenCalled()

    finish(OTHER)
    await act(() => client.invalidateQueries())
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(result.current.running).toBeNull()
  })

  describe('旁白的句子：每句按文字合成一次，和素材片的请求一起结束', () => {
    /** 合成接口：记下请求体，答复一条排队中的记录；之后读到的是合成好的那一条。 */
    const serveSpeeches = () => {
      const records: GenerationJob[] = []
      const sent: SpeechIn[] = []
      server.use(
        http.get('*/api/generations', ({ request }) =>
          HttpResponse.json({
            items: new URL(request.url).searchParams.get('kind') === 'speech' ? records : [],
          }),
        ),
        http.post('*/api/generations/speeches', async ({ request }) => {
          const body = (await request.json()) as SpeechIn
          sent.push(body)
          const id = crypto.randomUUID()
          records.unshift(
            makeGenerationJob({
              id,
              kind: 'speech',
              outputUrl: 'https://media.test/speech.m4a',
              durationMs: 900,
            }),
          )
          return HttpResponse.json(
            { generation: makeGenerationJob({ id, kind: 'speech', status: 'submitted' }) },
            { status: 202 },
          )
        }),
      )
      return sent
    }
    const render = (onDone: (done: DubbingDone) => void) => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      return renderHook(() => useDubbing(CONVERSATION, onDone), {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      }).result
    }

    it('其它语言下带着语言和上限发，结果在 `narrations` 里', async () => {
      const sent = serveSpeeches()
      const onDone = vi.fn<(done: DubbingDone) => void>()
      const result = render(onDone)
      const line = { caption: 'n1', text: 'Hello', voice: EMMA, maxMs: 900 }

      await act(() => result.current.start('en', { takes: [], narrations: [line] }))
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))

      expect(sent).toEqual([
        {
          conversationId: CONVERSATION,
          text: 'Hello',
          locale: 'en',
          reference: { kind: 'reference_audio', referenceId: EMMA },
          maxDurationMs: 900,
        },
      ])
      const done = onDone.mock.calls[0]?.[0]
      expect(
        done?.narrations.map(({ line: each, outcome }) => ({
          caption: each.caption,
          url: outcome.kind === 'ready' ? outcome.job.outputUrl : outcome.message,
        })),
      ).toEqual([{ caption: 'n1', url: 'https://media.test/speech.m4a' }])
    })

    it('原文下不写语言，也不写上限', async () => {
      const sent = serveSpeeches()
      const onDone = vi.fn<(done: DubbingDone) => void>()
      const result = render(onDone)
      const line = { caption: null, text: '欢迎光临', voice: EMMA }

      await act(() => result.current.start(null, { takes: [], narrations: [line] }))
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))

      expect(sent).toEqual([
        {
          conversationId: CONVERSATION,
          text: '欢迎光临',
          reference: { kind: 'reference_audio', referenceId: EMMA },
        },
      ])
      expect(result.current.running).toBeNull()
    })
  })
})
