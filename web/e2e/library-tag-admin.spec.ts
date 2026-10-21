import { expect, test } from '@playwright/test'
import { login } from './login'

test('治理者在灵感库管理标签：添加取值后回到列表，筛选里出现它', async ({ page }) => {
  await page.goto('/')
  await login(page, 'governor')
  await page.getByRole('button', { name: '资料库' }).click()
  await page.getByRole('tab', { name: '灵感库' }).click()
  const main = page.getByRole('main', { name: '资料库' })
  await expect(main.getByRole('article').first()).toBeVisible()

  await main.getByRole('button', { name: '管理标签' }).click()
  const panel = main.getByRole('region', { name: '管理标签' })
  await expect(main.getByRole('article')).toHaveCount(0)
  await expect(panel.getByRole('heading', { name: '场景' })).toBeVisible()
  await panel.getByRole('button', { name: '给场景添加标签' }).click()
  await panel.getByRole('textbox', { name: '场景的标签名称' }).fill('海边度假')
  await panel.getByRole('button', { name: '添加', exact: true }).click()
  await expect(
    panel.getByRole('list', { name: '场景的标签' }).getByText('海边度假', { exact: true }),
  ).toBeVisible()

  await panel.getByRole('button', { name: '完成' }).click()
  await expect(panel).toBeHidden()
  await expect(main.getByRole('article').first()).toBeVisible()
  await main.getByRole('button', { name: '场景：场景' }).click()
  await expect(
    page.getByRole('dialog', { name: '选择场景' }).getByRole('checkbox', { name: /^海边度假/ }),
  ).toBeVisible()
})
