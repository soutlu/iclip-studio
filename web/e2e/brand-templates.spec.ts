import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { screenshotBothThemes } from './helpers'
import { login } from './login'

const SCREENSHOTS = '../.artifacts/design-qa/brand-font-editor/library'

test('治理者上传片尾、编辑、停用与恢复；模板参数由服务端返回', async ({ page }) => {
  await page.goto('/')
  await login(page, 'governor')
  await page.getByRole('button', { name: '资料库', exact: true }).click()
  await page.getByRole('tab', { name: '品牌模板', exact: true }).click()
  const main = page.getByRole('main', { name: '品牌模板' })
  await expect(main.getByRole('article', { name: '品牌片头 · 竖版' })).toBeVisible()
  await expect(main.getByRole('article', { name: '示例字体' }).getByText('Aa')).toBeVisible()
  await screenshotBothThemes(page, `${SCREENSHOTS}/brand-templates-desktop`)
  await main.getByRole('button', { name: '上传资源' }).click()
  const dialog = page.getByRole('dialog', { name: '上传品牌资源' })
  await screenshotBothThemes(page, `${SCREENSHOTS}/brand-template-upload-desktop`)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(main.getByRole('button', { name: '上传资源' })).toBeFocused()
  await main.getByRole('button', { name: '上传资源' }).click()
  await dialog.getByLabel('名称').fill('秋日品牌片尾')
  await dialog.getByLabel('品牌').fill('秋日')
  await dialog.getByLabel('类型').selectOption('outro')
  await dialog
    .getByLabel('资源文件')
    .setInputFiles(
      fileURLToPath(new URL('../src/testing/fixtures/sample-video.mp4', import.meta.url)),
    )
  const posted = page.waitForRequest(
    (request) => request.url().endsWith('/api/brand-templates') && request.method() === 'POST',
  )
  await dialog.getByRole('button', { name: '保存资源' }).click()
  expect((await posted).postDataJSON()).toEqual({
    name: '秋日品牌片尾',
    brand: '秋日',
    kind: 'outro',
    uploadId: expect.any(String),
  })
  let card = main.getByRole('article', { name: '秋日品牌片尾' })
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: '编辑' }).click()
  const rename = page.getByRole('dialog', { name: '编辑品牌资源' })
  await rename.getByLabel('名称').fill('秋季正式片尾')
  await rename.getByRole('button', { name: '保存资源' }).click()
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
  await main.getByRole('combobox', { name: '筛选品牌' }).selectOption('秋日')
  await expect.poll(() => new URL(page.url()).searchParams.get('brand')).toBe('秋日')
  await main.getByRole('radio', { name: '片尾', exact: true }).click()
  await expect(page).toHaveURL(/kind=outro/)
  await expect(card).toBeVisible()
  await expect(main.getByRole('article', { name: '品牌片头 · 竖版' })).toHaveCount(0)
  await main.getByRole('textbox', { name: '搜索品牌资源' }).fill('秋季')
  await expect(page).toHaveURL(/q=/)
  await page.getByRole('button', { name: '需求单', exact: true }).click()
  await page.goBack()
  await expect(main.getByRole('textbox', { name: '搜索品牌资源' })).toHaveValue('秋季')
  await expect(main.getByRole('radio', { name: '片尾', exact: true })).toBeChecked()
  await expect(main.getByRole('combobox', { name: '筛选品牌' })).toHaveValue('秋日')
})

test('普通读者可预览在用模板，维护入口与停用模板不出现', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await login(page)
  await page.getByRole('button', { name: '资料库', exact: true }).click()
  await page.getByRole('tab', { name: '品牌模板', exact: true }).click()
  const main = page.getByRole('main', { name: '品牌模板' })
  await expect(main.getByRole('article', { name: '品牌片头 · 竖版' })).toBeVisible()
  await expect(main.getByRole('button', { name: '上传资源' })).toHaveCount(0)
  await expect(main.getByRole('button', { name: '编辑' })).toHaveCount(0)
  await expect(main.getByRole('checkbox', { name: '显示已停用' })).toHaveCount(0)
  await expect(main.getByRole('article', { name: '旧版片尾' })).toHaveCount(0)
  await expect(main.getByRole('article', { name: '示例字体' }).getByText('Aa')).toBeVisible()
  await screenshotBothThemes(page, `${SCREENSHOTS}/brand-templates-mobile`)
  await main.getByRole('button', { name: '预览资源：品牌片头 · 竖版' }).click()
  await expect(page.getByRole('dialog', { name: '品牌片头 · 竖版' })).toBeVisible()
  const video = page.getByRole('dialog', { name: '品牌片头 · 竖版' }).locator('video')
  await expect
    .poll(() =>
      video.evaluate((media: HTMLVideoElement) => media.readyState >= 2 && media.videoWidth > 0),
    )
    .toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(main.getByRole('button', { name: '预览资源：品牌片头 · 竖版' })).toBeFocused()
})

test('治理者上传真实字体后可预览，字体缺字不会静默切换为系统字体', async ({ page }) => {
  await page.goto('/')
  await login(page, 'governor')
  await page.getByRole('button', { name: '资料库', exact: true }).click()
  await page.getByRole('tab', { name: '品牌模板', exact: true }).click()
  const main = page.getByRole('main', { name: '品牌模板' })
  await main.getByRole('button', { name: '上传资源' }).click()
  const upload = page.getByRole('dialog', { name: '上传品牌资源' })
  await expect(upload.getByLabel('类型')).toHaveValue('font')
  await upload.getByLabel('名称').fill('秋日字体')
  await upload.getByLabel('品牌').fill('秋日')
  await upload
    .getByLabel('资源文件')
    .setInputFiles(
      fileURLToPath(new URL('../src/testing/fixtures/sample-font.otf', import.meta.url)),
    )
  await upload.getByRole('button', { name: '保存资源' }).click()
  const card = main.getByRole('article', { name: '秋日字体' })
  await expect(card.getByText('Aa')).toBeVisible()
  await card.getByRole('button', { name: '预览资源：秋日字体' }).click()
  const preview = page.getByRole('dialog', { name: '秋日字体' })
  const text = preview.getByText('Made for your next adventure.', { exact: true })
  await expect(text).toBeVisible()
  await expect
    .poll(() =>
      text.evaluate((element) => {
        const style = getComputedStyle(element)
        return (
          Array.from(document.fonts).some(
            (face) => face.status === 'loaded' && style.fontFamily.includes(face.family),
          ) &&
          document.fonts.check(
            `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
            element.textContent ?? '',
          )
        )
      }),
    )
    .toBe(true)
  await expect(page.getByText('品牌资源已创建', { exact: true })).toBeHidden({ timeout: 10_000 })
  await screenshotBothThemes(page, `${SCREENSHOTS}/brand-font-preview-desktop`)
  await preview.getByRole('textbox', { name: '预览文字' }).fill('𰻞')
  await expect(preview.getByRole('alert')).toContainText('所选字体不包含部分文字')
  await expect(preview.getByText('𰻞', { exact: true })).toHaveCount(0)
  await preview.getByRole('textbox', { name: '预览文字' }).fill('Made for your next adventure.')
  await expect(text).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await screenshotBothThemes(page, `${SCREENSHOTS}/brand-font-preview-mobile`)
  await page.keyboard.press('Escape')
  await expect(preview).toHaveCount(0)
  await expect(card.getByRole('button', { name: '预览资源：秋日字体' })).toBeFocused()
})
