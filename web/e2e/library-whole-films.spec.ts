import { expect, test, type Locator } from '@playwright/test'
import { screenshotBothThemes } from './helpers'
import { login } from './login'

const SCREENSHOTS = '../.artifacts/design-qa/whole-film-editor/impl-3'

/** 截图前确认选中版本已解码且能真实播放，再暂停在已显示的画面上。 */
const showDecodedFrame = async (dialog: Locator) => {
  const video = dialog.locator('video')
  await expect
    .poll(() =>
      video.evaluate(
        (element: HTMLVideoElement) => element.readyState >= 2 && element.videoWidth > 0,
      ),
    )
    .toBe(true)
  if (await video.evaluate((element: HTMLVideoElement) => element.paused))
    await dialog.getByRole('button', { name: '播放', exact: true }).click()
  const initialTime = await video.evaluate((element: HTMLVideoElement) => element.currentTime)
  await expect
    .poll(() =>
      video.evaluate(
        (element: HTMLVideoElement, from) =>
          !element.paused && Math.abs(element.currentTime - from) > 0.1,
        initialTime,
      ),
    )
    .toBe(true)
  await dialog.getByRole('button', { name: '暂停', exact: true }).click()
}

test('资料库整片：最新卡面、版本切换、下载埋点、返回与标题筛选', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('button', { name: '资料库', exact: true }).click()
  await page.getByRole('tab', { name: '整片', exact: true }).click()
  const main = page.getByRole('main', { name: '整片资料库' })
  const card = main.getByRole('article', { name: '春夏品牌整片' })
  await expect(card.getByText('V2')).toBeVisible()
  await expect(main.getByRole('radio', { name: '横版' })).toHaveCount(0)
  await screenshotBothThemes(page, `${SCREENSHOTS}/library-films-desktop`)
  await card.getByRole('button', { name: '查看整片：春夏品牌整片' }).click()
  const dialog = page.getByRole('dialog', { name: '春夏品牌整片' })
  await expect(dialog.getByRole('button', { name: 'V2' })).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog.getByRole('button', { name: '做同款' })).toHaveCount(0)
  await expect(dialog.getByText('脚本', { exact: true })).toHaveCount(0)
  await showDecodedFrame(dialog)
  await screenshotBothThemes(page, `${SCREENSHOTS}/library-film-viewer-desktop`)
  await dialog.getByRole('button', { name: 'V1', exact: true }).click()
  const tracked = page.waitForRequest(
    (request) => request.url().endsWith('/tracking/events') && request.method() === 'POST',
  )
  const downloaded = page.waitForEvent('download')
  await dialog.getByRole('button', { name: '下载视频' }).click()
  expect((await tracked).postDataJSON()).toEqual({
    name: 'video.downloaded',
    jobId: 'fa000001-0000-4000-8000-000000000001',
  })
  await downloaded
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(card.getByRole('button', { name: '查看整片：春夏品牌整片' })).toBeFocused()
  await expect(page).toHaveURL(/tab=whole-films/)
  await main.getByRole('textbox', { name: '搜索整片标题' }).fill('城市')
  await expect(main.getByRole('article')).toHaveCount(1)
  await main.getByRole('button', { name: '查看整片：城市漫步整片' }).click()
  await expect(
    page
      .getByRole('dialog', { name: '城市漫步整片' })
      .getByRole('button', { name: '打开来源任务' }),
  ).toHaveCount(0)
  await page.goBack()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(main.getByRole('textbox', { name: '搜索整片标题' })).toHaveValue('城市')
})

test('移动端整片可查看版本，筛选与页签不撑破视口', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await login(page)
  await page.getByRole('button', { name: '资料库', exact: true }).click()
  await page.getByRole('tab', { name: '整片', exact: true }).click()
  const main = page.getByRole('main', { name: '整片资料库' })
  await expect(main.getByRole('article', { name: '春夏品牌整片' })).toBeVisible()
  await screenshotBothThemes(page, `${SCREENSHOTS}/library-films-mobile`)
  await main.getByRole('button', { name: '查看整片：春夏品牌整片' }).click()
  const dialog = page.getByRole('dialog', { name: '春夏品牌整片' })
  await dialog.getByRole('button', { name: 'V1', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'V1', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true)
  await showDecodedFrame(dialog)
  await screenshotBothThemes(page, `${SCREENSHOTS}/library-film-viewer-mobile`)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(main.getByRole('textbox', { name: '搜索整片标题' })).toBeVisible()
})
