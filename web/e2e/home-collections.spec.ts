import { expect, test } from '@playwright/test'
import { login } from './login'

test('游客发送后登录，保留正文并发起对话', async ({ page }) => {
  const prompt = '请制作一条轻便跑鞋的产品宣传片'
  await page.goto('/')
  await page.getByLabel('输入消息').fill(prompt)
  await page.getByRole('button', { name: '发送', exact: true }).click()

  // 发送已经打开登录弹窗，直接填写当前表单，避免再次点击外壳的登录入口。
  const dialog = page.getByRole('dialog', { name: '登录 Cue' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('用户名', { exact: true }).fill('tester')
  await dialog.getByLabel('密码', { exact: true }).fill('secret')
  await dialog.getByRole('button', { name: '登录', exact: true }).click()
  await expect(dialog).toBeHidden()

  await expect(page).toHaveURL('/')
  await expect(page.getByLabel('输入消息')).toHaveText(prompt)
  await expect(page.getByRole('button', { name: '分镜 Agent', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '发送', exact: true }).click()

  await expect(page).toHaveURL(/\/c\//)
  await expect(page.getByText(prompt, { exact: true })).toBeVisible({ timeout: 15_000 })
})

test('在侧栏合集行上新建任务：回首页预选这个合集、输入框聚焦，地址栏不留参数', async ({ page }) => {
  await page.goto('/')
  await login(page)
  // 先进一段对话，从别的页面点回首页。
  await page.getByRole('link', { name: '无图分镜草稿', exact: true }).click()
  await expect(page).toHaveURL(/\/c\//)

  // 新建按钮与 ⋯ 一样随行悬停显示，紧挨在 ⋯ 左边。
  await page.getByRole('button', { name: '夏季亚麻系列 (2)', exact: true }).hover()
  const start = page.getByRole('button', { name: '在「夏季亚麻系列」里新建任务', exact: true })
  const more = page.getByRole('button', { name: '夏季亚麻系列 的操作', exact: true })
  await expect(start).toBeVisible()
  const startBox = await start.boundingBox()
  const moreBox = await more.boundingBox()
  expect(startBox && moreBox && moreBox.x - (startBox.x + startBox.width)).toBe(0)

  await start.click()

  await expect(page).toHaveURL('/')
  await expect(
    page.getByRole('button', { name: '关联合集：夏季亚麻系列', exact: true }),
  ).toBeVisible()
  await expect(page.getByLabel('输入消息')).toBeFocused()
})

test('首页搜索并新建合集，首条消息带上关联，回首页后同步侧栏重命名', async ({ page }) => {
  const collectionName = '秋季轻便跑鞋'
  const renamedCollection = '秋季轻便跑鞋宣传片'
  const prompt = '用自然光拍摄这双秋季跑鞋，制作一个短片'
  await page.goto('/')
  await login(page)

  const unassociated = page.getByRole('button', { name: '关联合集：未关联合集', exact: true })
  await unassociated.click()
  const menu = page.getByRole('dialog', { name: '关联合集', exact: true })
  await expect(menu).toBeVisible()
  await expect
    .poll(async () => {
      const anchor = await unassociated.boundingBox()
      const popup = await menu.boundingBox()
      return anchor && popup ? popup.y - (anchor.y + anchor.height) : -1
    })
    .toBeGreaterThanOrEqual(0)
  await page.getByRole('combobox', { name: '搜索合集' }).fill('亚麻')
  await page.getByRole('option', { name: '夏季亚麻系列', exact: true }).click()
  const existingSelection = page.getByRole('button', {
    name: '关联合集：夏季亚麻系列',
    exact: true,
  })
  await expect(existingSelection).toBeVisible()

  await existingSelection.click()
  await page.getByRole('combobox', { name: '搜索合集' }).fill(collectionName)
  await expect(page.getByRole('option')).toHaveCount(0)
  await page.getByRole('button', { name: `新建“${collectionName}”`, exact: true }).click()

  const createDialog = page.getByRole('dialog', { name: '新建合集', exact: true })
  await expect(createDialog.getByRole('textbox', { name: '合集名称' })).toHaveValue(collectionName)
  const collectionCreated = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/collections' &&
      response.request().method() === 'POST' &&
      response.ok(),
  )
  await createDialog.getByRole('button', { name: '保存', exact: true }).click()
  const created = (await (await collectionCreated).json()) as { collection: { id: string } }
  await expect(createDialog).toBeHidden()
  await expect(
    page.getByRole('button', { name: `关联合集：${collectionName}`, exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: '分镜 Agent', exact: true })).toBeEnabled()

  await page.getByLabel('输入消息').fill(prompt)
  const conversationCreated = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === '/api/conversations' && request.method() === 'POST',
  )
  await page.getByRole('button', { name: '发送', exact: true }).click()
  expect((await conversationCreated).postDataJSON()).toMatchObject({
    collectionId: created.collection.id,
  })
  await expect(page).toHaveURL(/\/c\//)
  await expect(page.getByText(prompt, { exact: true })).toBeVisible({ timeout: 15_000 })
  await expect(
    page.getByRole('button', { name: `${collectionName} (1)`, exact: true }),
  ).toBeVisible()

  // 用应用内导航返回，继续使用同一登录态、合集缓存与服务端记录。
  await page.getByRole('button', { name: '新建任务', exact: true }).click()
  await expect(page).toHaveURL('/')
  await page.getByRole('button', { name: '关联合集：未关联合集', exact: true }).click()
  await page.getByRole('combobox', { name: '搜索合集' }).fill(collectionName)
  await page.getByRole('option', { name: collectionName, exact: true }).click()

  // 合集的操作按钮随行悬停显示，先按用户操作移入对应合集行。
  await page.getByRole('button', { name: `${collectionName} (1)`, exact: true }).hover()
  await page.getByRole('button', { name: `${collectionName} 的操作`, exact: true }).click()
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
  // 侧栏合集在行内原位改名，回车保存。
  const renameInput = page.getByRole('textbox', { name: `重命名 ${collectionName}`, exact: true })
  await expect(renameInput).toBeFocused()
  await renameInput.fill(renamedCollection)
  await renameInput.press('Enter')
  await expect(renameInput).toBeHidden()
  await expect(
    page.getByRole('button', { name: `关联合集：${renamedCollection}`, exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: `${renamedCollection} (1)`, exact: true }),
  ).toBeVisible()
})
