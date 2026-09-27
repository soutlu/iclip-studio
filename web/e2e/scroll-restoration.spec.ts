import { expect, test, type Locator } from '@playwright/test'
import { login } from './login'

const scrollTopOf = (locator: Locator) => locator.evaluate((element) => element.scrollTop)

test('换到别的页面从顶部开始，浏览器返回回到离开时的滚动位置', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 700 })
  await page.goto('/')
  await login(page, 'governor')
  await page.getByRole('button', { name: '审计', exact: true }).click()
  const audit = page.getByRole('main', { name: '审计' })
  await expect(audit.getByRole('region', { name: '异常概览' })).toBeVisible()

  await audit.hover()
  await page.mouse.wheel(0, 600)
  await expect.poll(() => scrollTopOf(audit)).toBe(600)

  await page.getByRole('button', { name: '全部对话', exact: true }).click()
  const conversations = page.getByRole('main', { name: '全部对话' })
  await expect(conversations.getByRole('link').first()).toBeVisible()
  expect(await scrollTopOf(conversations)).toBe(0)

  await page.goBack()
  await expect(audit.getByRole('region', { name: '异常概览' })).toBeVisible()
  await expect.poll(() => scrollTopOf(audit)).toBe(600)
})

test('再进一个列表已在缓存里、一渲染就够长的页面，也从顶部开始', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 700 })
  await page.goto('/')
  await login(page, 'governor')
  // 先进一次全部对话，下次进来列表直接从缓存渲染，页面一开始就比一屏长。
  await page.getByRole('button', { name: '全部对话', exact: true }).click()
  const conversations = page.getByRole('main', { name: '全部对话' })
  await expect(conversations.getByRole('link').first()).toBeVisible()

  await page.getByRole('button', { name: '审计', exact: true }).click()
  const audit = page.getByRole('main', { name: '审计' })
  await expect(audit.getByRole('region', { name: '异常概览' })).toBeVisible()
  await audit.hover()
  await page.mouse.wheel(0, 600)
  await expect.poll(() => scrollTopOf(audit)).toBe(600)

  await page.getByRole('button', { name: '全部对话', exact: true }).click()
  await expect(conversations.getByRole('link').first()).toBeVisible()
  expect(await scrollTopOf(conversations)).toBe(0)

  await page.goBack()
  await expect(audit.getByRole('region', { name: '异常概览' })).toBeVisible()
  await expect.poll(() => scrollTopOf(audit)).toBe(600)
})
