import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { addMockReferenceAudio, resetMockReferenceAudios } from '@/testing/mocks/reference-audios'
import { server } from '@/testing/mocks/server'
import { mockWorkspaceFile, putMockWorkspaceFile } from '@/testing/mocks/workspace'
import { audio, video } from '@/testing/final-cut'
import {
  CONVERSATION,
  SCENE_FILE,
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
import type { FilmClip } from './composition/film'

vi.mock('mediabunny', async () => (await import('@/testing/final-cut-media')).mediabunnyMock())

// 一条用例要开整个编辑器、走完一串操作，上限放宽到 15 秒
vi.setConfig({ testTimeout: 15_000 })

beforeEach(setUpEditorCase)
afterEach(tearDownEditorCase)

describe('final-cut 编辑器 · 配音', () => {
  const EN_FILE = 'final-cut/locales/en.json'
  const DUB_URL = (source: string) => `https://media.test/dub-${source}.m4a`
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
  const languages = () => within(toolbar()).getByRole('group', { name: '语言' })
  const panel = () => screen.getByRole('tabpanel', { name: '字幕' })
  const voiceRow = () => within(panel()).getByRole('group', { name: '人声设置' })
  /** 人声设置里的按钮：「保留原声」「重新生成」和音色小块（「原声」、资料库里的各个音色）。 */
  const voiceButton = (name: string) => within(panel()).getByRole('button', { name })
  /** 音色小块的名字，按先后（不算试听键）。 */
  const voiceChips = () =>
    within(within(panel()).getByRole('group', { name: 'AI 配音音色' }))
      .getAllByRole('button', { name: /^(?!(暂停)?试听：)/ })
      .map((button) => button.textContent)

  /** 存下来的主文件里的配音片段：配的哪句、语言、起止、入点（秒）、速度、地址、截没截尾。 */
  const savedDubs = () =>
    [
      ...new DOMParser()
        .parseFromString(savedFilm(), 'text/html')
        .querySelectorAll('audio[data-dub-of]'),
    ]
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

  const savedModes = () =>
    new DOMParser()
      .parseFromString(savedFilm(), 'text/html')
      .getElementById('film')
      ?.getAttribute('data-voice-modes') ?? null

  /**
   * 配音接口：记下每次请求的素材片、语言、各句和参考音频，答复一条排队中的记录；之后读到的是 `outcome` 给的那一条
   * （默认配好：音轨地址按素材片取，素材片总长 6 秒，第一句截了尾）。`reply` 给了时发起就答它。
   */
  const serveDubbings = (reply?: () => Response) => {
    const records: GenerationJob[] = []
    const sent: { sourceJobId: string; locale: string; lines: unknown; reference: unknown }[] = []
    server.use(
      http.get('*/api/generations', ({ request }) => {
        const params = new URL(request.url).searchParams
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
            dubbedLines: lines.map((_, index) => ({ index, speed: 1, trimmed: index === 0 })),
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
    )
    return sent
  }

  /**
   * 工程：素材 A 切成两半（0–2 秒、2–4 秒，后半段从素材的第 2 秒起），素材 B 一段（4–5.5 秒，从素材的第 0.5 秒
   * 起、2 倍速）；字幕 a1、d4 属于前半段，b2 属于后半段，c3 属于 B，e5 是手动加的。English 的值表是 `english`
   * （默认翻了 a1、b2、c3、e5，没翻 d4）；`dubs` 是已有的配音片段，`modes` 是已有的人声设置。打开编辑器，切到
   * 「字幕」页签和 English。
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
        screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐、字幕和属性' }),
      ).getByRole('tab', { name: '字幕' }),
    )
    await user.click(within(languages()).getByRole('button', { name: 'English（EN）' }))
    await waitFor(() => expect(voiceRow()).toBeVisible())
    return user
  }

  it('原文下没有人声设置；English 下默认保留原声，点音色「原声」每条素材片发起一次，字幕时间换算到素材片里（切开、入点、变速），没翻的、手动加的不配，参考用原声', async () => {
    const user = await open()
    const sent = serveDubbings()
    expect(voiceButton('保留原声')).toHaveAttribute('aria-pressed', 'true')
    expect(voiceButton('原声')).toHaveAttribute('aria-pressed', 'false')
    await user.click(voiceButton('原声'))
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
    // 等配好的配音存下来再结束：卸载时没存的改动会存进同一份模拟的工作区，碰上下一条用例
    await waitSaved(() => expect(savedDubs()).toHaveLength(3))

    await user.click(within(languages()).getByRole('button', { name: '原文' }))
    expect(within(panel()).queryByRole('group', { name: '人声设置' })).toBeNull()
  })

  it('配好后每句一个配音片段：在配音行上和字幕对齐，从这句在素材片里的开始放、跟着视频片段的速度，占到下一句、不超出视频片段；截了尾的标出来；切到 AI 配音，一步撤销都回去', async () => {
    const user = await open()
    serveDubbings()
    await user.click(voiceButton('原声'))
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
    expect(savedModes()).toBe('{"en":{"mode":"dub","voice":null}}')
    expect((await screen.findAllByText('已生成 3 句 English 配音')).length).toBeGreaterThan(0)
    expect((await screen.findAllByText(/2.*截短/)).length).toBeGreaterThan(0)
    expect(voiceButton('原声')).toHaveAttribute('aria-pressed', 'true')
    const row = screen.getByRole('group', { name: '配音' })
    expect(within(row).getByRole('group', { name: /^配音 · A one，2\.0 秒，截短$/ })).toBeVisible()
    expect(within(row).getByRole('group', { name: /^配音 · B two，1\.5 秒$/ })).toBeVisible()

    await user.click(undoButton())
    await waitSaved(() => expect(savedDubs()).toEqual([]))
    expect(savedModes()).toBeNull()
  })

  it('保留原声、AI 配音来回切：写在主文件根上，各一步撤销；保留原声时时间线上不显示这种语言的配音片段；原文下看不到配音片段', async () => {
    const user = await open()
    const sent = serveDubbings()
    await user.click(voiceButton('原声'))
    await waitSaved(() => expect(savedDubs()).toHaveLength(3))
    const dubClips = () => screen.queryAllByRole('group', { name: /^配音 · / })
    expect(dubClips()).toHaveLength(3)

    await user.click(voiceButton('保留原声'))
    await waitSaved(() => expect(savedModes()).toBeNull())
    expect(dubClips()).toHaveLength(0)
    expect(screen.queryByRole('group', { name: '配音' })).toBeNull()
    expect(savedDubs()).toHaveLength(3)
    // 有用「原声」配好的配音时再点它只是切回去，不再生成
    await user.click(voiceButton('原声'))
    await waitSaved(() => expect(savedModes()).toBe('{"en":{"mode":"dub","voice":null}}'))
    expect(savedDubs()).toHaveLength(3)
    expect(sent).toHaveLength(2)
    expect(dubClips()).toHaveLength(3)
    await user.click(undoButton())
    await waitSaved(() => expect(savedModes()).toBeNull())
    expect(dubClips()).toHaveLength(0)

    await user.click(within(languages()).getByRole('button', { name: '原文' }))
    await waitFor(() =>
      expect(screen.queryAllByRole('group', { name: /^配音 · / })).toHaveLength(0),
    )
  })

  it('接口答 422：照原样提示它给的原因，不加配音、不切到 AI 配音', async () => {
    const user = await open()
    serveDubbings(() =>
      HttpResponse.json({ detail: '配音没有开通，暂时不能配音' }, { status: 422 }),
    )
    await user.click(voiceButton('原声'))
    await waitFor(() =>
      expect(screen.getAllByText(/的配音生成失败：配音没有开通，暂时不能配音$/)).toHaveLength(2),
    )
    expect(savedDubs()).toEqual([])
    expect(voiceButton('保留原声')).toHaveAttribute('aria-pressed', 'true')
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
  })

  it('一句都没翻：音色「原声」置灰，点了说明先翻译，不发起', async () => {
    const user = await open({})
    const sent = serveDubbings()
    expect(voiceButton('原声')).toHaveAttribute('aria-disabled', 'true')
    await user.click(voiceButton('原声'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('English')
    expect(sent).toEqual([])
  })

  it('资料库里的音色排在「原声」后面：只列语种是这种语言的和没设语种的', async () => {
    resetMockReferenceAudios([
      { title: '旁白', locale: null },
      { title: 'Klaus', locale: 'de' },
      { title: 'Emma', locale: 'en' },
      { title: '吉他', audioKind: 'bgm' },
    ])
    await open()
    await waitFor(() => expect(voiceChips()).toEqual(['原声', 'Emma', '旁白']))
  })

  it('资料库里没有音色：只有「原声」一个小块', async () => {
    resetMockReferenceAudios([])
    let voicesRead = false
    server.events.on('response:mocked', ({ request }) => {
      if (new URL(request.url).searchParams.get('audioKind') === 'voice') voicesRead = true
    })
    await open()
    // 音色读完以后也只有「原声」
    await waitFor(() => expect(voicesRead).toBe(true))
    expect(voiceChips()).toEqual(['原声'])
  })

  it('点资料库里的音色生成：参考是这个音色，主文件记着它；保留原声后再点它只切回去、不再发起；换成「原声」重新生成并换掉', async () => {
    resetMockReferenceAudios([])
    const emma = addMockReferenceAudio({ title: 'Emma', locale: 'en' })
    const user = await open()
    const sent = serveDubbings()
    await user.click(await within(panel()).findByRole('button', { name: 'Emma' }))
    await waitFor(() => expect(sent).toHaveLength(2))
    expect(sent.map((body) => body.reference)).toEqual([
      { kind: 'reference_audio', referenceId: emma },
      { kind: 'reference_audio', referenceId: emma },
    ])
    const dubbedWithEmma = `{"en":{"mode":"dub","voice":"${emma}"}}`
    await waitSaved(() => expect(savedModes()).toBe(dubbedWithEmma))
    expect(savedDubs()).toHaveLength(3)
    expect(voiceButton('Emma')).toHaveAttribute('aria-pressed', 'true')
    expect(voiceButton('原声')).toHaveAttribute('aria-pressed', 'false')

    await user.click(voiceButton('保留原声'))
    await waitSaved(() => expect(savedModes()).toBe(`{"en":{"mode":"original","voice":"${emma}"}}`))
    await user.click(voiceButton('Emma'))
    await waitSaved(() => expect(savedModes()).toBe(dubbedWithEmma))
    expect(sent).toHaveLength(2)
    expect(savedDubs()).toHaveLength(3)

    await user.click(voiceButton('原声'))
    await waitFor(() => expect(sent).toHaveLength(4))
    expect(
      sent
        .slice(2)
        .toSorted((left, right) => left.sourceJobId.localeCompare(right.sourceJobId))
        .map((body) => body.reference),
    ).toEqual([ORIGINAL_A, ORIGINAL_B])
    await waitSaved(() => expect(savedModes()).toBe('{"en":{"mode":"dub","voice":null}}'))
    expect(savedDubs()).toHaveLength(3)
  })

  /** 字幕列表里第 `index` 句（按开始排：a1、d4、b2、c3、e5）。 */
  const captionRow = (index: number) => {
    const row = within(within(panel()).getByRole('list', { name: '字幕' })).getAllByRole(
      'listitem',
    )[index]
    if (row === undefined) throw new Error(`没有第 ${index + 1} 句`)
    return row
  }
  /** 第 `index` 句右上的配音小块。 */
  const lineChip = (index: number) =>
    within(captionRow(index)).getByRole('button', { name: /^本句配音：/ })
  type User = ReturnType<typeof userEvent.setup>
  /** 给第 `index` 句在菜单里选 `name`。 */
  const pickLineVoice = async (user: User, index: number, name: string) => {
    await user.click(lineChip(index))
    await user.click(await screen.findByRole('menuitemradio', { name }))
  }
  /** 用「原声」配好 English：a1、b2、c3 各一个配音片段，等它存下来。 */
  const dubWithOriginal = async (user: User) => {
    await user.click(voiceButton('原声'))
    await waitSaved(() => expect(savedDubs()).toHaveLength(3))
  }

  it('各句的配音小块：保留原声时是不能点的「原声」；AI 配音时写着这句的音色，跟随的标出来；配不了的置灰、点了说明原因；菜单是跟随、原声、资料库的音色、不配音，现在的打勾', async () => {
    resetMockReferenceAudios([])
    addMockReferenceAudio({ title: 'Emma', locale: 'en' })
    const user = await open()
    serveDubbings()
    expect(within(captionRow(0)).queryByRole('button', { name: /^本句配音：/ })).toBeNull()
    expect(within(captionRow(0)).getByText('原声')).toBeVisible()

    await dubWithOriginal(user)
    expect(lineChip(0)).toHaveAccessibleName('本句配音：原声，跟随整体音色')
    expect(lineChip(0)).not.toHaveAttribute('aria-disabled')
    // d4 还没翻，e5 是手动加的、不属于视频片段
    expect(lineChip(1)).toHaveAttribute('aria-disabled', 'true')
    await user.click(lineChip(1))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('English')
    expect(lineChip(4)).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByRole('menu')).toBeNull()

    await user.click(lineChip(2))
    const menu = await screen.findByRole('menu', { name: '本句配音：原声，跟随整体音色' })
    await waitFor(() =>
      expect(
        within(menu)
          .getAllByRole('menuitemradio')
          .map((item) => item.textContent),
      ).toEqual(['跟随整体音色', '原声', 'Emma', '不配音']),
    )
    expect(within(menu).getByRole('menuitemradio', { name: '跟随整体音色' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('给一句选资料库的音色：只发这一句（带上限和这个音色），配好后换掉这句的配音、别的句子不动，主文件记着这句的选择；一步撤销都回去', async () => {
    resetMockReferenceAudios([])
    const emma = addMockReferenceAudio({ title: 'Emma', locale: 'en' })
    const user = await open()
    const sent = serveDubbings()
    await dubWithOriginal(user)
    const before = savedDubs()

    await pickLineVoice(user, 0, 'Emma')
    await waitFor(() => expect(sent).toHaveLength(3))
    expect(sent[2]).toEqual({
      conversationId: CONVERSATION,
      sourceJobId: TAKE_A,
      locale: 'en',
      lines: [{ startMs: 0, endMs: 1_000, text: 'A one', slotEndMs: 2_500 }],
      reference: { kind: 'reference_audio', referenceId: emma },
    })
    await waitSaved(() =>
      expect(savedModes()).toBe(
        `{"en":{"mode":"dub","voice":null,"lines":{"cap-a1":{"voice":"${emma}"}}}}`,
      ),
    )
    expect(savedDubs().map((dub) => dub.caption)).toEqual(['cap-a1', 'cap-b2', 'cap-c3'])
    expect(sent).toHaveLength(3)
    expect(lineChip(0)).toHaveAccessibleName('本句配音：Emma')
    expect(lineChip(2)).toHaveAccessibleName('本句配音：原声，跟随整体音色')

    await user.click(undoButton())
    await waitSaved(() => expect(savedModes()).toBe('{"en":{"mode":"dub","voice":null}}'))
    expect(savedDubs()).toEqual(before)
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
    expect(lineChip(2)).toHaveAccessibleName('本句配音：不配音')
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
   * 选回跟随整体音色。
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
            dub: { locale: 'en', caption: 'cap-a1', trimmed: false, voice: null },
          }),
        ],
        modes: '{"en":{"mode":"dub","voice":null,"lines":{"cap-d4":{"dub":false}}}}',
      },
    )
    const sent = serveDubbings()
    await pickLineVoice(user, 1, '跟随整体音色')
    await waitFor(() => expect(sent).toHaveLength(1))
    return user
  }

  it('不配音的一句改回配音、配好以后：前一句的配音收短到它的开始、标成截短，两个片段在同一条配音行', async () => {
    await voiceSkippedLine()
    await waitSaved(() =>
      expect(
        savedDubs().map(({ caption, start, duration, trimmed }) => ({
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
    ).toHaveLength(2)
  })

  it('不配音的一句改回配音、配好以后撤销一次：回到配之前，前一句的配音照原样', async () => {
    const user = await voiceSkippedLine()
    await waitSaved(() => expect(savedDubs()).toHaveLength(2))
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
    expect(savedModes()).toBe('{"en":{"mode":"dub","voice":null,"lines":{"cap-d4":{"dub":false}}}}')
  })

  it('有句子单独选过时：换整种语言的音色只重配跟着它的句子；「重新生成」各用各的音色，不配音的不配', async () => {
    resetMockReferenceAudios([])
    const emma = addMockReferenceAudio({ title: 'Emma', locale: 'en' })
    const user = await open()
    const sent = serveDubbings()
    await dubWithOriginal(user)
    await pickLineVoice(user, 2, '不配音')
    await waitSaved(() => expect(savedDubs()).toHaveLength(2))
    // c3 本来就是原声的音色、有配音：只记下它自己选了原声，不重新生成
    await pickLineVoice(user, 3, '原声')
    await waitSaved(() => expect(savedModes()).toContain('"cap-c3":{"voice":null}'))
    expect(sent).toHaveLength(2)

    // 只有 a1 跟着整种语言的音色；b2 不配音，a1 后面没有要配的句子，不写上限
    await user.click(await within(panel()).findByRole('button', { name: 'Emma' }))
    await waitFor(() => expect(sent).toHaveLength(3))
    expect(sent[2]).toMatchObject({
      sourceJobId: TAKE_A,
      reference: { kind: 'reference_audio', referenceId: emma },
    })
    expect(sent[2]?.lines).toEqual([{ startMs: 0, endMs: 1_000, text: 'A one' }])
    await waitSaved(() =>
      expect(JSON.parse(savedModes() ?? 'null')).toEqual({
        en: {
          mode: 'dub',
          voice: emma,
          lines: { 'cap-b2': { dub: false }, 'cap-c3': { voice: null } },
        },
      }),
    )

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
    await waitSaved(() =>
      expect(savedDubs().map((dub) => dub.caption)).toEqual(['cap-a1', 'cap-c3']),
    )
  })

  it('给一句选的音色和它现在实际用的一样、已有配音：只改记着的选择，不发起，一步撤销', async () => {
    resetMockReferenceAudios([])
    const emma = addMockReferenceAudio({ title: 'Emma', locale: 'en' })
    const user = await open()
    const sent = serveDubbings()
    await user.click(await within(panel()).findByRole('button', { name: 'Emma' }))
    const following = `{"en":{"mode":"dub","voice":"${emma}"}}`
    await waitSaved(() => expect(savedModes()).toBe(following))
    await waitSaved(() => expect(savedDubs()).toHaveLength(3))
    const dubs = savedDubs()

    await pickLineVoice(user, 0, 'Emma')
    const own = `{"en":{"mode":"dub","voice":"${emma}","lines":{"cap-a1":{"voice":"${emma}"}}}}`
    await waitSaved(() => expect(savedModes()).toBe(own))
    expect(lineChip(0)).toHaveAccessibleName('本句配音：Emma')
    await pickLineVoice(user, 0, '跟随整体音色')
    await waitSaved(() => expect(savedModes()).toBe(following))
    expect(lineChip(0)).toHaveAccessibleName('本句配音：Emma，跟随整体音色')
    await user.click(undoButton())
    await waitSaved(() => expect(savedModes()).toBe(own))
    expect(sent).toHaveLength(2)
    expect(savedDubs()).toEqual(dubs)
  })

  it('有配音正在生成时各句的小块都不能点，点了说明在生成；生成结束后又能点', async () => {
    const user = await open()
    serveDubbings()
    await dubWithOriginal(user)
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.post('*/api/generations/dubbings', async () => {
        await held
        return HttpResponse.json({ detail: '配音没有开通，暂时不能配音' }, { status: 422 })
      }),
    )

    await user.click(voiceButton('重新生成'))
    await waitFor(() => expect(lineChip(0)).toHaveAttribute('aria-disabled', 'true'))
    expect(lineChip(2)).toHaveAttribute('aria-disabled', 'true')
    await user.click(lineChip(0))
    expect((await screen.findAllByText('正在生成配音，请等待生成完成')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('menu')).toBeNull()

    release()
    await waitFor(() => expect(lineChip(0)).not.toHaveAttribute('aria-disabled'))
    expect(savedDubs()).toHaveLength(3)
  })
})

describe('final-cut 编辑器 · 旁白配音', () => {
  const EN_FILE = 'final-cut/locales/en.json'
  const SPEECH_URL = 'https://media.test/speech.m4a'
  const panel = () => screen.getByRole('tabpanel', { name: '字幕' })
  const languages = () => within(toolbar()).getByRole('group', { name: '语言' })
  const narrationClips = () => screen.queryAllByRole('group', { name: /^旁白 · / })

  /** 存下来的主文件里的配音片段：配的哪句、语言、起止（秒）、音色、地址。 */
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

  /** 旁白片段：配 `cap-n1`（2–3 秒），用音色 `voice`。 */
  const narration = (voice: string) =>
    audio({
      id: 'narr-1',
      label: '旁白 · 欢迎光临',
      src: SPEECH_URL,
      start: 2_000,
      duration: 1_000,
      dub: { locale: null, caption: 'cap-n1', trimmed: false, voice },
    })

  /**
   * 工程：素材 A 一段（0–4 秒），字幕 a1（0–1 秒）属于它；给了 `voice` 时还有一句旁白 n1（2–3 秒，用这个音色）和它的
   * 旁白片段，`dubbed` 时再加 n1 的 English 配音、English 是 AI 配音。打开编辑器，切到「字幕」页签。
   */
  const open = async ({ voice, dubbed = false }: { voice?: string; dubbed?: boolean } = {}) => {
    const lines = [sceneLine('a1', 0, 1_000, 'clip-1')]
    const clips: FilmClip[] = [video({ src: URL_A, duration: 4_000 })]
    if (voice !== undefined) {
      lines.push(sceneLine('n1', 2_000, 1_000))
      clips.push(narration(voice))
    }
    if (dubbed)
      clips.push(
        audio({
          id: 'narr-en',
          label: '配音 · Welcome',
          src: 'https://media.test/speech-en.m4a',
          start: 2_000,
          duration: 1_000,
          dub: { locale: 'en', caption: 'cap-n1', trimmed: false, voice: null },
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
        screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐、字幕和属性' }),
      ).getByRole('tab', { name: '字幕' }),
    )
    return user
  }

  it('原文下输入文案、选音色插入：时间线上多一句字幕和一个对齐的旁白片段（播放头处有字幕时往后放），一步撤销', async () => {
    resetMockReferenceAudios([])
    const emma = addMockReferenceAudio({ title: 'Emma' })
    const user = await open()
    const sent = serveSpeeches()

    await user.click(within(panel()).getByRole('button', { name: '旁白配音' }))
    await user.type(within(panel()).getByRole('textbox', { name: '旁白文案' }), '欢迎光临')
    await user.click(await within(panel()).findByRole('button', { name: 'Emma' }))
    await user.click(within(panel()).getByRole('button', { name: '插入配音与字幕' }))

    await waitSaved(() =>
      expect(savedDubs()).toEqual([
        // 播放头在 0 秒，那里有 a1（0–1 秒），往后放到 1 秒；长度是合成出来的 1.5 秒
        {
          caption: expect.any(String),
          locale: null,
          start: 1,
          duration: 1.5,
          voice: emma,
          src: SPEECH_URL,
        },
      ]),
    )
    expect(sent).toEqual([
      {
        conversationId: CONVERSATION,
        text: '欢迎光临',
        reference: { kind: 'reference_audio', referenceId: emma },
      },
    ])
    expect(savedSceneLines()).toEqual([
      ['字幕 a1', 0, 1, 'clip-1'],
      ['欢迎光临', 1, 1.5, null],
    ])
    // 旁白片段配的就是新加的那一句
    expect(mockWorkspaceFile(CONVERSATION, SCENE_FILE)?.content).toContain(
      `id="${savedDubs()[0]?.caption ?? '?'}"`,
    )
    expect(narrationClips()).toHaveLength(1)

    await user.click(undoButton())
    await waitSaved(() => expect(savedDubs()).toEqual([]))
    expect(savedSceneLines()).toEqual([['字幕 a1', 0, 1, 'clip-1']])
  })

  it('切到 AI 配音的语言：时间线上不显示原文的旁白，显示这种语言给它配的音', async () => {
    const user = await open({ voice: 'v-own', dubbed: true })
    expect(narrationClips()).toHaveLength(1)

    await user.click(within(languages()).getByRole('button', { name: 'English（EN）' }))

    await waitFor(() => expect(narrationClips()).toHaveLength(0))
    expect(screen.getByRole('group', { name: /^配音 · Welcome/ })).toBeVisible()
  })

  it('AI 配音的语言下「重新生成」：旁白这句按译文合成，音色取「原声」时用旁白记着的音色，配好换掉它原来的配音', async () => {
    const user = await open({ voice: 'v-own', dubbed: true })
    const sent = serveSpeeches()
    server.use(
      http.post('*/api/generations/dubbings', () =>
        HttpResponse.json({ detail: '配音没有开通，暂时不能配音' }, { status: 422 }),
      ),
    )
    await user.click(within(languages()).getByRole('button', { name: 'English（EN）' }))

    await user.click(await within(panel()).findByRole('button', { name: '重新生成' }))

    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toEqual({
      conversationId: CONVERSATION,
      text: 'Welcome',
      locale: 'en',
      reference: { kind: 'reference_audio', referenceId: 'v-own' },
    })
    await waitSaved(() =>
      expect(savedDubs().filter((dub) => dub.locale === 'en')).toEqual([
        { caption: 'cap-n1', locale: 'en', start: 2, duration: 1.5, voice: null, src: SPEECH_URL },
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
