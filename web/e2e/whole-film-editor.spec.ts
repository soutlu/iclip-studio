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
  await expect(dialog.getByText('成片里还没有画面；加入素材片后可以在这里预览')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '导出', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  )

  const materials = dialog
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
  const first = draftSaved(page, 1)
  await materials.getByRole('button', { name: /^生成 A 镜头 1，/ }).click()
  await toolbar.getByRole('button', { name: '加入成片' }).click()
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
  await transport.getByRole('button', { name: '播放' }).click()
  await expect(transport.getByRole('button', { name: '暂停' })).toBeVisible()
  await expect.poll(playerTime).toBeGreaterThan(0.2)
  await transport.getByRole('button', { name: '暂停' }).click()

  await transport.getByRole('slider', { name: '播放进度' }).focus()
  await page.keyboard.press('Home')
  await expect(transport.locator('.wf-clock')).toContainText('00:00.00 /')
  await expect.poll(playerTime).toBeLessThan(0.1)

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

test('成片编辑器在窄屏上纵向排开', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const panel = await openConversation(page, '夜景延时素材生成', { mobile: true })
  const dialog = await openWholeFilm(page, panel)
  await expect(dialog.getByRole('region', { name: '视频素材区' })).toBeVisible()
})
