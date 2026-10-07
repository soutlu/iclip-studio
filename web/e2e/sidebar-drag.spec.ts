import type { Locator, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { login } from './login'

// jsdom 缺少布局几何，dnd-kit 碰撞检测在浏览器测试中验证。

/** 分两步移动以越过 dnd-kit 的 5px 激活阈值；源为对话链接，目标为分区标题或合集按钮。
 *
 * 先把源滚进侧栏的可见区再量位置：列表底部的行会被侧栏底栏挡住（建立时间跨过半夜时多出
 * 「昨天」分组，最后一行就落到那里），在被挡住的位置按下去按到的是底栏，拖拽不会开始。 */
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

  // 拖拽不得触发对话链接的点击跳转。
  await expect(page).toHaveURL('/')

  await expect(page.getByRole('button', { name: '夏季亚麻系列 (3)' })).toBeVisible()
  // 合集收着，那一行离开任务区后就不在侧栏上了。
  await expect(row).toBeHidden()

  // 移动后侧栏会重建，重试展开操作以避免点击旧节点。
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
