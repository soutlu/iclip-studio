import { openComposition } from '@hyperframes/sdk'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { server } from '@/testing/mocks/server'
import { putMockProjectMain } from '@/testing/mocks/whole-film'
import { mockWorkspaceFile, putMockWorkspaceFile } from '@/testing/mocks/workspace'
import { audio, caption, fixtureCatalog, mainFile, video } from '@/testing/final-cut'
import {
  CONVERSATION,
  SCENE_FILE,
  TAKE_A,
  TAKE_B,
  TAKE_SILENT,
  URL_A,
  URL_B,
  URL_SILENT,
  editorRoot,
  openEditor,
  previewPlayer,
  previewSettled,
  progress,
  putFilm,
  quietTakes,
  savedClips,
  savedFilm,
  savedSceneLines,
  savedVariableTexts,
  savedVersion,
  sceneLine,
  setUpEditorCase,
  shot,
  takes,
  tearDownEditorCase,
  toolbar,
  twoVideos,
  undoButton,
  waitSaved,
} from '@/testing/final-cut-editor'
import type { GenerationJob } from '../storyboard.api'
import {
  CAPTIONS_PATH,
  CAPTIONS_PROBLEM_TEXT,
  captionFontSize,
  captionsHostElement,
  captionsScene,
  captionVariable,
} from './composition/captions'

vi.mock('mediabunny', async () => (await import('@/testing/final-cut-media')).mediabunnyMock())

// 一条用例要开整个编辑器、走完一串操作，上限放宽到 15 秒
vi.setConfig({ testTimeout: 15_000 })

beforeEach(setUpEditorCase)
afterEach(tearDownEditorCase)

const EMPTY_CAPTIONS_TEXT = '暂无字幕，请点击「识别字幕」或「在播放头处加一句」'

describe('final-cut 编辑器 · 字幕页签', () => {
  const side = () =>
    screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐、字幕和属性' })
  const openCaptions = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(within(side()).getByRole('tab', { name: '字幕' }))
  const panel = () => screen.getByRole('tabpanel', { name: '字幕' })
  const addButton = () => within(panel()).getByRole('button', { name: '在播放头处加一句' })
  const savedScene = () =>
    mockWorkspaceFile(CONVERSATION, `final-cut/${CAPTIONS_PATH}`)?.content ?? ''
  /** 存下来的主文件根上声明的变量的默认值。 */
  const savedTexts = () =>
    (
      JSON.parse(
        new DOMParser()
          .parseFromString(savedFilm(), 'text/html')
          .documentElement.getAttribute('data-composition-variables') ?? '[]',
      ) as { default: unknown }[]
    ).map((declaration) => declaration.default)

  it('加一句：列表里出现、焦点进文字框；同一处再加置灰；改字存进主文件的变量和字幕文件；删掉回到空的', async () => {
    const user = userEvent.setup()
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    await openCaptions(user)
    expect(within(panel()).getByText(EMPTY_CAPTIONS_TEXT)).toBeVisible()

    await user.click(addButton())
    const field = await within(panel()).findByRole('textbox', {
      name: '字幕文字 00:00.00 – 00:02.00',
    })
    expect(field).toHaveValue('新字幕')
    expect(field).toHaveFocus()
    expect(within(panel()).getByRole('listitem')).toHaveAttribute('aria-current', 'true')
    expect(addButton()).toHaveAttribute('aria-disabled', 'true')
    await user.click(addButton())
    expect(
      (await screen.findAllByText('播放头处已有字幕，无法再加一句；请把播放头移到没有字幕的地方'))
        .length,
    ).toBeGreaterThan(0)

    // 回车是换行；写进去以后焦点还在框里
    await user.clear(field)
    await user.type(field, '第一句{Enter}第二行')
    await waitSaved(() => expect(savedTexts()).toEqual(['第一句\n第二行']))
    await waitSaved(() => expect(savedScene()).toContain('>第一句<br>第二行</div>'))
    expect(field).toHaveFocus()

    await user.click(
      within(panel()).getByRole('button', { name: '删除 00:00.00 – 00:02.00 的字幕' }),
    )
    expect(within(panel()).getByText(EMPTY_CAPTIONS_TEXT)).toBeVisible()
    await waitSaved(() => expect(savedTexts()).toEqual([]))
    expect(savedScene()).not.toContain('class="clip caption"')
  })

  it('字幕写法不对（宿主带了取值）：导出置灰写原因，字幕页签里也显示这句', async () => {
    const user = userEvent.setup()
    const canvas = { width: 720, height: 1280 }
    const host = captionsHostElement(canvas, 2_000).replace(
      'data-no-timeline',
      'data-no-timeline data-variable-values="{}"',
    )
    putMockProjectMain(
      CONVERSATION,
      mainFile([video({ src: URL_A })], canvas).replace(
        '</div>\n</body>',
        `${host}\n</div>\n</body>`,
      ),
    )
    putMockWorkspaceFile(
      CONVERSATION,
      `final-cut/${CAPTIONS_PATH}`,
      captionsScene(canvas, fixtureCatalog),
    )
    await openEditor()
    const exportButton = screen.getByRole('button', { name: '导出' })
    expect(exportButton).toHaveAttribute('aria-disabled', 'true')
    await user.click(exportButton)
    expect((await screen.findAllByText(CAPTIONS_PROBLEM_TEXT)).length).toBeGreaterThan(0)
    await openCaptions(user)
    expect(within(panel()).getByRole('alert')).toHaveTextContent(CAPTIONS_PROBLEM_TEXT)
  })
})

