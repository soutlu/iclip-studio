import { expect, test } from '@playwright/test'
import { login } from './login'

test('在成片素材查看器里把一条素材片加入爆款素材库，打完标后按标签筛到它，点开回到那一版', async ({
  page,
}) => {
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

  // mock 几秒后打完标，状态每 5 秒轮询一次：AI 维度出现标签，人工维度的 AMZ 还在。
  await expect(viewer.getByRole('group', { name: '品类' }).getByText('跑鞋')).toBeVisible({
    timeout: 20_000,
  })
  await expect(viewer.getByRole('group', { name: '平台&渠道' }).getByText('AMZ')).toBeVisible()
  await expect(viewer.getByRole('button', { name: '移出爆款素材库' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(viewer).toBeHidden()

  // 爆款素材库里按 AI 打的标签筛选，能看到它。
  await page.getByRole('tab', { name: '爆款素材库' }).click()
  await expect(page).toHaveURL(/tab=hit-cases/)
  await main.getByRole('button', { name: '品类：品类' }).click()
  const category = page.getByRole('dialog', { name: '选择品类' })
  await category.getByRole('combobox', { name: '搜索品类' }).fill('跑鞋')
  await category.getByRole('option', { name: /^跑鞋/ }).click()
  await page.keyboard.press('Escape')
  await expect(main.getByText('找到 1 条')).toBeVisible()
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
})
