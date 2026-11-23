import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import { CanvasSettings, FramingGuides, type Framing } from './canvas-settings'
import type { Canvas } from './composition/film'
import { exportTierOf, useChosenTier } from './export-tier'

const CONVERSATION = '0f1e2d3c-4b5a-4968-8776-655443322110'

/** 和编辑器一样：画面尺寸、底色、参考线由外面记着，浮层里改的是外面这一份；导出档位按对话记在浏览器里。 */
function Harness({
  conversationId,
  initialCanvas,
  initialBackground,
  onCanvas,
  onBackground,
}: {
  conversationId: string
  initialCanvas: Canvas
  initialBackground: string | null
  onCanvas: (canvas: Canvas) => void
  onBackground: (color: string) => void
}) {
  const [canvas, setCanvas] = useState(initialCanvas)
  const [background, setBackground] = useState(initialBackground)
  const [framing, setFraming] = useState<Framing>({ grid: 'off', safeArea: false })
  const [chosenTier, chooseTier] = useChosenTier(conversationId)
  return (
    <>
      <CanvasSettings
        background={background}
        canvas={canvas}
        framing={framing}
        layer={null}
        onTier={chooseTier}
        tier={exportTierOf(canvas, chosenTier).tier}
        onBackground={(color) => {
          onBackground(color)
          setBackground(color)
        }}
        onCanvas={(next) => {
          onCanvas(next)
          setCanvas(next)
        }}
        onFraming={setFraming}
      />
      <FramingGuides canvas={canvas} framing={framing} />
    </>
  )
}

const renderHud = async ({
  canvas = { width: 720, height: 1280 },
  background = 'black',
  conversationId = CONVERSATION,
}: { canvas?: Canvas; background?: string | null; conversationId?: string } = {}) => {
  const onCanvas = vi.fn()
  const onBackground = vi.fn()
  const user = userEvent.setup()
  const { unmount } = await renderWithProviders(
    <Harness
      conversationId={conversationId}
      initialBackground={background}
      initialCanvas={canvas}
      onBackground={onBackground}
      onCanvas={onCanvas}
    />,
  )
  return { user, onCanvas, onBackground, unmount }
}

afterEach(() => window.localStorage.clear())

const trigger = () => screen.getByRole('button', { name: /^画面尺寸/ })
const panel = () => within(screen.getByRole('dialog', { name: '画面设置' }))
const ratios = () => within(panel().getByRole('group', { name: '画面比例' }))
/** 浮层里名为 `name` 的一组按钮中按下着的那些的名字。 */
const pressedIn = (name: string) =>
  within(panel().getByRole('group', { name }))
    .queryAllByRole('button', { pressed: true })
    .map((button) => button.textContent || button.getAttribute('aria-label'))
const width = () => panel().getByRole('textbox', { name: '宽' })
const height = () => panel().getByRole('textbox', { name: '高' })
const RANGE_TEXT = '宽高须在 240–4096 之间'

