import { expect, test } from '@playwright/test'
import { login } from './login'

test('Agent 配置：从侧栏进入，改系统提示词、保存草稿、发布，版本菜单里出现新的当前版本', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await login(page, 'governor')
  await page.getByRole('button', { name: 'Agent 配置' }).click()
  await expect(page).toHaveURL(/\/agents/)

  const main = page.getByRole('main', { name: 'Agent 配置' })
  const editor = main.getByRole('region', { name: 'Agent 配置编辑器' })
  await expect(editor.getByRole('button', { name: '切换 Agent，当前：AI 导演' })).toBeVisible()

  await editor.getByRole('button', { name: '编辑系统提示词' }).click()
  const prompt = main.getByRole('textbox', { name: '系统提示词' })
  await prompt.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('回复先给结论，再说理由。')
  await main.getByRole('region', { name: '配置调整' }).getByRole('button', { name: '完成' }).click()
  await expect(editor.getByRole('button', { name: '编辑系统提示词' })).toContainText(
    '回复先给结论，再说理由。',
  )

  const save = editor.getByRole('button', { name: '保存草稿' })
  await save.click()
  await expect(save).toBeDisabled()

  const publish = editor.getByRole('button', { name: '发布' })
  await publish.click()
  await expect(publish).toBeDisabled()

  await editor.getByRole('button', { name: /^查看版本/ }).click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitemradio', { name: /^v7，当前版本，治理者/ })).toBeVisible()
  await expect(menu.getByRole('menuitemradio', { name: /^v6，陈思远/ })).toBeVisible()
})
