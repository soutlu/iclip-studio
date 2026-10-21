import { expect, test, type Locator } from '@playwright/test'
import { login } from './login'

const showDecodedFrame = async (dialog: Locator) => {
  const video = dialog.locator('video')
  await expect
    .poll(() =>
      video.evaluate(
        (element: HTMLVideoElement) => element.readyState >= 2 && element.videoWidth > 0,
      ),
    )
    .toBe(true)
}

test('资料库成片：最新卡面、详情、下载记素材片、返回与标题筛选', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('button', { name: '资料库', exact: true }).click()
  await page.getByRole('tab', { name: '成片', exact: true }).click()
  await expect(page).toHaveURL(/tab=whole-films/)
  const main = page.getByRole('main', { name: '资料库' })
  const card = main.getByRole('article', { name: '春夏品牌成片' })
  await expect(card.getByText('V2')).toBeVisible()
  // mock 的成片能做高清版：等各档读回来，下载按钮先开菜单。
  const tiers = page.waitForResponse((response) => response.url().includes('/enhancements'))
  await card.getByRole('button', { name: '查看成片：春夏品牌成片' }).click()
  const dialog = page.getByRole('dialog', { name: '春夏品牌成片' })
  await showDecodedFrame(dialog)
  await tiers

  const tracked = page.waitForRequest(
    (request) => request.url().includes('/tracking/events') && request.method() === 'POST',
  )
  const fileSaved = page.waitForEvent('download')
  await dialog.getByRole('button', { name: '下载视频' }).click()
  await page.getByRole('menuitem', { name: '下载成片', exact: true }).click()
  expect((await tracked).postDataJSON()).toMatchObject({ name: 'video.downloaded' })
  expect((await fileSaved).suggestedFilename()).toMatch(/\.mp4$/)
  // 菜单收起后 Esc 才落到详情弹窗上。
  await expect(page.getByRole('menu')).toBeHidden()

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(card.getByRole('button', { name: '查看成片：春夏品牌成片' })).toBeFocused()
  await expect(page).toHaveURL(/tab=whole-films/)
  await main.getByRole('textbox', { name: '搜索成片标题' }).fill('城市')
  await expect(main.getByRole('article')).toHaveCount(1)
  await main.getByRole('button', { name: '查看成片：城市漫步成片' }).click()
  await expect(
    page
      .getByRole('dialog', { name: '城市漫步成片' })
      .getByRole('button', { name: '打开来源任务' }),
  ).toHaveCount(0)
  await page.goBack()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(main.getByRole('textbox', { name: '搜索成片标题' })).toHaveValue('城市')
})

test('移动端成片可查看版本，筛选与页签不撑破视口', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await login(page)
  await page.getByRole('button', { name: '资料库', exact: true }).click()
  await page.getByRole('tab', { name: '成片', exact: true }).click()
  const main = page.getByRole('main', { name: '资料库' })
  await expect(main.getByRole('article', { name: '春夏品牌成片' })).toBeVisible()
  await main.getByRole('button', { name: '查看成片：春夏品牌成片' }).click()
  const dialog = page.getByRole('dialog', { name: '春夏品牌成片' })
  await dialog.getByRole('button', { name: 'V1', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'V1', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true)
  await showDecodedFrame(dialog)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(main.getByRole('textbox', { name: '搜索成片标题' })).toBeVisible()
})
