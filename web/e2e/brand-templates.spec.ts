import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { login } from './login'

test('治理者编辑、停用与恢复字体；筛选留在地址里', async ({ page }) => {
  await page.goto('/')
  await login(page, 'governor')
  await page.getByRole('button', { name: '资料库', exact: true }).click()
  await page.getByRole('tab', { name: '品牌模板', exact: true }).click()
  const main = page.getByRole('main', { name: '品牌模板' })
  await expect(main.getByRole('article', { name: '示例字体' }).getByText('Aa')).toBeVisible()

  let card = main.getByRole('article', { name: '品牌标题字体' })
  await card.getByRole('button', { name: '编辑' }).click()
  const rename = page.getByRole('dialog', { name: '编辑字体' })
  await rename.getByLabel('名称').fill('秋季标题字体')
  await rename.getByRole('button', { name: '保存字体' }).click()
  card = main.getByRole('article', { name: '秋季标题字体' })
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: '停用', exact: true }).click()
  await expect(card).toHaveCount(0)
  await main.getByRole('checkbox', { name: '显示已停用字体' }).check()
  await expect(page).toHaveURL(/includeDisabled=true/)
  await expect(card.getByText('已停用', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: '恢复使用' }).click()
  await expect(card.getByRole('button', { name: '停用', exact: true })).toBeVisible()
  await main.getByRole('checkbox', { name: '显示已停用字体' }).uncheck()

  await main.getByRole('combobox', { name: '筛选品牌' }).selectOption('示例品牌')
  await expect.poll(() => new URL(page.url()).searchParams.get('brand')).toBe('示例品牌')
  await expect(main.getByRole('article', { name: '示例字体' })).toHaveCount(0)
  await main.getByRole('textbox', { name: '搜索字体' }).fill('秋季')
  await expect(page).toHaveURL(/q=/)
  await expect(card).toBeVisible()
  await page.getByRole('button', { name: '需求单', exact: true }).click()
  await page.goBack()
  await expect(main.getByRole('textbox', { name: '搜索字体' })).toHaveValue('秋季')
  await expect(main.getByRole('combobox', { name: '筛选品牌' })).toHaveValue('示例品牌')
})

test('普通读者在手机上查看并预览字体', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await login(page)
  await page.getByRole('button', { name: '资料库', exact: true }).click()
  await page.getByRole('tab', { name: '品牌模板', exact: true }).click()
  const main = page.getByRole('main', { name: '品牌模板' })
  const font = main.getByRole('article', { name: '示例字体' })
  await expect(font.getByText('Aa')).toBeVisible()
  await expect(font.getByRole('button', { name: '编辑' })).toHaveCount(0)
  await main.getByRole('button', { name: '预览字体：示例字体' }).click()
  await expect(page.getByRole('dialog', { name: '示例字体' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(main.getByRole('button', { name: '预览字体：示例字体' })).toBeFocused()
})

test('治理者上传真实字体后可预览，字体缺字不会静默切换为系统字体', async ({ page }) => {
  await page.goto('/')
  await login(page, 'governor')
  await page.getByRole('button', { name: '资料库', exact: true }).click()
  await page.getByRole('tab', { name: '品牌模板', exact: true }).click()
  const main = page.getByRole('main', { name: '品牌模板' })
  await main.getByRole('button', { name: '上传字体' }).click()
  const upload = page.getByRole('dialog', { name: '上传字体' })
  await upload.getByLabel('名称').fill('秋日字体')
  await upload.getByLabel('品牌').fill('秋日')
  await upload
    .getByLabel('字体文件')
    .setInputFiles(
      fileURLToPath(new URL('../src/testing/fixtures/sample-font.otf', import.meta.url)),
    )
  await upload.getByRole('button', { name: '保存字体' }).click()
  const card = main.getByRole('article', { name: '秋日字体' })
  await expect(card.getByText('Aa')).toBeVisible()
  await expect(
    main.getByRole('combobox', { name: '筛选品牌' }).getByRole('option', { name: '秋日' }),
  ).toBeAttached()
  await card.getByRole('button', { name: '预览字体：秋日字体' }).click()
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
  await preview.getByRole('textbox', { name: '预览文字' }).fill('𰻞')
  await expect(preview.getByRole('alert')).toContainText('所选字体不包含部分文字')
  await expect(preview.getByText('𰻞', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(preview).toHaveCount(0)
  await expect(card.getByRole('button', { name: '预览字体：秋日字体' })).toBeFocused()
})
