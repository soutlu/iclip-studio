import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { screenshotBothThemes } from './helpers'
import { login } from './login'

const SCREENSHOTS = '../.artifacts/design-qa/whole-film-editor/impl-3'

test('治理者上传片尾、改名、停用与恢复；模板参数由服务端返回', async ({ page }) => {
  await page.goto('/')
  await login(page, 'governor')
  await page.getByRole('button', { name: '资料库', exact: true }).click()
  await page.getByRole('tab', { name: '品牌模板', exact: true }).click()
  const main = page.getByRole('main', { name: '品牌模板' })
  await expect(main.getByRole('article', { name: '品牌片头 · 竖版' })).toBeVisible()
  await screenshotBothThemes(page, `${SCREENSHOTS}/brand-templates-desktop`)
  await main.getByRole('button', { name: '上传模板' }).click()
  const dialog = page.getByRole('dialog', { name: '上传品牌模板' })
  await screenshotBothThemes(page, `${SCREENSHOTS}/brand-template-upload-desktop`)
  await dialog.getByLabel('模板名称').fill('秋日品牌片尾')
  await dialog.getByLabel('使用位置').selectOption('outro')
  await dialog
    .getByLabel('模板视频')
    .setInputFiles(
      fileURLToPath(new URL('../src/testing/fixtures/sample-video.mp4', import.meta.url)),
    )
  const posted = page.waitForRequest(
    (request) => request.url().endsWith('/api/brand-templates') && request.method() === 'POST',
  )
  await dialog.getByRole('button', { name: '保存模板' }).click()
  expect((await posted).postDataJSON()).toEqual({
    name: '秋日品牌片尾',
    position: 'outro',
    uploadId: expect.any(String),
  })
  let card = main.getByRole('article', { name: '秋日品牌片尾' })
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: '改名' }).click()
  const rename = page.getByRole('dialog', { name: '修改模板名称' })
  await rename.getByLabel('模板名称').fill('秋季正式片尾')
  await rename.getByRole('button', { name: '保存模板' }).click()
  card = main.getByRole('article', { name: '秋季正式片尾' })
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: '停用', exact: true }).click()
  await expect(card).toHaveCount(0)
  await main.getByRole('checkbox', { name: '显示已停用' }).check()
  await expect(page).toHaveURL(/includeDisabled=true/)
  await expect(card.getByText('已停用', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: '恢复使用' }).click()
  await expect(card.getByRole('button', { name: '停用', exact: true })).toBeVisible()
  await main.getByRole('checkbox', { name: '显示已停用' }).uncheck()
  await main.getByRole('radio', { name: '片尾', exact: true }).click()
  await expect(page).toHaveURL(/position=outro/)
  await expect(card).toBeVisible()
  await expect(main.getByRole('article', { name: '品牌片头 · 竖版' })).toHaveCount(0)
  await main.getByRole('textbox', { name: '搜索品牌模板' }).fill('秋季')
  await expect(page).toHaveURL(/q=/)
  await page.getByRole('button', { name: '需求单', exact: true }).click()
  await page.goBack()
  await expect(main.getByRole('textbox', { name: '搜索品牌模板' })).toHaveValue('秋季')
  await expect(main.getByRole('radio', { name: '片尾', exact: true })).toBeChecked()
})

test('普通读者可预览在用模板，维护入口与停用模板不出现', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await login(page)
  await page.getByRole('button', { name: '资料库', exact: true }).click()
  await page.getByRole('tab', { name: '品牌模板', exact: true }).click()
  const main = page.getByRole('main', { name: '品牌模板' })
  await expect(main.getByRole('article', { name: '品牌片头 · 竖版' })).toBeVisible()
  await expect(main.getByRole('button', { name: '上传模板' })).toHaveCount(0)
  await expect(main.getByRole('button', { name: '改名' })).toHaveCount(0)
  await expect(main.getByRole('checkbox', { name: '显示已停用' })).toHaveCount(0)
  await expect(main.getByRole('article', { name: '旧版片尾' })).toHaveCount(0)
  await screenshotBothThemes(page, `${SCREENSHOTS}/brand-templates-mobile`)
  await main.getByRole('button', { name: '预览模板：品牌片头 · 竖版' }).click()
  await expect(page.getByRole('dialog', { name: '品牌片头 · 竖版' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(main.getByRole('button', { name: '预览模板：品牌片头 · 竖版' })).toBeFocused()
})
