import { openComposition } from '@hyperframes/sdk'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FinalCutTranslationsIn } from '@/shared/api/generated/types.gen'
import { server } from '@/testing/mocks/server'
import { mockProjectMain, putMockProjectMain } from '@/testing/mocks/whole-film'
import { mockWorkspaceFile, putMockWorkspaceFile } from '@/testing/mocks/workspace'
import { host, mainFile, video } from '@/testing/final-cut'
import {
  CAPTION_CANVAS,
  CONVERSATION,
  URL_A,
  openEditor,
  previewPages,
  previewSettled,
  progress,
  putFilm,
  savedFilm,
  savedVariableTexts,
  sceneLine,
  setUpEditorCase,
  tearDownEditorCase,
  toolbar,
  undoButton,
  waitSaved,
  type SceneLine,
} from '@/testing/final-cut-editor'

vi.mock('mediabunny', async () => (await import('@/testing/final-cut-media')).mediabunnyMock())

// 一条用例要开整个编辑器、走完一串操作，上限放宽到 15 秒
vi.setConfig({ testTimeout: 15_000 })

beforeEach(setUpEditorCase)
afterEach(tearDownEditorCase)

describe('final-cut 编辑器 · 语言', () => {
  const EN_FILE = 'final-cut/locales/en.json'
  const languages = () => within(toolbar()).getByRole('group', { name: '语言' })
  const side = () =>
    screen.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  const panel = () => screen.getByRole('tabpanel', { name: /^字幕/ })

  /** 最后一次发给预览页的 final-cut 里套的值；没套时是 undefined。 */
  const previewValues = (): unknown => {
    const load = previewPages
      .latest()
      .commands.filter((command) => command.type === 'load')
      .at(-1)
    if (load?.type !== 'load') throw new Error('还没有发过 final-cut')
    const match = /<script data-hf-preview-variables>window\.__hfVariables=(.*?);<\/script>/.exec(
      load.html,
    )
    return match?.[1] === undefined ? undefined : JSON.parse(match[1])
  }

  /** 工程：0–2 秒一段视频，两句字幕；English 翻了第一句。 */
  const open = async () => {
    await putFilm(
      [video({ src: URL_A, duration: 2_000 })],
      [sceneLine('a1', 0, 1_000), sceneLine('b2', 1_000, 1_000)],
    )
    putMockWorkspaceFile(CONVERSATION, EN_FILE, '{"cap_a1": "Line one"}')
    const user = userEvent.setup()
    await openEditor()
    await previewSettled()
    return user
  }

  it('工具条上一排语言：原文和工程里有的语言，当前的高亮；「+」里列出还没加的语言（中文也在里面），选一个就加上并切过去', async () => {
    const user = await open()
    expect(
      within(languages())
        .getAllByRole('button')
        .map((button) => [button.textContent, button.getAttribute('aria-pressed')]),
    ).toEqual([
      ['原文', 'true'],
      ['EN', 'false'],
      ['', null],
    ])
    await user.click(within(languages()).getByRole('button', { name: '添加语言' }))
    const menu = await screen.findByRole('menu')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['中文（ZH）', 'Deutsch（DE）', 'Español（ES）', 'Français（FR）'])
    await user.click(within(menu).getByRole('menuitem', { name: '中文（ZH）' }))
    await waitFor(() =>
      expect(within(languages()).getByRole('button', { name: '中文（ZH）' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
    expect(mockWorkspaceFile(CONVERSATION, 'final-cut/locales/zh.json')?.content).toBe('{}\n')
  })

  it('所有语言都加了：不显示「+」', async () => {
    await putFilm([video({ src: URL_A, duration: 2_000 })])
    for (const code of ['zh', 'en', 'de', 'es', 'fr'])
      putMockWorkspaceFile(CONVERSATION, `final-cut/locales/${code}.json`, '{}')
    await openEditor()
    expect(
      within(languages())
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['原文', 'ZH', 'EN', 'DE', 'ES', 'FR'])
  })

  it('切到 English：预览套上 English 的值，字幕页签、时间线上是英文，没翻的显示原文并标出来，不能加字幕；切回原文都回来', async () => {
    const user = await open()
    expect(previewValues()).toBeUndefined()
    await user.click(within(side()).getByRole('tab', { name: /^字幕/ }))

    await user.click(within(languages()).getByRole('button', { name: 'English（EN）' }))
    await waitFor(() => expect(previewValues()).toEqual({ cap_a1: 'Line one' }))
    const first = within(panel()).getByRole('textbox', { name: '字幕文字 00:00.00 – 00:01.00' })
    const second = within(panel()).getByRole('textbox', { name: '字幕文字 00:01.00 – 00:02.00' })
    expect(first).toHaveValue('Line one')
    expect(first).toHaveAccessibleDescription('原文 字幕 a1')
    expect(second).toHaveValue('')
    expect(second).toHaveAttribute('placeholder', '输入 English 字幕…')
    const row = screen.getByRole('group', { name: '字幕' })
    expect(within(row).getByRole('group', { name: /^Line one，/ })).toBeVisible()
    expect(within(row).getByRole('group', { name: /^字幕 b2，1\.0 秒，原文$/ })).toBeVisible()
    const add = within(panel()).getByRole('button', { name: '在播放头处添加字幕' })
    expect(add).toHaveAttribute('aria-disabled', 'true')
    await user.click(add)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('English')

    // 其它语言下写一句：存进 English 的值表，原文不变
    await user.type(second, 'Line two')
    await waitSaved(() =>
      expect(JSON.parse(mockWorkspaceFile(CONVERSATION, EN_FILE)?.content ?? '')).toEqual({
        cap_a1: 'Line one',
        cap_b2: 'Line two',
      }),
    )
    expect(savedVariableTexts()).toEqual(['字幕 a1', '字幕 b2'])
    await waitFor(() => expect(previewValues()).toEqual({ cap_a1: 'Line one', cap_b2: 'Line two' }))

    await user.click(within(languages()).getByRole('button', { name: '原文' }))
    await waitFor(() => expect(previewValues()).toBeUndefined())
    expect(
      within(panel()).getByRole('textbox', { name: '字幕文字 00:01.00 – 00:02.00' }),
    ).toHaveValue('字幕 b2')
    expect(within(row).getByRole('group', { name: /^字幕 a1，1\.0 秒$/ })).toBeVisible()
  })

  it('切到 English 点「导出」：导出 English 版，提示里提醒还有几条没翻；发起时带上语言，状态写这次导出的语言；原文时带 null', async () => {
    const exportId = '22222222-3333-4444-8555-666666666666'
    const bodies: unknown[] = []
    // 原文那次答「还没导出过」，按钮留在「导出」；English 那次答渲染中、记着 English
    server.use(
      http.post('*/api/conversations/:conversationId/whole-film/exports', async ({ request }) => {
        bodies.push(await request.json())
        return HttpResponse.json({ exportId }, { status: 202 })
      }),
      http.get('*/api/conversations/:conversationId/whole-film/exports/latest', () =>
        HttpResponse.json({
          export:
            bodies.length < 2
              ? null
              : {
                  id: exportId,
                  locale: 'en',
                  resolution: null,
                  status: 'rendering',
                  progress: 0.4,
                  queuePosition: null,
                  error: null,
                  downloadUrl: null,
                },
        }),
      ),
    )
    const user = await open()
    const exportButton = () => screen.getByRole('button', { name: '导出' })
    await user.click(exportButton())
    await waitFor(() => expect(bodies).toEqual([{ locale: null }]))
    await waitFor(() => expect(exportButton()).not.toHaveAttribute('aria-disabled'))

    await user.click(within(languages()).getByRole('button', { name: 'English（EN）' }))
    // 两句字幕 English 翻了一句
    await user.hover(exportButton())
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      /^导出 English 版；有 1 条文字未翻译，导出后显示原文$/,
    )
    await user.click(exportButton())
    await waitFor(() => expect(bodies).toEqual([{ locale: null }, { locale: 'en' }]))
    expect(await screen.findByText('正在渲染 English 版 40%')).toHaveAttribute('role', 'status')
  })
})

describe('final-cut 编辑器 · 元素、模板的文字分语言', () => {
  const EN_FILE = 'final-cut/locales/en.json'
  const languages = () => within(toolbar()).getByRole('group', { name: '语言' })
  const side = () =>
    screen.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  const panel = () => screen.getByRole('tabpanel', { name: /^字幕/ })
  const inspector = () => screen.getByRole('tabpanel', { name: '属性' })
  const texts = () => within(panel()).getByRole('list', { name: '画面文字' })
  const savedHost = (id: string) => {
    const element = new DOMParser().parseFromString(savedFilm(), 'text/html').getElementById(id)
    const bindings = element?.getAttribute('data-locale-bindings')
    return {
      values: JSON.parse(element?.getAttribute('data-variable-values') ?? 'null') as unknown,
      bindings:
        bindings === null || bindings === undefined ? null : (JSON.parse(bindings) as unknown),
    }
  }
  const savedEnglish = (): unknown =>
    JSON.parse(mockWorkspaceFile(CONVERSATION, EN_FILE)?.content ?? 'null')
  /** 最后一次发给预览页的 final-cut 里片段 `id` 的取值。 */
  const previewHostValues = (id: string): unknown => {
    const load = previewPages
      .latest()
      .commands.filter((command) => command.type === 'load')
      .at(-1)
    if (load?.type !== 'load') throw new Error('还没有发过 final-cut')
    const element = new DOMParser().parseFromString(load.html, 'text/html').getElementById(id)
    return JSON.parse(element?.getAttribute('data-variable-values') ?? 'null')
  }

  /** 工程：一段视频，两个元素——中文标题、英文季标。`english` 时已有 English，中文标题随语言。 */
  const open = async (english = false) => {
    const main = await openComposition(
      mainFile(
        [
          video({ src: URL_A, duration: 4_000 }),
          host({ id: 'zh', label: '中文标题', start: 500, track: 1, values: { text: '新品上市' } }),
          host({
            id: 'latin',
            label: '季标',
            start: 2_000,
            track: 2,
            values: { text: 'NEW IN · AW26' },
          }),
        ],
        CAPTION_CANVAS,
      ),
    )
    if (english) {
      main.declareVariable({
        id: 'txt_zh_text',
        type: 'string',
        label: '文字',
        default: '新品上市',
      })
      main.setAttribute('zh', 'data-locale-bindings', '{"text":"txt_zh_text"}')
      putMockWorkspaceFile(CONVERSATION, EN_FILE, '{}')
    }
    putMockProjectMain(CONVERSATION, main.serialize())
    const user = userEvent.setup()
    await openEditor()
    await previewSettled()
    await user.click(within(side()).getByRole('tab', { name: /^字幕/ }))
    return user
  }

  it('「字幕」页签上面切换「字幕」「画面文字」，各带个数；「画面文字」每个元素一块、每个文字字段一行，没加语言时不显示「固定 / 随语言」，改的是原文', async () => {
    const user = await open()
    const views = within(panel()).getByRole('group', { name: '字幕或画面文字' })
    expect(
      within(views)
        .getAllByRole('button')
        .map((button) => [button.textContent, button.getAttribute('aria-pressed')]),
    ).toEqual([
      ['字幕 0', 'true'],
      ['画面文字 2', 'false'],
    ])
    await user.click(within(views).getByRole('button', { name: '画面文字 2' }))
    expect(
      within(texts())
        .getAllByRole('listitem')
        .map((item) => within(item).getAllByRole('button')[0]?.textContent),
    ).toEqual(['中文标题00:00.50', '季标00:02.00'])
    expect(within(texts()).queryByRole('button', { name: /：(固定|随语言)$/ })).toBeNull()

    const field = within(texts()).getByRole('textbox', { name: '中文标题 文字' })
    expect(field).toHaveValue('新品上市')
    await user.clear(field)
    await user.type(field, '早秋新品')
    await waitSaved(() => expect(savedHost('zh').values).toEqual({ text: '早秋新品' }))
    // 点一块的名字：选中它（停在「字幕」页签），播放头到它的开始
    await user.click(within(texts()).getByRole('button', { name: /^季标/ }))
    expect(within(texts()).getAllByRole('listitem')[1]).toHaveAttribute('aria-current', 'true')
    await waitFor(() => expect(progress()).toHaveAttribute('aria-valuetext', '00:02.00 / 00:04.00'))
  })

  it('加上 English：文字字段都随语言（西文的也一样）；其它语言下随语言的框里写英文存进值表、预览里那个元素是英文；改成固定的只读；点「随语言」改成固定', async () => {
    const user = await open()
    await user.click(
      within(within(panel()).getByRole('group', { name: '字幕或画面文字' })).getByRole('button', {
        name: '画面文字 2',
      }),
    )
    await user.click(within(languages()).getByRole('button', { name: '添加语言' }))
    await user.click(await screen.findByRole('menuitem', { name: 'English（EN）' }))
    await waitFor(() =>
      expect(within(languages()).getByRole('button', { name: 'English（EN）' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
    expect(within(texts()).getAllByRole('button', { name: '文字：随语言' })).toHaveLength(2)
    await waitSaved(() => expect(savedHost('zh').bindings).toEqual({ text: 'txt_zh_text' }))
    expect(savedHost('latin').bindings).toEqual({ text: 'txt_latin_text' })
    expect(savedVariableTexts()).toHaveLength(2)
    expect(savedVariableTexts()).toEqual(expect.arrayContaining(['新品上市', 'NEW IN · AW26']))

    const zh = within(texts()).getByRole('textbox', { name: '中文标题 文字' })
    expect(zh).toHaveValue('')
    expect(zh).toHaveAttribute('placeholder', '输入 English 文字…')
    expect(zh).toHaveAccessibleDescription('原文 新品上市')
    expect(within(texts()).getByRole('textbox', { name: '季标 文字' })).toHaveAccessibleDescription(
      '原文 NEW IN · AW26',
    )

    // 季标改成固定：所有语言共用原文、只读
    const latinItem = within(texts()).getAllByRole('listitem')[1]
    if (latinItem === undefined) throw new Error('没有季标那一块')
    await user.click(within(latinItem).getByRole('button', { name: '文字：随语言' }))
    await waitSaved(() => expect(savedHost('latin').bindings).toBeNull())
    const latin = within(texts()).getByRole('textbox', { name: '季标 文字' })
    expect(latin).toHaveValue('NEW IN · AW26')
    expect(latin).toHaveAttribute('readonly')
    expect(latin).toHaveAccessibleDescription('固定原文，所有语言共用；点击「随语言」可分别修改')

    await user.type(zh, 'New in')
    await waitSaved(() => expect(savedEnglish()).toEqual({ txt_zh_text: 'New in' }))
    expect(savedHost('zh').values).toEqual({ text: '新品上市' })
    await waitFor(() => expect(previewHostValues('zh')).toEqual({ text: 'New in' }))
    expect(previewHostValues('latin')).toEqual({ text: 'NEW IN · AW26' })

    await user.click(within(texts()).getByRole('button', { name: '文字：随语言' }))
    await waitSaved(() => expect(savedEnglish()).toEqual({}))
    expect(savedHost('zh').bindings).toBeNull()
    expect(savedVariableTexts()).toEqual([])
    expect(within(texts()).getByRole('textbox', { name: '中文标题 文字' })).toHaveValue('新品上市')
    expect(within(texts()).getAllByRole('button', { name: '文字：固定' })).toHaveLength(2)
  })

  it('「属性」里的文字字段右边也有「固定 / 随语言」；其它语言下随语言的写这种语言，固定的只读', async () => {
    const user = await open(true)
    await user.click(screen.getByRole('button', { name: /^选中：中文标题，/ }))
    await user.click(within(side()).getByRole('tab', { name: '属性' }))
    const toggle = within(inspector()).getByRole('button', { name: '文字：随语言' })
    expect(within(inspector()).getByRole('textbox', { name: '文字' })).toHaveValue('新品上市')

    await user.click(within(languages()).getByRole('button', { name: 'English（EN）' }))
    const field = within(inspector()).getByRole('textbox', { name: '文字' })
    expect(field).toHaveValue('')
    await user.type(field, 'New in')
    await waitSaved(() => expect(savedEnglish()).toEqual({ txt_zh_text: 'New in' }))

    await user.click(toggle)
    await waitSaved(() => expect(savedHost('zh').bindings).toBeNull())
    const pinned = within(inspector()).getByRole('textbox', { name: '文字' })
    expect(pinned).toHaveValue('新品上市')
    expect(pinned).toHaveAttribute('readonly')
    expect(within(inspector()).getByRole('button', { name: '文字：固定' })).toBeVisible()
  })

  it('时间线上元素片段不写字，悬停提示写着「名字 · 文字」，文字是显示着的语言的（没翻的写原文）；改字、换语言后跟着变', async () => {
    const user = await open(true)
    // 片段的名字（读屏读的）还是原来的名字；片段上不写字，名字和文字在悬停提示里
    const tipOf = async (name: string) => {
      const clip = screen.getByRole('group', { name: new RegExp(`^${name}，`) })
      expect(clip).toHaveTextContent(/^$/)
      const body = within(clip).getByRole('button', { name: new RegExp(`^选中：${name}，`) })
      await user.hover(body)
      const tip = (await screen.findByRole('tooltip')).textContent
      // jsdom 里指针移开时提示还留在离开的缓冲区里，按 Esc 收起
      await user.unhover(body)
      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
      return tip
    }
    expect(await tipOf('中文标题')).toBe('中文标题 · 新品上市')
    expect(await tipOf('季标')).toBe('季标 · NEW IN · AW26')

    await user.click(within(languages()).getByRole('button', { name: 'English（EN）' }))
    expect(await tipOf('中文标题')).toBe('中文标题 · 新品上市')
    await user.click(
      within(within(panel()).getByRole('group', { name: '字幕或画面文字' })).getByRole('button', {
        name: '画面文字 2',
      }),
    )
    await user.type(within(texts()).getByRole('textbox', { name: '中文标题 文字' }), 'New in')
    await waitSaved(() => expect(savedEnglish()).toEqual({ txt_zh_text: 'New in' }))
    expect(await tipOf('中文标题')).toBe('中文标题 · New in')

    await user.click(within(languages()).getByRole('button', { name: '原文' }))
    expect(await tipOf('中文标题')).toBe('中文标题 · 新品上市')
  })
})

describe('final-cut 编辑器 · 翻译', () => {
  const EN_FILE = 'final-cut/locales/en.json'
  const TRANSLATIONS_URL = '*/api/conversations/:conversationId/final-cut/translations'
  const languages = () => within(toolbar()).getByRole('group', { name: '语言' })
  const panel = () => screen.getByRole('tabpanel', { name: /^字幕/ })
  const translateButton = () => within(panel()).getByRole('button', { name: /^(翻译|翻译中…)$/ })
  const savedEnglish = (): unknown =>
    JSON.parse(mockWorkspaceFile(CONVERSATION, EN_FILE)?.content ?? 'null')

  /**
   * 换上翻译接口：记下每次请求，译文照模拟环境写成「[EN] 原文」。`fail` 给第几次请求（从 0 数）答失败，
   * `hold` 了结之前不答。
   */
  const serveTranslations = (
    fail?: (index: number) => Response | undefined,
    hold?: Promise<void>,
  ) => {
    const sent: FinalCutTranslationsIn[] = []
    server.use(
      http.post(TRANSLATIONS_URL, async ({ request }) => {
        const body = (await request.json()) as FinalCutTranslationsIn
        sent.push(body)
        await hold
        const failure = fail?.(sent.length - 1)
        if (failure !== undefined) return failure
        return HttpResponse.json({
          translations: body.entries.map((entry) => ({
            id: entry.id,
            text: `[${body.targetLocale.toUpperCase()}] ${entry.text}`,
          })),
        })
      }),
    )
    return sent
  }

  /**
   * 工程：一段视频，两个元素（中文标题随语言、英文季标固定），字幕 `lines`；English 的值表是 `english`。
   * 打开编辑器，切到「字幕」页签。
   */
  const open = async (lines: SceneLine[], english: Record<string, string>) => {
    await putFilm(
      [
        video({ src: URL_A, duration: 2_000 }),
        host({ id: 'zh', label: '中文标题', start: 0, track: 1, values: { text: '新品上市' } }),
        host({ id: 'latin', label: '季标', start: 0, track: 2, values: { text: 'NEW IN' } }),
      ],
      lines,
    )
    const main = await openComposition(mockProjectMain(CONVERSATION)?.content ?? '')
    main.declareVariable({ id: 'txt_zh_text', type: 'string', label: '文字', default: '新品上市' })
    main.setAttribute('zh', 'data-locale-bindings', '{"text":"txt_zh_text"}')
    putMockProjectMain(CONVERSATION, main.serialize())
    putMockWorkspaceFile(CONVERSATION, EN_FILE, JSON.stringify(english))
    const user = userEvent.setup()
    await openEditor()
    await previewSettled()
    await user.click(
      within(
        screen.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' }),
      ).getByRole('tab', { name: /^字幕/ }),
    )
    return user
  }

  const toEnglish = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(within(languages()).getByRole('button', { name: 'English（EN）' }))
    await waitFor(() => expect(translateButton()).toBeVisible())
  }

  const twoLines = [sceneLine('a1', 0, 1_000), sceneLine('b2', 1_000, 1_000)]

  it('原文时没有「翻译」；English 下只翻还没翻的，固定的不翻，一次写进值表、一步撤销；都翻过了置灰说明原因', async () => {
    const sent = serveTranslations()
    const user = await open(twoLines, { cap_a1: 'Line one' })
    expect(within(panel()).queryByRole('button', { name: '翻译' })).toBeNull()

    await toEnglish(user)
    await user.click(translateButton())
    await waitSaved(() =>
      expect(savedEnglish()).toEqual({
        cap_a1: 'Line one',
        cap_b2: '[EN] 字幕 b2',
        txt_zh_text: '[EN] 新品上市',
      }),
    )
    expect(sent).toEqual([
      {
        targetLocale: 'en',
        entries: [
          { id: 'txt_zh_text', text: '新品上市' },
          { id: 'cap_b2', text: '字幕 b2' },
        ],
      },
    ])
    expect(await screen.findByText('已翻译 2 条')).toBeVisible()
    expect(
      within(panel()).getByRole('textbox', { name: '字幕文字 00:01.00 – 00:02.00' }),
    ).toHaveValue('[EN] 字幕 b2')

    expect(translateButton()).toHaveAttribute('aria-disabled', 'true')
    await user.click(translateButton())
    expect(await screen.findByRole('tooltip')).toHaveTextContent('English')
    expect(sent).toHaveLength(1)

    await user.click(undoButton())
    await waitSaved(() => expect(savedEnglish()).toEqual({ cap_a1: 'Line one' }))
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
    expect(translateButton()).not.toHaveAttribute('aria-disabled')
  })

  it('翻译中按钮写「翻译中…」并置灰，连点只发一次，照常能编辑；翻译期间填了的那句不覆盖，别的写进去', async () => {
    let release = () => {}
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const sent = serveTranslations(undefined, hold)
    const user = await open(twoLines, { cap_a1: 'Line one' })
    await toEnglish(user)
    await user.click(translateButton())
    await waitFor(() => expect(translateButton()).toHaveTextContent('翻译中…'))
    expect(translateButton()).toHaveAttribute('aria-disabled', 'true')
    await user.click(translateButton())

    await user.type(
      within(panel()).getByRole('textbox', { name: '字幕文字 00:01.00 – 00:02.00' }),
      'Mine',
    )
    await waitSaved(() => expect(savedEnglish()).toEqual({ cap_a1: 'Line one', cap_b2: 'Mine' }))
    release()
    await waitSaved(() =>
      expect(savedEnglish()).toEqual({
        cap_a1: 'Line one',
        cap_b2: 'Mine',
        txt_zh_text: '[EN] 新品上市',
      }),
    )
    expect(sent).toHaveLength(1)
    expect(await screen.findByText('已翻译 1 条')).toBeVisible()
    expect(await screen.findByText('1 条在翻译期间已修改或删除，未写入译文')).toBeVisible()
    expect(translateButton()).toHaveTextContent('翻译')
  })

  it('分两批发、第二批失败：整次不写，按接口答的原因提示，按钮恢复可点', async () => {
    // 十句各 450 字：合计超过 4000 字，前八句一批、后两句一批
    const lines = Array.from({ length: 10 }, (_, index) => ({
      ...sceneLine(`l${index}`, index * 200, 200),
      text: `${index}`.padEnd(450, '字'),
    }))
    const sent = serveTranslations((index) =>
      index === 1
        ? HttpResponse.json({ code: 'model_call_failed', detail: '上游限流' }, { status: 502 })
        : undefined,
    )
    const user = await open(lines, { txt_zh_text: 'New in' })
    await toEnglish(user)
    await user.click(translateButton())
    expect(await screen.findByText('翻译失败，请点击「翻译」重试')).toBeVisible()
    expect(sent.map((body) => body.entries.length)).toEqual([8, 2])
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
    expect(savedEnglish()).toEqual({ txt_zh_text: 'New in' })
    expect(translateButton()).toHaveTextContent('翻译')
    expect(translateButton()).not.toHaveAttribute('aria-disabled')
  })

  it('没有启用翻译用的模型（409）：提示翻译服务暂不可用', async () => {
    serveTranslations(() =>
      HttpResponse.json({ code: 'model_unavailable', detail: '未配置' }, { status: 409 }),
    )
    const user = await open(twoLines, {})
    await toEnglish(user)
    await user.click(translateButton())
    expect(await screen.findByText('翻译服务暂不可用，请稍后再试')).toBeVisible()
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
  })

  it('超过 500 字的那句不发，写完提示跳过了几条；剩下的都超长时置灰说明原因', async () => {
    const sent = serveTranslations()
    const user = await open(
      [{ ...sceneLine('a1', 0, 1_000), text: '长'.repeat(501) }, sceneLine('b2', 1_000, 1_000)],
      { txt_zh_text: 'New in' },
    )
    await toEnglish(user)
    await user.click(translateButton())
    await waitSaved(() =>
      expect(savedEnglish()).toEqual({ cap_b2: '[EN] 字幕 b2', txt_zh_text: 'New in' }),
    )
    expect(sent.map((body) => body.entries.map((entry) => entry.id))).toEqual([['cap_b2']])
    expect(await screen.findByText('1 条超过 500 字，未翻译；请手动填写')).toBeVisible()
    expect(translateButton()).toHaveAttribute('aria-disabled', 'true')
    await user.click(translateButton())
    expect(await screen.findByRole('tooltip')).toHaveTextContent('500')
  })
})
