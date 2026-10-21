import { expect, test } from '@playwright/test'
import { login } from './login'

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
]) {
  test(`补充标签在 ${viewport.width}px 下可滚动，搜索框固定且能选中末项`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto('/')
    await login(page)
    await page.getByRole('button', { name: '资料库', exact: true }).click()
    await page.getByRole('tab', { name: '爆款素材库', exact: true }).click()
    await page.getByRole('button', { name: '查看详情：春夏凉鞋合集', exact: true }).click()
    const viewer = page.getByRole('dialog', { name: '春夏凉鞋合集', exact: true })
    await viewer.getByRole('tab', { name: '爆款素材', exact: true }).click()
    await viewer.getByRole('button', { name: '添加品类', exact: true }).click()
    const picker = page.getByRole('dialog', { name: '添加品类', exact: true })
    const list = picker.getByRole('listbox', { name: '品类', exact: true })
    await expect(list).toBeVisible()
    await picker.getByRole('combobox', { name: '搜索品类', exact: true }).press('End')
    await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
    await picker.getByRole('combobox', { name: '搜索品类', exact: true }).press('Home')
    await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBe(0)
    await list.hover()
    await page.mouse.wheel(0, 10000)
    await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
    await expect(picker.getByRole('combobox', { name: '搜索品类', exact: true })).toBeInViewport()
    const lastOption = list.getByRole('option').last()
    const label = await lastOption.innerText()
    await expect(lastOption).toBeInViewport()
    await lastOption.click()
    await expect(picker).toBeHidden()
    await expect(
      viewer.getByRole('group', { name: '品类', exact: true }).getByText(label, { exact: true }),
    ).toBeVisible()
  })
}

test('关闭入选详情后按尚未打上的标签筛选，打标完成自动出现并能打开对应版本', async ({ page }) => {
  await page.goto('/')
  await login(page, 'tester')
  await page.getByRole('button', { name: '资料库' }).click()
  const main = page.getByRole('main', { name: '资料库' })

  // 成片素材里打开一条，在「爆款素材」页签带一个人工维度的标签加入。
  const title = '跑鞋手持展示'
  await main
    .getByRole('article', { name: title })
    .getByRole('button', { name: /查看详情/ })
    .click()
  const viewer = page.getByRole('dialog', { name: title })
  await viewer.getByRole('tab', { name: '爆款素材' }).click()
  await viewer.getByRole('button', { name: '添加平台&渠道' }).click()
  await page
    .getByRole('dialog', { name: '添加平台&渠道' })
    .getByRole('option', { name: 'AMZ' })
    .click()
  await viewer.getByRole('button', { name: '加入爆款素材库' }).click()
  await expect(viewer.getByText('正在打标，完成后自动更新标签')).toBeVisible()

  // 在打标完成前关掉详情，当前筛选结果里没有这一条，也要继续观察该任务。
  await page.keyboard.press('Escape')
  await expect(viewer).toBeHidden()

  // 先按尚未打上的标签筛选，任务完成后应自动刷新列表。
  await page.getByRole('tab', { name: '爆款素材库' }).click()
  await expect(page).toHaveURL(/tab=hit-cases/)
  await main.getByRole('button', { name: '品类：品类' }).click()
  const category = page.getByRole('dialog', { name: '选择品类' })
  await category.getByRole('combobox', { name: '搜索品类' }).fill('跑鞋')
  await category.getByRole('option', { name: /^跑鞋/ }).click()
  await page.keyboard.press('Escape')
  await expect(main.getByText('找到 1 条')).toBeVisible({ timeout: 20_000 })
  await expect(page).toHaveURL(/tags=/)
  const card = main.getByRole('article', { name: title })
  await expect(card).toBeVisible()

  // 点开定位到那一张卡的那一版，「爆款素材」页签上是已入选的样子。
  await card.getByRole('button', { name: /查看详情/ }).click()
  const opened = page.getByRole('dialog', { name: title })
  await expect(page).toHaveURL(/video=[0-9a-f-]+/)
  await expect(page).toHaveURL(/version=[0-9a-f-]+/)
  await opened.getByRole('tab', { name: '爆款素材' }).click()
  await expect(opened.getByText(/由 tester 加入爆款素材库$/)).toBeVisible()
  await expect(opened.getByRole('group', { name: '品类' }).getByText('跑鞋')).toBeVisible()
  await expect(opened.getByRole('group', { name: '平台&渠道' }).getByText('AMZ')).toBeVisible()
})
