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

test('会话更多操作可用鼠标命中和键盘打开，运行状态保持可见', async ({ page }) => {
  await page.goto('/')
  await login(page)
  const sidebar = page.getByRole('complementary', { name: '侧边栏' })
  const link = sidebar.getByRole('link', { name: '亚麻衬衫二剪', exact: true })
  const status = sidebar.getByRole('img', { name: '视频排队中' })
  const more = sidebar.getByRole('button', { name: '亚麻衬衫二剪 的更多操作' })
  await link.hover()
  // 真实命中检查代替父节点宽度：按钮可点，且没有挡住运行状态。
  await more.click({ trial: true })
  await expect(status).toBeVisible()
  await page.mouse.move(800, 450)
  await link.focus()
  await page.keyboard.press('Tab')
  await expect(more).toBeFocused()
  await expect(status).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menuitem', { name: '重命名', exact: true })).toBeVisible()
})