describe('final-cut 编辑器 · 时间线上的字幕', () => {
  const CANVAS = { width: 720, height: 1280 }
  const SCENE = `final-cut/${CAPTIONS_PATH}`
  // 画面 1：视频 0–2 秒；字幕：0–1、1.5–2.5、3–4 秒三句；配乐 0–4 秒
  const lines = [
    caption({ id: 'cap-a1', variable: 'cap_a1', start: 0, duration: 1_000, text: '第一句' }),
    caption({ id: 'cap-b2', variable: 'cap_b2', start: 1_500, duration: 1_000, text: '第二句' }),
    caption({ id: 'cap-c3', variable: 'cap_c3', start: 3_000, duration: 1_000, text: '第三句' }),
  ]
  const others = [video({ src: URL_A, duration: 2_000 }), audio({ duration: 4_000 })]

  /** 工作区里放一份带字幕的工程（照编辑器用 SDK 写的样子），打开编辑器。 */
  const open = async (captions = lines) => {
    const main = await openComposition(mainFile(others, CANVAS))
    main.addElement('film', 99, captionsHostElement(CANVAS, 4_000))
    for (const each of captions) main.declareVariable(captionVariable(each))
    putMockWorkspaceFile(CONVERSATION, SCENE, captionsScene(CANVAS, fixtureCatalog, captions))
    putMockProjectMain(CONVERSATION, main.serialize())
    const user = userEvent.setup()
    await openEditor()
    return user
  }

  const captionRow = () => screen.getByRole('group', { name: '字幕' })
  const clipOf = (text: string) => screen.getByRole('group', { name: new RegExp(`^${text}，`) })
  const bodyOf = (text: string) =>
    within(clipOf(text)).getByRole('button', { name: new RegExp(`^选中：${text}，`) })
  /** 存下来的字幕场景里各句的「编号、开始、时长」（秒）。 */
  const savedLines = () =>
    [
      ...new DOMParser()
        .parseFromString(
          (mockWorkspaceFile(CONVERSATION, SCENE)?.content ?? '').replace(/<\/?template>/g, ''),
          'text/html',
        )
        .querySelectorAll('.caption'),
    ].map((element) => [
      element.id,
      Number(element.getAttribute('data-start')),
      Number(element.getAttribute('data-duration')),
    ])
  /** 存下来的主文件里字幕宿主带没带隐藏标记。 */
  const hostHidden = () =>
    new DOMParser()
      .parseFromString(savedFilm(), 'text/html')
      .getElementById('captions')
      ?.hasAttribute('data-hidden')
  const undoButton = () => within(toolbar()).getByRole('button', { name: '撤销' })
  /**
   * 拖片段：测试里时间线按一秒 100 像素排、没有排版（片段的左边都量成 0），拖 `dx` 像素就是想挪到
   * 第 `dx` × 10 毫秒。
   */
  const drag = (target: HTMLElement, dx: number) => {
    fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: 10, clientY: 50 })
    fireEvent.pointerMove(target, { pointerId: 1, clientX: 10 + dx, clientY: 50 })
    fireEvent.pointerUp(target, { pointerId: 1, clientX: 10 + dx, clientY: 50 })
  }

  it('「字幕」一行在画面区和声音区之间，行头是字幕图标（名字在无障碍名称里）和眼睛；每句是一个片段，写着这句的字', async () => {
    await open()
    const rows = screen
      .getAllByRole('group')
      .map((group) => group.getAttribute('aria-label'))
      .filter((name) => name === '画面 1' || name === '字幕' || name === '配乐')
    expect(rows).toEqual(['画面 1', '字幕', '配乐'])
    expect(
      within(captionRow())
        .getAllByRole('group')
        .map((clip) => clip.getAttribute('aria-label')),
    ).toEqual(['第一句，1.0 秒', '第二句，1.0 秒', '第三句，1.0 秒'])
    expect(within(clipOf('第二句')).getByText('第二句')).toBeVisible()
    const head = screen.getByRole('button', { name: '隐藏字幕' }).parentElement
    if (head === null) throw new Error('开关不在行头里')
    expect(within(head).getByRole('img', { name: '字幕' })).toBeVisible()
  })

  it('拖着挪一句：碰到后一句就停；把手上按方向键裁结尾，不压到后一句；都写进字幕场景，各一步撤销', async () => {
    const user = await open()
    // 想挪到 0.8 秒：会压到 1.5 秒开始的第二句，停在 0.5 秒
    drag(bodyOf('第一句'), 80)
    await waitSaved(() => expect(savedLines()[0]).toEqual(['cap-a1', 0.5, 1]))
    expect(savedLines().slice(1)).toEqual([
      ['cap-b2', 1.5, 1],
      ['cap-c3', 3, 1],
    ])

    await user.click(bodyOf('第二句'))
    const end = within(clipOf('第二句')).getByRole('slider', { name: '裁剪结尾' })
    end.focus()
    await user.keyboard('{ArrowLeft}')
    await waitSaved(() => expect(savedLines()[1]).toEqual(['cap-b2', 1.5, 0.9]))
    await user.keyboard('{Shift>}{ArrowRight}{ArrowRight}{/Shift}')
    await waitSaved(() => expect(savedLines()[1]).toEqual(['cap-b2', 1.5, 1.5]))

    await user.click(undoButton())
    await waitSaved(() => expect(savedLines()[1]).toEqual(['cap-b2', 1.5, 0.9]))
    await user.click(undoButton())
    await user.click(undoButton())
    await waitSaved(() => expect(savedLines()[0]).toEqual(['cap-a1', 0, 1]))
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
  })

  it('删一句：选中按 Delete，或者右键选「删除字幕」（菜单里只有这一项）；开着波纹编辑别的片段也不动', async () => {
    const user = await open()
    await user.click(bodyOf('第一句'))
    await user.keyboard('{Delete}')
    await waitSaved(() => expect(savedLines().map(([id]) => id)).toEqual(['cap-b2', 'cap-c3']))
    expect(savedClips()[0]).toContain('data-start="0" data-duration="2"')

    fireEvent.pointerDown(clipOf('第二句'), { button: 2, pointerType: 'mouse' })
    fireEvent.contextMenu(clipOf('第二句'))
    const menu = await screen.findByRole('menu', { name: '第二句' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['删除字幕Delete'])
    await user.click(within(menu).getByRole('menuitem', { name: /^删除字幕/ }))
    await waitSaved(() => expect(savedLines().map(([id]) => id)).toEqual(['cap-c3']))
  })

  it('和视频片段一起多选：一起挪同样的时间，一起删；删除一步撤销两个都回来', async () => {
    const user = await open()
    await user.click(within(screen.getByRole('group', { name: '画面 1' })).getByRole('button'))
    await user.keyboard('{Shift>}')
    await user.click(bodyOf('第三句'))
    await user.keyboard('{/Shift}')
    drag(bodyOf('第三句'), 350)
    await waitSaved(() => expect(savedLines()[2]).toEqual(['cap-c3', 3.5, 1]))
    await waitSaved(() => expect(savedClips()[0]).toContain('data-start="0.5"'))

    await user.keyboard('{Delete}')
    await waitSaved(() => expect(savedClips()).toHaveLength(0))
    expect(savedLines().map(([id]) => id)).toEqual(['cap-a1', 'cap-b2'])
    await user.click(undoButton())
    await waitSaved(() => expect(savedClips()).toHaveLength(1))
    expect(savedLines().map(([id]) => id)).toEqual(['cap-a1', 'cap-b2', 'cap-c3'])
  })

  it('点行头的眼睛：隐藏标记写在字幕宿主上，每句都标成已隐藏；再点显示回来', async () => {
    const user = await open()
    await user.click(screen.getByRole('button', { name: '隐藏字幕' }))
    await waitSaved(() => expect(hostHidden()).toBe(true))
    expect(
      within(captionRow())
        .getAllByRole('group')
        .map((clip) => clip.getAttribute('aria-label')),
    ).toEqual(['第一句，1.0 秒，已隐藏', '第二句，1.0 秒，已隐藏', '第三句，1.0 秒，已隐藏'])
    expect(mockWorkspaceFile(CONVERSATION, SCENE)?.content).not.toContain('data-hidden')

    await user.click(screen.getByRole('button', { name: '显示字幕' }))
    await waitSaved(() => expect(hostHidden()).toBe(false))
    expect(screen.getByRole('button', { name: '隐藏字幕' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('切开工具点在字幕上什么都不做；按着 Shift 点只切开那个时间上的视频片段，字幕不切', async () => {
    const user = await open()
    editorRoot().focus()
    await user.keyboard('b')
    const razorAt = (x: number, shiftKey = false) =>
      fireEvent.pointerDown(captionRow(), {
        button: 0,
        pointerId: 1,
        pointerType: 'mouse',
        clientX: x,
        clientY: 10,
        shiftKey,
      })
    razorAt(50)
    await act(() => new Promise((resolve) => setTimeout(resolve, 900)))
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
    razorAt(50, true)
    await waitSaved(() => expect(savedClips()).toHaveLength(2))
    expect(savedLines()).toEqual([
      ['cap-a1', 0, 1],
      ['cap-b2', 1.5, 1],
      ['cap-c3', 3, 1],
    ])
  })

  it('选中一句时的「属性」：头部是字、「字幕」、起止时间和删除，没有隐藏；改字停下才写进去、改时长按「+」，各一步撤销', async () => {
    const user = await open()
    await user.click(bodyOf('第一句'))
    const inspector = screen.getByRole('tabpanel', { name: '属性' })
    expect(within(inspector).getByRole('heading', { name: '第一句' })).toBeVisible()
    expect(within(inspector).getByText('字幕')).toBeVisible()
    expect(within(inspector).getByText('0.00 – 1.00s')).toBeVisible()
    expect(within(inspector).getByRole('button', { name: '删除' })).toBeVisible()
    expect(within(inspector).queryByRole('button', { name: '隐藏' })).toBeNull()

    const field = within(inspector).getByRole('textbox', { name: '内容' })
    expect(field).toHaveValue('第一句')
    await user.clear(field)
    await user.type(field, '改过的{Enter}两行')
    await waitSaved(() =>
      expect(mockWorkspaceFile(CONVERSATION, SCENE)?.content).toContain('>改过的<br>两行</div>'),
    )
    // 名字里的换行合成一个空格；文字框里照旧是换行
    expect(clipOf('改过的 两行')).toBeVisible()
    expect(within(inspector).getByRole('heading', { name: '改过的 两行' })).toBeVisible()
    expect(field).toHaveValue('改过的\n两行')
    await user.click(undoButton())
    await waitSaved(() =>
      expect(mockWorkspaceFile(CONVERSATION, SCENE)?.content).toContain('>第一句</div>'),
    )
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')

    // 第二句从 1.5 秒开始：结尾最多拉到那里
    await user.click(within(inspector).getByRole('button', { name: '延长 0.5 秒' }))
    await waitSaved(() => expect(savedLines()[0]).toEqual(['cap-a1', 0, 1.5]))
    expect(within(inspector).getByRole('button', { name: '延长 0.5 秒' })).toBeDisabled()
    await user.click(undoButton())
    await waitSaved(() => expect(savedLines()[0]).toEqual(['cap-a1', 0, 1]))
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
  })

  it('选中一句改字体、改颜色：写在这句元素的行内样式上，别的句不动，主文件链上字体；各一步撤销', async () => {
    const user = await open()
    await user.click(bodyOf('第二句'))
    const inspector = within(screen.getByRole('tabpanel', { name: '属性' }))
    /** 存下来的字幕场景里各句元素的行内样式。 */
    const savedStyles = () =>
      Object.fromEntries(
        [
          ...new DOMParser()
            .parseFromString(
              (mockWorkspaceFile(CONVERSATION, SCENE)?.content ?? '').replace(/<\/?template>/g, ''),
              'text/html',
            )
            .querySelectorAll('.caption'),
        ].map((element) => [element.id, element.getAttribute('style')]),
      )
    const link = '<link rel="stylesheet" href="vendor/fonts/families/playfair-display.css">'

    // 没设过：字体「默认」、颜色是默认的白色
    await user.click(inspector.getByRole('button', { name: '字体：默认' }))
    expect(screen.getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual([
      '默认',
      'Playfair Display',
    ])
    await user.click(screen.getByRole('menuitemradio', { name: 'Playfair Display' }))
    await waitSaved(() =>
      expect(savedStyles()).toEqual({
        'cap-a1': null,
        'cap-b2': `font-family: 'Playfair Display', '${fixtureCatalog.cjk.family}', sans-serif`,
        'cap-c3': null,
      }),
    )
    expect(savedFilm()).toContain(link)
    expect(inspector.getByRole('button', { name: '字体：Playfair Display' })).toBeVisible()

    const hex = inspector.getByRole('textbox', { name: '颜色' })
    expect(hex).toHaveValue('#ffffff')
    await user.clear(hex)
    await user.type(hex, '#ff3366')
    await waitSaved(() => expect(savedStyles()['cap-b2']).toMatch(/; color: #ff3366$/))
    expect(savedStyles()['cap-b2']).toMatch(/^font-family: 'Playfair Display'/)
    expect(savedStyles()['cap-a1']).toBeNull()

    await user.click(undoButton())
    await waitSaved(() => expect(savedStyles()['cap-b2']).toMatch(/^font-family:/))
    expect(hex).toHaveValue('#ffffff')
    await user.click(undoButton())
    await waitSaved(() => expect(savedStyles()['cap-b2'] ?? '').toBe(''))
    expect(savedFilm()).not.toContain(link)
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
  })

  /** 存下来的字幕场景里一句元素的行内样式；没有时是空的。 */
  const sceneStyleOf = (id: string) =>
    new DOMParser()
      .parseFromString(
        (mockWorkspaceFile(CONVERSATION, SCENE)?.content ?? '').replace(/<\/?template>/g, ''),
        'text/html',
      )
      .getElementById(id)
      ?.getAttribute('style') ?? ''
  /** 选中第二句，在「属性」的「字号」里输入 `typed` 回车。 */
  const typeFontSize = async (user: ReturnType<typeof userEvent.setup>, typed: string) => {
    await user.click(bodyOf('第二句'))
    const inspector = within(screen.getByRole('tabpanel', { name: '属性' }))
    const size = captionFontSize(CANVAS)
    expect(inspector.getByRole('slider', { name: '字号' })).toHaveAttribute(
      'aria-valuetext',
      `${size} px`,
    )
    await user.click(inspector.getByRole('button', { name: `字号 ${size} px，点击可直接输入` }))
    await user.keyboard(`${typed}{Enter}`)
    return inspector
  }
  const SIZED_60 =
    'font-size: 60px; -webkit-text-stroke: 12px #000000; text-shadow: 0 2px 5px rgba(0, 0, 0, 0.45)'

  it('选中一句改字号：这句的行内写上字号和跟着它的描边、投影，别的句不动；一步撤销', async () => {
    const user = await open()
    const inspector = await typeFontSize(user, '60')
    await waitSaved(() => expect(sceneStyleOf('cap-b2')).toBe(SIZED_60))
    expect(sceneStyleOf('cap-a1')).toBe('')
    expect(inspector.getByRole('button', { name: '字号 60 px，点击可直接输入' })).toBeVisible()

    await user.click(undoButton())
    await waitSaved(() => expect(sceneStyleOf('cap-b2')).toBe(''))
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
  })

  it('双击字号的滑杆回到默认：字号、描边、投影一起去掉；输入超出范围时收进范围', async () => {
    const user = await open()
    const inspector = await typeFontSize(user, '500')
    const size = captionFontSize(CANVAS)
    await waitSaved(() => expect(sceneStyleOf('cap-b2')).toContain(`font-size: ${size * 2}px;`))

    const slider = inspector.getByRole('slider', { name: '字号' })
    fireEvent.doubleClick(
      slider.parentElement?.closest<HTMLElement>('[data-orientation]') ?? slider,
    )
    await waitSaved(() => expect(sceneStyleOf('cap-b2')).toBe(''))
    expect(slider).toHaveAttribute('aria-valuetext', `${size} px`)
  })

  it('停在「字幕」页签时在时间线上选中片段（字幕、视频都一样）不切走，选中的字幕在列表里标成当前；在页签里点一句的时间：选中它、播放头到它的开始', async () => {
    const user = await open()
    const side = screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐、字幕和属性' })
    await user.click(within(side).getByRole('tab', { name: '字幕' }))
    const panel = () => screen.getByRole('tabpanel', { name: '字幕' })
    const current = () =>
      within(panel())
        .getAllByRole('listitem')
        .filter((item) => item.getAttribute('aria-current') === 'true')
        .map((item) => within(item).getByRole('textbox').getAttribute('aria-label'))

    await user.click(bodyOf('第二句'))
    expect(panel()).toBeVisible()
    expect(current()).toEqual(['字幕文字 00:01.50 – 00:02.50'])
    await user.click(within(screen.getByRole('group', { name: '画面 1' })).getByRole('button'))
    expect(panel()).toBeVisible()
    expect(current()).toEqual([])

    await user.click(within(panel()).getByRole('button', { name: '00:03.00 – 00:04.00' }))
    expect(bodyOf('第三句')).toHaveAttribute('aria-pressed', 'true')
    expect(current()).toEqual(['字幕文字 00:03.00 – 00:04.00'])
    expect(progress()).toHaveAttribute('aria-valuetext', '00:03.00 / 00:04.00')
    expect(panel()).toBeVisible()
  })

  it('点一句的时间：这句的开头不在帧边界上，预览也停在看得到这句的时刻', async () => {
    // 3.01 秒落在 30 帧每秒的第 90 帧（3.000 秒起）里，这句从第 91 帧才出现
    const late = caption({
      id: 'cap-c3',
      variable: 'cap_c3',
      start: 3_010,
      duration: 990,
      text: '第三句',
    })
    const user = await open([...lines.slice(0, 2), late])
    await user.click(
      within(
        screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐、字幕和属性' }),
      ).getByRole('tab', { name: '字幕' }),
    )
    await previewSettled()

    await user.click(
      within(screen.getByRole('tabpanel', { name: '字幕' })).getByRole('button', {
        name: '00:03.01 – 00:04.00',
      }),
    )
    await waitFor(() => {
      const at = previewPlayer().currentTime
      expect(at).toBeGreaterThanOrEqual(3.01)
      expect(at).toBeLessThan(4)
    })
  })

  it('停在别的页签时在时间线上选中字幕：照常切到「属性」', async () => {
    const user = await open()
    await user.click(bodyOf('第二句'))
    expect(screen.getByRole('tabpanel', { name: '属性' })).toBeVisible()
  })

  it('字幕那一行的空白处点右键什么都不出：合拢会把字幕从说话的时间上挪开', async () => {
    await open()
    // 1.2 秒处是第一句和第二句之间的空档（测试里一秒 100 像素）
    fireEvent.contextMenu(captionRow(), { clientX: 120 })
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)))
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

const subtitleJob = (sourceJobId: string, overrides: Partial<GenerationJob> = {}): GenerationJob =>
  makeGenerationJob({ kind: 'subtitle', sourceJobId, sentences: [], ...overrides })

const said = (startMs: number, endMs: number, text: string) => ({
  startMs,
  endMs,
  text,
  speaker: null,
  words: [],
})

/**
 * 字幕识别记录：`stored` 是已有的记录。发起识别时记下素材片，答复一条排队中的记录，之后读到的是
 * `outcome(素材片)` 给的那一条（默认识别完成、没有句子）；`hold` 给了时发起识别的答复等它放行。
 */
const serveSubtitles = (
  stored: GenerationJob[],
  outcome: (sourceJobId: string) => GenerationJob = (source) => subtitleJob(source),
  hold?: Promise<void>,
) => {
  const records = [...stored]
  const submitted: string[] = []
  server.use(
    http.get('*/api/generations', ({ request }) => {
      const params = new URL(request.url).searchParams
      if (params.get('kind') !== 'subtitle') return undefined
      const source = params.get('sourceJobId')
      return HttpResponse.json({ items: records.filter((job) => job.sourceJobId === source) })
    }),
    http.post('*/api/generations/subtitles', async ({ request }) => {
      const { sourceJobId } = (await request.json()) as { sourceJobId: string }
      submitted.push(sourceJobId)
      await hold
      records.unshift(outcome(sourceJobId))
      return HttpResponse.json(
        { generation: subtitleJob(sourceJobId, { status: 'submitted', sentences: null }) },
        { status: 202 },
      )
    }),
  )
  return submitted
}

describe('final-cut 编辑器 · 识别字幕', () => {
  const openCaptions = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(
      within(
        screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐、字幕和属性' }),
      ).getByRole('tab', { name: '字幕' }),
    )
    return screen.getByRole('tabpanel', { name: '字幕' })
  }
  const recognizeButton = (panel: HTMLElement) =>
    within(panel).getByRole('button', { name: /^(识别字幕|识别中…)$/ })
  const clipA = video({ label: 'A · 镜头 1', src: URL_A, duration: 2_000 })
  const clipB = video({
    id: 'clip-2',
    label: 'B · 镜头 1',
    src: URL_B,
    start: 2_000,
    duration: 1_500,
  })

  it('已有识别完成的记录：不发起识别，各片段的句子换算到 final-cut 里一次写进去，属于各自的片段，一步撤销', async () => {
    await putFilm([clipA, clipB])
    const user = userEvent.setup()
    await openEditor()
    const submitted = serveSubtitles([
      subtitleJob(TAKE_A, { sentences: [said(300, 1_200, '第一句话')] }),
      // 片段只用到素材的前 1.5 秒：后一句开头在片段里，结尾超出片段也照句子的结尾
      subtitleJob(TAKE_B, {
        sentences: [said(200, 1_000, '第二段'), said(1_200, 2_500, '说到片段外')],
      }),
    ])
    const panel = await openCaptions(user)
    await user.click(recognizeButton(panel))
    await waitSaved(() =>
      expect(savedSceneLines()).toEqual([
        ['第一句话', 0.3, 0.9, 'clip-1'],
        ['第二段', 2.2, 0.8, 'clip-2'],
        ['说到片段外', 3.2, 1.3, 'clip-2'],
      ]),
    )
    expect(savedVariableTexts()).toEqual(['第一句话', '第二段', '说到片段外'])
    expect(submitted).toEqual([])
    expect(await screen.findByText('已加入 3 句字幕')).toBeVisible()
    // 都有字幕了：不再识别
    expect(recognizeButton(panel)).toHaveAttribute('aria-disabled', 'true')

    await user.click(undoButton())
    await waitSaved(() => expect(savedSceneLines()).toEqual([]))
    expect(savedVariableTexts()).toEqual([])
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
  })

  it('没有记录：同一条素材的两个片段只发起一次识别；识别中按钮写「识别中…」、写着在识别几个片段，结果来了一次写进去', async () => {
    // 两个片段用同一条素材的前后两段
    await putFilm([
      video({ label: '前半', src: URL_A, duration: 2_000 }),
      video({
        id: 'clip-2',
        label: '后半',
        src: URL_A,
        start: 2_000,
        duration: 2_000,
        mediaStart: 2_000,
      }),
    ])
    const user = userEvent.setup()
    await openEditor()
    let release = () => {}
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const submitted = serveSubtitles(
      [],
      (source) =>
        subtitleJob(source, {
          sentences: [said(500, 1_500, '前一句'), said(2_500, 3_500, '后一句')],
        }),
      hold,
    )
    const panel = await openCaptions(user)
    await user.click(recognizeButton(panel))
    await waitFor(() => expect(recognizeButton(panel)).toHaveTextContent('识别中…'))
    expect(recognizeButton(panel)).toHaveAttribute('aria-disabled', 'true')
    expect(within(panel).getByText('正在识别 2 个视频片段的字幕，可继续编辑')).toBeVisible()
    // 识别中再点不会再发起
    await user.click(recognizeButton(panel))
    release()
    await waitSaved(() =>
      expect(savedSceneLines()).toEqual([
        ['前一句', 0.5, 1, 'clip-1'],
        ['后一句', 2.5, 1, 'clip-2'],
      ]),
    )
    expect(submitted).toEqual([TAKE_A])
    expect(recognizeButton(panel)).toHaveTextContent('识别字幕')
    expect(within(panel).queryByText(/^正在识别/)).toBeNull()
  })

  it('这条素材正在识别：不再发起，等着它', async () => {
    await putFilm([clipA])
    const user = userEvent.setup()
    await openEditor()
    const submitted = serveSubtitles([
      subtitleJob(TAKE_A, { status: 'submitted', sentences: null }),
    ])
    const panel = await openCaptions(user)
    await user.click(recognizeButton(panel))
    await act(() => new Promise((resolve) => setTimeout(resolve, 300)))
    expect(submitted).toEqual([])
    expect(recognizeButton(panel)).toHaveTextContent('识别中…')
    expect(within(panel).getByText('正在识别 1 个视频片段的字幕，可继续编辑')).toBeVisible()
  })

  it('已经有字幕的片段、关闭了原声又没分离的片段不识别，别的照常', async () => {
    await putFilm(
      [
        clipA,
        video({
          id: 'clip-2',
          label: '静音',
          src: URL_B,
          start: 2_000,
          duration: 1_500,
          muted: true,
        }),
        video({ id: 'clip-3', label: '有声', src: URL_B, start: 4_000, duration: 1_500 }),
      ],
      [sceneLine('a1', 0, 1_000, 'clip-1')],
    )
    const user = userEvent.setup()
    await openEditor()
    const submitted = serveSubtitles([
      subtitleJob(TAKE_A, { sentences: [said(1_200, 1_800, '不会写进去')] }),
      subtitleJob(TAKE_B, { sentences: [said(100, 900, '有声的话')] }),
    ])
    const panel = await openCaptions(user)
    await user.click(recognizeButton(panel))
    await waitSaved(() =>
      expect(savedSceneLines()).toEqual([
        ['字幕 a1', 0, 1, 'clip-1'],
        ['有声的话', 4.1, 0.8, 'clip-3'],
      ]),
    )
    expect(submitted).toEqual([])
  })

  it('一个片段识别失败：其余照常写进去，提示失败的片段，可以再点重试；识别出来没有话的片段也提示', async () => {
    await putFilm([
      clipA,
      clipB,
      video({ id: 'clip-3', label: '安静', src: URL_SILENT, start: 4_000 }),
    ])
    const user = userEvent.setup()
    await openEditor([...takes, ...quietTakes])
    const submitted = serveSubtitles(
      [
        subtitleJob(TAKE_A, { status: 'failed', sentences: null }),
        subtitleJob(TAKE_B, { sentences: [said(200, 1_000, '照常写')] }),
        subtitleJob(TAKE_SILENT, { sentences: [] }),
      ],
      (source) => subtitleJob(source, { status: 'failed', sentences: null }),
    )
    const panel = await openCaptions(user)
    await user.click(recognizeButton(panel))
    await waitSaved(() => expect(savedSceneLines()).toEqual([['照常写', 2.2, 0.8, 'clip-2']]))
    expect(
      await screen.findByText('A · 镜头 1 的字幕识别失败，请点击「识别字幕」重试'),
    ).toBeVisible()
    expect(await screen.findByText('安静 没有识别出说话，未加字幕')).toBeVisible()
    // 上次失败了的那条重新发起一次
    expect(submitted).toEqual([TAKE_A])
    await waitFor(() => expect(recognizeButton(panel)).not.toHaveAttribute('aria-disabled'))
    await user.click(recognizeButton(panel))
    await waitFor(() => expect(submitted).toEqual([TAKE_A, TAKE_A]))
  })

  it('没有可识别的片段时「识别字幕」置灰，点了说明原因', async () => {
    const user = userEvent.setup()
    await openEditor()
    const panel = await openCaptions(user)
    expect(recognizeButton(panel)).toHaveAttribute('aria-disabled', 'true')
    await user.click(recognizeButton(panel))
    expect(
      (await screen.findAllByText('final-cut 里暂无视频片段，无法识别字幕；请先加入镜头')).length,
    ).toBeGreaterThan(0)
  })

  it('视频片段都关了原声：「识别字幕」置灰，说明原因', async () => {
    await putFilm([{ ...clipA, muted: true }])
    const user = userEvent.setup()
    await openEditor()
    // 素材片读完了才知道片段对不对得上素材
    await shot(/^出片 A 镜头 1，/)
    const panel = await openCaptions(user)
    expect(recognizeButton(panel)).toHaveAttribute('aria-disabled', 'true')
    await user.click(recognizeButton(panel))
    expect(
      (
        await screen.findAllByText(
          '视频片段都关闭了原声或找不到素材记录，无法识别字幕；请先打开原声',
        )
      ).length,
    ).toBeGreaterThan(0)
  })
})

describe('final-cut 编辑器 · 字幕跟着视频片段、配音片段走', () => {
  /** 画面 1：视频 0–4 秒；字幕：它的两句 0.5–1 秒、2.5–3 秒，手动加的一句 6–7 秒。 */
  const open = async () => {
    await putFilm(
      [video({ label: 'A · 镜头 1', src: URL_A, duration: 4_000 })],
      [
        sceneLine('a1', 500, 500, 'clip-1'),
        sceneLine('b2', 2_500, 500, 'clip-1'),
        sceneLine('m3', 6_000, 1_000),
      ],
    )
    const user = userEvent.setup()
    await openEditor()
    return user
  }
  const lane = () => screen.getByRole('group', { name: '画面 1' })
  const videoBodies = () => within(lane()).getAllByRole('button', { name: /^选中：/ })
  /** 拖片段：测试里时间线按一秒 100 像素排，拖 `dx` 像素就是想挪到第 `dx` × 10 毫秒。 */
  const drag = (target: HTMLElement, dx: number) => {
    fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: 10, clientY: 50 })
    fireEvent.pointerMove(target, { pointerId: 1, clientX: 10 + dx, clientY: 50 })
    fireEvent.pointerUp(target, { pointerId: 1, clientX: 10 + dx, clientY: 50 })
  }
  const timingsOf = () => savedSceneLines().map(([text, start]) => [text, start])

  it('在时间线上拖视频片段：它的字幕挪同样的时间，手动加的不动；一步撤销都回去', async () => {
    const user = await open()
    const [body] = videoBodies()
    if (body === undefined) throw new Error('没有视频片段')
    drag(body, 100)
    await waitSaved(() =>
      expect(timingsOf()).toEqual([
        ['字幕 a1', 1.5],
        ['字幕 b2', 3.5],
        ['字幕 m3', 6],
      ]),
    )
    expect(savedClips()[0]).toContain('data-start="1"')
    await user.click(undoButton())
    await waitSaved(() =>
      expect(timingsOf()).toEqual([
        ['字幕 a1', 0.5],
        ['字幕 b2', 2.5],
        ['字幕 m3', 6],
      ]),
    )
    expect(savedClips()[0]).toContain('data-start="0"')
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
  })

  it('拖视频片段：它的字幕上配的各语言配音（原文下不显示）跟着字幕挪；一步撤销都回去', async () => {
    const dub = (id: string, locale: string, caption: string, start: number) =>
      audio({
        id,
        label: `配音 ${id}`,
        src: `https://media.test/${id}.m4a`,
        start,
        duration: 500,
        dub: { locale, caption, trimmed: false, voice: null },
      })
    await putFilm(
      [
        video({ label: 'A · 镜头 1', src: URL_A, duration: 4_000 }),
        dub('en-a1', 'en', 'cap-a1', 500),
        dub('de-b2', 'de', 'cap-b2', 2_500),
      ],
      [sceneLine('a1', 500, 500, 'clip-1'), sceneLine('b2', 2_500, 500, 'clip-1')],
    )
    const user = userEvent.setup()
    await openEditor()
    const dubStarts = () =>
      [
        ...new DOMParser()
          .parseFromString(savedFilm(), 'text/html')
          .querySelectorAll('audio[data-dub-of]'),
      ].map((element) => [element.id, Number(element.getAttribute('data-start'))])
    expect(screen.queryAllByRole('group', { name: /^配音 / })).toHaveLength(0)
    const [body] = videoBodies()
    if (body === undefined) throw new Error('没有视频片段')
    drag(body, 100)
    await waitSaved(() =>
      expect(dubStarts()).toEqual([
        ['en-a1', 1.5],
        ['de-b2', 3.5],
      ]),
    )
    await user.click(undoButton())
    await waitSaved(() =>
      expect(dubStarts()).toEqual([
        ['en-a1', 0.5],
        ['de-b2', 2.5],
      ]),
    )
  })

  it('删掉视频片段：它的字幕和变量一起删，手动加的留着；一步撤销都回来', async () => {
    const user = await open()
    const [body] = videoBodies()
    if (body === undefined) throw new Error('没有视频片段')
    await user.click(body)
    await user.keyboard('{Delete}')
    await waitSaved(() => expect(timingsOf()).toEqual([['字幕 m3', 6]]))
    expect(savedVariableTexts()).toEqual(['字幕 m3'])
    expect(savedClips()).toHaveLength(0)
    await user.click(undoButton())
    await waitSaved(() => expect(timingsOf()).toHaveLength(3))
    expect(savedClips()).toHaveLength(1)
  })

  it('开着波纹编辑删视频片段，后一段的字幕跟着补上来会压到别的字幕：不删，提示原因，片段还选中着', async () => {
    // 画面 1：视频 0–2 秒、2–4 秒；后一段的一句 2.5–3 秒，手动加的一句 0.6–1 秒。
    // 删掉前一段时后一段补到 0 秒，它的字幕挪到 0.5–1 秒，压到手动加的那句
    await putFilm(
      [
        video({ src: URL_A, duration: 2_000 }),
        video({ id: 'clip-2', label: 'B · 镜头 1', src: URL_B, start: 2_000, duration: 2_000 }),
      ],
      [sceneLine('m1', 600, 400), sceneLine('b2', 2_500, 500, 'clip-2')],
    )
    const user = userEvent.setup()
    await openEditor()
    const savedVersions = () => [
      savedVersion(),
      mockWorkspaceFile(CONVERSATION, SCENE_FILE)?.version,
    ]
    const versionsBefore = savedVersions()
    const [first] = videoBodies()
    if (first === undefined) throw new Error('没有视频片段')
    await user.click(first)
    expect(first).toHaveAttribute('aria-pressed', 'true')

    await user.keyboard('{Delete}')
    expect(
      await screen.findByText(
        '字幕跟着挪动后会和别的字幕重叠，无法完成这次编辑；请先挪开或删掉挡住的字幕',
      ),
    ).toBeVisible()
    expect(videoBodies()).toHaveLength(2)
    expect(videoBodies()[0]).toHaveAttribute('aria-pressed', 'true')
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
    // 过了自动保存的等待时间也不存：主文件和字幕场景都还是原来那一版
    await act(() => new Promise((resolve) => setTimeout(resolve, 1_500)))
    expect(savedVersions()).toEqual(versionsBefore)
  })

  it('切开以后挪后半段：切点以后的字幕跟着后半段走，切点以前的留在原处', async () => {
    const user = await open()
    editorRoot().focus()
    await user.keyboard('b')
    // 剃刀点在 2 秒处（一秒 100 像素）
    fireEvent.pointerDown(lane(), {
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
      clientX: 200,
      clientY: 10,
    })
    await waitSaved(() => expect(savedClips()).toHaveLength(2))
    const halfId = /id="(clip-[^"]+)"/.exec(
      savedClips().find((tag) => tag.includes('data-start="2"')) ?? '',
    )?.[1]
    expect(halfId).toBeDefined()
    expect(savedSceneLines().map(([text, , , owner]) => [text, owner])).toEqual([
      ['字幕 a1', 'clip-1'],
      ['字幕 b2', halfId],
      ['字幕 m3', null],
    ])

    editorRoot().focus()
    await user.keyboard('v')
    const second = videoBodies()[1]
    if (second === undefined) throw new Error('没有后半段')
    // 后半段从 2 秒挪到 4.5 秒
    drag(second, 450)
    await waitSaved(() =>
      expect(timingsOf()).toEqual([
        ['字幕 a1', 0.5],
        ['字幕 b2', 5],
        ['字幕 m3', 6],
      ]),
    )
  })

  it('English 下拖配音片段：它配的那句字幕和这句别的语言的配音挪同样的时间，视频片段不动；一步撤销都回去', async () => {
    const dub = (id: string, locale: string, caption: string, start: number) =>
      audio({
        id,
        label: `配音 ${id}`,
        src: `https://media.test/${id}.m4a`,
        start,
        duration: 500,
        dub: { locale, caption, trimmed: false, voice: null },
      })
    await putFilm(
      [
        video({ label: 'A · 镜头 1', src: URL_A, duration: 4_000 }),
        dub('en-a1', 'en', 'cap-a1', 500),
        dub('de-a1', 'de', 'cap-a1', 500),
        dub('en-b2', 'en', 'cap-b2', 2_500),
      ],
      [sceneLine('a1', 500, 500, 'clip-1'), sceneLine('b2', 2_500, 500, 'clip-1')],
      // 保留原声时这种语言的配音片段不显示，先切到 AI 配音
      '{"en":{"mode":"dub","voice":null}}',
    )
    putMockWorkspaceFile(CONVERSATION, 'final-cut/locales/en.json', '{"cap_a1": "A one"}')
    const user = userEvent.setup()
    await openEditor()
    await user.click(
      within(within(toolbar()).getByRole('group', { name: '语言' })).getByRole('button', {
        name: 'English（EN）',
      }),
    )
    const dubStarts = () =>
      [
        ...new DOMParser()
          .parseFromString(savedFilm(), 'text/html')
          .querySelectorAll('audio[data-dub-of]'),
      ].map((element) => [element.id, Number(element.getAttribute('data-start'))])
    const row = await screen.findByRole('group', { name: '配音' })
    const [first] = within(row).getAllByRole('button', { name: /^选中：/ })
    if (first === undefined) throw new Error('没有配音片段')

    // 0.5 秒挪到 1.2 秒
    drag(first, 120)
    await waitSaved(() =>
      expect(dubStarts()).toEqual([
        ['en-a1', 1.2],
        ['de-a1', 1.2],
        ['en-b2', 2.5],
      ]),
    )
    expect(timingsOf()).toEqual([
      ['字幕 a1', 1.2],
      ['字幕 b2', 2.5],
    ])
    expect(savedClips()[0]).toContain('data-start="0"')

    await user.click(undoButton())
    await waitSaved(() =>
      expect(dubStarts()).toEqual([
        ['en-a1', 0.5],
        ['de-a1', 0.5],
        ['en-b2', 2.5],
      ]),
    )
    expect(timingsOf()).toEqual([
      ['字幕 a1', 0.5],
      ['字幕 b2', 2.5],
    ])
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
  })
})
