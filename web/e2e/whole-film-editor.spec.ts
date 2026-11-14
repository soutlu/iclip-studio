import { expect, test, type Locator, type Page } from '@playwright/test'
import { openConversation } from './helpers'

const openWholeFilm = async (page: Page, panel: Locator) => {
  await panel.getByRole('button', { name: '成片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '夜景延时素材生成' })
  await expect(dialog).toBeVisible()
  await expect(page).toHaveURL(/[?&]wholeFilm=true/)
  return dialog
}

const draftSaved = (page: Page, clips: number) =>
  page.waitForRequest(
    (request) =>
      request.method() === 'PUT' &&
      request.url().includes('/whole-film/draft') &&
      ((request.postDataJSON() as { html: string }).html.match(/<video /g) ?? []).length === clips,
  )

const readyPlayer = async (dialog: Locator) => {
  const player = dialog.getByRole('region', { name: '预览' }).locator('hyperframes-player')
  await expect
    .poll(() =>
      player.evaluateAll(
        (elements) =>
          elements.length === 1 && (elements[0] as HTMLElement & { painted: boolean }).painted,
      ),
    )
    .toBe(true)
  return player
}

test('成片编辑器：选镜头加入成片、播放、撤销、导出下载，关掉再开成片还在', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const dialog = await openWholeFilm(page, panel)
  const toolbar = dialog.getByRole('toolbar', { name: '剪辑工具' })
  const transport = dialog.getByRole('group', { name: '播放控制' })
  await expect(dialog.getByText('成片还是空的；加入内容后可以在这里预览')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '导出', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  )

  const materials = dialog
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
  const first = draftSaved(page, 1)
  await materials.getByRole('button', { name: /^生成 A 镜头 1，/ }).click()
  await page.keyboard.press('Enter')
  const { html } = (await first).postDataJSON() as { html: string }
  expect(html).toContain('data-no-timeline')
  expect(html).not.toContain('<script')
  expect(html).toMatch(/<video [^>]*src="[^"]+" data-var-src="src-[0-9a-f-]{36}"/)

  const player = await readyPlayer(dialog)
  const second = draftSaved(page, 2)
  await materials.getByRole('button', { name: /^生成 A 镜头 3，/ }).click()
  await page.keyboard.press('Enter')
  await second
  await readyPlayer(dialog)
  const total = await transport.locator('.wf-clock span').innerText()
  expect(total).not.toBe('/ 00:00.00')

  const playerTime = () =>
    player.evaluate((element: HTMLElement & { currentTime: number }) => element.currentTime)
  await transport.getByRole('button', { name: '播放', exact: true }).click()
  await expect(transport.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
  await expect.poll(playerTime).toBeGreaterThan(0.2)
  await transport.getByRole('button', { name: '暂停', exact: true }).click()

  await transport.getByRole('slider', { name: '播放进度' }).focus()
  await page.keyboard.press('Home')
  await expect(transport.locator('.wf-clock')).toContainText('00:00.00 /')
  await expect.poll(playerTime).toBeLessThan(0.1)

  // 缩放：放大一档片段变宽一倍，读数从「适应」变成百分比；点「适应宽度」回去
  const clip = dialog.getByRole('group', { name: '第 1 行' }).locator('[data-clip-id]').first()
  const widthOf = async () => (await clip.boundingBox())?.width ?? 0
  const fitted = await widthOf()
  await expect(toolbar.getByText('适应', { exact: true })).toBeVisible()
  await toolbar.getByRole('button', { name: '放大时间线' }).click()
  await expect(toolbar.getByText('200%')).toBeVisible()
  expect((await widthOf()) / fitted).toBeGreaterThan(1.9)
  await toolbar.getByRole('slider', { name: '时间线缩放' }).focus()
  await page.keyboard.press('Home')
  await expect(toolbar.getByText('10%')).toBeVisible()
  await toolbar.getByRole('button', { name: '适应宽度' }).click()
  await expect(toolbar.getByText('适应', { exact: true })).toBeVisible()
  expect(Math.abs((await widthOf()) - fitted)).toBeLessThan(1)

  // 关掉缩略图：片段上不画画面，只剩名字和声音
  await expect(clip.locator('.wf-clip-frames')).toBeVisible()
  await toolbar.getByRole('button', { name: '显示缩略图' }).click()
  await expect(clip.locator('.wf-clip-frames')).toBeHidden()
  await expect(clip.locator('.wf-clip-label')).toBeVisible()
  await toolbar.getByRole('button', { name: '显示缩略图' }).click()
  await expect(clip.locator('.wf-clip-frames')).toBeVisible()

  const undone = draftSaved(page, 1)
  await toolbar.getByRole('button', { name: '撤销' }).click()
  await undone
  const redone = draftSaved(page, 2)
  await toolbar.getByRole('button', { name: '重做' }).click()
  await redone

  const exported = page.waitForResponse(
    (response) => response.url().includes('/whole-film/exports') && response.status() === 202,
  )
  await dialog.getByRole('button', { name: '导出', exact: true }).click()
  const { exportId } = (await (await exported).json()) as { exportId: string }
  const tiers = page.waitForResponse(
    (response) => response.url().includes(`/generations/${exportId}/enhancements`),
    { timeout: 20_000 },
  )
  await expect(dialog.getByRole('status').filter({ hasText: /排队中|正在渲染/ })).toBeVisible()
  const download = dialog.getByRole('button', { name: '下载成片' })
  await expect(download).toBeVisible({ timeout: 15_000 })
  await tiers
  const tracked = page.waitForRequest(
    (request) => request.url().includes('/tracking/events') && request.method() === 'POST',
  )
  const fileSaved = page.waitForEvent('download')
  await download.click()
  await page.getByRole('menuitem', { name: '下载成片', exact: true }).click()
  expect((await tracked).postDataJSON()).toMatchObject({ name: 'video.downloaded' })
  expect((await fileSaved).suggestedFilename()).toMatch(/\.mp4$/)

  await dialog.getByRole('button', { name: '关闭成片编辑' }).click()
  await expect(dialog).toBeHidden()
  const reopened = await openWholeFilm(page, panel)
  await expect(reopened.getByRole('button', { name: '下载成片' })).toBeVisible()
  const reopenedToolbar = reopened.getByRole('toolbar', { name: '剪辑工具' })
  await expect(
    reopened.getByRole('group', { name: '播放控制' }).locator('.wf-clock span'),
  ).toHaveText(total)
  await expect(reopenedToolbar.getByRole('button', { name: '撤销' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await readyPlayer(reopened)
})

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox()
  if (box === null) throw new Error('元素不在页面上')
  return box
}

type PlayerSettings = HTMLElement & {
  playbackRate: number
  muted: boolean
  loop: boolean
  currentTime: number
  iframeElement: HTMLIFrameElement
}

test('播放条：倍速和静音对素材、成片都生效且换播放器后还在，循环播放、快捷键面板、全屏', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const dialog = await openWholeFilm(page, panel)
  const transport = dialog.getByRole('group', { name: '播放控制' })
  const materials = dialog
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })

  // 素材预览：选 2×、按 M 静音
  await materials.getByRole('button', { name: /^生成 A 镜头 1，/ }).click()
  // 菜单打开时编辑器对读屏隐藏，按钮的位置先量好
  const rate = transport.getByRole('button', { name: '播放速度 1×' })
  const rateTop = (await boxOf(rate)).y
  await rate.click()
  const menu = page.getByRole('menu')
  const menuBox = await boxOf(menu)
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(rateTop)
  await menu.getByRole('menuitemradio', { name: '2×' }).click()
  await expect(transport.getByRole('button', { name: '播放速度 2×' })).toHaveText('2×')
  await page.keyboard.press('m')
  await expect(transport.getByRole('button', { name: '开启声音' })).toBeVisible()
  const material = dialog.locator('video')
  expect(
    await material.evaluate((video: HTMLVideoElement) => [video.playbackRate, video.muted]),
  ).toEqual([2, true])

  // 加入成片：成片预览也是 2×、静音
  const first = draftSaved(page, 1)
  await materials.getByRole('button', { name: /^生成 A 镜头 1，/ }).focus()
  await page.keyboard.press('Enter')
  await first
  const player = await readyPlayer(dialog)
  // 换播放器时新旧两个同时在，只看换完剩下的那一个
  const settings = () =>
    player.evaluateAll((elements) => {
      const [element] = elements as PlayerSettings[]
      if (elements.length !== 1 || element === undefined) return null
      return {
        rate: element.playbackRate,
        muted: element.muted,
        loop: element.loop,
        clips: element.iframeElement.contentDocument?.querySelectorAll('video[data-start]').length,
      }
    })
  await expect.poll(settings).toEqual({ rate: 2, muted: true, loop: false, clips: 1 })

  const loop = transport.getByRole('button', { name: '循环播放' })
  await loop.click()
  await expect(loop).toHaveAttribute('aria-pressed', 'true')

  // 改动成片后换了播放器：倍速、静音、循环都还在
  const second = draftSaved(page, 2)
  await materials.getByRole('button', { name: /^生成 A 镜头 3，/ }).click()
  await page.keyboard.press('Enter')
  await second
  await expect.poll(settings).toEqual({ rate: 2, muted: true, loop: true, clips: 2 })
  await readyPlayer(dialog)

  // 循环开着：从结尾前一点开始放，放到结尾回到开头接着放
  await transport.getByRole('slider', { name: '播放进度' }).focus()
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await transport.getByRole('button', { name: '播放', exact: true }).click()
  await expect
    .poll(() => player.evaluate((element: PlayerSettings) => element.currentTime))
    .toBeLessThan(0.5)
  await expect(transport.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
  await transport.getByRole('button', { name: '暂停', exact: true }).click()
  await page.keyboard.press('Shift+L')
  await expect(loop).toHaveAttribute('aria-pressed', 'false')

  // 快捷键面板向上打开
  const shortcuts = transport.getByRole('button', { name: '快捷键' })
  const shortcutsTop = (await boxOf(shortcuts)).y
  await shortcuts.click()
  const sheet = page.getByRole('dialog', { name: '快捷键' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText('打开或关闭循环播放')).toBeVisible()
  await expect(sheet.getByText('全屏或退出全屏')).toBeVisible()
  const sheetBox = await boxOf(sheet)
  expect(sheetBox.y + sheetBox.height).toBeLessThanOrEqual(shortcutsTop)
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()

  // 再按 M 恢复声音：成片里的片段不再静音
  await page.keyboard.press('m')
  await expect(transport.getByRole('button', { name: '静音', exact: true })).toBeVisible()
  await expect
    .poll(() =>
      player.evaluate((element: PlayerSettings) =>
        [...(element.iframeElement.contentDocument?.querySelectorAll('video') ?? [])].map(
          (video) => video.muted,
        ),
      ),
    )
    .toEqual([false, false])

  // F 全屏：预览和播放条一起进全屏，倍速菜单在全屏里打得开；Esc 退出，编辑器还在、布局照旧
  const preview = dialog.getByRole('region', { name: '预览' })
  const before = [await boxOf(preview), await boxOf(transport)]
  await page.keyboard.press('f')
  await expect(transport.getByRole('button', { name: '退出全屏' })).toBeVisible()
  const inFullscreen = (locator: Locator) =>
    locator.evaluate((element) => document.fullscreenElement?.contains(element) ?? false)
  expect(await inFullscreen(transport)).toBe(true)
  expect(await inFullscreen(preview)).toBe(true)
  await transport.getByRole('button', { name: '播放速度 2×' }).click()
  await expect(menu).toBeVisible()
  expect(await inFullscreen(menu)).toBe(true)
  await menu.getByRole('menuitemradio', { name: '1×' }).click()
  await page.keyboard.press('Escape')
  await expect(transport.getByRole('button', { name: '全屏', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull()
  await expect(dialog).toBeVisible()
  await expect.poll(async () => [await boxOf(preview), await boxOf(transport)]).toEqual(before)
})

/** 存下来的成片里名字是 `title` 的组件或块的片段的属性；没有时是 null。 */
const savedComponent = (html: string, title: string) => {
  const tag = new RegExp(`<div [^>]*class="clip component"[^>]*data-label="${title}"[^>]*>`).exec(
    html,
  )?.[0]
  if (tag === undefined) return null
  const attribute = (name: string) => new RegExp(` ${name}="([^"]*)"`).exec(tag)?.[1]
  return {
    id: attribute('id'),
    component: attribute('data-composition-id'),
    start: Number(attribute('data-start')),
    duration: Number(attribute('data-duration')),
    track: Number(attribute('data-track-index')),
    values: JSON.parse(
      (attribute('data-variable-values') ?? '{}').replaceAll('&quot;', '"'),
    ) as Record<string, unknown>,
  }
}

const draftSavedWith = (page: Page, check: (html: string) => boolean) =>
  page.waitForRequest(
    (request) =>
      request.method() === 'PUT' &&
      request.url().includes('/whole-film/draft') &&
      check((request.postDataJSON() as { html: string }).html),
  )

test('组件栏：搜到组件点「加到播放头」、拖一个到时间线上，预览里画出来，撤销回去', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const dialog = await openWholeFilm(page, panel)
  const first = draftSaved(page, 1)
  await dialog
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^生成 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  const { html: withVideo } = (await first).postDataJSON() as { html: string }
  const videoSeconds = Number(/<video [^>]*data-duration="([^"]+)"/.exec(withVideo)?.[1])

  const side = dialog.getByRole('complementary', { name: '组件和音频' })
  await side.getByRole('searchbox', { name: '搜索组件' }).fill('渐变')
  const cards = side.getByRole('list', { name: '组件' }).getByRole('group')
  await expect(cards).toHaveCount(1)
  const scene = cards.first()
  await expect(scene).toHaveAccessibleName('测试画面，6 秒')
  const add = scene.getByRole('button', { name: '加到播放头' })
  await expect(add).toHaveCSS('opacity', '0')
  await scene.hover()
  await expect(add).toHaveCSS('opacity', '1')

  // 播放头在 0：第一行这时有视频片段，组件放进它下面新开的一行
  const added = draftSavedWith(page, (html) => savedComponent(html, '测试画面') !== null)
  await add.click()
  const placed = savedComponent(((await added).postDataJSON() as { html: string }).html, '测试画面')
  expect(placed).toMatchObject({ component: 'fixture-scene', start: 0, duration: 6, track: 1 })
  await expect(
    dialog.getByRole('group', { name: '第 2 行' }).getByRole('group', { name: '测试画面，6.0 秒' }),
  ).toBeVisible()

  // 预览里画出了组件，按原比例缩进画面、居中
  const player = await readyPlayer(dialog)
  await expect
    .poll(() =>
      player.evaluate((element: HTMLElement & { iframeElement: HTMLIFrameElement }, id) => {
        const page = element.iframeElement.contentDocument
        const root = page?.getElementById('film')
        const host = page?.getElementById(id)
        if (!root || !host || host.querySelector('.fs-dot') === null) return null
        const width = Number(root.dataset['width'])
        const height = Number(root.dataset['height'])
        const scale = Math.min(width / 1920, height / 1080)
        const outer = root.getBoundingClientRect()
        const inner = host.getBoundingClientRect()
        const near = (actual: number, expected: number) => Math.abs(actual - expected) < 0.01
        return {
          width: near(inner.width / outer.width, (1920 * scale) / width),
          height: near(inner.height / outer.height, (1080 * scale) / height),
          centered: Math.abs(inner.top - outer.top - (outer.bottom - inner.bottom)) < 1,
        }
      }, placed?.id ?? ''),
    )
    .toEqual({ width: true, height: true, centered: true })

  // 拖一个组件到第一行视频片段后面的空处（离各个吸附点都远）：落在指针的位置
  await side.getByRole('searchbox', { name: '搜索组件' }).fill('')
  const overlay = side.getByRole('group', { name: '测试叠加，4 秒' })
  const row = dialog.getByRole('group', { name: '第 1 行' })
  // 6 秒长、从 0 开始的那个片段量出每秒多少像素
  const sceneBox = await dialog
    .getByRole('group', { name: '第 2 行' })
    .locator('[data-clip-id]')
    .first()
    .boundingBox()
  const lane = await row.boundingBox()
  if (sceneBox === null || lane === null) throw new Error('时间线尚未布局')
  const target = videoSeconds + 2.5
  const dropX = sceneBox.x + (sceneBox.width / 6) * target
  const from = await overlay.boundingBox()
  if (from === null) throw new Error('卡片尚未布局')
  await page.mouse.move(from.x + from.width / 2, from.y + 10)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + 20, { steps: 3 })
  await page.mouse.move(dropX, lane.y + lane.height / 2, { steps: 8 })
  await expect(row.getByTestId('drop-ghost')).toBeVisible()
  const dropped = draftSavedWith(page, (html) => savedComponent(html, '测试叠加') !== null)
  await page.mouse.up()
  const carried = savedComponent(
    ((await dropped).postDataJSON() as { html: string }).html,
    '测试叠加',
  )
  expect(carried).toMatchObject({ component: 'fixture-overlay', duration: 4, track: 0 })
  expect(Math.abs((carried?.start ?? 0) - target)).toBeLessThan(0.1)

  const undone = draftSavedWith(
    page,
    (html) =>
      savedComponent(html, '测试叠加') === null && savedComponent(html, '测试画面') !== null,
  )
  await dialog
    .getByRole('toolbar', { name: '剪辑工具' })
    .getByRole('button', { name: '撤销' })
    .click()
  await undone
})

test('右侧栏：选中组件或块的片段改文字可填项，存下来、预览里看得到；在「时间」里改开始；点空白处回到没有选中，撤销回去', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const dialog = await openWholeFilm(page, panel)
  const inspector = dialog.getByRole('complementary', { name: '属性' })
  await expect(inspector.getByRole('heading', { name: '没有选中' })).toBeVisible()

  const side = dialog.getByRole('complementary', { name: '组件和音频' })
  await side.getByRole('searchbox', { name: '搜索组件' }).fill('可填项')
  const card = side.getByRole('group', { name: '测试可填项，5 秒' })
  const added = draftSavedWith(page, (html) => savedComponent(html, '测试可填项') !== null)
  await card.hover()
  await card.getByRole('button', { name: '加到播放头' }).click()
  const placed = savedComponent(
    ((await added).postDataJSON() as { html: string }).html,
    '测试可填项',
  )
  expect(placed).toMatchObject({ component: 'fixture-fields', start: 0, values: {} })

  const row = dialog.getByRole('group', { name: '第 1 行' })
  await row.getByRole('button', { name: /^选中：测试可填项，/ }).click()
  await expect(inspector.getByRole('heading', { name: '测试可填项' })).toBeVisible()
  await expect(inspector.getByRole('button', { name: '内容' })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  const text = inspector.getByRole('textbox', { name: '文字' })
  await expect(text).toHaveValue('示例文字')

  // 分两下输入，中间停过提交的时间：预览换了一份，焦点还在框里
  await text.fill('新的')
  await page.waitForTimeout(600)
  const renamed = draftSavedWith(
    page,
    (html) => savedComponent(html, '测试可填项')?.values['text'] === '新的标题',
  )
  await text.pressSequentially('标题')
  await renamed
  await expect(text).toBeFocused()
  const player = await readyPlayer(dialog)
  await expect
    .poll(() =>
      player.evaluate((element: HTMLElement & { iframeElement: HTMLIFrameElement }, id) => {
        const host = element.iframeElement.contentDocument?.getElementById(id)
        return host?.querySelector('.ff-text')?.textContent ?? null
      }, placed?.id ?? ''),
    )
    .toBe('新的标题')

  await inspector.getByRole('button', { name: /^时间/ }).click()
  const start = inspector.getByRole('textbox', { name: '开始' })
  await expect(start).toHaveValue('0.00')
  const moved = draftSavedWith(page, (html) => savedComponent(html, '测试可填项')?.start === 2)
  await start.fill('2')
  await start.press('Enter')
  await moved
  await expect(start).toHaveValue('2.00')

  const lane = await row.boundingBox()
  if (lane === null) throw new Error('时间线尚未布局')
  await page.mouse.click(lane.x + 6, lane.y + lane.height / 2)
  await expect(inspector.getByRole('heading', { name: '没有选中' })).toBeVisible()

  const undone = draftSavedWith(page, (html) => savedComponent(html, '测试可填项')?.start === 0)
  await dialog
    .getByRole('toolbar', { name: '剪辑工具' })
    .getByRole('button', { name: '撤销' })
    .click()
  await undone
})

/** 存下来的成片里的音频片段，写成「名字@行号 起点 时长」，按起点排。 */
const savedAudio = (html: string) =>
  [...html.matchAll(/<audio [^>]*>/g)]
    .map(([tag]) => {
      const attribute = (name: string) => new RegExp(` ${name}="([^"]*)"`).exec(tag)?.[1]
      return {
        label: attribute('data-label'),
        start: Number(attribute('data-start')),
        duration: Number(attribute('data-duration')),
        track: Number(attribute('data-track-index')),
      }
    })
    .toSorted((left, right) => left.start - right.start)

test('音频栏：试听只播一条，右键加到播放头新开声音行、成片变长，拖一条到声音行的空处，生成一条音乐，撤销回去', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const dialog = await openWholeFilm(page, panel)
  const first = draftSaved(page, 1)
  await dialog
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^生成 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  const { html: withVideo } = (await first).postDataJSON() as { html: string }
  const videoSeconds = Number(/<video [^>]*data-duration="([^"]+)"/.exec(withVideo)?.[1])
  const progress = dialog
    .getByRole('group', { name: '播放控制' })
    .getByRole('slider', { name: '播放进度' })
  await expect(progress).toHaveAttribute('aria-valuetext', /^00:00\.00 \/ 00:0\d\.\d\d$/)

  const side = dialog.getByRole('complementary', { name: '组件和音频' })
  await side.getByRole('tab', { name: '音频' }).click()
  const list = side.getByRole('list', { name: '音频' })
  const guitar = list.getByRole('listitem').filter({ hasText: '轻快原声吉他，适合秋季穿搭' })
  const uploaded = list.getByRole('listitem').filter({ hasText: /^上传的音乐 · / })
  await expect(guitar).toContainText('00:30')
  // 上传的音频记录上没有时长，读完文件才显示
  await expect(uploaded).toContainText('00:30')

  await guitar.getByRole('button', { name: /^试听：/ }).click()
  await expect(guitar.getByRole('button', { name: /^暂停试听：/ })).toBeVisible()
  await uploaded.getByRole('button', { name: /^试听：/ }).click()
  await expect(uploaded.getByRole('button', { name: /^暂停试听：/ })).toBeVisible()
  await expect(guitar.getByRole('button', { name: /^试听：/ })).toBeVisible()
  await uploaded.getByRole('button', { name: /^暂停试听：/ }).click()
  await expect(list.getByRole('button', { name: /^暂停试听：/ })).toHaveCount(0)

  // 播放头挪到 1 秒；还没有声音行，加进来的音频在画面行下面新开一行
  await dialog.evaluate((element: HTMLElement) => element.focus())
  await page.keyboard.press('Shift+ArrowRight')
  await expect(progress).toHaveAttribute('aria-valuetext', /^00:01\.00 \//)
  const added = draftSavedWith(page, (html) => savedAudio(html).length === 1)
  await guitar
    .getByRole('button', { name: '轻快原声吉他，适合秋季穿搭', exact: true })
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: '加到播放头' }).click()
  expect(savedAudio(((await added).postDataJSON() as { html: string }).html)).toEqual([
    { label: '轻快原声吉他，适合秋季穿搭', start: 1, duration: 30, track: 0 },
  ])
  const soundRow = dialog.getByRole('group', { name: '第 2 行' })
  const music = soundRow.getByRole('group', { name: '轻快原声吉他，适合秋季穿搭，30.0 秒' })
  await expect(music).toBeVisible()
  await expect(guitar).toContainText('00:30 · 已使用')
  await expect(progress).toHaveAttribute('aria-valuetext', '00:01.00 / 00:31.00')
  expect(videoSeconds).toBeLessThan(31)

  // 点「已使用」的那一行：选中它对应的片段
  await guitar.getByRole('button', { name: '轻快原声吉他，适合秋季穿搭，已使用' }).click()
  await expect(music.getByRole('button', { name: /^选中：/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  // 拖上传的那条到声音行里这个片段后面的空处：吸到它的结尾
  const box = await music.boundingBox()
  const lane = await soundRow.boundingBox()
  const from = await uploaded.boundingBox()
  if (box === null || lane === null || from === null) throw new Error('尚未布局')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 3 })
  await page.mouse.move(box.x + box.width + 4, lane.y + lane.height / 2, { steps: 8 })
  await expect(soundRow.getByTestId('drop-ghost')).toBeVisible()
  const dropped = draftSavedWith(page, (html) => savedAudio(html).length === 2)
  await page.mouse.up()
  const both = savedAudio(((await dropped).postDataJSON() as { html: string }).html)
  expect(both.map(({ start, duration, track }) => ({ start, duration, track }))).toEqual([
    { start: 1, duration: 30, track: 0 },
    { start: 31, duration: 30, track: 0 },
  ])
  expect(both[1]?.label).toMatch(/^上传的音乐 · /)
  await expect(dialog.getByRole('group', { name: '第 3 行' })).toHaveCount(0)
  await expect(progress).toHaveAttribute('aria-valuetext', '00:01.00 / 01:01.00')

  // 生成一条音乐：先是生成中，生成完能试听
  await side.getByRole('button', { name: '生成音乐' }).click()
  const popover = page.getByRole('dialog', { name: '生成音乐' })
  await popover.getByRole('textbox', { name: '音乐描述' }).fill('雨夜爵士钢琴')
  await popover.getByRole('button', { name: '生成音乐' }).click()
  await expect(popover).toBeHidden()
  const jazz = list.getByRole('listitem').filter({ hasText: '雨夜爵士钢琴' })
  await expect(jazz.getByRole('img', { name: '生成中' })).toBeVisible()
  await expect(jazz.getByRole('button', { name: '试听：雨夜爵士钢琴' })).toBeVisible({
    timeout: 15_000,
  })

  const undone = draftSavedWith(page, (html) => savedAudio(html).length === 1)
  await dialog
    .getByRole('toolbar', { name: '剪辑工具' })
    .getByRole('button', { name: '撤销' })
    .click()
  expect(savedAudio(((await undone).postDataJSON() as { html: string }).html)).toEqual([
    { label: '轻快原声吉他，适合秋季穿搭', start: 1, duration: 30, track: 0 },
  ])
  await expect(uploaded).not.toContainText('已使用')
})

/** 存下来的成片里第一个 `tag` 片段上的属性 `name`；不写值的属性是空串，没有这个属性时是 undefined。 */
const savedAttribute = (html: string, tag: 'video' | 'audio', name: string) => {
  const element = new RegExp(`<${tag} [^>]*>`).exec(html)?.[0] ?? ''
  const found = new RegExp(` ${name}(?:="([^"]*)")?(?=[ >])`).exec(element)
  return found === null ? undefined : (found[1] ?? '')
}

test('右侧栏「媒体」：音频片段拉满增益、打开循环写进文件；视频片段调成 2 倍速，片段长不变、能拉到的最长减半', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const dialog = await openWholeFilm(page, panel)
  const inspector = dialog.getByRole('complementary', { name: '属性' })
  const first = draftSaved(page, 1)
  const materials = dialog
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
  await materials.getByRole('button', { name: /^生成 A 镜头 1，/ }).click()
  await page.keyboard.press('Enter')
  await first

  // 音频加到播放头（0 秒），在画面行下面新开一行
  const side = dialog.getByRole('complementary', { name: '组件和音频' })
  await side.getByRole('tab', { name: '音频' }).click()
  const added = draftSavedWith(page, (html) => savedAudio(html).length === 1)
  await side
    .getByRole('list', { name: '音频' })
    .getByRole('button', { name: '轻快原声吉他，适合秋季穿搭', exact: true })
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: '加到播放头' }).click()
  await added

  await dialog
    .getByRole('group', { name: '第 2 行' })
    .getByRole('button', { name: /^选中：轻快原声吉他/ })
    .click()
  await inspector.getByRole('button', { name: /^媒体/ }).click()
  await expect(inspector.getByText('轻快原声吉他，适合秋季穿搭', { exact: true })).toHaveCount(2)
  const louder = draftSavedWith(
    page,
    (html) => savedAttribute(html, 'audio', 'data-volume') === '3.981072',
  )
  await inspector.getByRole('slider', { name: '增益' }).press('End')
  await louder
  await expect(inspector.getByRole('slider', { name: '增益' })).toHaveAttribute(
    'aria-valuetext',
    '+12.0 dB',
  )
  const looped = draftSavedWith(page, (html) => savedAttribute(html, 'audio', 'loop') === 'true')
  await inspector.getByRole('switch', { name: '循环' }).click()
  await looped

  // 视频片段（选中后展开的是「时间」）：先把时长拉到素材能放的最长
  await dialog
    .getByRole('group', { name: '第 1 行' })
    .getByRole('button', { name: /^选中：A · / })
    .click()
  const length = inspector.getByRole('textbox', { name: '时长' })
  const setLength = async (seconds: string) => {
    await length.fill(seconds)
    await length.press('Enter')
  }
  await setLength('999')
  const longest = Number(await length.inputValue())
  expect(longest).toBeGreaterThan(1)

  await inspector.getByRole('button', { name: /^媒体/ }).click()
  const faster = draftSavedWith(
    page,
    (html) => savedAttribute(html, 'video', 'data-playback-rate') === '2',
  )
  await inspector.getByRole('button', { name: /^速度 1x/ }).click()
  await inspector.getByRole('textbox', { name: '速度' }).fill('2')
  await inspector.getByRole('textbox', { name: '速度' }).press('Enter')
  const html = ((await faster).postDataJSON() as { html: string }).html
  expect(Number(savedAttribute(html, 'video', 'data-duration'))).toBeCloseTo(longest, 2)

  // 收短再拉长：2 倍速时素材剩下的那段只够放原来的一半
  await inspector.getByRole('button', { name: /^时间/ }).click()
  await setLength('1')
  await expect(length).toHaveValue('1.00')
  await setLength('999')
  await expect.poll(async () => Number(await length.inputValue())).toBeCloseTo(longest / 2, 1)
})

test('成片编辑器在窄屏上纵向排开', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const panel = await openConversation(page, '夜景延时素材生成', { mobile: true })
  const dialog = await openWholeFilm(page, panel)
  await expect(dialog.getByRole('region', { name: '视频素材区' })).toBeVisible()
  // 右侧栏接在时间线下面，按内容高，不被挤成看不见
  const inspector = dialog.getByRole('complementary', { name: '属性' })
  await inspector.scrollIntoViewIfNeeded()
  await expect(inspector.getByRole('heading', { name: '没有选中' })).toBeVisible()
  expect((await inspector.boundingBox())?.height ?? 0).toBeGreaterThan(80)
})
