import { parseAutomation, sampleAutomationLane } from '@hyperframes/core/audio-automation'
import { parseAudioFxChain } from '@hyperframes/core/audio-fx'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import { putMockProjectMain } from '@/testing/mocks/whole-film'
import { audio, fixtureCatalog, host, mainFile, video } from '@/testing/final-cut'
import {
  CONVERSATION,
  URL_A,
  URL_B,
  URL_SILENT,
  URL_UNREADABLE,
  editorRoot,
  openEditor,
  previewPages,
  previewPlayer,
  previewSettled,
  savedClips,
  savedFilm,
  setUpEditorCase,
  shot,
  tearDownEditorCase,
  toolbar,
  transport,
  waitSaved,
} from '@/testing/final-cut-editor'
import { files } from '@/testing/final-cut-media'
import { eqBandsOf, ownEffects, presetOf } from './mix-fx'

vi.mock('mediabunny', async () => (await import('@/testing/final-cut-media')).mediabunnyMock())

// 一条用例要开整个编辑器、走完一串操作，上限放宽到 15 秒
vi.setConfig({ testTimeout: 15_000 })

beforeEach(setUpEditorCase)
afterEach(tearDownEditorCase)

// 不在出片列表里的地址：final-cut 里的片段还在用、「镜头」页签里已经不显示的旧版本
const URL_OLD = 'https://media.test/take-old.mp4'
files.set(URL_OLD, { keyframes: [0, 2], duration: 5 })