describe('画面设置 · 画面尺寸', () => {
  it('触发条写现在的比例；六个比例按钮，宽高正好等于哪一种时它按下，都不是时都不按下；点一下改成它', async () => {
    const { user, onCanvas } = await renderHud()
    expect(trigger()).toHaveAccessibleName('画面尺寸 9:16 · 720P')
    await user.click(trigger())
    expect(
      ratios()
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['9:16', '3:4', '1:1', '4:3', '16:9', '21:9'])
    expect(pressedIn('画面比例')).toEqual([])
    expect(width()).toHaveValue('720')
    expect(height()).toHaveValue('1280')

    await user.click(ratios().getByRole('button', { name: '21:9' }))
    expect(onCanvas).toHaveBeenLastCalledWith({ width: 2520, height: 1080 })
    expect(pressedIn('画面比例')).toEqual(['21:9'])
    expect(width()).toHaveValue('2520')
    expect(height()).toHaveValue('1080')
    expect(trigger()).toHaveAccessibleName('画面尺寸 21:9 · 1080P')
  })

  it('数字框回车或失焦生效，奇数减 1；改成预设的宽高时那个比例按下', async () => {
    const { user, onCanvas } = await renderHud()
    await user.click(trigger())
    await user.clear(width())
    await user.type(width(), '1081{Enter}')
    expect(onCanvas).toHaveBeenLastCalledWith({ width: 1080, height: 1280 })
    expect(width()).toHaveValue('1080')

    await user.clear(height())
    await user.type(height(), '1440')
    await user.tab()
    expect(onCanvas).toHaveBeenLastCalledWith({ width: 1080, height: 1440 })
    expect(pressedIn('画面比例')).toEqual(['3:4'])
    expect(screen.queryByText(RANGE_TEXT)).toBeNull()
  })

  it('超出 240–4096、不是整数、空着时框下面提示，框回到原来的值，画面不变；下一次改成功后提示消失', async () => {
    const { user, onCanvas } = await renderHud()
    await user.click(trigger())
    for (const typed of ['4097', '239', '12a', '1080.5']) {
      await user.clear(width())
      await user.type(width(), `${typed}{Enter}`)
      expect(panel().getByRole('alert')).toHaveTextContent(RANGE_TEXT)
      expect(width()).toHaveValue('720')
      expect(width()).toHaveAttribute('aria-invalid', 'true')
    }
    await user.clear(height())
    await user.tab()
    expect(height()).toHaveValue('1280')
    expect(onCanvas).not.toHaveBeenCalled()

    await user.clear(width())
    await user.type(width(), '4096{Enter}')
    expect(onCanvas).toHaveBeenLastCalledWith({ width: 4096, height: 1280 })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('Esc 放弃输入，回到原来的值，浮层留着', async () => {
    const { user, onCanvas } = await renderHud()
    await user.click(trigger())
    await user.clear(width())
    await user.type(width(), '1920{Escape}')
    expect(width()).toHaveValue('720')
    expect(onCanvas).not.toHaveBeenCalled()
  })

  it('「互换宽高」把宽高对调', async () => {
    const { user, onCanvas } = await renderHud({ canvas: { width: 1080, height: 1920 } })
    await user.click(trigger())
    await user.click(panel().getByRole('button', { name: '互换宽高' }))
    expect(onCanvas).toHaveBeenLastCalledWith({ width: 1920, height: 1080 })
    expect(pressedIn('画面比例')).toEqual(['16:9'])
  })
})

describe('画面设置 · 导出分辨率', () => {
  const tiers = () => within(panel().getByRole('group', { name: '导出分辨率' }))
  const tierButton = (name: string) => tiers().getByRole('button', { name })
  const disabledTiers = () =>
    tiers()
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-disabled') === 'true')
      .map((button) => button.textContent)

  it('1080×1920：1080P 亮，480P、720P 能选；选 720P 胶囊写「· 720P」，画面尺寸不变、不改主文件，提示写导出尺寸', async () => {
    const { user, onCanvas } = await renderHud({ canvas: { width: 1080, height: 1920 } })
    expect(trigger()).toHaveAccessibleName('画面尺寸 9:16 · 1080P')
    await user.click(trigger())
    expect(
      tiers()
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['480P', '720P', '1080P'])
    expect(pressedIn('导出分辨率')).toEqual(['1080P'])
    expect(disabledTiers()).toEqual([])

    await user.click(tierButton('720P'))
    expect(pressedIn('导出分辨率')).toEqual(['720P'])
    expect(trigger()).toHaveAccessibleName('画面尺寸 9:16 · 720P')
    expect(width()).toHaveValue('1080')
    expect(height()).toHaveValue('1920')
    expect(onCanvas).not.toHaveBeenCalled()

    await user.keyboard('{Escape}')
    await user.hover(trigger())
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      /^画面尺寸 1080×1920，导出 720×1280$/,
    )
  })

  it('3:4 的 1080×1440：1080P 亮，480P、720P 置灰，点了说明一句、不选上', async () => {
    const { user } = await renderHud({ canvas: { width: 1080, height: 1440 } })
    await user.click(trigger())
    expect(pressedIn('导出分辨率')).toEqual(['1080P'])
    expect(disabledTiers()).toEqual(['480P', '720P'])

    await user.click(tierButton('720P'))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/^当前画面尺寸不支持按 720P 导出$/)
    expect(pressedIn('导出分辨率')).toEqual(['1080P'])
  })

  it('1280×800：三档都不亮、都置灰，胶囊在简称后面写宽×高；480×854 只亮 480P，放大的两档置灰', async () => {
    const { user, unmount } = await renderHud({ canvas: { width: 1280, height: 800 } })
    expect(trigger()).toHaveAccessibleName('画面尺寸 8:5 · 1280×800')
    await user.click(trigger())
    expect(pressedIn('导出分辨率')).toEqual([])
    expect(disabledTiers()).toEqual(['480P', '720P', '1080P'])
    unmount()

    const small = await renderHud({ canvas: { width: 480, height: 854 } })
    await small.user.click(trigger())
    expect(pressedIn('导出分辨率')).toEqual(['480P'])
    expect(disabledTiers()).toEqual(['720P', '1080P'])
  })

  it('简称本身就是宽×高时不重复写', async () => {
    await renderHud({ canvas: { width: 1234, height: 802 } })
    expect(trigger()).toHaveAccessibleName('画面尺寸 1234×802')
  })

  it('换成不能按选的档导出的比例时回到画面档；换回来选的档又亮', async () => {
    const { user } = await renderHud({ canvas: { width: 1080, height: 1920 } })
    await user.click(trigger())
    await user.click(tierButton('720P'))

    await user.click(ratios().getByRole('button', { name: '3:4' }))
    expect(pressedIn('导出分辨率')).toEqual(['1080P'])
    expect(trigger()).toHaveAccessibleName('画面尺寸 3:4 · 1080P')

    await user.click(ratios().getByRole('button', { name: '9:16' }))
    expect(pressedIn('导出分辨率')).toEqual(['720P'])
  })

  it('选的档按对话记在浏览器里：重新打开还在，别的对话不受影响', async () => {
    const canvas = { width: 1080, height: 1920 }
    const { user, unmount } = await renderHud({ canvas })
    await user.click(trigger())
    await user.click(tierButton('480P'))
    unmount()

    const reopened = await renderHud({ canvas })
    expect(trigger()).toHaveAccessibleName('画面尺寸 9:16 · 480P')
    reopened.unmount()

    await renderHud({ canvas, conversationId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' })
    expect(trigger()).toHaveAccessibleName('画面尺寸 9:16 · 1080P')
  })
})

describe('画面设置 · 画布底色', () => {
  const swatches = () => within(panel().getByRole('group', { name: '画布底色' }))

  it('按模版写的 black 是纯黑；点纯白改成它，再点纯白不再改', async () => {
    const { user, onBackground } = await renderHud()
    await user.click(trigger())
    expect(pressedIn('画布底色')).toEqual(['纯黑'])
    expect(swatches().getByText('纯黑')).toBeVisible()

    await user.click(swatches().getByRole('button', { name: '纯白' }))
    expect(onBackground).toHaveBeenCalledWith('#ffffff')
    expect(pressedIn('画布底色')).toEqual(['纯白'])
    await user.click(swatches().getByRole('button', { name: '纯白' }))
    expect(onBackground).toHaveBeenCalledTimes(1)
  })

  it.each([null, '#123456'])(
    '底色是 %s（读不出、不是这几种）时哪个都不按下',
    async (background) => {
      const { user } = await renderHud({ background })
      await user.click(trigger())
      expect(pressedIn('画布底色')).toEqual([])
    },
  )
})

describe('画面设置 · 参考线', () => {
  const guides = () => screen.queryByTestId('framing-guides')
  const quick = () => screen.getByRole('button', { name: '参考线' })

  it('快捷按钮：全关着时打开九宫格和安全区（竖的画面是互动区和底部信息区），有开着的时全关', async () => {
    const { user } = await renderHud()
    expect(guides()).toBeNull()
    expect(quick()).toHaveAttribute('aria-pressed', 'false')

    await user.click(quick())
    expect(quick()).toHaveAttribute('aria-pressed', 'true')
    expect(within(guides() ?? document.body).getByText('互动区')).toBeInTheDocument()
    expect(within(guides() ?? document.body).getByText('底部信息遮挡区')).toBeInTheDocument()
    await user.click(trigger())
    expect(pressedIn('构图网格')).toEqual(['九宫格'])
    expect(panel().getByRole('switch', { name: '短视频安全区' })).toBeChecked()

    await user.click(quick())
    expect(guides()).toBeNull()
  })

  it('浮层里选十字、开安全区；横的画面的安全区是底部播控区', async () => {
    const { user } = await renderHud({ canvas: { width: 1920, height: 1080 } })
    await user.click(trigger())
    await user.click(panel().getByRole('button', { name: '十字' }))
    expect(guides()).not.toBeNull()
    expect(quick()).toHaveAttribute('aria-pressed', 'true')
    await user.click(panel().getByRole('switch', { name: '短视频安全区' }))
    expect(within(guides() ?? document.body).getByText('底部播控遮挡区')).toBeInTheDocument()
    expect(screen.queryByText('互动区')).toBeNull()

    await user.click(panel().getByRole('button', { name: '关闭' }))
    await user.click(panel().getByRole('switch', { name: '短视频安全区' }))
    expect(guides()).toBeNull()
  })
})
