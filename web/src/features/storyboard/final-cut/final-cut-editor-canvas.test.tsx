import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { putMockProjectMain } from '@/testing/mocks/whole-film'
import { host, mainFile, video } from '@/testing/final-cut'
import {
  CONVERSATION,
  openEditor,
  previewPages,
  previewSettled,
  savedClips,
  savedFilm,
  setUpEditorCase,
  shot,
  tearDownEditorCase,
  transport,
  undoButton,
  waitSaved,
} from '@/testing/final-cut-editor'

vi.mock('mediabunny', async () => (await import('@/testing/final-cut-media')).mediabunnyMock())

// 一条用例要开整个编辑器、走完一串操作，上限放宽到 15 秒
vi.setConfig({ testTimeout: 15_000 })

beforeEach(setUpEditorCase)
afterEach(tearDownEditorCase)

describe('final-cut 编辑器 · 画面设置', () => {
  const openWith = async (
    clips: Parameters<typeof mainFile>[0],
    canvas = { width: 720, height: 1280 },
  ) => {
    putMockProjectMain(CONVERSATION, mainFile(clips, canvas))
    const user = userEvent.setup()
    await openEditor()
    return user
  }

  const trigger = () => screen.getByRole('button', { name: /^画面尺寸/ })
  const panel = () => within(screen.getByRole('dialog', { name: '画面设置' }))
  const openPanel = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(trigger())
    return panel()
  }
  const row = () => screen.getByRole('group', { name: '画面 1' })
  const clipButton = () => within(row()).getByRole('button', { name: /^选中：A · 镜头 1，/ })

  /** 存下的主文件里根上写的画面尺寸。 */
  const savedCanvas = () => {
    const root = /<div [^>]*id="film"[^>]*data-width="(\d+)" data-height="(\d+)"/.exec(savedFilm())
    return root === null ? null : `${root[1]}×${root[2]}`
  }
  /** 存下的主文件里根的开始标签。 */
  const savedRoot = () => /<div [^>]*id="film"[^>]*>/.exec(savedFilm())?.[0] ?? ''

  it('时间线上有视频片段时也能在画面右上角改画面尺寸：点 16:9 后预览变横、存下来是 1920×1080；一次撤销回到原尺寸', async () => {
    const user = await openWith([video()])
    expect(trigger()).toHaveAccessibleName('画面尺寸 9:16 · 720P')
    const previewSize = () =>
      previewPages.latest().commands.findLast((command) => command.type === 'size')
    await waitFor(() => expect(previewSize()).toMatchObject({ width: 720, height: 1280 }))

    const landscape = (await openPanel(user)).getByRole('button', { name: '16:9' })
    expect(landscape).toHaveAttribute('aria-pressed', 'false')
    await user.click(landscape)
    expect(landscape).toHaveAttribute('aria-pressed', 'true')
    expect(trigger()).toHaveAccessibleName('画面尺寸 16:9 · 1080P')
    await waitFor(() => expect(previewSize()).toMatchObject({ width: 1920, height: 1080 }))
    await waitSaved(() => expect(savedCanvas()).toBe('1920×1080'))

    await user.click(undoButton())
    await waitSaved(() => expect(savedCanvas()).toBe('720×1280'))
    expect((await openPanel(user)).getByRole('textbox', { name: '宽' })).toHaveValue('720')
  })

  it('「互换宽高」改成 1280×720，一次撤销回到 720×1280', async () => {
    const user = await openWith([video()])
    await user.click((await openPanel(user)).getByRole('button', { name: '互换宽高' }))
    await waitSaved(() => expect(savedCanvas()).toBe('1280×720'))
    await user.click(undoButton())
    await waitSaved(() => expect(savedCanvas()).toBe('720×1280'))
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
  })

  it('还没有视频片段时放进第一段视频：画面尺寸改成跟它一致（720×1280 的素材 → 1080×1920），已有贴片的行内样式不变；一次撤销尺寸和片段一起回去', async () => {
    const user = await openWith([host()], { width: 1920, height: 1080 })
    const hostTag = () => /<[a-z]+ [^>]*\bid="title-1"[^>]*>/.exec(savedFilm())?.[0] ?? ''
    const hostBefore = hostTag()
    await user.click(await shot(/^出片 A 镜头 1，/))
    await user.keyboard('{Enter}')
    await waitSaved(() => expect(savedClips()).toHaveLength(1))
    expect(savedCanvas()).toBe('1080×1920')
    expect(hostTag()).toBe(hostBefore)

    await user.click(undoButton())
    await waitSaved(() => expect(savedClips()).toHaveLength(0))
    expect(savedCanvas()).toBe('1920×1080')
  })

  it('已经有视频片段时再放视频：画面尺寸不变', async () => {
    const user = await openWith([video()])
    await user.click(await shot(/^出片 A 镜头 1，/))
    await user.keyboard('{Enter}')
    await waitSaved(() => expect(savedClips()).toHaveLength(2))
    expect(savedCanvas()).toBe('720×1280')
  })

  it('画布底色：选纯白写在主文件根上；一次撤销回到黑底、根上不再写底色', async () => {
    const user = await openWith([video()])
    const swatches = within((await openPanel(user)).getByRole('group', { name: '画布底色' }))
    expect(swatches.getByRole('button', { name: '纯黑' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(swatches.getByRole('button', { name: '纯白' }))
    await waitSaved(() => expect(savedRoot()).toContain('style="background-color: #ffffff"'))
    expect(swatches.getByRole('button', { name: '纯白' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(undoButton())
    await waitSaved(() => expect(savedRoot()).not.toContain('background-color'))
    expect(swatches.getByRole('button', { name: '纯黑' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('参考线只是编辑时看的：打开九宫格和安全区后存下的主文件里没有它们', async () => {
    const user = await openWith([video()])
    const quick = screen.getByRole('button', { name: '参考线' })
    await user.click(quick)
    expect(quick).toHaveAttribute('aria-pressed', 'true')
    // 再改一下底色，让它存一次
    const swatches = within((await openPanel(user)).getByRole('group', { name: '画布底色' }))
    await user.click(swatches.getByRole('button', { name: '岩灰' }))
    await waitSaved(() => expect(savedRoot()).toContain('#4b535c'))
    expect(savedFilm()).not.toMatch(/互动区|底部信息遮挡区|九宫格|framing/)
  })

  it('浮层数字框里按 Enter、空格、Delete 不当编辑器快捷键：不加入、不播放、不删选中的片段；Esc 只关浮层，片段仍选中', async () => {
    const user = await openWith([video()])
    await previewSettled()
    await user.click(clipButton())
    expect(clipButton()).toHaveAttribute('aria-pressed', 'true')

    const width = (await openPanel(user)).getByRole('textbox', { name: '宽' })
    await user.click(width)
    await user.keyboard(' {Delete}{Backspace}{ArrowLeft}')
    await user.keyboard('{Enter}')
    expect(within(transport()).getByRole('button', { name: '播放' })).toBeVisible()
    expect(clipButton()).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen.queryByText('尚未选中镜头，无法加入轨道；请先在「镜头」页签中选中镜头范围'),
    ).toBeNull()
    expect(savedClips()).toHaveLength(1)

    await user.click(panel().getByRole('button', { name: '1:1' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: '画面设置' })).toBeNull()
    expect(clipButton()).toHaveAttribute('aria-pressed', 'true')
  })
})