describe('final-cut 编辑器 · 属性', () => {
  const inspector = () => screen.getByRole('tabpanel', { name: '属性' })
  const sideTab = (name: string) =>
    within(
      screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐、字幕和属性' }),
    ).getByRole('tab', { name })
  const row = () => screen.getByRole('group', { name: '画面 1' })
  const pick = (user: ReturnType<typeof userEvent.setup>, label: string) =>
    user.click(screen.getByRole('button', { name: new RegExp(`^选中：${label}，`) }))
  /** 「属性」里平铺的几段的标题。 */
  const sections = () =>
    within(inspector())
      .queryAllByRole('heading', { level: 4 })
      .map((heading) => heading.textContent)
  const undoButton = () => within(toolbar()).getByRole('button', { name: '撤销' })
  const savedTag = (id: string) =>
    new RegExp(`<[a-z]+ [^>]*\\bid="${id}"[^>]*>`).exec(savedFilm())?.[0] ?? ''
  /** 存下来的片段上的可填项取值。 */
  const savedValues = (id: string) =>
    JSON.parse(
      (/data-variable-values="([^"]*)"/.exec(savedTag(id))?.[1] ?? '{}').replaceAll('&quot;', '"'),
    ) as Record<string, unknown>
  /** 等过提交可填项的 300 毫秒。 */
  const pastDelay = () => new Promise((resolve) => setTimeout(resolve, 400))

  // 用了假计时的用例失败时也换回真的，不影响后面的用例
  afterEach(() => {
    vi.useRealTimers()
  })

  const brand = () =>
    host({
      id: 'brand-1',
      label: '示例品牌 片尾',
      item: 'fixture-brand-card',
      src: 'compositions/fixtures/fixture-brand-card.html',
      start: 2_000,
      duration: 3_000,
    })
  const overlay = () =>
    host({
      id: 'overlay-1',
      label: '测试叠加',
      item: 'fixture-overlay',
      src: 'compositions/fixtures/fixture-overlay.html',
      start: 5_000,
    })

  const openWith = async (clips: Parameters<typeof mainFile>[0], extra = '') => {
    putMockProjectMain(CONVERSATION, mainFile(clips, { width: 720, height: 1280 }, extra))
    const user = userEvent.setup()
    await openEditor()
    return user
  }

  it('没选中时点「属性」说明怎么用；选中多个时列出名字、不显示字段；点空白处回到没有选中', async () => {
    const user = await openWith([
      host({ duration: 2_000 }),
      video({ id: 'clip-2', label: 'B · 镜头 1', src: URL_B, start: 2_000 }),
    ])
    expect(screen.queryByRole('tabpanel', { name: '属性' })).toBeNull()
    await user.click(sideTab('属性'))
    expect(within(inspector()).getByText('选中时间线上的片段后，可在此调整')).toBeVisible()

    await pick(user, '测试可填项')
    await user.keyboard('{Shift>}')
    await pick(user, 'B · 镜头 1')
    await user.keyboard('{/Shift}')
    expect(within(inspector()).getByRole('heading', { name: '已选中 2 个片段' })).toBeVisible()
    const names = within(within(inspector()).getByRole('list', { name: '选中的片段' }))
      .getAllByRole('listitem')
      .map((item) => item.textContent)
    expect(names).toEqual(['测试可填项贴片', 'B · 镜头 1视频'])
    expect(within(inspector()).queryByRole('textbox')).toBeNull()
    expect(within(inspector()).queryByRole('heading', { level: 4 })).toBeNull()

    await user.click(row())
    for (const clip of within(row()).getAllByRole('button', { name: /^选中：/ }))
      expect(clip).toHaveAttribute('aria-pressed', 'false')
    expect(sideTab('镜头')).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tabpanel', { name: '属性' })).toBeNull()
  })

  it('组件或块的片段：头部是名字、种类和时长，下面平铺「显示时长」「内容与样式」，没有手风琴', async () => {
    const user = await openWith([host({ start: 1_000, duration: 3_500 })])
    await pick(user, '测试可填项')
    const head = within(within(inspector()).getByRole('banner'))
    expect(head.getByRole('heading', { name: '测试可填项' })).toBeVisible()
    expect(head.getByText('贴片')).toBeVisible()
    expect(head.getByText('3.50s')).toBeVisible()
    expect(sections()).toEqual(['显示时长', '内容与样式'])
    expect(within(inspector()).queryByRole('button', { expanded: true })).toBeNull()
    expect(within(inspector()).getByRole('textbox', { name: '显示时长' })).toHaveValue('3.50')
    expect(within(inspector()).getByRole('textbox', { name: '文字' })).toBeVisible()
  })

  it('头部名字后面的种类按条目在组件库里的种类写：块写「场景」；组件库里没有的条目、手写的元素是「其他」，不写种类、只有「显示时长」', async () => {
    const user = await openWith(
      [brand()],
      '<div id="gone-1" data-label="已下架" data-composition-id="fixture-gone"' +
        ' data-composition-src="compositions/fixtures/fixture-gone.html" data-start="5" data-duration="2"' +
        ' data-track-index="0"></div>\n' +
        '<p id="note" data-start="1" data-duration="2" data-track-index="1">手写文字</p>',
    )
    const head = () => within(inspector()).getByRole('banner')
    await pick(user, '示例品牌 片尾')
    expect(within(head()).getByRole('heading', { name: '示例品牌 片尾' })).toBeVisible()
    expect(within(head()).getByText('场景')).toBeVisible()
    expect(within(head()).queryByText('贴片')).toBeNull()

    for (const name of ['已下架', '手写文字']) {
      await user.click(screen.getByRole('button', { name: new RegExp(`^选中：${name}，`) }))
      expect(within(head()).getByRole('heading', { name })).toBeVisible()
      expect(within(head()).queryByText('场景')).toBeNull()
      expect(within(head()).queryByText('贴片')).toBeNull()
      expect(sections()).toEqual(['显示时长'])
    }
    // 「其他」片段也能改显示时长：结尾往后拉，开始不动
    const length = within(inspector()).getByRole('textbox', { name: '显示时长' })
    await user.clear(length)
    await user.type(length, '3{Enter}')
    await waitSaved(() =>
      expect(savedFilm()).toMatch(/<p [^>]*id="note"[^>]*data-start="1" data-duration="3"/),
    )
  })

  it('视频片段、音频片段是「原片截取」「音量与变速」和「智能调音」，开关分别是「关闭原声」「循环播放」；音频片段的隐藏叫静音', async () => {
    const user = await openWith([
      video({ src: URL_A, duration: 2_000 }),
      audio({ duration: 4_000 }),
    ])
    await pick(user, 'A · 镜头 1')
    expect(within(inspector()).getByText('视频')).toBeVisible()
    expect(sections()).toEqual(['原片截取', '音量与变速', '智能调音'])
    expect(within(inspector()).getByRole('switch', { name: '关闭原声' })).toBeVisible()
    expect(within(inspector()).getByRole('button', { name: '隐藏' })).toBeVisible()
    expect(within(inspector()).queryByRole('textbox')).toBeNull()

    await pick(user, '配乐')
    expect(within(inspector()).getByText('音频')).toBeVisible()
    expect(sections()).toEqual(['原片截取', '音量与变速', '智能调音'])
    expect(within(inspector()).getByRole('switch', { name: '循环播放' })).toBeVisible()
    await user.click(within(inspector()).getByRole('button', { name: '静音' }))
    await waitSaved(() => expect(savedTag('music-1')).toMatch(/^<audio data-hidden=""/))
    expect(within(inspector()).getByRole('button', { name: '取消静音' })).toBeVisible()
  })

  it('头部的隐藏、删除：隐藏写进文件、再点显示回来；删除和按 Delete 一样，后面的片段往前补，回到没有选中', async () => {
    const user = await openWith([
      video({ src: URL_A, duration: 2_000 }),
      video({ id: 'clip-2', label: 'B · 镜头 1', src: URL_B, start: 2_000 }),
    ])
    await pick(user, 'A · 镜头 1')
    await user.click(within(inspector()).getByRole('button', { name: '隐藏' }))
    expect(within(row()).getByRole('group', { name: 'A · 镜头 1，2.0 秒，已隐藏' })).toBeVisible()
    await waitSaved(() => expect(savedTag('clip-1')).toMatch(/^<video data-hidden=""/))
    await user.click(within(inspector()).getByRole('button', { name: '显示' }))
    await waitSaved(() => expect(savedTag('clip-1')).not.toContain('data-hidden'))

    await user.click(within(inspector()).getByRole('button', { name: '删除' }))
    await waitSaved(() => expect(savedClips()).toHaveLength(1))
    expect(savedTag('clip-2')).toContain('data-start="0"')
    expect(within(row()).getByRole('button', { name: /^选中：B · 镜头 1，/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(sideTab('镜头')).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tabpanel', { name: '属性' })).toBeNull()
  })

  it('内容：每项按类型用对应的控件，没填过的显示默认值', async () => {
    const user = await openWith([host()])
    await pick(user, '测试可填项')
    const panel = within(inspector())
    expect(panel.getByRole('textbox', { name: '文字' })).toHaveValue('示例文字')
    // 选项不是原生下拉：是一个按钮，点开是单选菜单
    expect(panel.queryByRole('combobox')).toBeNull()
    const weight = panel.getByRole('button', { name: '字体粗细：常规' })
    await user.click(weight)
    expect(
      screen
        .getAllByRole('menuitemradio')
        .map((item) => [item.textContent, item.getAttribute('aria-checked')]),
    ).toEqual([
      ['常规', 'true'],
      ['加粗', 'false'],
    ])
    await user.keyboard('{Escape}')
    expect(panel.getByRole('textbox', { name: '底色' })).toHaveValue('#2756ff')
    expect(panel.getByRole('button', { name: '底色取色' })).toBeVisible()
    const size = panel.getByRole('slider', { name: '字号' })
    expect(size).toHaveAttribute('aria-valuenow', '96')
    expect(size).toHaveAttribute('aria-valuemin', '48')
    expect(size).toHaveAttribute('aria-valuemax', '144')
    expect(size).toHaveAttribute('aria-valuetext', '96 px')
    expect(panel.getByRole('button', { name: '字号 96 px，点击可直接输入' })).toBeVisible()
    expect(panel.getByRole('switch', { name: '阴影' })).toHaveAttribute('aria-checked', 'false')
  })

  it('改文字：停下 300 毫秒才写进片段，算一步撤销，预览跟着变', async () => {
    const user = await openWith([host()])
    await pick(user, '测试可填项')
    const text = within(inspector()).getByRole('textbox', { name: '文字' })
    // 从这里到结束都用假的计时（含预览页等的动画帧）、由用例拨钟，不看机器快慢；
    // user-event 在假计时下会卡住，所以直接发事件
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
    })
    const elapse = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
      })
    /** 每次拨 50 毫秒，直到 `check` 通过；拨满 5 秒还不通过就失败。 */
    const elapseUntil = async (check: () => void) => {
      for (let elapsed = 0; ; elapsed += 50) {
        try {
          check()
          return
        } catch (error) {
          if (elapsed >= 5_000) throw error
        }
        await elapse(50)
      }
    }
    // 每次按键之间停 299 毫秒：加起来早过了 300 毫秒，每次都还没写进片段
    for (const value of ['', '新', '新的', '新的标', '新的标题']) {
      fireEvent.change(text, { target: { value } })
      await elapse(299)
      expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
    }
    await elapse(1)
    expect(undoButton()).not.toHaveAttribute('aria-disabled')

    await elapseUntil(() => expect(savedValues('title-1')).toEqual({ text: '新的标题' }))
    await elapseUntil(() =>
      expect(previewPlayer().getAttribute('srcdoc')).toContain(
        '{&quot;text&quot;:&quot;新的标题&quot;}',
      ),
    )
    expect(text).toHaveValue('新的标题')

    fireEvent.click(undoButton())
    await elapseUntil(() => expect(savedValues('title-1')).toEqual({}))
    expect(within(inspector()).getByRole('textbox', { name: '文字' })).toHaveValue('示例文字')
  })

  it('输入法还在拼字时不写进片段，上屏以后才写', async () => {
    const user = await openWith([host()])
    await pick(user, '测试可填项')
    const text = within(inspector()).getByRole('textbox', { name: '文字' })
    fireEvent.compositionStart(text)
    fireEvent.change(text, { target: { value: 'xin' } })
    await pastDelay()
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
    fireEvent.change(text, { target: { value: '新' } })
    fireEvent.compositionEnd(text)
    await waitSaved(() => expect(savedValues('title-1')).toEqual({ text: '新' }))
  })

  it('300 毫秒里改了几项：合成一次写进片段，几项都在；菜单里选了以后值写进片段', async () => {
    const user = await openWith([host({ values: { text: '原来的字' } })])
    await pick(user, '测试可填项')
    const panel = within(inspector())
    // 菜单关上后焦点回到下拉上，还在这一段里：不算失焦，两项一起写
    await user.click(panel.getByRole('button', { name: '字体粗细：常规' }))
    await user.click(screen.getByRole('menuitemradio', { name: '加粗' }))
    expect(panel.getByRole('button', { name: '字体粗细：加粗' })).toHaveFocus()
    fireEvent.click(panel.getByRole('switch', { name: '阴影' }))
    await waitSaved(() =>
      expect(savedValues('title-1')).toEqual({ text: '原来的字', weight: '700', shadow: true }),
    )
    expect(panel.getByRole('switch', { name: '阴影' })).toHaveAttribute('aria-checked', 'true')
  })

  it('数字：有上下限时是滑杆加数值；按方向键一步一格，数值可直接输入，超出时收进上下限', async () => {
    const user = await openWith([host()])
    await pick(user, '测试可填项')
    const panel = within(inspector())
    const size = panel.getByRole('slider', { name: '字号' })
    size.focus()
    await user.keyboard('{ArrowRight}')
    await waitSaved(() => expect(savedValues('title-1')).toEqual({ size: 100 }))
    expect(size).toHaveAttribute('aria-valuetext', '100 px')

    await user.click(panel.getByRole('button', { name: '字号 100 px，点击可直接输入' }))
    const box = panel.getByRole('textbox', { name: '字号' })
    await user.clear(box)
    await user.type(box, '999{Enter}')
    await waitSaved(() => expect(savedValues('title-1')).toEqual({ size: 144 }))
    expect(size).toHaveAttribute('aria-valuenow', '144')
  })

  it('数字：没有上下限时是数字框，后面写单位；框清空时不提交', async () => {
    server.use(
      http.get('/hyperframes/catalog.json', () =>
        HttpResponse.json({
          ...fixtureCatalog,
          items: fixtureCatalog.items.map((item) =>
            item.name === 'fixture-fields'
              ? {
                  ...item,
                  variables: [
                    { id: 'size', type: 'number', label: '字号', default: 96, unit: 'px' },
                  ],
                }
              : item,
          ),
        }),
      ),
    )
    const user = await openWith([host()])
    await pick(user, '测试可填项')
    const panel = within(inspector())
    expect(panel.queryByRole('slider', { name: '字号' })).toBeNull()
    const box = panel.getByRole('spinbutton', { name: '字号' })
    expect(box).toHaveValue(96)
    expect(panel.getByText('px')).toBeVisible()
    await user.clear(box)
    await pastDelay()
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
    await user.type(box, '120')
    await waitSaved(() => expect(savedValues('title-1')).toEqual({ size: 120 }))
  })

  it('颜色：十六进制文字照写；取色板里点预设色写成大写的 #RRGGBB，色块跟着变', async () => {
    const user = await openWith([host()])
    await pick(user, '测试可填项')
    const panel = within(inspector())
    const hex = panel.getByRole('textbox', { name: '底色' })
    await user.clear(hex)
    await user.type(hex, '#ff0000')
    await waitSaved(() => expect(savedValues('title-1')).toEqual({ accent: '#ff0000' }))

    await user.click(panel.getByRole('button', { name: '底色取色' }))
    const picker = screen.getByRole('dialog', { name: '取色板' })
    expect(within(picker).getByRole('slider', { name: '饱和度与明度' })).toHaveAttribute(
      'aria-valuetext',
      '#FF0000',
    )
    await user.click(within(picker).getByRole('button', { name: '#34D399' }))
    await waitSaved(() => expect(savedValues('title-1')).toEqual({ accent: '#34D399' }))
    expect(hex).toHaveValue('#34D399')
  })

  it('字体：下拉里是「默认」和组件库里有的字体；没填时显示条目的默认字体，选「默认」写空', async () => {
    const user = await openWith([brand()])
    await pick(user, '示例品牌 片尾')
    await user.click(within(inspector()).getByRole('button', { name: '字体：Playfair Display' }))
    expect(screen.getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual([
      '默认',
      'Playfair Display',
    ])
    await user.click(screen.getByRole('menuitemradio', { name: '默认' }))
    await waitSaved(() => expect(savedValues('brand-1')).toEqual({ font: '' }))
    expect(within(inspector()).getByRole('button', { name: '字体：默认' })).toBeVisible()
  })

  it('条目没有可填项时说明没有；图片类可填项只读，说明暂不支持', async () => {
    server.use(
      http.get('/hyperframes/catalog.json', () =>
        HttpResponse.json({
          ...fixtureCatalog,
          items: fixtureCatalog.items.map((item) =>
            item.name === 'fixture-scene'
              ? {
                  ...item,
                  variables: [{ id: 'logo', type: 'image', label: '标志', default: '' }],
                }
              : item,
          ),
        }),
      ),
    )
    const user = await openWith([
      overlay(),
      host({
        id: 'scene-1',
        label: '测试画面',
        item: 'fixture-scene',
        src: 'compositions/fixtures/fixture-scene.html',
      }),
    ])
    await pick(user, '测试叠加')
    expect(within(inspector()).getByText('暂无可填项')).toBeVisible()
    await pick(user, '测试画面')
    expect(within(inspector()).getByText('标志')).toBeVisible()
    expect(within(inspector()).getByText('暂不支持在此修改图片')).toBeVisible()
    expect(within(inspector()).getAllByRole('textbox')).toEqual([
      within(inspector()).getByRole('textbox', { name: '显示时长' }),
    ])
  })

  describe('显示时长', () => {
    // 一行两个贴片：测试可填项在 1–3 秒，测试叠加从 5 秒开始
    const twoApart = () => [host({ start: 1_000 }), overlay()]
    const field = () => within(inspector()).getByRole('textbox', { name: '显示时长' })
    const step = (name: '缩短 0.5 秒' | '延长 0.5 秒') =>
      within(inspector()).getByRole('button', { name })
    const enter = async (user: ReturnType<typeof userEvent.setup>, value: string) => {
      await user.clear(field())
      await user.type(field(), `${value}{Enter}`)
    }

    it('「−」「+」一次改 0.5 秒，开始不动；每按一次算一步撤销，连按两次撤销一次只退回一次', async () => {
      const user = await openWith(twoApart())
      await pick(user, '测试可填项')
      expect(field()).toHaveValue('2.00')
      await user.click(step('延长 0.5 秒'))
      expect(field()).toHaveValue('2.50')
      await waitSaved(() =>
        expect(savedTag('title-1')).toContain('data-start="1" data-duration="2.5"'),
      )
      await user.click(undoButton())
      await waitSaved(() => expect(savedTag('title-1')).toContain('data-duration="2"'))
      expect(field()).toHaveValue('2.00')

      await user.click(step('缩短 0.5 秒'))
      await user.click(step('缩短 0.5 秒'))
      expect(field()).toHaveValue('1.00')
      await waitSaved(() => expect(savedTag('title-1')).toContain('data-duration="1"'))
      await user.click(undoButton())
      await waitSaved(() => expect(savedTag('title-1')).toContain('data-duration="1.5"'))
      expect(field()).toHaveValue('1.50')
      expect(undoButton()).not.toHaveAttribute('aria-disabled')
    })

    it('上下限：不压到后面的片段，不短于最短长度；到头时那一边的按钮不能点', async () => {
      const user = await openWith(twoApart())
      await pick(user, '测试可填项')
      await enter(user, '9')
      expect(field()).toHaveValue('4.00')
      await waitSaved(() => expect(savedTag('title-1')).toContain('data-duration="4"'))
      expect(step('延长 0.5 秒')).toBeDisabled()

      await enter(user, '0')
      expect(field()).toHaveValue('0.10')
      await waitSaved(() => expect(savedTag('title-1')).toContain('data-duration="0.1"'))
      expect(step('缩短 0.5 秒')).toBeDisabled()
      expect(step('延长 0.5 秒')).toBeEnabled()
    })

    it('回车、失焦提交；Esc 放弃刚输入的，片段还选中着；不是数字时不提交、显示回原来的值', async () => {
      const user = await openWith(twoApart())
      await pick(user, '测试可填项')
      await user.clear(field())
      await user.type(field(), '3{Escape}')
      expect(field()).toHaveValue('2.00')
      expect(field()).not.toHaveFocus()
      expect(within(row()).getByRole('button', { name: /^选中：测试可填项，/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      )

      await enter(user, '很长')
      expect(field()).toHaveValue('2.00')
      await pastDelay()
      expect(undoButton()).toHaveAttribute('aria-disabled', 'true')

      await user.clear(field())
      await user.type(field(), '3.5')
      await user.tab()
      await waitSaved(() => expect(savedTag('title-1')).toContain('data-duration="3.5"'))
    })
  })

  describe('原片截取', () => {
    // 一行两个片段：A 镜头 1 在 0–2 秒、用素材 A（6 秒）的 1–3 秒；B 镜头 1 从 3 秒开始
    const twoClips = () => [
      video({ src: URL_A, duration: 2_000, mediaStart: 1_000 }),
      video({ id: 'clip-2', label: 'B · 镜头 1', src: URL_B, start: 3_000, duration: 1_000 }),
    ]
    const summary = () => within(inspector()).getByTestId('slip-summary')
    const handle = (name: '裁剪开头' | '裁剪结尾') =>
      within(inspector()).getByRole('slider', { name })
    const strip = () => within(inspector()).getByRole('group', { name: '原片截取条' })
    /** 存下来的片段的起点、时长、入点。 */
    const timed = (start: string, duration: string, mediaStart: string) =>
      new RegExp(
        `data-start="${start}" data-duration="${duration}"[^>]* data-media-start="${mediaStart}"`,
      )

    it('标题行写入点 – 出点 / 素材总长；抓手按方向键微调入点、出点，碰到后面的片段就停', async () => {
      const user = await openWith(twoClips())
      await shot(/^生成 A 镜头 1，/)
      await pick(user, 'A · 镜头 1')
      expect(within(inspector()).getByText('· 镜头组 1 · A · V1')).toBeVisible()
      await waitFor(() => expect(summary()).toHaveTextContent('1.00 – 3.00s / 6.0s'))

      handle('裁剪开头').focus()
      await user.keyboard('{ArrowLeft}')
      await waitSaved(() => expect(savedTag('clip-1')).toMatch(timed('0', '2.1', '0.9')))
      expect(summary()).toHaveTextContent('0.90 – 3.00s')
      // 片段最长到 3 秒（后面的片段在 3 秒）：入点最早到 0
      await user.keyboard('{Shift>}{ArrowLeft}{/Shift}')
      await waitSaved(() => expect(savedTag('clip-1')).toMatch(timed('0', '3', '0')))

      // 出点往外拉也被后面的片段挡住
      handle('裁剪结尾').focus()
      await user.keyboard('{Shift>}{ArrowRight}{/Shift}')
      await pastDelay()
      expect(savedTag('clip-1')).toMatch(timed('0', '3', '0'))
      await user.keyboard('{ArrowLeft}')
      await waitSaved(() => expect(savedTag('clip-1')).toMatch(timed('0', '2.9', '0')))
      expect(savedTag('clip-2')).toContain('data-start="3"')
    })

    it('在条上按下、拖动：拖动中只动面板，松手写进 final-cut 一次，一步撤销回去', async () => {
      const user = await openWith(twoClips())
      await shot(/^生成 A 镜头 1，/)
      await pick(user, 'A · 镜头 1')
      await waitFor(() => expect(summary()).toHaveTextContent('1.00 – 3.00s / 6.0s'))
      // jsdom 不排版：条宽 600px，1px 是素材的 10 毫秒
      const box = { left: 0, top: 0, right: 600, bottom: 26, width: 600, height: 26, x: 0, y: 0 }
      Object.defineProperty(strip(), 'getBoundingClientRect', { value: () => box })

      // 按在 3 秒处：框的正中对过去，入点 2 秒；再拖到最右，入点收在 6 − 2 = 4 秒
      fireEvent.pointerDown(strip(), { button: 0, pointerId: 1, clientX: 300 })
      expect(summary()).toHaveTextContent('2.00 – 4.00s')
      fireEvent.pointerMove(strip(), { pointerId: 1, clientX: 590 })
      expect(summary()).toHaveTextContent('4.00 – 6.00s')
      await pastDelay()
      expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
      fireEvent.pointerUp(strip(), { pointerId: 1, clientX: 590 })
      await waitSaved(() => expect(savedTag('clip-1')).toMatch(timed('0', '2', '4')))

      await user.click(undoButton())
      await waitSaved(() => expect(savedTag('clip-1')).toMatch(timed('0', '2', '1')))
      expect(undoButton()).toHaveAttribute('aria-disabled', 'true')

      // 拖动中按 Esc：什么都不写，片段还选中着
      fireEvent.pointerDown(strip(), { button: 0, pointerId: 2, clientX: 300 })
      expect(summary()).toHaveTextContent('2.00 – 4.00s')
      await user.keyboard('{Escape}')
      expect(summary()).toHaveTextContent('1.00 – 3.00s')
      fireEvent.pointerUp(strip(), { pointerId: 2, clientX: 300 })
      await pastDelay()
      expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
      expect(within(row()).getByRole('button', { name: /^选中：A · 镜头 1，/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
    })

    it('片段用的素材不在出片里：标题写片段自己的名字，照样读到总长，能截取', async () => {
      const user = await openWith([video({ src: URL_OLD, duration: 2_000 })])
      await pick(user, 'A · 镜头 1')
      expect(within(inspector()).getByText('· A · 镜头 1')).toBeVisible()
      await waitFor(() => expect(summary()).toHaveTextContent('0.00 – 2.00s / 5.0s'))
      handle('裁剪结尾').focus()
      await user.keyboard('{Shift>}{ArrowRight}{/Shift}')
      expect(summary()).toHaveTextContent('0.00 – 3.00s / 5.0s')
      await waitSaved(() => expect(savedClips()[0]).toContain('data-duration="3"'))
    })

    it('素材总长读不出来：条上写原因，没有框和抓手，按下不改', async () => {
      const user = await openWith([
        video({ src: 'https://media.test/videos/elsewhere.mp4', duration: 2_000 }),
        audio({ duration: 4_000 }),
      ])
      await pick(user, 'A · 镜头 1')
      expect(await within(strip()).findByText('视频时长无效，无法分段')).toBeVisible()
      expect(within(inspector()).queryByTestId('slip-summary')).toBeNull()
      expect(within(inspector()).queryByRole('slider', { name: /^裁剪/ })).toBeNull()
      fireEvent.pointerDown(strip(), { button: 0, pointerId: 1, clientX: 30 })
      fireEvent.pointerUp(strip(), { pointerId: 1, clientX: 30 })
      await pastDelay()
      expect(undoButton()).toHaveAttribute('aria-disabled', 'true')

      // 配乐读不出声音：写明，同样不能拖
      await pick(user, '配乐')
      expect(await within(strip()).findByText('该音频没有声音')).toBeVisible()
      expect(within(inspector()).queryByRole('slider', { name: /^裁剪/ })).toBeNull()
    })
  })

  describe('音量与变速', () => {
    const slider = (name: string) => within(inspector()).getByRole('slider', { name })
    /** 滑杆的点按区：按下、双击都在它上面。 */
    const track = (name: string) =>
      slider(name).parentElement?.closest<HTMLElement>('[data-orientation]') ?? slider(name)
    /** 滑杆右边的数值，点一下可以直接输入。 */
    const readout = (name: string) =>
      within(inspector()).getByRole('button', { name: new RegExp(`^${name} .*，点击可直接输入$`) })
    const toggle = (name: string) => within(inspector()).getByRole('switch', { name })
    const press = async (user: ReturnType<typeof userEvent.setup>, name: string, key: string) => {
      slider(name).focus()
      await user.keyboard(key)
    }
    const type = async (user: ReturnType<typeof userEvent.setup>, name: string, text: string) => {
      await user.click(readout(name))
      const box = within(inspector()).getByRole('textbox', { name })
      await user.clear(box)
      await user.type(box, text)
      return box
    }
    const savedAttribute = (id: string, name: string) =>
      new RegExp(` ${name}(?:="([^"]*)")?[ >]`).exec(savedTag(id))?.[1]

    it('音频片段：音量、淡入、淡出、倍速，标题行右边是「循环播放」；数值照参照的换算显示', async () => {
      const user = await openWith([
        audio({
          duration: 4_000,
          volume: 0.5,
          playbackRate: 2,
          fadeIn: 1_000,
          loop: true,
        }),
      ])
      await pick(user, '配乐')
      const labels = within(inspector())
        .getAllByText(/^(音量|淡入|淡出|倍速)$/)
        .map((label) => label.textContent)
      expect(labels).toEqual(['音量', '淡入', '淡出', '倍速'])
      expect(slider('音量')).toHaveAttribute('aria-valuetext', '-6.0 dB')
      expect(slider('音量')).toHaveAttribute('aria-valuemin', '-100')
      expect(slider('音量')).toHaveAttribute('aria-valuemax', '100')
      expect(readout('音量')).toHaveTextContent('-6.0 dB')
      expect(slider('倍速')).toHaveAttribute('aria-valuetext', '2x')
      expect(slider('倍速')).toHaveAttribute('aria-valuenow', '651')
      expect(readout('淡入')).toHaveTextContent('1.00 秒')
      expect(readout('淡出')).toHaveTextContent('0.00 秒')
      expect(toggle('循环播放')).toHaveAttribute('aria-checked', 'true')
      expect(within(inspector()).queryByRole('switch', { name: '关闭原声' })).toBeNull()
    })

    it('音量：方向键一步写一次，算一步撤销；最右 +12 dB，最左无声；双击回到 0 dB', async () => {
      const user = await openWith([audio({ duration: 4_000 })])
      await pick(user, '配乐')
      expect(slider('音量')).toHaveAttribute('aria-valuenow', '0')
      expect(readout('音量')).toHaveTextContent('0.0 dB')

      // 按一下方向键再撤销：滑杆和数值回到原来的值，不留着按键时的那一格
      await press(user, '音量', '{ArrowRight}')
      await waitSaved(() =>
        expect(Number(savedAttribute('music-1', 'data-volume'))).toBeGreaterThan(1),
      )
      await user.click(undoButton())
      await waitSaved(() => expect(Number(savedAttribute('music-1', 'data-volume') ?? '1')).toBe(1))
      expect(readout('音量')).toHaveTextContent('0.0 dB')
      expect(slider('音量')).toHaveAttribute('aria-valuenow', '0')

      await press(user, '音量', '{End}')
      await waitSaved(() => expect(savedAttribute('music-1', 'data-volume')).toBe('3.981072'))
      expect(readout('音量')).toHaveTextContent('+12.0 dB')
      await press(user, '音量', '{Home}')
      await waitSaved(() => expect(savedAttribute('music-1', 'data-volume')).toBe('0'))
      expect(readout('音量')).toHaveTextContent('-∞ dB')

      fireEvent.doubleClick(track('音量'))
      await waitSaved(() => expect(savedAttribute('music-1', 'data-volume')).toBe('1'))
      expect(readout('音量')).toHaveTextContent('0.0 dB')

      await user.click(undoButton())
      await waitSaved(() => expect(savedAttribute('music-1', 'data-volume')).toBe('0'))
    })

    it('音量直接输入：按 dB 读；读不出时回车框留着、标成不对，Esc 放弃，片段还选中着', async () => {
      const user = await openWith([audio({ duration: 4_000 })])
      await pick(user, '配乐')
      await type(user, '音量', '-6{Enter}')
      await waitSaved(() => expect(savedAttribute('music-1', 'data-volume')).toBe('0.501187'))
      expect(readout('音量')).toHaveTextContent('-6.0 dB')
      expect(slider('音量')).toHaveAttribute('aria-valuetext', '-6.0 dB')

      const box = await type(user, '音量', '很响{Enter}')
      expect(box).toHaveAttribute('aria-invalid', 'true')
      expect(box).toHaveFocus()
      await user.keyboard('{Escape}')
      expect(readout('音量')).toHaveTextContent('-6.0 dB')
      const soundRow = screen.getByRole('group', { name: '配乐' })
      expect(within(soundRow).getByRole('button', { name: /^选中：配乐，/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      expect(savedAttribute('music-1', 'data-volume')).toBe('0.501187')
    })

    it('倍速：滑杆按对数走，正中 1 倍、两头 0.1 倍和 10 倍；1 倍时不写，双击回到 1 倍；片段的时长不变，用掉的素材跟着变', async () => {
      const user = await openWith([video({ src: URL_A, duration: 2_000 })])
      await shot(/^生成 A 镜头 1，/)
      await pick(user, 'A · 镜头 1')
      expect(slider('倍速')).toHaveAttribute('aria-valuenow', '500')
      expect(readout('倍速')).toHaveTextContent('1x')
      await press(user, '倍速', '{End}')
      await waitSaved(() => expect(savedAttribute('clip-1', 'data-playback-rate')).toBe('10'))
      await press(user, '倍速', '{Home}')
      await waitSaved(() => expect(savedAttribute('clip-1', 'data-playback-rate')).toBe('0.1'))
      fireEvent.doubleClick(track('倍速'))
      await waitSaved(() => expect(savedTag('clip-1')).not.toContain('data-playback-rate'))

      await type(user, '倍速', '2x{Enter}')
      await waitSaved(() => expect(savedAttribute('clip-1', 'data-playback-rate')).toBe('2'))
      expect(savedAttribute('clip-1', 'data-duration')).toBe('2')
      // 2 倍速：2 秒的片段用掉素材的 0–4 秒
      expect(within(inspector()).getByTestId('slip-summary')).toHaveTextContent(
        '0.00 – 4.00s / 6.0s',
      )
    })

    it('淡入淡出：一端最多到片段长减去另一端，0 时不写', async () => {
      const user = await openWith([audio({ duration: 4_000, fadeOut: 1_000 })])
      await pick(user, '配乐')
      expect(slider('淡入')).toHaveAttribute('aria-valuemax', '300')
      expect(slider('淡出')).toHaveAttribute('aria-valuemax', '400')
      await type(user, '淡入', '10{Enter}')
      await waitSaved(() => expect(savedAttribute('music-1', 'data-fade-in')).toBe('3'))
      expect(slider('淡出')).toHaveAttribute('aria-valuemax', '100')
      await press(user, '淡出', '{Home}')
      await waitSaved(() => expect(savedTag('music-1')).not.toContain('data-fade-out'))
      expect(slider('淡入')).toHaveAttribute('aria-valuemax', '400')
    })

    it('循环播放、关闭原声：开关写进文件；关闭原声写 muted、不写有声音的标记，音量和淡入淡出变得不能操作，倍速照常', async () => {
      const user = await openWith([
        video({ src: URL_A, duration: 2_000 }),
        audio({ duration: 4_000 }),
      ])
      await pick(user, '配乐')
      await user.click(toggle('循环播放'))
      await waitSaved(() => expect(savedAttribute('music-1', 'loop')).toBe('true'))

      await pick(user, 'A · 镜头 1')
      expect(within(inspector()).queryByRole('switch', { name: '循环播放' })).toBeNull()
      expect(slider('淡入')).not.toHaveAttribute('aria-disabled')
      await user.click(toggle('关闭原声'))
      await waitSaved(() => expect(savedAttribute('clip-1', 'muted')).toBe('true'))
      expect(savedTag('clip-1')).not.toContain('data-has-audio')
      for (const name of ['音量', '淡入', '淡出']) {
        expect(slider(name)).toHaveAttribute('aria-disabled', 'true')
        expect(readout(name)).toBeDisabled()
      }
      expect(slider('倍速')).not.toHaveAttribute('aria-disabled')
      const volume = savedAttribute('clip-1', 'data-volume')
      await press(user, '音量', '{End}')
      fireEvent.doubleClick(track('音量'))
      await pastDelay()
      expect(savedAttribute('clip-1', 'data-volume')).toBe(volume)
      expect(slider('音量')).toHaveAttribute('aria-valuenow', '0')

      await user.click(toggle('关闭原声'))
      await waitSaved(() => expect(savedAttribute('clip-1', 'data-has-audio')).toBe('true'))
      expect(savedTag('clip-1')).not.toContain('muted')
      expect(slider('音量')).not.toHaveAttribute('aria-disabled')
    })

    it('视频片段的素材没有声音：「关闭原声」开着、不能关，悬停说明原因；读不出有没有声音时照常能拨', async () => {
      const user = await openWith([
        video({ src: URL_SILENT, label: '无声', muted: true }),
        video({
          id: 'clip-2',
          src: URL_UNREADABLE,
          label: '读不出',
          start: 2_000,
          muted: true,
        }),
      ])
      await pick(user, '无声')
      await waitFor(() => expect(toggle('关闭原声')).toHaveAttribute('aria-disabled', 'true'))
      expect(toggle('关闭原声')).toHaveAttribute('aria-checked', 'true')
      await user.hover(toggle('关闭原声'))
      expect(await screen.findByRole('tooltip')).toHaveTextContent('该素材没有声音，无法打开原声')
      await user.click(toggle('关闭原声'))
      expect(toggle('关闭原声')).toHaveAttribute('aria-checked', 'true')
      expect(undoButton()).toHaveAttribute('aria-disabled', 'true')

      await pick(user, '读不出')
      expect(toggle('关闭原声')).not.toHaveAttribute('aria-disabled')
      await user.click(toggle('关闭原声'))
      await waitSaved(() => expect(savedAttribute('clip-2', 'data-has-audio')).toBe('true'))
    })
  })

  it('「属性」里的控件上按快捷键不动时间线：删除、退格、M、[ 都归控件，空格拨开关', async () => {
    const user = await openWith([host()])
    await pick(user, '测试可填项')
    const panel = within(inspector())
    const clipButton = () => within(row()).queryByRole('button', { name: /^选中：测试可填项，/ })

    panel.getByRole('textbox', { name: '文字' }).focus()
    await user.keyboard('{Backspace}{Delete}')
    panel.getByRole('button', { name: '字体粗细：常规' }).focus()
    await user.keyboard('{Delete}{Backspace}m[[')
    panel.getByRole('slider', { name: '字号' }).focus()
    await user.keyboard('{Delete}{Backspace}m')
    const shadow = panel.getByRole('switch', { name: '阴影' })
    shadow.focus()
    await user.keyboard('{Delete} ')

    // 打开的取色板里按的键归它；Esc 只关上取色板，片段还选中着
    await user.click(panel.getByRole('button', { name: '底色取色' }))
    const picker = screen.getByRole('dialog', { name: '取色板' })
    within(picker).getByRole('button', { name: '#FFFFFF' }).focus()
    await user.keyboard('{Delete}{Backspace}m[[{ArrowRight}')
    await user.keyboard('{Escape}')
    expect(picker).not.toBeInTheDocument()

    expect(shadow).toHaveAttribute('aria-checked', 'true')
    expect(clipButton()).toHaveAttribute('aria-pressed', 'true')
    expect(within(transport()).getByRole('button', { name: '静音' })).toBeVisible()
    await waitSaved(() => expect(savedValues('title-1')).toEqual({ text: '示例文', shadow: true }))
    expect(savedTag('title-1')).not.toBe('')
  })

  it('原片截取、音量与变速的滑杆上按 Delete、M 不动时间线，按方向键只改这一项', async () => {
    const user = await openWith([video({ src: URL_A, duration: 2_000 })])
    await shot(/^生成 A 镜头 1，/)
    await pick(user, 'A · 镜头 1')
    const panel = within(inspector())
    const clipButton = () => within(row()).queryByRole('button', { name: /^选中：A · 镜头 1，/ })
    await waitFor(() => expect(panel.getByRole('slider', { name: '裁剪结尾' })).toBeVisible())
    panel.getByRole('slider', { name: '裁剪结尾' }).focus()
    await user.keyboard('{Delete}{Backspace}m')
    panel.getByRole('slider', { name: '倍速' }).focus()
    await user.keyboard('{Delete}{Backspace}m')
    expect(clipButton()).toHaveAttribute('aria-pressed', 'true')
    expect(within(transport()).getByRole('button', { name: '静音' })).toBeVisible()
    await pastDelay()
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
  })

  describe('智能调音', () => {
    const MUSIC = 'https://media.test/audio/music.mp3'
    const TALK = 'https://media.test/audio/talk.mp3'
    const control = (name: string) => within(inspector()).getByRole('switch', { name })
    const carveSwitch = () => control('有人说话时自动压低')
    const savedAttribute = (id: string, name: string) =>
      new RegExp(` ${name}="([^"]*)"`).exec(savedTag(id))?.[1]?.replaceAll('&quot;', '"')
    const savedCarve = (id: string): unknown =>
      JSON.parse(savedAttribute(id, 'data-fx-carve') ?? 'null')
    const musicClip = () => screen.getByRole('button', { name: /^选中：配乐，/ })
    const typeStrength = async (
      user: ReturnType<typeof userEvent.setup>,
      label: string,
      from: string,
      to: string,
    ) => {
      await user.click(
        within(inspector()).getByRole('button', { name: `${label} ${from}，点击可直接输入` }),
      )
      const box = within(inspector()).getByRole('textbox', { name: label })
      await user.clear(box)
      await user.type(box, `${to}{Enter}`)
    }
    // 各素材地址被取了几次
    let fetched: string[] = []

    beforeEach(() => {
      fetched = []
      // 人声：1 kHz 的声音，前一秒轻、后一秒响；配乐：噪声。文件内容直接是解好的采样，离线音频上下文原样读出来
      const rate = 48_000
      const voice = Float32Array.from(
        { length: 2 * rate },
        (_, i) => Math.sin((2 * Math.PI * 1_000 * i) / rate) * (i < rate ? 0.03 : 0.3),
      )
      const music = Float32Array.from(
        { length: 4 * rate },
        (_, i) => ((i * 7_919) % 97) / 160 - 0.3,
      )
      vi.stubGlobal(
        'OfflineAudioContext',
        class {
          decodeAudioData(data: ArrayBuffer) {
            return Promise.resolve({ getChannelData: () => new Float32Array(data) })
          }
        },
      )
      const serve = (url: string, samples: Float32Array<ArrayBuffer>) =>
        http.get(url, () => {
          fetched.push(url)
          return HttpResponse.arrayBuffer(samples.buffer)
        })
      server.use(serve(URL_A, voice), serve(TALK, voice), serve(MUSIC, music))
    })

    afterEach(() => vi.unstubAllGlobals())

    it('选中和有声视频重叠的配乐：默认打开，设置和效果链写进配乐，时间线上标「自动压低」；关掉后不再自动打开', async () => {
      const user = await openWith([
        video({ src: URL_A, duration: 2_000 }),
        audio({ duration: 4_000 }),
      ])
      await pick(user, '配乐')
      await waitFor(() => expect(carveSwitch()).toHaveAttribute('aria-checked', 'true'))
      expect(musicClip()).toHaveAccessibleName('选中：配乐，4.0 秒，自动压低')
      await waitSaved(() => expect(savedAttribute('music-1', 'data-fx-chain')).toContain('peaking'))
      // 压人声组：重叠的视频片段一起放进人声组
      expect(savedCarve('music-1')).toEqual({ enabled: true, sources: ['voice'], strength: 0.25 })
      expect(savedAttribute('clip-1', 'data-audio-group')).toBe('voice')
      expect(savedAttribute('music-1', 'data-automation')).toContain('.gain')

      await user.click(carveSwitch())
      await waitSaved(() => expect(savedCarve('music-1')).toMatchObject({ enabled: false }))
      expect(savedAttribute('music-1', 'data-fx-chain')).toBeUndefined()
      expect(musicClip()).toHaveAccessibleName('选中：配乐，4.0 秒')
      await pick(user, 'A · 镜头 1')
      await pick(user, '配乐')
      await pastDelay()
      expect(carveSwitch()).toHaveAttribute('aria-checked', 'false')
      expect(within(inspector()).queryByRole('slider', { name: '压低幅度' })).toBeNull()

      // 再打开，改强度：一个素材地址只读一次声音
      await user.click(carveSwitch())
      await waitFor(() => expect(carveSwitch()).toHaveAttribute('aria-checked', 'true'))
      await typeStrength(user, '压低幅度', '25%', '50')
      await waitSaved(() => expect(savedCarve('music-1')).toMatchObject({ strength: 0.5 }))
      expect(within(inspector()).getByRole('slider', { name: '压低幅度' })).toHaveAttribute(
        'aria-valuetext',
        '50%',
      )
      expect(fetched.toSorted()).toEqual([MUSIC, URL_A])
    })

    it('改角色，压低的名单跟着变：唯一的人声改成音效后，配乐没有人声可压，生成的去掉', async () => {
      const user = await openWith([
        video({ src: URL_A, duration: 2_000 }),
        audio({ duration: 4_000 }),
      ])
      await pick(user, '配乐')
      await waitSaved(() => expect(savedAttribute('music-1', 'data-fx-chain')).toContain('peaking'))

      // 视频片段从人声改成音效：换到音效组，主开关换成「有人说话时自动压低」
      await pick(user, 'A · 镜头 1')
      expect(control('自动平稳人声音量')).toBeVisible()
      await user.click(within(inspector()).getByRole('button', { name: '角色：人声' }))
      await user.click(screen.getByRole('menuitemradio', { name: /^音效/ }))
      await waitSaved(() => expect(savedAttribute('clip-1', 'data-audio-group')).toBe('sfx'))
      expect(within(inspector()).getByRole('button', { name: '角色：音效' })).toBeVisible()
      expect(carveSwitch()).toHaveAttribute('aria-checked', 'false')
      expect(control('同时开启自动平稳音量')).toHaveAttribute('aria-checked', 'false')

      // 再选中配乐：人声组里没有片段了，名单清空，生成的滤波和曲线去掉
      await pick(user, '配乐')
      await waitSaved(() =>
        expect(savedCarve('music-1')).toEqual({ enabled: true, sources: [], strength: 0.25 }),
      )
      expect(savedAttribute('music-1', 'data-fx-chain')).toBeUndefined()
      expect(savedAttribute('music-1', 'data-automation')).toBeUndefined()

      // 改回人声：重新打开压低时又压它
      await pick(user, 'A · 镜头 1')
      await user.click(within(inspector()).getByRole('button', { name: '角色：音效' }))
      await user.click(screen.getByRole('menuitemradio', { name: /^人声/ }))
      await waitSaved(() => expect(savedAttribute('clip-1', 'data-audio-group')).toBe('voice'))
      await pick(user, '配乐')
      await waitSaved(() => expect(savedAttribute('music-1', 'data-fx-chain')).toContain('peaking'))
      expect(savedCarve('music-1')).toMatchObject({ sources: ['voice'] })
    })

    it('人声开、关自动平稳音量：只有开关，各算一步撤销；不会自动打开', async () => {
      const user = await openWith([video({ src: URL_A, duration: 2_000 })])
      await pick(user, 'A · 镜头 1')
      expect(within(inspector()).getByRole('button', { name: '角色：人声' })).toBeVisible()
      const leveller = () => control('自动平稳人声音量')
      await pastDelay()
      expect(leveller()).toHaveAttribute('aria-checked', 'false')
      expect(savedTag('clip-1')).not.toContain('data-fx-chain')

      await user.click(leveller())
      await waitSaved(() =>
        expect(savedAttribute('clip-1', 'data-fx-chain')).toContain('"fromLeveller":true'),
      )
      expect(savedAttribute('clip-1', 'data-automation')).toMatch(/"target":"fx\.[^"]+\.gain"/)
      expect(leveller()).toHaveAttribute('aria-checked', 'true')
      // 只有开关，没有强度
      expect(within(inspector()).queryByRole('slider', { name: /平稳|强度|幅度/ })).toBeNull()
      expect(savedFilm()).not.toContain('data-fx-leveller')

      await user.click(leveller())
      await waitSaved(() => expect(savedTag('clip-1')).not.toContain('data-fx-chain'))
      expect(savedTag('clip-1')).not.toContain('data-automation')
      expect(leveller()).toHaveAttribute('aria-checked', 'false')
      await user.click(undoButton())
      await waitSaved(() =>
        expect(savedAttribute('clip-1', 'data-fx-chain')).toContain('"fromLeveller":true'),
      )
      expect(leveller()).toHaveAttribute('aria-checked', 'true')
      await user.click(undoButton())
      await waitSaved(() => expect(savedTag('clip-1')).not.toContain('data-fx-chain'))
      // 一个素材地址只读一次声音
      expect(fetched).toEqual([URL_A])
    })

    it('切开一段开着压低的配乐：前半段的曲线只到切点，后半段的从切点起、时间从 0 开始', async () => {
      const user = await openWith([
        video({ src: URL_A, duration: 2_000 }),
        audio({ duration: 4_000 }),
      ])
      await pick(user, '配乐')
      await waitSaved(() => expect(savedAttribute('music-1', 'data-fx-chain')).toContain('peaking'))
      const lanesOf = (id: string) =>
        parseAutomation(savedAttribute(id, 'data-automation') ?? '').lanes
      const whole = lanesOf('music-1')
      expect(whole.length).toBeGreaterThan(0)

      editorRoot().focus()
      await user.keyboard('{Shift>}{ArrowRight}{/Shift}')
      expect(fireEvent.keyDown(editorRoot(), { key: 's' })).toBe(false)
      await waitSaved(() => expect(savedFilm().match(/<audio /g)).toHaveLength(2))
      const secondId = [...savedFilm().matchAll(/<audio [^>]*\bid="([^"]+)"/g)]
        .map((match) => match[1] ?? '')
        .find((id) => id !== 'music-1')
      const first = lanesOf('music-1')
      const second = lanesOf(secondId ?? '')
      whole.forEach((lane, index) => {
        expect(first[index]?.points.at(-1)?.t).toBe(1)
        expect(second[index]?.points[0]?.t).toBe(0)
        for (const t of [0, 0.5, 1, 2.5]) {
          expect(sampleAutomationLane(first[index] ?? lane, Math.min(t, 1))).toBeCloseTo(
            sampleAutomationLane(lane, Math.min(t, 1)),
            4,
          )
          expect(sampleAutomationLane(second[index] ?? lane, t)).toBeCloseTo(
            sampleAutomationLane(lane, 1 + t),
            4,
          )
        }
      })
    })

    it('配乐同时开平稳音量：声音已经很平稳时提示，不写', async () => {
      const user = await openWith([audio({ duration: 4_000 })])
      await pick(user, '配乐')
      await user.click(control('同时开启自动平稳音量'))
      expect((await screen.findAllByText('这段声音已经很平稳，不用再调')).length).toBeGreaterThan(0)
      await pastDelay()
      expect(control('同时开启自动平稳音量')).toHaveAttribute('aria-checked', 'false')
      expect(savedTag('music-1')).not.toContain('data-fx-chain')
    })

    it('人声开「遇到其他人声时自动压低」：压人声组里别的人声，不含自己', async () => {
      const user = await openWith([
        video({ src: URL_A, duration: 2_000 }),
        audio({
          id: 'talk',
          label: '对白',
          src: TALK,
          duration: 2_000,
          track: 1,
          audioGroup: 'voice',
        }),
      ])
      await pick(user, 'A · 镜头 1')
      const carve = () => control('遇到其他人声时自动压低')
      await pastDelay()
      expect(carve()).toHaveAttribute('aria-checked', 'false')
      expect(savedTag('clip-1')).not.toContain('data-fx-carve')

      await user.click(carve())
      await waitSaved(() =>
        expect(savedCarve('clip-1')).toEqual({ enabled: true, sources: ['voice'], strength: 0.25 }),
      )
      expect(savedAttribute('clip-1', 'data-fx-chain')).toContain('"fromCarve":true')
      expect(carve()).toHaveAttribute('aria-checked', 'true')
      // 量的是「对白」，没有拿自己当人声
      expect(fetched.toSorted()).toEqual([TALK, URL_A])
      expect(screen.getByRole('button', { name: /^选中：A · 镜头 1，.*自动压低$/ })).toBeVisible()
    })

    it('自动打开以后撤销：回到没设置过，不会又自动打开', async () => {
      const user = await openWith([
        video({ src: URL_A, duration: 2_000 }),
        audio({ duration: 4_000 }),
      ])
      await pick(user, '配乐')
      await waitSaved(() => expect(savedCarve('music-1')).toMatchObject({ enabled: true }))
      await user.click(undoButton())
      await waitSaved(() => expect(savedCarve('music-1')).toBeNull())
      await pastDelay()
      expect(savedCarve('music-1')).toBeNull()
      expect(carveSwitch()).toHaveAttribute('aria-checked', 'false')
      expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
    })

    it('分离出来的原声是人声，不自动压低；配乐读不出声音时提示，不写', async () => {
      server.use(
        http.get(MUSIC, () => {
          fetched.push(MUSIC)
          return new HttpResponse(null, { status: 404 })
        }),
      )
      const user = await openWith([
        video({ src: URL_A, duration: 2_000, muted: true, link: 'lk-1', syncOrigin: 'lk-1' }),
        audio({
          id: 'orig',
          label: '原声',
          src: URL_A,
          duration: 2_000,
          link: 'lk-1',
          syncOrigin: 'lk-1',
        }),
        audio({ duration: 4_000, track: 1 }),
      ])
      await pick(user, '原声')
      expect(within(inspector()).getByRole('button', { name: '角色：人声' })).toBeVisible()
      expect(within(inspector()).queryByRole('switch', { name: '有人说话时自动压低' })).toBeNull()
      expect(control('遇到其他人声时自动压低')).toHaveAttribute('aria-checked', 'false')
      await pick(user, '配乐')
      expect(
        (await screen.findAllByText('自动压低没有生效：人声或配乐的声音读取失败，请重试')).length,
      ).toBeGreaterThan(0)
      expect(carveSwitch()).toHaveAttribute('aria-checked', 'false')
      await pastDelay()
      expect(savedTag('music-1')).not.toContain('data-fx-carve')
      // 读失败以后不会一直重试：人声读一次；配乐打开时节拍分析读过一次（失败不重试），压低最多再读一次
      expect(fetched.filter((url) => url === URL_A)).toHaveLength(1)
      expect(fetched.filter((url) => url === MUSIC).length).toBeLessThanOrEqual(2)
    })

    // 音色风格和精细调音：一条用例只做一样，连着做会超过单条用例的时限
    const fxChain = () =>
      parseAudioFxChain(savedAttribute('clip-1', 'data-fx-chain') ?? '{"version":1,"nodes":[]}')
    const styleTile = (name: string) =>
      within(within(inspector()).getByRole('radiogroup', { name: '音色风格' })).getByRole('radio', {
        name,
      })
    const eqGains = () => eqBandsOf(fxChain()).map((band) => band.gain)
    const fineTune = () => within(inspector()).getByRole('button', { name: /^精细调音/ })
    const openVoiceClip = async () => {
      const user = await openWith([video({ src: URL_A, duration: 2_000 })])
      await pick(user, 'A · 镜头 1')
      await pastDelay()
      return user
    }

    it('选预设、从全部预设里换一个：各是一步撤销，链上只有现在这个预设的节点', async () => {
      const user = await openVoiceClip()
      expect(styleTile('原声')).toHaveAttribute('aria-checked', 'true')

      await user.click(styleTile('纯净人声'))
      await waitSaved(() => expect(presetOf(fxChain())).toBe('voice-clean'))
      expect(styleTile('纯净人声')).toHaveAttribute('aria-checked', 'true')
      // 从全部预设里换一个：只剩它的节点，快捷小块的最后一个换成它
      await user.click(within(inspector()).getByRole('button', { name: '全部预设 (22)' }))
      await user.click(screen.getByRole('menuitemradio', { name: /^花栗鼠/ }))
      await waitSaved(() => expect(presetOf(fxChain())).toBe('chipmunk'))
      expect(fxChain().nodes.every((node) => node.fromPreset === 'chipmunk')).toBe(true)
      expect(styleTile('花栗鼠')).toHaveAttribute('aria-checked', 'true')

      await user.click(undoButton())
      await waitSaved(() => expect(presetOf(fxChain())).toBe('voice-clean'))
      await user.click(undoButton())
      await waitSaved(() => expect(savedTag('clip-1')).not.toContain('data-fx-chain'))
      expect(styleTile('原声')).toHaveAttribute('aria-checked', 'true')
    })

    it('调一段均衡、双击滑杆归零：各是一步撤销，三段都回到 0 时去掉均衡', async () => {
      const user = await openVoiceClip()
      expect(fineTune()).toHaveAttribute('aria-expanded', 'false')
      expect(fineTune()).toHaveTextContent('默认')
      await user.click(fineTune())

      await typeStrength(user, '中频 1kHz', '0.0dB', '2')
      await waitSaved(() => expect(eqGains()).toEqual([0, 2, 0]))
      await user.dblClick(within(inspector()).getByRole('slider', { name: '中频 1kHz' }))
      await waitSaved(() => expect(savedTag('clip-1')).not.toContain('data-fx-chain'))

      await user.click(undoButton())
      await waitSaved(() => expect(eqGains()).toEqual([0, 2, 0]))
      await user.click(undoButton())
      await waitSaved(() => expect(savedTag('clip-1')).not.toContain('data-fx-chain'))
    })

    it('调一段均衡：改动直接打进正在播的预览，不重新加载', async () => {
      const user = await openVoiceClip()
      await previewSettled()
      const loads = () =>
        previewPages.latest().commands.filter((command) => command.type === 'load').length
      const before = loads()
      const player = previewPlayer()
      await user.click(fineTune())

      await typeStrength(user, '中频 1kHz', '0.0dB', '2')
      await waitFor(() =>
        expect(
          player.iframeElement.contentDocument
            ?.querySelector('[data-hf-id="clip-1"]')
            ?.getAttribute('data-fx-chain'),
        ).toContain('peaking'),
      )
      expect(previewPlayer()).toBe(player)
      expect(loads()).toBe(before)
      // 等存完：没存完的保存会落到下一条用例的工程上
      await waitSaved(() => expect(eqGains()).toEqual([0, 2, 0]))
    })

    it('升降调以后点右上「归零」：一起清掉，是一步撤销', async () => {
      const user = await openVoiceClip()
      await user.click(fineTune())
      expect(within(inspector()).queryByRole('button', { name: '归零' })).toBeNull()

      await typeStrength(user, '升降音调', '0半音', '3')
      await waitSaved(() => expect(savedTag('clip-1')).toContain('pitchshift'))
      await user.click(within(inspector()).getByRole('button', { name: '归零' }))
      await waitSaved(() => expect(savedTag('clip-1')).not.toContain('data-fx-chain'))
      expect(within(inspector()).queryByRole('button', { name: '归零' })).toBeNull()

      await user.click(undoButton())
      await waitSaved(() => expect(savedTag('clip-1')).toContain('pitchshift'))
    })

    it('加一个效果再改参数：各是一步撤销，均衡不动，摘要跟着变', async () => {
      const user = await openVoiceClip()
      await user.click(fineTune())
      await typeStrength(user, '低频 200Hz', '0.0dB', '3')
      await waitSaved(() => expect(eqGains()).toEqual([3, 0, 0]))

      await user.click(within(inspector()).getByRole('button', { name: /添加效果/ }))
      await user.click(screen.getByRole('menuitem', { name: /^隔门闷音过滤/ }))
      await waitSaved(() =>
        expect(ownEffects(fxChain()).map((node) => node.type)).toEqual(['lowpass']),
      )
      expect(within(inspector()).getByRole('group', { name: '隔门闷音过滤' })).toBeVisible()
      await typeStrength(user, '保留频率', '8000Hz', '1800')
      await waitSaved(() =>
        expect(ownEffects(fxChain())[0]?.params).toMatchObject({ frequency: 1800 }),
      )
      expect(eqGains()).toEqual([3, 0, 0])
      expect(fineTune()).toHaveTextContent('均衡 · 1 个效果')

      await user.click(undoButton())
      await waitSaved(() =>
        expect(ownEffects(fxChain())[0]?.params).toMatchObject({ frequency: 8000 }),
      )
      await user.click(undoButton())
      await waitSaved(() => expect(ownEffects(fxChain())).toEqual([]))
      expect(eqGains()).toEqual([3, 0, 0])
    })

    const volumeLane = (id: string) =>
      parseAutomation(
        savedAttribute(id, 'data-automation') ?? '{"version":1,"lanes":[]}',
      ).lanes.find((lane) => lane.target === 'volume')?.points

    it('波形音量关键帧：打开加平的一条、关掉去掉曲线，各算一步撤销；开没开从文件里读', async () => {
      const user = await openWith([video({ src: URL_A, duration: 2_000 })])
      await pick(user, 'A · 镜头 1')
      await pastDelay()
      await user.click(within(inspector()).getByRole('button', { name: /^精细调音/ }))
      const toggle = () => control('波形音量关键帧')
      expect(toggle()).toHaveAttribute('aria-checked', 'false')
      expect(within(inspector()).queryByRole('button', { name: '重置' })).toBeNull()

      await user.click(toggle())
      await waitSaved(() =>
        expect(volumeLane('clip-1')).toEqual([
          { t: 0, v: 1 },
          { t: 2, v: 1 },
        ]),
      )
      expect(toggle()).toHaveAttribute('aria-checked', 'true')
      expect(screen.getByRole('group', { name: /^A · 镜头 1，/ })).toHaveTextContent('关键帧')
      expect(within(inspector()).getByRole('button', { name: /^精细调音/ })).toHaveTextContent(
        '关键帧',
      )

      await user.click(toggle())
      await waitSaved(() => expect(savedTag('clip-1')).not.toContain('data-automation'))
      expect(toggle()).toHaveAttribute('aria-checked', 'false')

      await user.click(undoButton())
      await waitSaved(() => expect(volumeLane('clip-1')?.[0]?.v).toBe(1))
      expect(toggle()).toHaveAttribute('aria-checked', 'true')
      await user.click(undoButton())
      await waitSaved(() => expect(savedTag('clip-1')).not.toContain('data-automation'))
      expect(toggle()).toHaveAttribute('aria-checked', 'false')
    })

    it('波形音量关键帧的「重置」：调过的曲线换回平的一条，算一步撤销', async () => {
      const dipped = JSON.stringify({
        version: 1,
        lanes: [
          {
            target: 'volume',
            points: [
              { t: 0, v: 0.5 },
              { t: 2, v: 1 },
            ],
          },
        ],
      })
      const user = await openWith([video({ src: URL_A, duration: 2_000, automation: dipped })])
      await pick(user, 'A · 镜头 1')
      await pastDelay()
      await user.click(within(inspector()).getByRole('button', { name: /^精细调音/ }))
      expect(control('波形音量关键帧')).toHaveAttribute('aria-checked', 'true')

      await user.click(within(inspector()).getByRole('button', { name: '重置' }))
      await waitSaved(() =>
        expect(volumeLane('clip-1')).toEqual([
          { t: 0, v: 1 },
          { t: 2, v: 1 },
        ]),
      )
      await user.click(undoButton())
      await waitSaved(() => expect(volumeLane('clip-1')?.[0]?.v).toBe(0.5))
    })

    it('时间线上的音量关键帧：没选中的片段只画线、改不了；选中后每个点是滑杆，方向键调音量、Delete 删中间的点，各一步撤销', async () => {
      const lane = JSON.stringify({
        version: 1,
        lanes: [
          {
            target: 'volume',
            points: [
              { t: 0, v: 1 },
              { t: 1, v: 1 },
              { t: 2, v: 1 },
            ],
          },
        ],
      })
      const user = await openWith([
        video({ src: URL_A, duration: 2_000, automation: lane }),
        audio({ start: 3_000, duration: 2_000, automation: lane }),
      ])
      const music = () => screen.getByRole('group', { name: /^配乐，/ })
      const shot = () => screen.getByRole('group', { name: /^A · 镜头 1，/ })
      expect(within(music()).getByTestId('volume-envelope')).toBeInTheDocument()
      expect(within(music()).queryAllByRole('slider', { name: /^音量关键帧/ })).toEqual([])
      expect(within(music()).queryByTestId('volume-envelope-line')).toBeNull()

      await pick(user, 'A · 镜头 1')
      expect(within(music()).queryAllByRole('slider', { name: /^音量关键帧/ })).toEqual([])
      const points = within(shot()).getAllByRole('slider', { name: /^音量关键帧/ })
      expect(points).toHaveLength(3)
      expect(points[1]).toHaveAttribute('aria-valuetext', '0.0 dB，第 1.0 秒')

      points[1]?.focus()
      await user.keyboard('{Shift>}{ArrowDown}{/Shift}')
      await waitSaved(() => expect(volumeLane('clip-1')?.[1]?.v).toBeLessThan(0.6))
      expect(volumeLane('clip-1')?.[1]?.t).toBe(1)
      expect(within(shot()).getByRole('slider', { name: '音量关键帧 2' })).toHaveFocus()
      // 两头的点按 Delete 不删，片段也还在
      within(shot()).getByRole('slider', { name: '音量关键帧 1' }).focus()
      await user.keyboard('{Delete}')
      within(shot()).getByRole('slider', { name: '音量关键帧 2' }).focus()
      await user.keyboard('{Delete}')
      await waitSaved(() => expect(volumeLane('clip-1')).toHaveLength(2))
      expect(savedTag('clip-1')).toContain('<video')
      // 别的片段的曲线没动
      expect(volumeLane('music-1')).toHaveLength(3)

      await user.click(undoButton())
      await waitSaved(() => expect(volumeLane('clip-1')).toHaveLength(3))
      await user.click(undoButton())
      await waitSaved(() => expect(volumeLane('clip-1')?.[1]?.v).toBe(1))
    })

    describe('曲线跟着编辑走', () => {
      const dipped = JSON.stringify({
        version: 1,
        lanes: [
          {
            target: 'volume',
            points: [
              { t: 0, v: 1 },
              { t: 1, v: 0.25 },
              { t: 2, v: 1 },
            ],
          },
        ],
      })
      const timedClip = (start: string, mediaStart: string) =>
        new RegExp(`data-start="${start}"[^>]* data-media-start="${mediaStart}"`)

      it('在时间线上裁左边：音量关键帧跟着平移，0 秒上补原曲线在那里的值；撤销一步都回去', async () => {
        const user = await openWith([video({ src: URL_A, duration: 2_000, automation: dipped })])
        await pick(user, 'A · 镜头 1')
        within(screen.getByRole('group', { name: '画面 1' }))
          .getByRole('slider', { name: '裁剪开头' })
          .focus()
        await user.keyboard('{ArrowRight}')
        await waitSaved(() =>
          expect(volumeLane('clip-1')).toEqual([
            { t: 0, v: 0.925 },
            { t: 0.9, v: 0.25 },
            { t: 1.9, v: 1 },
          ]),
        )
        expect(savedTag('clip-1')).toMatch(timedClip('0.1', '0.1'))

        await user.click(undoButton())
        await waitSaved(() => expect(savedTag('clip-1')).toMatch(timedClip('0', '0')))
        expect(savedAttribute('clip-1', 'data-automation')).toBe(dipped)
        expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
      })

      it('改成 2 倍速：音量关键帧按比例压到一半的时间', async () => {
        const user = await openWith([video({ src: URL_A, duration: 2_000, automation: dipped })])
        await shot(/^生成 A 镜头 1，/)
        await pick(user, 'A · 镜头 1')
        await user.click(within(inspector()).getByRole('button', { name: /^倍速 1x，/ }))
        const box = within(inspector()).getByRole('textbox', { name: '倍速' })
        await user.clear(box)
        await user.type(box, '2x{Enter}')
        await waitSaved(() =>
          expect(volumeLane('clip-1')).toEqual([
            { t: 0, v: 1 },
            { t: 0.5, v: 0.25 },
            { t: 1, v: 1 },
          ]),
        )
        expect(savedAttribute('clip-1', 'data-playback-rate')).toBe('2')
      })

      it('「原片截取」里把入点往前挪：平稳音量的曲线跟着内容往后移', async () => {
        // 声音换成噪声：选中着时按新的入点重量，量出来已经平稳，不写，留下的就是跟着挪的曲线
        server.use(
          http.get(URL_A, () =>
            HttpResponse.arrayBuffer(
              Float32Array.from({ length: 4 * 48_000 }, (_, i) => ((i * 7_919) % 97) / 160 - 0.3)
                .buffer,
            ),
          ),
        )
        const chain = JSON.stringify({
          version: 1,
          nodes: [{ type: 'gain', id: 'n1', enabled: true, fromLeveller: true, params: {} }],
        })
        const levelled = JSON.stringify({
          version: 1,
          lanes: [
            {
              target: 'fx.n1.gain',
              points: [
                { t: 0, v: 0 },
                { t: 1, v: 6 },
                { t: 2, v: 0 },
              ],
            },
          ],
        })
        const user = await openWith([
          video({
            src: URL_A,
            duration: 2_000,
            mediaStart: 1_000,
            fxChain: chain,
            automation: levelled,
          }),
        ])
        await shot(/^生成 A 镜头 1，/)
        await pick(user, 'A · 镜头 1')
        expect(control('自动平稳人声音量')).toHaveAttribute('aria-checked', 'true')
        await waitFor(() =>
          expect(within(inspector()).getByTestId('slip-summary')).toHaveTextContent('1.00 – 3.00s'),
        )
        within(inspector()).getByRole('slider', { name: '裁剪开头' }).focus()
        await user.keyboard('{ArrowLeft}')
        await waitSaved(() => expect(savedTag('clip-1')).toMatch(timedClip('0', '0.9')))
        expect(
          parseAutomation(savedAttribute('clip-1', 'data-automation') ?? '').lanes[0]?.points,
        ).toEqual([
          { t: 0.1, v: 0 },
          { t: 1.1, v: 6 },
          { t: 2.1, v: 0 },
        ])
      })

      /** 视频 0–2 秒、配乐 0–4 秒：选中配乐默认打开压低，量好写进去；答复那时配乐的曲线。 */
      const carvedMusic = async () => {
        const user = await openWith([
          video({ src: URL_A, duration: 2_000 }),
          audio({ duration: 4_000 }),
        ])
        await pick(user, '配乐')
        await waitSaved(() =>
          expect(savedAttribute('music-1', 'data-fx-chain')).toContain('peaking'),
        )
        return { user, measured: savedAttribute('music-1', 'data-automation') }
      }
      /**
       * 选中视频片段，在时间线上把它的结尾裁掉 1 秒（人声变了，不是整体挪动，压低不能靠平移跟上）；等存好。
       * 量和写都在同一批微任务里做完，存下来的就是这一步以后的样子。
       */
      const trimVoice = async (user: ReturnType<typeof userEvent.setup>) => {
        await pick(user, 'A · 镜头 1')
        within(screen.getByRole('group', { name: '画面 1' }))
          .getByRole('slider', { name: '裁剪结尾' })
          .focus()
        await user.keyboard('{Shift>}{ArrowLeft}{/Shift}')
        await waitSaved(() => expect(savedTag('clip-1')).toContain('data-duration="1"'))
      }
      const redoButton = () => within(toolbar()).getByRole('button', { name: '重做' })
      // 让选中以后的分析（声音已经读过，都在微任务里）做完
      const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

      it('裁了人声以后再选中配乐：按人声现在的样子重新量压低，写进去；没选中时不重量', async () => {
        const { user, measured } = await carvedMusic()
        await trimVoice(user)
        expect(savedAttribute('music-1', 'data-automation')).toBe(measured)

        await pick(user, '配乐')
        await waitSaved(() =>
          expect(savedAttribute('music-1', 'data-automation')).not.toBe(measured),
        )
        expect(savedCarve('music-1')).toEqual({ enabled: true, sources: ['voice'], strength: 0.25 })
      })

      it('撤销掉重新量的那一步以后，同样的人声再选中配乐不再重量', async () => {
        const { user, measured } = await carvedMusic()
        await trimVoice(user)
        await pick(user, '配乐')
        await waitSaved(() =>
          expect(savedAttribute('music-1', 'data-automation')).not.toBe(measured),
        )
        await user.click(undoButton())
        expect(redoButton()).not.toHaveAttribute('aria-disabled', 'true')

        // 重量过就会多一步、把重做清掉
        await pick(user, 'A · 镜头 1')
        await pick(user, '配乐')
        await settled()
        expect(redoButton()).not.toHaveAttribute('aria-disabled', 'true')
        await waitSaved(() => expect(savedAttribute('music-1', 'data-automation')).toBe(measured))
      })

      it('人声改回原样时重量出来和原来一样：不写，重做还在', async () => {
        const { user, measured } = await carvedMusic()
        await trimVoice(user)
        await pick(user, '配乐')
        await waitSaved(() =>
          expect(savedAttribute('music-1', 'data-automation')).not.toBe(measured),
        )
        // 撤销重量、再撤销裁剪：选中着的配乐按人声原来的样子重量，结果和原来一样
        await user.click(undoButton())
        await user.click(undoButton())
        await settled()
        expect(redoButton()).not.toHaveAttribute('aria-disabled', 'true')
        await waitSaved(() => expect(savedTag('clip-1')).toContain('data-duration="2"'))
        expect(savedAttribute('music-1', 'data-automation')).toBe(measured)
      })

      it('人声改回原样时确实重量过：重做裁剪以后又和上次量的不一样，再重量一次', async () => {
        const { user, measured } = await carvedMusic()
        await trimVoice(user)
        await pick(user, '配乐')
        await waitSaved(() =>
          expect(savedAttribute('music-1', 'data-automation')).not.toBe(measured),
        )
        await user.click(undoButton())
        await user.click(undoButton())
        await settled()
        // 没按原样重量的话，记着的还是裁过的人声，重做以后不会再量
        await user.click(redoButton())
        await waitSaved(() =>
          expect(savedAttribute('music-1', 'data-automation')).not.toBe(measured),
        )
        expect(savedTag('clip-1')).toContain('data-duration="1"')
      })

      it('配乐和它压的人声一起选中、整体拖动：存下的压低曲线不变', async () => {
        const carve = JSON.stringify({ enabled: true, sources: ['voice'], strength: 0.25 })
        const chain = JSON.stringify({
          version: 1,
          nodes: [{ type: 'gain', id: 'n1', enabled: true, fromCarve: true, params: {} }],
        })
        const ducked = JSON.stringify({
          version: 1,
          lanes: [
            {
              target: 'fx.n1.gain',
              points: [
                { t: 0, v: 0 },
                { t: 1, v: -6 },
                { t: 2, v: 0 },
              ],
            },
          ],
        })
        const user = await openWith([
          video({ src: URL_A, duration: 2_000, audioGroup: 'voice' }),
          audio({ duration: 4_000, fxCarve: carve, fxChain: chain, automation: ducked }),
        ])
        await pick(user, 'A · 镜头 1')
        await user.keyboard('{Shift>}')
        await pick(user, '配乐')
        await user.keyboard('{/Shift}')
        // 拖视频片段 1 秒（测试里一秒 100 像素），选中的两段一起挪
        const body = screen.getByRole('button', { name: /^选中：A · 镜头 1，/ })
        fireEvent.pointerDown(body, { button: 0, pointerId: 1, clientX: 10, clientY: 50 })
        fireEvent.pointerMove(body, { pointerId: 1, clientX: 110, clientY: 50 })
        fireEvent.pointerUp(body, { pointerId: 1, clientX: 110, clientY: 50 })
        await waitSaved(() => expect(savedTag('music-1')).toContain('data-start="1"'))
        expect(savedTag('clip-1')).toContain('data-start="1"')
        expect(savedAttribute('music-1', 'data-automation')).toBe(ducked)
      })
    })
  })
})
