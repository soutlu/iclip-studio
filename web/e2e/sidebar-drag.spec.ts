import type { Locator, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { login } from './login'

const dragOnto = async (page: Page, source: string, to: Locator) => {
  const from = page.getByRole('link', { name: source, exact: true })
  await from.scrollIntoViewIfNeeded()
  const start = await from.boundingBox()
  const end = await to.boundingBox()
  if (!start || !end) throw new Error('拖拽的两端要先在页面上')

  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2 + 12, { steps: 4 })
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 10 })
  await to.hover()
  await page.mouse.up()
}

test('把对话拖进合集，再拖回任务区', async ({ page }) => {
  await page.goto('/')
  await login(page)

  await expect(page.getByRole('button', { name: '夏季亚麻系列 (2)' })).toBeVisible()
  const row = page.getByRole('link', { name: '夜景延时素材生成', exact: true })
  await expect(row).toBeVisible()

  await dragOnto(
    page,
    '夜景延时素材生成',
    page.getByRole('button', { name: '夏季亚麻系列 (2)', exact: true }),
  )

  await expect(page).toHaveURL('/')

  await expect(page.getByRole('button', { name: '夏季亚麻系列 (3)' })).toBeVisible()
  await expect(row).toBeHidden()

  await expect(async () => {
    await page.getByRole('button', { name: '夏季亚麻系列 (3)' }).click()
    await expect(row).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 10_000 })
  await dragOnto(
    page,
    '夜景延时素材生成',
    page
      .getByRole('complementary', { name: '侧边栏' })
      .getByRole('heading', { name: '任务', exact: true }),
  )

  await expect(page.getByRole('button', { name: '夏季亚麻系列 (2)' })).toBeVisible()
  await expect(row).toBeVisible()
})
