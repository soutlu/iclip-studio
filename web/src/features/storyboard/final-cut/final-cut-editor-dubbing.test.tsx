import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { addMockReferenceAudio, resetMockReferenceAudios } from '@/testing/mocks/reference-audios'
import { server } from '@/testing/mocks/server'
import { putMockWorkspaceFile } from '@/testing/mocks/workspace'
import { audio, video } from '@/testing/final-cut'
import {
  CONVERSATION,
  TAKE_A,
  TAKE_B,
  URL_A,
  URL_B,
  openEditor,
  previewSettled,
  putFilm,
  savedFilm,
  savedSceneLines,
  sceneLine,
  setUpEditorCase,
  shot,
  tearDownEditorCase,
  toolbar,
  undoButton,
  waitSaved,
} from '@/testing/final-cut-editor'
import type { GenerationJob } from '../storyboard.api'
import type { AudioDub, FilmClip } from './composition/film'

vi.mock('mediabunny', async () => (await import('@/testing/final-cut-media')).mediabunnyMock())

// 一条用例要开整个编辑器、走完一串操作，上限放宽到 15 秒
vi.setConfig({ testTimeout: 15_000 })

beforeEach(setUpEditorCase)
afterEach(tearDownEditorCase)

/** 配音片段的 `dub`：没有合成时的记录（老的配音片段）；旁白给 `voice`。 */
const legacyDub = (
  locale: string | null,
  caption: string,
  voice: string | null = null,
): AudioDub => ({
  locale,
  caption,
  trimmed: false,
  text: null,
  voice,
  speed: 1,
})

