import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

export const login = async (page: Page, username: 'tester' | 'governor' = 'tester') => {
  const expandSidebar = page.getByRole('button', { name: '展开侧边栏' })
  const loginTrigger = page.getByRole('button', { name: '登录', exact: true })
  await expect(expandSidebar.or(loginTrigger).first()).toBeVisible()

  if (await expandSidebar.isVisible()) {
    await expandSidebar.click()
  }

  await loginTrigger.click()
  const dialog = page.getByRole('dialog', { name: '登录 iClip' })
  await dialog.getByLabel('用户名', { exact: true }).fill(username)
  await dialog.getByLabel('密码', { exact: true }).fill('secret')
  await dialog.getByRole('button', { name: '登录', exact: true }).click()
  await expect(dialog).toBeHidden()
}
