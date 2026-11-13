import { expect, test, type Locator, type Page } from '@playwright/test'
import { openConversation } from './helpers'

const openWholeFilm = async (page: Page, panel: Locator) => {
  await panel.getByRole('button', { name: '成片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '夜景延时素材生成' })
  await expect(dialog).toBeVisible()
  await expect(page).toHaveURL(/[?&]wholeFilm=true/)
  return dialog
}

const draftSaved = (page: Page, blocks: number) =>
  page.waitForRequest(
    (request) =>
      request.method() === 'PUT' &&
      request.url().includes('/whole-film/draft') &&
      ((request.postDataJSON() as { html: string }).html.match(/<video /g) ?? []).length === blocks,
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

  // 缩放：放大一档块变宽一倍，读数从「适应」变成百分比；点「适应宽度」回去
  const block = dialog.getByRole('group', { name: '第 1 行' }).locator('[data-block-id]').first()
  const widthOf = async () => (await block.boundingBox())?.width ?? 0
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

  // 关掉缩略图：块上不画画面，只剩名字和声音
  await expect(block.locator('.wf-clip-frames')).toBeVisible()
  await toolbar.getByRole('button', { name: '显示缩略图' }).click()
  await expect(block.locator('.wf-clip-frames')).toBeHidden()
  await expect(block.locator('.wf-clip-label')).toBeVisible()
  await toolbar.getByRole('button', { name: '显示缩略图' }).click()
  await expect(block.locator('.wf-clip-frames')).toBeVisible()

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

test('成片编辑器在窄屏上纵向排开', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const panel = await openConversation(page, '夜景延时素材生成', { mobile: true })
  const dialog = await openWholeFilm(page, panel)
  await expect(dialog.getByRole('region', { name: '视频素材区' })).toBeVisible()
})