describe('final-cut 编辑器 · 配音', () => {
  const EN_FILE = 'final-cut/locales/en.json'
  const DUB_URL = (source: string) => `https://media.test/dub-${source}.m4a`
  const SPEECH_URL = 'https://media.test/speech.m4a'
  /** 用原声的音色时带的说话时段：素材片的视频片段名下全部字幕（含没翻的 d4）在素材片里的起止。 */
  const ORIGINAL_A = {
    kind: 'original',
    spans: [
      { startMs: 0, endMs: 1_000 },
      { startMs: 1_200, endMs: 1_800 },
      { startMs: 2_500, endMs: 3_500 },
    ],
  }
  const ORIGINAL_B = { kind: 'original', spans: [{ startMs: 900, endMs: 1_900 }] }
  /** 时间线上还没有配音行时，配音行的位置写的引导：保留原声时、AI 配音还没生成时。 */
  const KEEP_ORIGINAL_HINT = '当前语言保留原声；在「字幕」页签切到「配音」可生成配音'
  const NOT_DUBBED_HINT = '当前语言还没有配音；在「字幕」页签点击「生成配音」'
  const languages = () => within(toolbar()).getByRole('radiogroup', { name: '语言' })
  type User = ReturnType<typeof userEvent.setup>
  const panel = () => screen.getByRole('tabpanel', { name: /^字幕/ })
  /** 第二排的「原声 | 配音」。 */
  const modeButton = (name: '原声' | '配音') =>
    within(within(panel()).getByRole('radiogroup', { name: '原声或配音' })).getByRole('radio', {
      name,
    })
  /** 页签里的按钮：「生成配音」「重配 N 句」「重新生成」、默认音色胶囊等。 */
  const voiceButton = (name: string | RegExp) => within(panel()).getByRole('button', { name })
  /** 选音浮层（「选择默认音色」「选择本句音色」）。 */
  const voicePop = (name: string) => screen.getByRole('dialog', { name })
  /** 浮层列表里资料库音色的名字，按先后。 */
  const popVoices = (name: string) =>
    within(within(voicePop(name)).getByRole('list', { name: '音色' }))
      .queryAllByRole('button', { name: /^试听：/ })
      .map((button) => button.getAttribute('aria-label')?.slice('试听：'.length))
  /** 点默认音色胶囊，在浮层里选 `name`（「原片音色」或资料库音色）。 */
  const pickDefault = async (user: User, name: string) => {
    await user.click(voiceButton(/^默认音色：/))
    const pop = await screen.findByRole('dialog', { name: '选择默认音色' })
    await user.click(
      await within(pop).findByRole('button', {
        name: name === '原片音色' ? /^原片音色/ : new RegExp(`^(选用：${name}|${name}，当前)$`),
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '选择默认音色' })).toBeNull())
  }

  const savedDubElements = () => [
    ...new DOMParser()
      .parseFromString(savedFilm(), 'text/html')
      .querySelectorAll('audio[data-dub-of]'),
  ]

  /** 存下来的主文件里的配音片段：配的哪句、语言、起止、入点（秒）、速度、地址、截没截尾。 */
  const savedDubs = () =>
    savedDubElements()
      .map((element) => ({
        caption: element.getAttribute('data-dub-of'),
        locale: element.getAttribute('data-locale'),
        start: Number(element.getAttribute('data-start')),
        duration: Number(element.getAttribute('data-duration')),
        mediaStart: Number(element.getAttribute('data-media-start')),
        rate: element.getAttribute('data-playback-rate'),
        src: element.getAttribute('src'),
        trimmed: element.hasAttribute('data-dub-trimmed'),
      }))
      .toSorted((left, right) => left.start - right.start)

  /** 存下来的配音片段记着的合成记录：配的哪句、念的字、音色、倍数，按配的哪句排。 */
  const savedRecords = () =>
    savedDubElements()
      .map((element) => ({
        caption: element.getAttribute('data-dub-of'),
        text: element.getAttribute('data-dub-text'),
        voice: element.getAttribute('data-dub-voice'),
        speed: element.getAttribute('data-dub-speed'),
      }))
      .toSorted((left, right) => (left.caption ?? '').localeCompare(right.caption ?? ''))

  const savedModes = () =>
    new DOMParser()
      .parseFromString(savedFilm(), 'text/html')
      .getElementById('film')
      ?.getAttribute('data-voice-modes') ?? null

  /** 按文字合成（旁白句）的请求体，`serveDubbings` 每次调用时清空。 */
  let speeches: { text: string; locale?: string; reference: unknown }[] = []

  /**
   * 配音和按文字合成的接口：记下每次配音请求的素材片、语言、各句和参考音频，答复一条排队中的记录；之后读到的是
   * 配好的那一条（音轨地址按素材片取，素材片总长 6 秒，第一句截了尾，第二句加速 1.183 倍）。`reply` 给了时配音
   * 一发起就答它。按文字合成的记在 `speeches` 里，合成出来 1.5 秒。
   */
  const serveDubbings = (reply?: () => Response) => {
    const records: GenerationJob[] = []
    const sent: { sourceJobId: string; locale: string; lines: unknown; reference: unknown }[] = []
    speeches = []
    server.use(
      http.get('*/api/generations', ({ request }) => {
        const params = new URL(request.url).searchParams
        if (params.get('kind') === 'speech')
          return HttpResponse.json({ items: records.filter((job) => job.kind === 'speech') })
        if (params.get('kind') !== 'dubbing') return undefined
        const source = params.get('sourceJobId')
        return HttpResponse.json({ items: records.filter((job) => job.sourceJobId === source) })
      }),
      http.post('*/api/generations/dubbings', async ({ request }) => {
        const body = (await request.json()) as (typeof sent)[number]
        sent.push(body)
        if (reply !== undefined) return reply()
        const id = crypto.randomUUID()
        const lines = body.lines as unknown[]
        records.unshift(
          makeGenerationJob({
            id,
            kind: 'dubbing',
            sourceJobId: body.sourceJobId,
            outputUrl: DUB_URL(body.sourceJobId),
            durationMs: 6_000,
            dubbedLines: lines.map((_, index) => ({
              index,
              speed: index === 1 ? 1.183 : 1,
              trimmed: index === 0,
            })),
          }),
        )
        return HttpResponse.json(
          {
            generation: makeGenerationJob({
              id,
              kind: 'dubbing',
              status: 'submitted',
              sourceJobId: body.sourceJobId,
              outputUrl: null,
            }),
          },
          { status: 202 },
        )
      }),
      http.post('*/api/generations/speeches', async ({ request }) => {
        speeches.push((await request.json()) as (typeof speeches)[number])
        const id = crypto.randomUUID()
        records.unshift(
          makeGenerationJob({
            id,
            kind: 'speech',
            outputUrl: SPEECH_URL,
            durationMs: 1_500,
            dubbedLines: [{ index: 0, speed: 1, trimmed: false }],
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

  /**
   * 工程：素材 A 切成两半（0–2 秒、2–4 秒，后半段从素材的第 2 秒起），素材 B 一段（4–5.5 秒，从素材的第 0.5 秒
   * 起、2 倍速）；字幕 a1、d4 属于前半段，b2 属于后半段，c3 属于 B，e5 是手动加的（旁白句，还没有旁白片段）。
   * English 的值表是 `english`（默认翻了 a1、b2、c3、e5，没翻 d4）；`dubs` 是已有的配音片段，`modes` 是已有的
   * 人声设置。打开编辑器，切到「字幕」页签和 English。
   */
  const open = async (
    english: Record<string, string> = {
      cap_a1: 'A one',
      cap_b2: 'B two',
      cap_c3: 'C three',
      cap_e5: 'E five',
    },
    { dubs = [], modes }: { dubs?: FilmClip[]; modes?: string } = {},
  ) => {
    await putFilm(
      [
        video({ src: URL_A, duration: 2_000 }),
        video({ id: 'clip-2', src: URL_A, start: 2_000, duration: 2_000, mediaStart: 2_000 }),
        video({
          id: 'clip-3',
          src: URL_B,
          start: 4_000,
          duration: 1_500,
          mediaStart: 500,
          playbackRate: 2,
        }),
        ...dubs,
      ],
      [
        sceneLine('a1', 0, 1_000, 'clip-1'),
        sceneLine('d4', 1_200, 600, 'clip-1'),
        sceneLine('b2', 2_500, 1_000, 'clip-2'),
        sceneLine('c3', 4_200, 500, 'clip-3'),
        sceneLine('e5', 6_000, 500),
      ],
      modes,
    )
    putMockWorkspaceFile(CONVERSATION, EN_FILE, JSON.stringify(english))
    const user = userEvent.setup()
    await openEditor()
    await previewSettled()
    // 素材片读完了才知道片段对不对得上素材
    await shot(/^出片 A 镜头 1，/)
    await user.click(
      within(
        screen.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' }),
      ).getByRole('tab', { name: /^字幕/ }),
    )
    await user.click(within(languages()).getByRole('radio', { name: 'English（EN）' }))
    await waitFor(() => expect(modeButton('原声')).toBeVisible())
    return user
  }

  /** 切到「配音」（默认音色是原片音色）、点「生成配音」：a1、b2、c3 各一个配音片段，等它存下来。 */
  const dubWithOriginal = async (user: User) => {
    await user.click(modeButton('配音'))
    await user.click(voiceButton('生成配音'))
    await waitSaved(() => expect(savedDubs()).toHaveLength(3))
  }

  it('English 下默认原声；切到「配音」只记下、不发起，默认音色是原片音色；点「生成配音」每条素材片发起一次，字幕时间换算到素材片里（切开、入点、变速），没翻的、没有音色的旁白句不配，参考用原声；原文也有「原声 | 配音」', async () => {
    const user = await open()
    const sent = serveDubbings()
    expect(modeButton('原声')).toBeChecked()
    expect(within(panel()).queryByRole('button', { name: '生成配音' })).toBeNull()
    expect(within(panel()).queryByRole('button', { name: /^默认音色/ })).toBeNull()
    // 时间线上还没有配音行：配音行的位置写一句去哪里配
    expect(screen.getByText(KEEP_ORIGINAL_HINT)).toBeVisible()
    await user.click(modeButton('配音'))
    await waitSaved(() => expect(savedModes()).toBe('{"en":{"mode":"dub","voice":null}}'))
    expect(modeButton('配音')).toBeChecked()
    expect(voiceButton('默认音色：原片音色')).toBeVisible()
    expect(sent).toEqual([])
    expect(savedDubs()).toEqual([])
    expect(screen.getByText(NOT_DUBBED_HINT)).toBeVisible()
    expect(screen.queryByText(KEEP_ORIGINAL_HINT)).toBeNull()

    await user.click(voiceButton('生成配音'))
    await waitFor(() => expect(sent).toHaveLength(2))
    expect(
      sent.toSorted((left, right) => left.sourceJobId.localeCompare(right.sourceJobId)),
    ).toEqual(
      [
        {
          conversationId: CONVERSATION,
          sourceJobId: TAKE_A,
          locale: 'en',
          // 第一句最晚占到下一句的开始，最后一句不写上限
          lines: [
            { startMs: 0, endMs: 1_000, text: 'A one', slotEndMs: 2_500 },
            { startMs: 2_500, endMs: 3_500, text: 'B two' },
          ],
          reference: ORIGINAL_A,
        },
        {
          conversationId: CONVERSATION,
          sourceJobId: TAKE_B,
          locale: 'en',
          lines: [{ startMs: 900, endMs: 1_900, text: 'C three' }],
          reference: ORIGINAL_B,
        },
      ].toSorted((left, right) => left.sourceJobId.localeCompare(right.sourceJobId)),
    )
    expect(speeches).toEqual([])
    // 等配好的配音存下来再结束：卸载时没存的改动会存进同一份模拟的工作区，碰上下一条用例
    await waitSaved(() => expect(savedDubs()).toHaveLength(3))
    // 有了配音片段，引导收起
    await waitFor(() => expect(screen.queryByText(NOT_DUBBED_HINT)).toBeNull())

    await user.click(within(languages()).getByRole('radio', { name: '原文' }))
    expect(modeButton('原声')).toBeChecked()
    expect(modeButton('配音')).toBeVisible()
  })

  it('配好后每句一个配音片段：在配音行上和字幕对齐，从这句在素材片里的开始放、跟着视频片段的速度，占到下一句、不超出视频片段；片段上写音色名，加速的写倍数、截了尾的标出来；每段记着念的字、音色和倍数；一步撤销都回去', async () => {
    const user = await open()
    serveDubbings()
    await dubWithOriginal(user)
    await waitSaved(() =>
      expect(savedDubs()).toEqual([
        // 下一句在素材里从 2.5 秒开始，但前半段只到 2 秒
        {
          caption: 'cap-a1',
          locale: 'en',
          start: 0,
          duration: 2,
          mediaStart: 0,
          rate: null,
          src: DUB_URL(TAKE_A),
          trimmed: true,
        },
        // 最后一句占到音轨结尾（6 秒），但后半段只到 4 秒
        {
          caption: 'cap-b2',
          locale: 'en',
          start: 2.5,
          duration: 1.5,
          mediaStart: 2.5,
          rate: null,
          src: DUB_URL(TAKE_A),
          trimmed: false,
        },
        // 音轨里从 0.9 秒到结尾 6 秒，2 倍速放 2.55 秒，片段到 5.5 秒：放 1.3 秒
        {
          caption: 'cap-c3',
          locale: 'en',
          start: 4.2,
          duration: 1.3,
          mediaStart: 0.9,
          rate: '2',
          src: DUB_URL(TAKE_B),
          trimmed: true,
        },
      ]),
    )
    expect(savedRecords()).toEqual([
      { caption: 'cap-a1', text: 'A one', voice: 'original', speed: null },
      { caption: 'cap-b2', text: 'B two', voice: 'original', speed: '1.183' },
      { caption: 'cap-c3', text: 'C three', voice: 'original', speed: null },
    ])
    expect(savedModes()).toBe('{"en":{"mode":"dub","voice":null}}')
    expect((await screen.findAllByText('已生成 3 句 English 配音')).length).toBeGreaterThan(0)
    expect((await screen.findAllByText(/2.*截短/)).length).toBeGreaterThan(0)
    expect(voiceButton('重新生成')).toBeVisible()
    const row = screen.getByRole('group', { name: '配音' })
    const trimmed = within(row).getByRole('group', { name: /^配音 · A one，2\.0 秒，倍速 · 截尾$/ })
    expect(trimmed).toBeVisible()
    expect(within(trimmed).getByText('原片音色')).toBeVisible()
    expect(within(trimmed).getByText('倍速 · 截尾')).toBeVisible()
    const faster = within(row).getByRole('group', { name: /^配音 · B two，1\.5 秒，1\.18×$/ })
    expect(within(faster).getByText('1.18×')).toBeVisible()

    // 撤销一步：配音片段都去掉，人声设置还是选音色时记下的
    await user.click(undoButton())
    await waitSaved(() => expect(savedDubs()).toEqual([]))
    expect(savedModes()).toBe('{"en":{"mode":"dub","voice":null}}')
    await user.click(undoButton())
    await waitSaved(() => expect(savedModes()).toBeNull())
  })

  it('改了译文的句子过期：按钮变成「重配 1 句」，时间线上这句的配音片段标着需重配，只重配这一句；撤销回去又不过期', async () => {
    const user = await open()
    const sent = serveDubbings()
    await dubWithOriginal(user)
    const stale = () => screen.queryAllByRole('group', { name: /^配音 · .*，需重配$/ })
    expect(stale()).toHaveLength(0)
    const field = within(panel()).getByRole('textbox', { name: '字幕文字 00:02.50 – 00:03.50' })
    await user.clear(field)
    await user.type(field, 'B again')
    await user.tab()
    await waitFor(() => expect(voiceButton('重配 1 句')).toBeVisible())
    expect(stale()).toEqual([screen.getByRole('group', { name: /^配音 · B two，/ })])

    await user.click(undoButton())
    await waitFor(() => expect(voiceButton('重新生成')).toBeVisible())
    expect(stale()).toHaveLength(0)
    await user.click(within(toolbar()).getByRole('button', { name: '重做' }))
    await user.click(await within(panel()).findByRole('button', { name: '重配 1 句' }))
    await waitFor(() => expect(sent).toHaveLength(3))
    expect(sent[2]).toMatchObject({
      sourceJobId: TAKE_A,
      lines: [{ startMs: 2_500, endMs: 3_500, text: 'B again' }],
    })
    await waitSaved(() =>
      expect(savedRecords().find((record) => record.caption === 'cap-b2')?.text).toBe('B again'),
    )
    expect(voiceButton('重新生成')).toBeVisible()
  })

  it('「原声 | 配音」来回切：写在主文件根上，各一步撤销，不发起；原声时时间线上不显示这种语言的配音片段；原文下看不到配音片段', async () => {
    const user = await open()
    const sent = serveDubbings()
    await dubWithOriginal(user)
    const dubClips = () => screen.queryAllByRole('group', { name: /^配音 · / })
    expect(dubClips()).toHaveLength(3)

    await user.click(modeButton('原声'))
    await waitSaved(() => expect(savedModes()).toBeNull())
    expect(dubClips()).toHaveLength(0)
    expect(screen.queryByRole('group', { name: '配音' })).toBeNull()
    expect(screen.getByText(KEEP_ORIGINAL_HINT)).toBeVisible()
    expect(savedDubs()).toHaveLength(3)
    // 再切回「配音」，配音片段都还在，不再生成
    await user.click(modeButton('配音'))
    await waitSaved(() => expect(savedModes()).toBe('{"en":{"mode":"dub","voice":null}}'))
    expect(savedDubs()).toHaveLength(3)
    expect(sent).toHaveLength(2)
    expect(dubClips()).toHaveLength(3)
    await user.click(undoButton())
    await waitSaved(() => expect(savedModes()).toBeNull())
    expect(dubClips()).toHaveLength(0)

    await user.click(within(languages()).getByRole('radio', { name: '原文' }))
    await waitFor(() =>
      expect(screen.queryAllByRole('group', { name: /^配音 · / })).toHaveLength(0),
    )
  })

  it('接口答 422：照原样提示它给的原因，不加配音；人声设置是切到配音时记下的', async () => {
    const user = await open()
    serveDubbings(() =>
      HttpResponse.json({ detail: '配音没有开通，暂时不能配音' }, { status: 422 }),
    )
    await user.click(modeButton('配音'))
    await user.click(voiceButton('生成配音'))
    await waitFor(() =>
      expect(screen.getAllByText(/的配音生成失败：配音没有开通，暂时不能配音$/)).toHaveLength(2),
    )
    expect(savedDubs()).toEqual([])
    expect(savedModes()).toBe('{"en":{"mode":"dub","voice":null}}')
    expect(voiceButton('生成配音')).toBeVisible()
  })

  it('一句都没翻：切到配音照样记下，「生成配音」置灰，点了说明先翻译，不发起', async () => {
    const user = await open({})
    const sent = serveDubbings()
    await user.click(modeButton('配音'))
    await waitSaved(() => expect(savedModes()).toBe('{"en":{"mode":"dub","voice":null}}'))
    expect(voiceButton('生成配音')).toHaveAttribute('aria-disabled', 'true')
    await user.click(voiceButton('生成配音'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('English')
    expect(sent).toEqual([])
  })

  it('默认音色浮层：首项「原片音色」打着「✓ 当前」；语种只列资料库里有的；按语种、性别、关键词筛（筛了以后不列原片音色）；选用只记下、收起浮层，不发起', async () => {
    resetMockReferenceAudios([])
    addMockReferenceAudio({ title: '旁白', gender: 'female' })
    const klaus = addMockReferenceAudio({
      title: 'Klaus',
      locale: 'de',
      gender: 'male',
      description: '沉稳的德语男声',
    })
    addMockReferenceAudio({ title: 'Emma', locale: 'en', gender: 'female' })
    addMockReferenceAudio({ title: 'Hans', locale: 'de', gender: 'male' })
    const user = await open()
    const sent = serveDubbings()
    await user.click(modeButton('配音'))
    await user.click(voiceButton('默认音色：原片音色'))
    const name = '选择默认音色'
    const pop = within(await screen.findByRole('dialog', { name }))
    expect(pop.getByRole('searchbox', { name: '搜索音色' })).toHaveFocus()
    expect(pop.getByRole('button', { name: '原片音色，当前' })).toBeVisible()
    await waitFor(() => expect(popVoices(name)).toEqual(['Hans', 'Emma', 'Klaus', '旁白']))
    await waitFor(() =>
      expect(
        within(pop.getByRole('radiogroup', { name: '语种' }))
          .getAllByRole('radio')
          .map((radio) => radio.textContent),
      ).toEqual(['全部', 'EN', 'DE', '多语']),
    )
    await user.click(pop.getByRole('radio', { name: 'DE' }))
    await waitFor(() => expect(popVoices(name)).toEqual(['Hans', 'Klaus', '旁白']))
    expect(pop.queryByRole('button', { name: /^原片音色/ })).toBeNull()
    await user.click(pop.getByRole('radio', { name: '男声' }))
    await waitFor(() => expect(popVoices(name)).toEqual(['Hans', 'Klaus']))
    await user.type(pop.getByRole('searchbox', { name: '搜索音色' }), '沉稳')
    await waitFor(() => expect(popVoices(name)).toEqual(['Klaus']))

    await user.click(pop.getByRole('button', { name: '选用：Klaus' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name })).toBeNull())
    await waitSaved(() => expect(savedModes()).toBe(`{"en":{"mode":"dub","voice":"${klaus}"}}`))
    expect(sent).toEqual([])
    expect(voiceButton('默认音色：Klaus')).toHaveFocus()
    expect(voiceButton('生成配音')).toBeVisible()
  })

  it('选音浮层：Esc、点外面都收起；收起时停下样音试听', async () => {
    resetMockReferenceAudios([])
    addMockReferenceAudio({ title: 'Emma', locale: 'en' })
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const user = await open()
    await user.click(modeButton('配音'))
    await user.click(voiceButton('默认音色：原片音色'))
    const pop = within(await screen.findByRole('dialog', { name: '选择默认音色' }))
    await user.click(await pop.findByRole('button', { name: '试听：Emma' }))
    expect(pop.getByRole('button', { name: '暂停试听：Emma' })).toBeVisible()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '选择默认音色' })).toBeNull())
    expect(pause).toHaveBeenCalled()

    await user.click(voiceButton('默认音色：原片音色'))
    expect(await screen.findByRole('dialog', { name: '选择默认音色' })).toBeVisible()
    await user.click(modeButton('配音'))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '选择默认音色' })).toBeNull())
  })

  it('资料库的音色作默认音色生成：参考是这个音色，旁白句也用它按文字合成；原声后再切回配音不重新生成；换成「原片音色」后跟着默认音色的句子都过期，「重配 N 句」用原声重配', async () => {
    resetMockReferenceAudios([])
    const emma = addMockReferenceAudio({ title: 'Emma', locale: 'en' })
    const user = await open()
    const sent = serveDubbings()
    await user.click(modeButton('配音'))
    await pickDefault(user, 'Emma')
    const dubbedWithEmma = `{"en":{"mode":"dub","voice":"${emma}"}}`
    await waitSaved(() => expect(savedModes()).toBe(dubbedWithEmma))
    expect(sent).toEqual([])
    await user.click(voiceButton('生成配音'))
    await waitFor(() => expect(sent).toHaveLength(2))
    expect(sent.map((body) => body.reference)).toEqual([
      { kind: 'reference_audio', referenceId: emma },
      { kind: 'reference_audio', referenceId: emma },
    ])
    // e5 是手动加的旁白句：有了库音色就按文字合成
    await waitFor(() => expect(speeches).toHaveLength(1))
    expect(speeches[0]).toEqual({
      conversationId: CONVERSATION,
      text: 'E five',
      locale: 'en',
      reference: { kind: 'reference_audio', referenceId: emma },
    })
    await waitSaved(() => expect(savedDubs()).toHaveLength(4))
    expect(voiceButton('默认音色：Emma')).toBeVisible()

    await user.click(modeButton('原声'))
    await waitSaved(() => expect(savedModes()).toBe(`{"en":{"mode":"original","voice":"${emma}"}}`))
    await user.click(modeButton('配音'))
    await waitSaved(() => expect(savedModes()).toBe(dubbedWithEmma))
    expect(sent).toHaveLength(2)

    await pickDefault(user, '原片音色')
    await waitSaved(() => expect(savedModes()).toBe('{"en":{"mode":"dub","voice":null}}'))
    expect(sent).toHaveLength(2)
    await user.click(voiceButton('重配 3 句'))
    await waitFor(() => expect(sent).toHaveLength(4))
    expect(
      sent
        .slice(2)
        .toSorted((left, right) => left.sourceJobId.localeCompare(right.sourceJobId))
        .map((body) => body.reference),
    ).toEqual([ORIGINAL_A, ORIGINAL_B])
    await waitSaved(() =>
      expect(savedRecords().filter((record) => record.voice === 'original')).toHaveLength(3),
    )
    expect(speeches).toHaveLength(1)
  })

  /** 字幕列表里第 `index` 句（按开始排：a1、d4、b2、c3、e5）。 */
  const captionRow = (index: number) => {
    const row = within(within(panel()).getByRole('list', { name: '字幕' })).getAllByRole(
      'listitem',
    )[index]
    if (row === undefined) throw new Error(`没有第 ${index + 1} 句`)
    return row
  }
  /** 第 `index` 句的音色按钮（自己选过时常驻写着音色名，跟随默认时是按意图显露的「音色 ⌄」）。 */
  const lineChip = (index: number) =>
    within(captionRow(index)).getByRole('button', { name: /^本句音色：/ })
  /** 给第 `index` 句打开选音浮层选 `name`：「跟随默认」「原片音色」「不配音」或资料库音色。 */
  const pickLineVoice = async (user: User, index: number, name: string) => {
    await user.click(lineChip(index))
    const pop = within(await screen.findByRole('dialog', { name: '选择本句音色' }))
    await user.click(
      ['跟随默认', '原片音色', '不配音'].includes(name)
        ? within(pop.getByRole('radiogroup', { name: '本句音色' })).getByRole('radio', {
            name: new RegExp(`^${name}`),
          })
        : await pop.findByRole('button', { name: `选用：${name}` }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '选择本句音色' })).toBeNull())
  }

  it('各句的音色按钮：原声时没有；配音时跟随默认的是「音色」，点了弹「选择本句音色」，最上面「跟随默认（原片音色）| 原片音色 | 不配音」，跟随的按下，列表里没有打「当前」的', async () => {
    resetMockReferenceAudios([])
    addMockReferenceAudio({ title: 'Emma', locale: 'en' })
    const user = await open()
    serveDubbings()
    expect(within(captionRow(0)).queryByRole('button', { name: /^本句音色：/ })).toBeNull()

    await dubWithOriginal(user)
    expect(lineChip(0)).toHaveAccessibleName('本句音色：跟随默认')
    expect(lineChip(0)).toHaveTextContent('音色')
    // 选音色只记下：还没翻的 d4、手动加的 e5 也能选
    expect(lineChip(1)).not.toHaveAttribute('aria-disabled')
    expect(lineChip(4)).not.toHaveAttribute('aria-disabled')

    await user.click(lineChip(2))
    const pop = within(await screen.findByRole('dialog', { name: '选择本句音色' }))
    const modes = within(pop.getByRole('radiogroup', { name: '本句音色' }))
    expect(modes.getAllByRole('radio').map((radio) => radio.textContent)).toEqual([
      '跟随默认（原片音色）',
      '原片音色',
      '不配音',
    ])
    expect(modes.getByRole('radio', { name: /^跟随默认/ })).toBeChecked()
    await waitFor(() => expect(popVoices('选择本句音色')).toEqual(['Emma']))
    expect(pop.queryByText('当前')).toBeNull()
    // 浮层没有「原片音色」那一行：单句的原片音色在最上面一排
    expect(pop.queryByRole('button', { name: /^原片音色，/ })).toBeNull()
  })

  it('给一句选资料库的音色：只记下、不发起，这句过期；「重配 1 句」只发这一句（带上限和这个音色），配好后换掉这句的配音、别的句子不动；撤销一步回到配之前', async () => {
    resetMockReferenceAudios([])
    const emma = addMockReferenceAudio({ title: 'Emma', locale: 'en' })
    const user = await open()
    const sent = serveDubbings()
    await dubWithOriginal(user)
    const before = savedDubs()

    await pickLineVoice(user, 0, 'Emma')
    const chosen = `{"en":{"mode":"dub","voice":null,"lines":{"cap-a1":{"voice":"${emma}"}}}}`
    await waitSaved(() => expect(savedModes()).toBe(chosen))
    expect(sent).toHaveLength(2)
    expect(lineChip(0)).toHaveAccessibleName('本句音色：Emma')
    expect(lineChip(0)).toHaveTextContent('Emma')
    // 这句过期：行里常驻琥珀色「重配」
    expect(within(captionRow(0)).getByRole('button', { name: '重配' })).toBeVisible()

    await user.click(voiceButton('重配 1 句'))
    await waitFor(() => expect(sent).toHaveLength(3))
    expect(sent[2]).toEqual({
      conversationId: CONVERSATION,
      sourceJobId: TAKE_A,
      locale: 'en',
      lines: [{ startMs: 0, endMs: 1_000, text: 'A one', slotEndMs: 2_500 }],
      reference: { kind: 'reference_audio', referenceId: emma },
    })
    await waitSaved(() =>
      expect(savedRecords().find((record) => record.caption === 'cap-a1')?.voice).toBe(emma),
    )
    expect(savedDubs().map((dub) => dub.caption)).toEqual(['cap-a1', 'cap-b2', 'cap-c3'])
    expect(lineChip(2)).toHaveAccessibleName('本句音色：跟随默认')
    expect(voiceButton('重新生成')).toBeVisible()

    await user.click(undoButton())
    await waitSaved(() => expect(savedDubs()).toEqual(before))
    expect(savedModes()).toBe(chosen)
  })

  it('给一句选「不配音」：不发起，删掉这句的配音、记下选择，一步撤销都回去；删掉这句字幕时选择一起去掉，撤销时一起回来', async () => {
    const user = await open()
    const sent = serveDubbings()
    await dubWithOriginal(user)
    const unvoiced = '{"en":{"mode":"dub","voice":null,"lines":{"cap-b2":{"dub":false}}}}'

    await pickLineVoice(user, 2, '不配音')
    await waitSaved(() =>
      expect(savedDubs().map((dub) => dub.caption)).toEqual(['cap-a1', 'cap-c3']),
    )
    expect(savedModes()).toBe(unvoiced)
    expect(sent).toHaveLength(2)
    expect(lineChip(2)).toHaveAccessibleName('本句音色：不配音')
    expect(lineChip(2)).toHaveTextContent('不配音')
    await user.click(undoButton())
    await waitSaved(() => expect(savedDubs()).toHaveLength(3))
    expect(savedModes()).toBe('{"en":{"mode":"dub","voice":null}}')

    await user.click(within(toolbar()).getByRole('button', { name: '重做' }))
    await waitSaved(() => expect(savedModes()).toBe(unvoiced))
    await user.click(within(captionRow(2)).getByRole('button', { name: /^删除 / }))
    await waitSaved(() => expect(savedModes()).toBe('{"en":{"mode":"dub","voice":null}}'))
    await user.click(undoButton())
    await waitSaved(() => expect(savedModes()).toBe(unvoiced))
  })

  /**
   * 第二句 d4 翻了、选了不配音，第一句 a1 已有一个 English 配音片段（0–2 秒，占过了 d4 的开始）；打开以后给 d4
   * 选回跟随整体音色（只记下），再点「重配 1 句」。
   */
  const voiceSkippedLine = async () => {
    const user = await open(
      { cap_a1: 'A one', cap_d4: 'D four', cap_b2: 'B two', cap_c3: 'C three' },
      {
        dubs: [
          audio({
            id: 'dub-a1',
            label: '配音 · A one',
            src: DUB_URL(TAKE_A),
            duration: 2_000,
            dub: legacyDub('en', 'cap-a1'),
          }),
        ],
        modes: '{"en":{"mode":"dub","voice":null,"lines":{"cap-d4":{"dub":false}}}}',
      },
    )
    const sent = serveDubbings()
    await pickLineVoice(user, 1, '跟随默认')
    await waitSaved(() => expect(savedModes()).toBe('{"en":{"mode":"dub","voice":null}}'))
    expect(sent).toEqual([])
    // a1 的配音片段没有记录（老的），不算过期；b2、c3 还没配，d4 改回了配音：都待处理
    await user.click(voiceButton('重配 3 句'))
    await waitFor(() => expect(sent).toHaveLength(2))
    return user
  }

  it('不配音的一句改回配音、配好以后：前一句的配音收短到它的开始、标成截短，两个片段在同一条配音行', async () => {
    await voiceSkippedLine()
    await waitSaved(() =>
      expect(
        savedDubs()
          .filter((dub) => ['cap-a1', 'cap-d4'].includes(dub.caption ?? ''))
          .map(({ caption, start, duration, trimmed }) => ({
            caption,
            start,
            duration,
            trimmed,
          })),
      ).toEqual([
        { caption: 'cap-a1', start: 0, duration: 1.2, trimmed: true },
        // 下一句 b2 在素材里从 2.5 秒开始，但前半段只到 2 秒
        { caption: 'cap-d4', start: 1.2, duration: 0.8, trimmed: true },
      ]),
    )
    expect(screen.queryByRole('group', { name: '配音 2' })).toBeNull()
    expect(
      within(screen.getByRole('group', { name: '配音' })).getAllByRole('group', {
        name: /^配音 · /,
      }),
    ).toHaveLength(4)
  })

  it('不配音的一句改回配音、配好以后撤销一次：回到配之前，前一句的配音照原样', async () => {
    const user = await voiceSkippedLine()
    await waitSaved(() => expect(savedDubs()).toHaveLength(4))
    await user.click(undoButton())
    await waitSaved(() =>
      expect(savedDubs()).toEqual([
        {
          caption: 'cap-a1',
          locale: 'en',
          start: 0,
          duration: 2,
          mediaStart: 0,
          rate: null,
          src: DUB_URL(TAKE_A),
          trimmed: false,
        },
      ]),
    )
    expect(savedModes()).toBe('{"en":{"mode":"dub","voice":null}}')
  })

  it('有句子单独选过时：换默认音色只让跟着它的句子过期，「重配 N 句」只配它们；「重新生成」各用各的音色，不配音的不配', async () => {
    resetMockReferenceAudios([])
    const emma = addMockReferenceAudio({ title: 'Emma', locale: 'en' })
    const user = await open()
    const sent = serveDubbings()
    await dubWithOriginal(user)
    await pickLineVoice(user, 2, '不配音')
    await waitSaved(() => expect(savedDubs()).toHaveLength(2))
    // c3 本来就是原片音色、有配音：只记下它自己选了原片音色，不过期
    await pickLineVoice(user, 3, '原片音色')
    await waitSaved(() => expect(savedModes()).toContain('"cap-c3":{"voice":null}'))

    // 跟着默认音色的 a1 过期，e5 有了库音色要配；b2 不配音，a1 后面没有要配的素材片句子，不写上限
    await pickDefault(user, 'Emma')
    await waitSaved(() =>
      expect(JSON.parse(savedModes() ?? 'null')).toEqual({
        en: {
          mode: 'dub',
          voice: emma,
          lines: { 'cap-b2': { dub: false }, 'cap-c3': { voice: null } },
        },
      }),
    )
    expect(sent).toHaveLength(2)
    await user.click(voiceButton('重配 2 句'))
    await waitFor(() => expect(sent).toHaveLength(3))
    expect(sent[2]).toMatchObject({
      sourceJobId: TAKE_A,
      reference: { kind: 'reference_audio', referenceId: emma },
    })
    expect(sent[2]?.lines).toEqual([{ startMs: 0, endMs: 1_000, text: 'A one' }])
    await waitFor(() => expect(speeches.map((body) => body.text)).toEqual(['E five']))
    await waitSaved(() => expect(savedDubs()).toHaveLength(3))

    await user.click(voiceButton('重新生成'))
    await waitFor(() => expect(sent).toHaveLength(5))
    expect(
      sent
        .slice(3)
        .map(({ sourceJobId, lines, reference }) => ({ sourceJobId, lines, reference }))
        .toSorted((left, right) => left.sourceJobId.localeCompare(right.sourceJobId)),
    ).toEqual(
      [
        {
          sourceJobId: TAKE_A,
          lines: [{ startMs: 0, endMs: 1_000, text: 'A one' }],
          reference: { kind: 'reference_audio', referenceId: emma },
        },
        {
          sourceJobId: TAKE_B,
          lines: [{ startMs: 900, endMs: 1_900, text: 'C three' }],
          reference: ORIGINAL_B,
        },
      ].toSorted((left, right) => left.sourceJobId.localeCompare(right.sourceJobId)),
    )
    await waitFor(() => expect(speeches).toHaveLength(2))
    await waitSaved(() =>
      expect(savedDubs().map((dub) => dub.caption)).toEqual(['cap-a1', 'cap-c3', 'cap-e5']),
    )
  })

  it('给一句选的音色和它现在用的一样：只改记着的选择，不过期，一步撤销', async () => {
    resetMockReferenceAudios([])
    const emma = addMockReferenceAudio({ title: 'Emma', locale: 'en' })
    const user = await open()
    const sent = serveDubbings()
    await user.click(modeButton('配音'))
    await pickDefault(user, 'Emma')
    await user.click(voiceButton('生成配音'))
    const following = `{"en":{"mode":"dub","voice":"${emma}"}}`
    await waitSaved(() => expect(savedDubs()).toHaveLength(4))
    const dubs = savedDubs()

    await pickLineVoice(user, 0, 'Emma')
    const own = `{"en":{"mode":"dub","voice":"${emma}","lines":{"cap-a1":{"voice":"${emma}"}}}}`
    await waitSaved(() => expect(savedModes()).toBe(own))
    expect(lineChip(0)).toHaveAccessibleName('本句音色：Emma')
    expect(voiceButton('重新生成')).toBeVisible()
    await pickLineVoice(user, 0, '跟随默认')
    await waitSaved(() => expect(savedModes()).toBe(following))
    expect(lineChip(0)).toHaveAccessibleName('本句音色：跟随默认')
    await user.click(undoButton())
    await waitSaved(() => expect(savedModes()).toBe(own))
    expect(sent).toHaveLength(2)
    expect(savedDubs()).toEqual(dubs)
  })

  it('合成中：主按钮换成转圈和还剩几句、不能点，合成中的句子各一个小转圈；各句照样能选音色（只记下）；结束后「重新生成」又能点', async () => {
    const user = await open()
    serveDubbings()
    await dubWithOriginal(user)
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let posted = 0
    server.use(
      http.post('*/api/generations/dubbings', async () => {
        posted += 1
        await held
        return HttpResponse.json({ detail: '配音没有开通，暂时不能配音' }, { status: 422 })
      }),
    )

    await user.click(voiceButton('重新生成'))
    expect(
      await within(panel()).findByRole('status', { name: '正在生成配音，还剩 3 句' }),
    ).toHaveTextContent(/还剩 3 句/)
    expect(within(panel()).queryByRole('button', { name: '重新生成' })).toBeNull()
    expect(within(captionRow(0)).getByRole('img', { name: '本句配音合成中' })).toBeVisible()
    expect(posted).toBe(2)
    await pickLineVoice(user, 0, '不配音')
    await waitSaved(() => expect(savedModes()).toContain('"cap-a1":{"dub":false}'))
    expect(posted).toBe(2)

    release()
    await waitFor(() => expect(voiceButton('重新生成')).not.toHaveAttribute('aria-disabled'))
  })

  it('单句试听：点「试听本句配音」放这句的配音片段（从它在音轨里的起点、按它的倍速），行内展开进度条，再点暂停', async () => {
    const played: { src: string | null; at: number; rate: number }[] = []
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (
      this: HTMLMediaElement,
    ) {
      played.push({ src: this.getAttribute('src'), at: this.currentTime, rate: this.playbackRate })
      return Promise.resolve()
    })
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const user = await open()
    serveDubbings()
    await dubWithOriginal(user)

    // c3：音轨里从 0.9 秒起、2 倍速
    await user.click(within(captionRow(3)).getByRole('button', { name: '试听本句配音' }))
    expect(played).toEqual([{ src: DUB_URL(TAKE_B), at: 0.9, rate: 2 }])
    expect(within(captionRow(3)).getByRole('slider', { name: /^本句配音播放进度/ })).toBeVisible()
    await user.click(within(captionRow(3)).getByRole('button', { name: '暂停本句配音试听' }))
    expect(pause).toHaveBeenCalled()
    expect(within(captionRow(3)).getByRole('button', { name: '试听本句配音' })).toBeVisible()

    // 试听着切到原文：这句的配音不在列表里了，停下
    await user.click(within(captionRow(3)).getByRole('button', { name: '试听本句配音' }))
    pause.mockClear()
    await user.click(within(languages()).getByRole('radio', { name: '原文' }))
    await waitFor(() => expect(pause).toHaveBeenCalled())
  })

  it('单句浮层选资料库的音色：只记下、收起，行里常驻写着音色名；「重配 1 句」只配这一句', async () => {
    resetMockReferenceAudios([])
    const klaus = addMockReferenceAudio({ title: 'Klaus', locale: 'de' })
    const user = await open()
    const sent = serveDubbings()
    await dubWithOriginal(user)

    await pickLineVoice(user, 0, 'Klaus')
    await waitSaved(() =>
      expect(savedModes()).toBe(
        `{"en":{"mode":"dub","voice":null,"lines":{"cap-a1":{"voice":"${klaus}"}}}}`,
      ),
    )
    expect(sent).toHaveLength(2)
    expect(lineChip(0)).toHaveTextContent('Klaus')
    expect(lineChip(2)).toHaveAccessibleName('本句音色：跟随默认')

    await user.click(voiceButton('重配 1 句'))
    await waitFor(() => expect(sent).toHaveLength(3))
    expect(sent[2]).toMatchObject({
      sourceJobId: TAKE_A,
      lines: [{ startMs: 0, endMs: 1_000, text: 'A one', slotEndMs: 2_500 }],
      reference: { kind: 'reference_audio', referenceId: klaus },
    })
    await waitSaved(() =>
      expect(savedRecords().find((record) => record.caption === 'cap-a1')?.voice).toBe(klaus),
    )
  })

  const sideTabs = () =>
    within(screen.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' }))
  /** 「属性」里配音片段的「音色」那一行的按钮。 */
  const inspectorVoice = () =>
    within(screen.getByRole('tabpanel', { name: '属性' })).getByRole('button', {
      name: /^音色：/,
    })
  /** 在时间线上选中 a1 的配音片段，切到「属性」。 */
  const inspectDub = async (user: User) => {
    await user.click(screen.getByRole('button', { name: /^选中：配音 · A one，/ }))
    await user.click(sideTabs().getByRole('tab', { name: '属性' }))
  }

  it('「属性」里点配音片段的「音色」：弹出选本句音色的浮层，最上面「跟随默认 | 原片音色 | 不配音」；选资料库的音色只记下、不发起，浮层收起，「音色」换成它，焦点回到这个按钮', async () => {
    resetMockReferenceAudios([])
    const emma = addMockReferenceAudio({ title: 'Emma', locale: 'en' })
    const user = await open()
    const sent = serveDubbings()
    await dubWithOriginal(user)
    await inspectDub(user)
    expect(inspectorVoice()).toHaveAccessibleName('音色：原片音色')

    await user.click(inspectorVoice())
    const pop = within(await screen.findByRole('dialog', { name: '选择本句音色' }))
    expect(
      within(pop.getByRole('radiogroup', { name: '本句音色' }))
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['跟随默认（原片音色）', '原片音色', '不配音'])
    await user.click(await pop.findByRole('button', { name: '选用：Emma' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '选择本句音色' })).toBeNull())
    await waitSaved(() =>
      expect(savedModes()).toBe(
        `{"en":{"mode":"dub","voice":null,"lines":{"cap-a1":{"voice":"${emma}"}}}}`,
      ),
    )
    expect(sent).toHaveLength(2)
    expect(speeches).toEqual([])
    expect(inspectorVoice()).toHaveAccessibleName('音色：Emma')
    expect(inspectorVoice()).toHaveFocus()
  })

  it('「属性」里弹着选音浮层时换到别的页签：浮层收起，切回「属性」也不再弹', async () => {
    resetMockReferenceAudios([])
    addMockReferenceAudio({ title: 'Emma', locale: 'en' })
    const user = await open()
    serveDubbings()
    await dubWithOriginal(user)
    await inspectDub(user)
    await user.click(inspectorVoice())
    expect(await screen.findByRole('dialog', { name: '选择本句音色' })).toBeVisible()

    await user.click(sideTabs().getByRole('tab', { name: /^字幕/ }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '选择本句音色' })).toBeNull())
    await user.click(sideTabs().getByRole('tab', { name: '属性' }))
    expect(inspectorVoice()).toBeVisible()
    expect(screen.queryByRole('dialog', { name: '选择本句音色' })).toBeNull()
  })
})

