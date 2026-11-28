import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { useRef, useState, type ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import type { DubbingIn, SpeechIn } from '@/shared/api/generated/types.gen'
import { audio, caption, video } from '@/testing/final-cut'
import { makeGenerationJob } from '@/testing/generation-job'
import { server } from '@/testing/mocks/server'
import type { GenerationJob } from '../storyboard.api'
import { isDubClip, type FilmClip } from './composition/film'
import {
  voiceKeyOf,
  voiceSettingOf,
  type VoiceModes,
  type VoiceSetting,
} from './composition/voices'
import { dubsOf } from './dubbing'
import { SOURCE_SHOWN, type Language } from './locales'
import { useVoiceControl } from './use-voice-control'

const CONVERSATION = '6b0f3a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'
const TAKE = '0f1e2d3c-4b5a-4968-8776-655443322110'
const SRC = 'https://media.test/videos/a.mp4'
const EMMA = '9a8b7c6d-5e4f-4321-8abc-def012345678'

// 视频片段 va 上一句 c1；n 是手动加的旁白句，还没有旁白片段
const CLIPS: FilmClip[] = [
  video({ id: 'va', src: SRC, duration: 4_000 }),
  caption({ id: 'c1', variable: 'v1', start: 0, duration: 1_000, owner: 'va', text: '一' }),
  caption({ id: 'n', variable: 'vn', start: 2_000, duration: 1_000, text: '新旁白' }),
]

/**
 * 配音和按文字合成的接口：记下请求体，答复排队中的记录；之后读到的是配好的那一条。给了 `held` 时配音请求等它
 * 好了才答复。
 */
const serve = (held?: Promise<void>) => {
  const records: GenerationJob[] = []
  const dubbings: DubbingIn[] = []
  const speeches: SpeechIn[] = []
  server.use(
    http.get('*/api/generations', ({ request }) => {
      const kind = new URL(request.url).searchParams.get('kind')
      return HttpResponse.json({ items: records.filter((job) => job.kind === kind) })
    }),
    http.post('*/api/generations/dubbings', async ({ request }) => {
      const body = (await request.json()) as DubbingIn
      dubbings.push(body)
      await held
      const id = crypto.randomUUID()
      records.unshift(
        makeGenerationJob({
          id,
          kind: 'dubbing',
          sourceJobId: TAKE,
          outputUrl: 'https://media.test/dub.m4a',
          durationMs: 4_000,
          dubbedLines: body.lines.map((_, index) => ({ index, speed: 1, trimmed: false })),
        }),
      )
      return HttpResponse.json(
        { generation: makeGenerationJob({ id, kind: 'dubbing', status: 'submitted' }) },
        { status: 202 },
      )
    }),
    http.post('*/api/generations/speeches', async ({ request }) => {
      speeches.push((await request.json()) as SpeechIn)
      const id = crypto.randomUUID()
      records.unshift(
        makeGenerationJob({
          id,
          kind: 'speech',
          outputUrl: 'https://media.test/speech.m4a',
          durationMs: 900,
          dubbedLines: [{ index: 0, speed: 1.1, trimmed: false }],
        }),
      )
      return HttpResponse.json(
        { generation: makeGenerationJob({ id, kind: 'speech', status: 'submitted' }) },
        { status: 202 },
      )
    }),
  )
  return { dubbings, speeches }
}

type Project = { clips: readonly FilmClip[]; modes: VoiceModes }

/**
 * 原文下的配音控制，接在一份放在内存里的工程上：会话的几个写法照它们的约定改这份工程（人声设置、删掉不配音的
 * 配音片段、写进配好的配音片段），`project` 读它现在的样子。
 */
const renderSourceVoice = (initial: Project = { clips: CLIPS, modes: {} }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderHook(
    () => {
      const [project, setProject] = useState(initial)
      const latestRef = useRef(project)
      latestRef.current = project
      const write = (next: Project) => {
        latestRef.current = next
        setProject(next)
      }
      const withSetting = (
        locale: Language,
        update: (setting: VoiceSetting) => VoiceSetting,
      ): VoiceModes => ({
        ...latestRef.current.modes,
        [voiceKeyOf(locale)]: update(voiceSettingOf(latestRef.current.modes, locale)),
      })
      const voice = useVoiceControl({
        conversationId: CONVERSATION,
        film: { clips: project.clips, voiceModes: project.modes, locale: SOURCE_SHOWN },
        sourceMs: () => undefined,
        takeOf: (src) => (src === SRC ? TAKE : undefined),
        takesPending: false,
        sourceName: () => undefined,
        notice: () => {},
        beforeEdit: () => {},
        session: {
          setVoiceMode: (locale, mode) =>
            write({
              ...latestRef.current,
              modes: withSetting(locale, (each) => ({ ...each, mode })),
            }),
          changeVoice: (locale, update, unvoiced = []) => {
            const removed = dubsOf(latestRef.current.clips, locale, unvoiced)
            write({
              clips: latestRef.current.clips.filter((clip) => !removed.includes(clip.id)),
              modes: withSetting(locale, update),
            })
          },
          addDubs: (locale, plan) => {
            const { removed, added, narrated } = plan(latestRef.current.clips)
            const dubs = [...added, ...narrated].map(
              ({ caption: of, trimmed, text, voice: used, speed, ...clip }) =>
                audio({
                  ...clip,
                  id: `dub-${of}`,
                  dub: { locale, caption: of, trimmed, text, voice: used, speed },
                }),
            )
            write({
              ...latestRef.current,
              clips: [
                ...latestRef.current.clips.filter((clip) => !removed.includes(clip.id)),
                ...dubs,
              ],
            })
            return dubs.length
          },
        },
      })
      return { voice, project }
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  ).result
}

const sourceDubOf = (clips: readonly FilmClip[], of: string) =>
  clips.find((clip) => isDubClip(clip) && clip.dub.locale === null && clip.dub.caption === of)

describe('原文的配音', () => {
  it('原文原声：视频句保留原声；给没有配音的旁白句选音色只记下，单句合成按文字合成（不带语言），写成记着字和音色的旁白片段', async () => {
    const sent = serve()
    const result = renderSourceVoice()
    const voice = () => result.current.voice
    expect(voice()?.locale).toBeNull()
    expect(voice()?.lines.get('c1')).toMatchObject({ status: 'original' })
    expect(voice()?.lines.get('c1')?.chooseBlocked).toBeDefined()
    expect(voice()?.lines.get('n')?.status).toBe('voiceless')

    act(() => voice()?.onLine('n', { voice: EMMA }))
    expect(result.current.project.modes).toEqual({
      _source: { mode: 'original', voice: null, lines: { n: { voice: EMMA } } },
    })
    expect(voice()?.lines.get('n')).toMatchObject({
      status: 'missing',
      voice: EMMA,
      own: { voice: EMMA },
    })
    expect(voice()?.summary).toEqual({ dubbed: false, pending: 1, running: 0 })
    expect(sent.speeches).toEqual([])

    act(() => voice()?.dubLine('n'))
    await waitFor(() => expect(sent.speeches).toHaveLength(1))
    expect(sent.speeches[0]).toEqual({
      conversationId: CONVERSATION,
      text: '新旁白',
      reference: { kind: 'reference_audio', referenceId: EMMA },
    })
    await waitFor(() => expect(sourceDubOf(result.current.project.clips, 'n')).toBeDefined())
    expect(sourceDubOf(result.current.project.clips, 'n')).toMatchObject({
      start: 2_000,
      duration: 900,
      dub: { locale: null, caption: 'n', text: '新旁白', voice: EMMA, speed: 1.1 },
    })
    expect(voice()?.lines.get('n')).toMatchObject({ status: 'ready', speed: 1.1 })
    expect(voice()?.summary).toEqual({ dubbed: true, pending: 0, running: 0 })
    expect(sent.dubbings).toEqual([])
  })

  it('原文配音：切过去不发起；整种语言生成时视频句按素材片配（不带语言、念原文的字），没有音色的旁白句不配', async () => {
    const sent = serve()
    const result = renderSourceVoice()
    const voice = () => result.current.voice

    act(() => voice()?.onMode('dub'))
    expect(result.current.project.modes).toEqual({
      _source: { mode: 'dub', voice: null, lines: {} },
    })
    expect(voice()?.lines.get('c1')?.status).toBe('missing')
    expect(voice()?.lines.get('n')?.status).toBe('voiceless')
    expect(sent.dubbings).toEqual([])

    act(() => voice()?.generate.run())
    await waitFor(() => expect(sent.dubbings).toHaveLength(1))
    expect(sent.dubbings[0]).toEqual({
      conversationId: CONVERSATION,
      sourceJobId: TAKE,
      lines: [{ startMs: 0, endMs: 1_000, text: '一' }],
      reference: { kind: 'original', spans: [{ startMs: 0, endMs: 1_000 }] },
    })
    await waitFor(() => expect(voice()?.lines.get('c1')?.status).toBe('ready'))
    expect(sourceDubOf(result.current.project.clips, 'c1')).toMatchObject({
      dub: { locale: null, caption: 'c1', text: '一', voice: null, speed: 1 },
    })
    expect(sent.speeches).toEqual([])
    expect(voice()?.fill.blocked).toBe('没有待重配的字幕')
  })

  it('合成中：别的句子照样算待处理；这时把在合成的那句改成不配音，配好的那段不写回去', async () => {
    let release = () => {}
    const sent = serve(
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    const result = renderSourceVoice({
      clips: CLIPS,
      modes: { _source: { mode: 'dub', voice: null, lines: { n: { voice: EMMA } } } },
    })
    const voice = () => result.current.voice
    expect(voice()?.summary.pending).toBe(2)

    act(() => voice()?.dubLine('c1'))
    await waitFor(() => expect(sent.dubbings).toHaveLength(1))
    expect(voice()?.lines.get('c1')?.status).toBe('running')
    expect(voice()?.lines.get('n')).toMatchObject({ pending: true, blocked: expect.any(String) })
    expect(voice()?.summary).toEqual({ dubbed: false, pending: 1, running: 1 })

    act(() => voice()?.onLine('c1', { dub: false }))
    release()
    await waitFor(() => expect(voice()?.summary.running).toBe(0))
    expect(voice()?.lines.get('c1')?.status).toBe('unvoiced')
    expect(sourceDubOf(result.current.project.clips, 'c1')).toBeUndefined()
  })
})
