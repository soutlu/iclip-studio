import { expect, test } from '@playwright/test'
import { login } from './login'

// 列表按建立时间倒序（合同 §3），改名这类后续操作不让条目换位。
test('侧栏改名后那一行留在原位', async ({ page }) => {
  await page.goto('/')
  await login(page)

  const sidebar = page.getByRole('complementary').first()
  const rows = sidebar.getByRole('link')
  const target = '夜景延时素材生成'
  const renamed = '夜景延时素材 · 改名'
  await expect(sidebar.getByRole('link', { name: target, exact: true })).toBeVisible()
  const before = await rows.allTextContents()
  // 不在第一行，按最近修改排的话改完会跳到顶上，换位才看得出来。
  expect(before.indexOf(target)).toBeGreaterThan(0)

  await sidebar.getByRole('link', { name: target, exact: true }).hover()
  await sidebar.getByRole('button', { name: `${target} 的更多操作` }).click()
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
  const input = sidebar.getByRole('textbox', { name: `重命名 ${target}` })
  await input.fill(renamed)
  await input.press('Enter')

  // 改名成功后重拉侧栏，新名字出现时顺序已是服务端给的。
  await expect(rows).toHaveText(before.map((title) => (title === target ? renamed : title)))
})

// jsdom 不跑样式，行尾 ⋯ 的显隐只能在浏览器里看；⋯ 平时是视觉隐藏（槽位裁成 1px），按槽位宽度判断是否现身。
test('悬停时 ⋯ 在行尾状态右边现身、状态仍在，从对话链接按 Tab 也走得到 ⋯', async ({ page }) => {
  await page.goto('/')
  await login(page)

  const sidebar = page.getByRole('complementary').first()
  const link = sidebar.getByRole('link', { name: '亚麻衬衫二剪', exact: true })
  const status = sidebar.getByRole('img', { name: '视频排队中' })
  const more = sidebar.getByRole('button', { name: '亚麻衬衫二剪 的更多操作' })
  // 裁切的是按钮外面那层槽位，按钮自身的盒子不变，量槽位的宽度。
  const moreSlot = more.locator('xpath=..')
  const moreShown = async () => ((await moreSlot.boundingBox())?.width ?? 0) > 1
  await expect(status).toBeVisible()
  await expect.poll(moreShown).toBe(false)

  await link.hover()
  await expect.poll(moreShown).toBe(true)
  await expect(status).toBeVisible()

  // 先让 ⋯ 收回去，下面按 Tab 后现身才算是焦点带出来的。
  await page.mouse.move(800, 450)
  await expect.poll(moreShown).toBe(false)
  await link.focus()
  await page.keyboard.press('Tab')
  await expect(more).toBeFocused()
  await expect.poll(moreShown).toBe(true)
  await expect(status).toBeVisible()
})
