import { expect, test } from '@playwright/test'
import { openConversation, openStoryboardShot } from './helpers'

// 高清版：分镜舞台的下载菜单里提交一档，菜单不关、那一行原地变成在做；做好后在哪都弹提示条，点「下载」取高清版并记在成片上。
// mock 的超分约 6 秒做完，经 WebSocket 推状态跳转帧（见 testing/mocks/enhancements.ts）。

test.use({ viewport: { height: 900, width: 1440 } })

/** 演示对话第 2 组那条 480p 的成片：1080p、720p 两档都能做。 */
const TAKE = '5b2f3071-0b2f-4d30-8d9c-2e3f4a5b6c7d'

test('高清版：舞台菜单里生成 1080p，做好后提示条下载，下载记在成片上', async ({ page }) => {
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
  await expect(download).not.toHaveAccessibleDescription(/高清版/)
  await download.click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: /^生成高清版 720p/ })).toBeVisible()
  await menu.getByRole('menuitem', { name: /^生成高清版 1080p/ }).click()
  // 菜单不关，那一行原地变成在做、点不了。
  const running = menu.getByRole('menuitem', { name: /^正在生成高清版 1080p/ })
  await expect(running).toBeVisible()
  await expect(running).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(download).toHaveAccessibleDescription('高清版正在生成')

  await expect(page.getByText('第 2 组的高清版 1080p 已生成')).toBeVisible({ timeout: 15_000 })
  const tracked = page.waitForRequest(
    (request) => request.url().includes('/tracking/events') && request.method() === 'POST',
  )
  const saved = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载', exact: true }).click()
  expect((await tracked).postDataJSON()).toEqual({ jobId: TAKE, name: 'video.downloaded' })
  expect((await saved).suggestedFilename()).toMatch(/\.mp4$/)

  // 做好不留点；菜单里那一档已经是「下载高清版」。
  await expect(download).not.toHaveAccessibleDescription(/高清版/)
  await download.click()
  await expect(menu.getByRole('menuitem', { name: '下载高清版 1080p' })).toBeVisible()
})
