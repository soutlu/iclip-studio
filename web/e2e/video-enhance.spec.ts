import { expect, test } from '@playwright/test'
import { openConversation, openStoryboardShot } from './helpers'

test.use({ viewport: { height: 900, width: 1440 } })

const TAKE = '5b2f3071-0b2f-4d30-8d9c-2e3f4a5b6c7d'

test('高清版：舞台菜单里生成 1080p，做好出点、打开菜单点消失，下载记在高清版上', async ({
  page,
}) => {
  const panel = await openConversation(page, '夜景延时素材生成')
  await openStoryboardShot(panel, 2)
  const group = panel.getByRole('region', { name: '镜头组 2' })
  const takes = group.getByRole('region', { name: '本组素材片', exact: true })
  const tiers = page.waitForResponse((response) =>
    response.url().includes(`/generations/${TAKE}/enhancements`),
  )
  await takes.getByRole('button', { name: /的素材片$/ }).click({ timeout: 20_000 })
  await tiers

  const download = group.getByRole('button', { name: '下载视频', exact: true })
  const ring = download.locator('[data-enhance-ring]')
  const dot = download.locator('[data-enhance-dot]')
  await expect(download).not.toHaveAccessibleDescription(/高清版/)
  await expect(dot).toHaveCount(0)
  await download.click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: '下载高清版 720p' })).toBeVisible()
  const submitted = page.waitForResponse(
    (response) =>
      response.url().includes('/generations/video-enhancements') &&
      response.request().method() === 'POST',
  )
  await menu.getByRole('menuitem', { name: /^生成高清版 1080p/ }).click()
  const { generation } = (await (await submitted).json()) as { generation: { id: string } }
  const running = menu.getByRole('menuitem', { name: /^正在生成高清版 1080p/ })
  await expect(running).toBeVisible()
  await expect(running).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(download).toHaveAccessibleDescription('高清版正在生成')
  await expect(ring).toBeVisible()
  await expect(dot).toHaveCount(0)

  await expect(page.getByText('第 2 组的高清版 1080p 已生成')).toBeVisible({ timeout: 15_000 })
  await expect(download).toHaveAccessibleDescription('高清版已生成')
  await expect(dot).toHaveAttribute('data-enhance-dot', 'done')
  await expect(ring).toHaveCount(0)

  await download.click()
  await expect(menu.getByRole('menuitem', { name: '下载高清版 1080p' })).toBeVisible()
  const tracked = page.waitForRequest(
    (request) => request.url().includes('/tracking/events') && request.method() === 'POST',
  )
  const saved = page.waitForEvent('download')
  await menu.getByRole('menuitem', { name: '下载高清版 1080p' }).click()
  expect((await tracked).postDataJSON()).toEqual({
    jobId: generation.id,
    name: 'video.downloaded',
  })
  expect((await saved).suggestedFilename()).toMatch(/\.mp4$/)
  await expect(menu).toBeHidden()
  await expect(download).not.toHaveAccessibleDescription(/高清版/)
  await expect(dot).toHaveCount(0)
})
