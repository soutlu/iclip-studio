import { expect, test } from '@playwright/test'
import { openConversation, openStoryboardShot } from './helpers'

// 高清版：分镜舞台的下载菜单里提交一档，菜单不关、那一行原地变成在做，按钮外圈转圈；做好后在哪都弹提示条，
// 按钮上出绿点，打开菜单就消失，从菜单下载高清版并记在成片上。同事做好的那一档菜单里能下载，按钮上不加点。
// mock 的超分约 6 秒做完，经 WebSocket 推状态跳转帧（见 testing/mocks/enhancements.ts）。

test.use({ viewport: { height: 900, width: 1440 } })

/** 演示对话第 2 组那条 480p 的成片：1080p、720p 两档都能做，同事已经做好了 720p。 */
const TAKE = '5b2f3071-0b2f-4d30-8d9c-2e3f4a5b6c7d'

test('高清版：舞台菜单里生成 1080p，做好出点、打开菜单点消失，下载记在成片上', async ({ page }) => {
  const panel = await openConversation(page, '夜景延时素材生成')
  await openStoryboardShot(panel, 2)
  const group = panel.getByRole('region', { name: '镜头组 2' })
  const takes = group.getByRole('region', { name: '本组成片', exact: true })
  const tiers = page.waitForResponse((response) =>
    response.url().includes(`/generations/${TAKE}/enhancements`),
  )
  await takes.getByRole('button', { name: /的成片$/ }).click({ timeout: 20_000 })
  await tiers

  const download = group.getByRole('button', { name: '下载视频', exact: true })
  const ring = download.locator('[data-enhance-ring]')
  const dot = download.locator('[data-enhance-dot]')
  // 同事做好的 720p 不加点。
  await expect(download).not.toHaveAccessibleDescription(/高清版/)
  await expect(dot).toHaveCount(0)
  await download.click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: '下载高清版 720p' })).toBeVisible()
  await menu.getByRole('menuitem', { name: /^生成高清版 1080p/ }).click()
  // 菜单不关，那一行原地变成在做、点不了。
  const running = menu.getByRole('menuitem', { name: /^正在生成高清版 1080p/ })
  await expect(running).toBeVisible()
  await expect(running).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(download).toHaveAccessibleDescription('高清版正在生成')
  await expect(ring).toBeVisible()
  await expect(dot).toHaveCount(0)

  // 做好了：提示条弹出，外圈停下，右上角出绿点。
  await expect(page.getByText('第 2 组的高清版 1080p 已生成')).toBeVisible({ timeout: 15_000 })
  await expect(download).toHaveAccessibleDescription('高清版已生成')
  await expect(dot).toHaveAttribute('data-enhance-dot', 'done')
  await expect(ring).toHaveCount(0)

  // 打开菜单就算看过，点消失；那一档在菜单里可以下载。
  await download.click()
  await expect(menu.getByRole('menuitem', { name: '下载高清版 1080p' })).toBeVisible()
  const tracked = page.waitForRequest(
    (request) => request.url().includes('/tracking/events') && request.method() === 'POST',
  )
  const saved = page.waitForEvent('download')
  await menu.getByRole('menuitem', { name: '下载高清版 1080p' }).click()
  expect((await tracked).postDataJSON()).toEqual({ jobId: TAKE, name: 'video.downloaded' })
  expect((await saved).suggestedFilename()).toMatch(/\.mp4$/)
  await expect(menu).toBeHidden()
  await expect(download).not.toHaveAccessibleDescription(/高清版/)
  await expect(dot).toHaveCount(0)
})