describe('final-cut 编辑器 · 旁白配音', () => {
  const EN_FILE = 'final-cut/locales/en.json'
  const SPEECH_URL = 'https://media.test/speech.m4a'
  const panel = () => screen.getByRole('tabpanel', { name: /^字幕/ })
  const languages = () => within(toolbar()).getByRole('radiogroup', { name: '语言' })
  const narrationClips = () => screen.queryAllByRole('group', { name: /^旁白 · / })

  /** 存下来的主文件里的配音片段：配的哪句、语言、起止（秒）、音色、念的字、地址。 */
  const savedDubs = () =>
    [
      ...new DOMParser()
        .parseFromString(savedFilm(), 'text/html')
        .querySelectorAll('audio[data-dub-of]'),
    ].map((element) => ({
      caption: element.getAttribute('data-dub-of'),
      locale: element.getAttribute('data-locale'),
      start: Number(element.getAttribute('data-start')),
      duration: Number(element.getAttribute('data-duration')),
      voice: element.getAttribute('data-dub-voice'),
      text: element.getAttribute('data-dub-text'),
      src: element.getAttribute('src'),
    }))

  /** 合成接口：记下请求体，答复排队中的记录；之后读到的是合成好的那一条（1.5 秒）。 */
  const serveSpeeches = () => {
    const records: GenerationJob[] = []
    const sent: Record<string, unknown>[] = []
    server.use(
      http.get('*/api/generations', ({ request }) =>
        new URL(request.url).searchParams.get('kind') === 'speech'
          ? HttpResponse.json({ items: records })
          : undefined,
      ),
      http.post('*/api/generations/speeches', async ({ request }) => {
        sent.push((await request.json()) as Record<string, unknown>)
        const id = crypto.randomUUID()
        records.unshift(
          makeGenerationJob({ id, kind: 'speech', outputUrl: SPEECH_URL, durationMs: 1_500 }),
        )
        return HttpResponse.json(
          { generation: makeGenerationJob({ id, kind: 'speech', status: 'submitted' }) },
          { status: 202 },
        )
      }),
    )
    return sent
  }

  /** 旁白片段：配 `cap-n1`（2–3 秒），用音色 `voice`（老的旁白片段，没有记录）。 */
  const narration = (voice: string) =>
    audio({
      id: 'narr-1',
      label: '旁白 · 欢迎光临',
      src: SPEECH_URL,
      start: 2_000,
      duration: 1_000,
      dub: legacyDub(null, 'cap-n1', voice),
    })

  /**
   * 工程：素材 A 一段（0–4 秒），字幕 a1（0–1 秒）属于它；给了 `voice` 时还有一句旁白 n1（2–3 秒），`voice` 是音色时
   * 再加它用这个音色的旁白片段（null 时没有旁白片段、也没选音色），`dubbed` 时再加 n1 的 English 配音（记着念的是旧的字，已经过期）、English 是 AI 配音。打开编辑器，切到
   * 「字幕」页签。
   */
  const open = async ({
    voice,
    dubbed = false,
  }: { voice?: string | null; dubbed?: boolean } = {}) => {
    const lines = [sceneLine('a1', 0, 1_000, 'clip-1')]
    const clips: FilmClip[] = [video({ src: URL_A, duration: 4_000 })]
    if (voice !== undefined) lines.push(sceneLine('n1', 2_000, 1_000))
    if (typeof voice === 'string') clips.push(narration(voice))
    if (dubbed)
      clips.push(
        audio({
          id: 'narr-en',
          label: '配音 · Welcome',
          src: 'https://media.test/speech-en.m4a',
          start: 2_000,
          duration: 1_000,
          dub: { ...legacyDub('en', 'cap-n1'), text: 'Old welcome', voice: 'v-own' },
        }),
      )
    await putFilm(clips, lines, dubbed ? '{"en":{"mode":"dub","voice":null}}' : undefined)
    putMockWorkspaceFile(
      CONVERSATION,
      EN_FILE,
      JSON.stringify({ cap_a1: 'A one', cap_n1: 'Welcome' }),
    )
    const user = userEvent.setup()
    await openEditor()
    await previewSettled()
    await shot(/^出片 A 镜头 1，/)
    await user.click(
      within(
        screen.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' }),
      ).getByRole('tab', { name: /^字幕/ }),
    )
    return user
  }

  it('原文原声下手动加的旁白句：属于视频片段的句子没有音色按钮；给旁白句选资料库音色只记下，行里常驻音色名和琥珀色「配音」，点它按文字合成（不带语言），写成记着字和音色的旁白片段', async () => {
    resetMockReferenceAudios([])
    const emma = addMockReferenceAudio({ title: 'Emma' })
    const user = await open({ voice: null })
    const sent = serveSpeeches()
    const rows = () =>
      within(within(panel()).getByRole('list', { name: '字幕' })).getAllByRole('listitem')
    const [owned, narrated] = rows()
    if (owned === undefined || narrated === undefined) throw new Error('应有两句字幕')
    expect(within(owned).queryByRole('button', { name: /^本句音色/ })).toBeNull()

    await user.click(within(narrated).getByRole('button', { name: '本句音色：跟随默认' }))
    const pop = within(await screen.findByRole('dialog', { name: '选择本句音色' }))
    // 原文原声时没有默认音色可跟：第一段不写音色名
    expect(
      within(pop.getByRole('radiogroup', { name: '本句音色' })).getAllByRole('radio')[0],
    ).toHaveTextContent(/^跟随默认$/)
    await user.click(await pop.findByRole('button', { name: '选用：Emma' }))
    const savedModes = () =>
      new DOMParser()
        .parseFromString(savedFilm(), 'text/html')
        .getElementById('film')
        ?.getAttribute('data-voice-modes') ?? null
    await waitSaved(() =>
      expect(JSON.parse(savedModes() ?? 'null')).toMatchObject({
        _source: { lines: { 'cap-n1': { voice: emma } } },
      }),
    )
    expect(sent).toEqual([])
    expect(within(narrated).getByRole('button', { name: '本句音色：Emma' })).toHaveTextContent(
      'Emma',
    )

    await user.click(within(narrated).getByRole('button', { name: '配音' }))
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toMatchObject({
      conversationId: CONVERSATION,
      text: '字幕 n1',
      reference: { kind: 'reference_audio', referenceId: emma },
    })
    expect(sent[0]).not.toHaveProperty('locale')
    await waitSaved(() =>
      expect(savedDubs()).toEqual([
        {
          caption: 'cap-n1',
          locale: null,
          start: 2,
          duration: expect.any(Number),
          voice: emma,
          text: '字幕 n1',
          src: SPEECH_URL,
        },
      ]),
    )
  })

  it('切到 AI 配音的语言：时间线上不显示原文的旁白，显示这种语言给它配的音', async () => {
    const user = await open({ voice: 'v-own', dubbed: true })
    expect(narrationClips()).toHaveLength(1)

    await user.click(within(languages()).getByRole('radio', { name: 'English（EN）' }))

    await waitFor(() => expect(narrationClips()).toHaveLength(0))
    expect(screen.getByRole('group', { name: /^配音 · Welcome/ })).toBeVisible()
  })

  it('AI 配音的语言下「重配 N 句」：过期的旁白这句按译文合成，音色取「原声」时用旁白记着的音色，配好换掉它原来的配音、记下用的音色', async () => {
    const user = await open({ voice: 'v-own', dubbed: true })
    const sent = serveSpeeches()
    server.use(
      http.post('*/api/generations/dubbings', () =>
        HttpResponse.json({ detail: '配音没有开通，暂时不能配音' }, { status: 422 }),
      ),
    )
    await user.click(within(languages()).getByRole('radio', { name: 'English（EN）' }))

    // a1 还没配，n1 记着的字是旧的：两句待处理
    await user.click(await within(panel()).findByRole('button', { name: '重配 2 句' }))

    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toEqual({
      conversationId: CONVERSATION,
      text: 'Welcome',
      locale: 'en',
      reference: { kind: 'reference_audio', referenceId: 'v-own' },
    })
    await waitSaved(() =>
      expect(savedDubs().filter((dub) => dub.locale === 'en')).toEqual([
        {
          caption: 'cap-n1',
          locale: 'en',
          start: 2,
          duration: 1.5,
          voice: 'v-own',
          text: 'Welcome',
          src: SPEECH_URL,
        },
      ]),
    )
  })

  it('删掉有旁白的那句字幕：旁白片段一起删', async () => {
    const user = await open({ voice: 'v-own' })

    await user.click(
      within(panel()).getByRole('button', { name: '删除 00:02.00 – 00:03.00 的字幕' }),
    )

    await waitSaved(() => expect(savedDubs()).toEqual([]))
    expect(savedSceneLines()).toEqual([['字幕 a1', 0, 1, 'clip-1']])
  })
})
