import { expect, test, type Locator, type Page } from '@playwright/test'
import { openConversation } from './helpers'
import { login } from './login'

// 在真实浏览器中验证拖动宽度跨刷新持久化。

test.use({ viewport: { height: 900, width: 1600 } })

test('拖侧栏拖柄改宽，刷新之后还在', async ({ page }) => {
  await page.goto('/')
  await login(page)

  const sidebar = page.getByRole('complementary').first()
  const before = await sidebar.boundingBox()
  if (!before) throw new Error('侧栏没有可测量的位置')

  const handle = page.getByRole('button', { name: '调整侧边栏宽度' })
  const grip = await handle.boundingBox()
  if (!grip) throw new Error('拖柄没有可测量的位置')

  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2 + 60, grip.y + grip.height / 2, { steps: 6 })
  await page.mouse.up()

  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(before.width + 60, 0)

  await page.reload()
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width)
    .toBeCloseTo(before.width + 60, 0)

  // 缩窄后的用户宽度也保留；继续拖到边缘可折叠，再往回拖能恢复。
  const narrowWidth = before.width / 2
  await dragBy(page, handle, narrowWidth - (await bounds(sidebar)).width)
  await widthIs(sidebar, narrowWidth)
  await page.reload()
  await widthIs(sidebar, narrowWidth)
  await dragBy(page, handle, -1000)
  await expect(page.getByRole('button', { name: '展开侧边栏' })).toBeVisible()
  await dragBy(page, handle, 160)
  await expect(page.getByRole('button', { name: '折叠侧边栏' })).toBeVisible()
})

test('双击侧栏拖柄恢复默认宽', async ({ page }) => {
  await page.goto('/')
  await login(page)
  const sidebar = page.getByRole('complementary', { name: '侧边栏' })
  const initialWidth = (await bounds(sidebar)).width
  const handle = page.getByRole('button', { name: '调整侧边栏宽度' })
  await dragBy(page, handle, 60)
  await widthIs(sidebar, initialWidth + 60)
  await handle.dblclick()
  await widthIs(sidebar, initialWidth)
})

/** 拖动真实边界热区，位移正负由当前列顺序决定。 */
const dragBy = async (page: Page, handle: Locator, delta: number) => {
  const box = await bounds(handle)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + delta, y, { steps: 10 })
  await page.mouse.up()
}

const bounds = async (locator: Locator) => {
  const box = await locator.boundingBox()
  if (!box) throw new Error('布局控件没有可测量的位置')
  return box
}

const widthIs = async (locator: Locator, width: number) => {
  await expect.poll(async () => (await bounds(locator)).width).toBeCloseTo(width, 0)
}

const swapPanes = async (page: Page) => {
  const button = page.getByRole('button', { name: '交换对话与工作台' }).first()
  await button.hover()
  await button.click()
}

test('工作台拖宽跨刷新保留，窗口变窄与变宽不覆盖偏好宽度', async ({ page }) => {
  const panel = await openConversation(page, '夜景延时素材生成')
  await expect(page.getByRole('button', { name: '折叠工作台', exact: true })).toBeVisible()
  const resizedWidth = (await bounds(panel)).width - 80
  await dragBy(page, page.getByRole('button', { name: '调整工作台宽度' }), 80)
  await widthIs(panel, resizedWidth)
  await page.setViewportSize({ height: 900, width: 1335 })
  await expect.poll(async () => (await bounds(panel)).width).toBeLessThanOrEqual(resizedWidth)
  await page.setViewportSize({ height: 900, width: 1100 })
  await expect(page.getByTestId('pane-chat')).toBeVisible()
  await page.setViewportSize({ height: 900, width: 1600 })
  await widthIs(panel, resizedWidth)
  await page.reload()
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
  await widthIs(panel, resizedWidth)
})

test('折叠各栏后仍能操作入口，展开后恢复内容', async ({ page }) => {
  await openConversation(page, '夜景延时素材生成')
  const sidebar = page.getByRole('complementary', { name: '侧边栏' })
  await page.getByRole('button', { name: '折叠侧边栏' }).click()

  for (const name of ['新建任务', '搜索', '需求单', '资料库', '用户菜单']) {
    await expect(sidebar.getByRole('button', { name, exact: true })).toBeVisible()
  }
  await page.getByRole('button', { name: '折叠对话', exact: true }).click()

  await expect(page.getByRole('button', { name: '展开对话', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '展开对话', exact: true })).toBeFocused()
  await expect(page.getByRole('main', { includeHidden: true })).toBeHidden()
  await page.getByRole('button', { name: '展开对话', exact: true }).click()
  await page.getByRole('button', { name: '折叠工作台', exact: true }).click()

  await expect(page.getByRole('button', { name: '展开工作台', exact: true })).toBeVisible()
  await expect(page.getByRole('main')).toBeVisible()

  await page.getByRole('button', { name: '展开工作台', exact: true }).click()
  await expect(page.getByRole('complementary', { name: '工作台' })).toBeVisible()
  await page.getByRole('button', { name: '展开侧边栏' }).click()
  await expect(sidebar.getByRole('button', { name: '折叠侧边栏' })).toBeVisible()
})

test('折叠、展开和交换保留草稿、对话滚动及工作台选择', async ({ page }) => {
  const panel = await openConversation(page, '夜景延时素材生成')
  await expect(page.getByText('镜头表已经更新。')).toBeVisible({ timeout: 15_000 })
  const editor = page.getByLabel('输入消息')
  await editor.fill('这段草稿还没有发送，换位后继续编辑')
  const scroller = page.getByTestId('chat-scroller')
  const beforeScroll = await scroller.evaluate((element) => element.scrollTop)
  await scroller.hover()
  await page.mouse.wheel(0, -350)
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBeLessThan(beforeScroll)
  const scrollTop = await scroller.evaluate((element) => element.scrollTop)
  const selectedTab = await panel.getByRole('tab', { selected: true }).textContent()

  await page.getByRole('button', { name: '折叠对话', exact: true }).click()
  await expect(editor).toBeHidden()
  await page.getByRole('button', { name: '展开对话', exact: true }).click()
  await expect(editor).toHaveText('这段草稿还没有发送，换位后继续编辑')
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBeCloseTo(scrollTop, 0)

  await page.getByRole('button', { name: '折叠工作台', exact: true }).click()
  await page.getByRole('button', { name: '展开工作台', exact: true }).click()
  await expect(panel.getByRole('tab', { selected: true })).toHaveText(selectedTab ?? '')
  await swapPanes(page)
  expect((await bounds(page.getByTestId('pane-workbench'))).x).toBeLessThan(
    (await bounds(page.getByTestId('pane-chat'))).x,
  )
  await expect(editor).toHaveText('这段草稿还没有发送，换位后继续编辑')
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBeCloseTo(scrollTop, 0)
  await swapPanes(page)
  expect((await bounds(page.getByTestId('pane-chat'))).x).toBeLessThan(
    (await bounds(page.getByTestId('pane-workbench'))).x,
  )
  await expect(editor).toHaveText('这段草稿还没有发送，换位后继续编辑')
})

for (const workbenchFirst of [false, true]) {
  test(`边界拖动可折叠与重新展开两栏：工作台${workbenchFirst ? '在前' : '在后'}`, async ({
    page,
  }) => {
    await openConversation(page, '夜景延时素材生成')
    if (workbenchFirst) await swapPanes(page)
    const workbench = page.getByTestId('pane-workbench')
    const handle = page.getByRole('button', { name: '调整工作台宽度' })
    const direction = workbenchFirst ? 1 : -1

    await dragBy(page, handle, -1000 * direction)

    await expect(page.getByRole('button', { name: '展开工作台', exact: true })).toBeVisible()
    await expect(page.getByRole('main')).toBeVisible()
    await dragBy(page, handle, 560 * direction)
    await expect(page.getByRole('complementary', { name: '工作台' })).toBeVisible()
    await expect(page.getByRole('main')).toBeVisible()
    await expect.poll(async () => (await bounds(workbench)).width).toBeGreaterThanOrEqual(560)

    await dragBy(page, handle, 900 * direction)

    await expect(page.getByRole('button', { name: '展开对话', exact: true })).toBeVisible()
    await expect(page.getByRole('main', { includeHidden: true })).toBeHidden()
    await dragBy(page, handle, -400 * direction)
    await expect(page.getByRole('main')).toBeVisible()
    await expect(page.getByRole('complementary', { name: '工作台' })).toBeVisible()
  })
}

test('最后一栏折叠时另一栏展开，离开对话后不留空白图标栏', async ({ page }) => {
  await openConversation(page, '夜景延时素材生成')
  const chat = page.getByTestId('pane-chat')
  await page.getByRole('button', { name: '折叠工作台', exact: true }).click()

  await expect(page.getByRole('button', { name: '展开工作台', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '折叠对话', exact: true }).click()

  await expect(page.getByRole('button', { name: '展开对话', exact: true })).toBeVisible()
  await expect(page.getByRole('complementary', { name: '工作台' })).toBeVisible()
  await page.getByRole('button', { name: '折叠工作台', exact: true }).click()

  await expect(page.getByRole('button', { name: '展开工作台', exact: true })).toBeVisible()
  await expect(page.getByRole('main')).toBeVisible()

  await page.getByRole('button', { name: '需求单', exact: true }).click()
  await expect(page).toHaveURL(/\/tasks$/)
  await expect(page.getByRole('button', { name: '展开工作台', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '展开对话', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '调整工作台宽度', exact: true })).toHaveCount(0)
  const sidebar = await bounds(page.getByRole('complementary', { name: '侧边栏' }))
  const content = await bounds(chat)
  expect(content.x).toBeCloseTo(sidebar.x + sidebar.width, 0)
  expect(content.x + content.width).toBeCloseTo(1600, 0)
})

test('拖动栏头换位、键盘换回和取消调宽', async ({ page }) => {
  await openConversation(page, '夜景延时素材生成')
  await expect(page.getByText('镜头表已经更新。')).toBeVisible({ timeout: 15_000 })
  const chat = page.getByTestId('pane-chat')
  const workbench = page.getByTestId('pane-workbench')
  const title = await bounds(page.getByRole('heading', { name: '夜景延时素材生成', exact: true }))
  const target = await bounds(workbench)
  await page.mouse.move(title.x + 10, title.y + title.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, 26, { steps: 12 })
  await page.mouse.up()
  await expect.poll(async () => (await bounds(workbench)).x).toBeLessThan((await bounds(chat)).x)

  // dnd-kit 在松手后保留 50ms 的 click 拦截，防止把拖动误判为点击。
  await page.waitForTimeout(60)
  const swap = chat.getByRole('button', { name: '交换对话与工作台' })
  await swap.focus()
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await bounds(chat)).x).toBeLessThan((await bounds(workbench)).x)

  const sidebar = page.getByRole('complementary', { name: '侧边栏' })
  const originalWidth = (await bounds(sidebar)).width
  const handle = page.getByRole('button', { name: '调整侧边栏宽度' })
  const grip = await bounds(handle)
  await page.mouse.move(grip.x + grip.width / 2, 400)
  await page.mouse.down()
  await page.mouse.move(grip.x + 100, 400, { steps: 6 })
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await widthIs(sidebar, originalWidth)
  await handle.focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await bounds(sidebar)).width).toBeGreaterThan(originalWidth)
  const keyboardWidth = (await bounds(sidebar)).width
  await page.getByRole('button', { name: '折叠侧边栏' }).click()
  await handle.focus()
  await page.keyboard.press('ArrowRight')
  await widthIs(sidebar, keyboardWidth)
  const workbenchWidth = (await bounds(workbench)).width
  await page.getByRole('button', { name: '折叠工作台' }).click()
  await page.getByRole('button', { name: '调整工作台宽度' }).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('complementary', { name: '工作台' })).toBeVisible()
  await widthIs(workbench, workbenchWidth)

  await page.reload()
  await widthIs(sidebar, keyboardWidth)
})

test('三种布局、窄屏切换与桌面偏好恢复', async ({ page }) => {
  await openConversation(page, '夜景延时素材生成')
  await expect(page.getByText('镜头表已经更新。')).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: '折叠侧边栏', exact: true }).click()
  await page.getByRole('button', { name: '折叠工作台', exact: true }).click()

  await page.getByRole('button', { name: '展开工作台', exact: true }).click()
  await swapPanes(page)
  await page.getByRole('button', { name: '折叠对话', exact: true }).click()

  await expect(page.getByRole('button', { name: '展开对话', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '展开对话', exact: true }).click()
  await expect(page.getByLabel('输入消息')).toBeVisible()
  await page.getByLabel('输入消息').fill('移动端切换后保留的草稿')
  await page.getByRole('button', { name: '展开工作台', exact: true }).click()
  await expect(page.getByRole('complementary', { name: '工作台' })).toBeVisible()
  await expect(page.getByRole('button', { name: '交换对话与工作台' })).toHaveCount(0)
  await page.getByRole('button', { name: '展开对话', exact: true }).click()
  await expect(page.getByLabel('输入消息')).toHaveText('移动端切换后保留的草稿')
  await page.setViewportSize({ width: 1600, height: 900 })

  await expect(page.getByRole('button', { name: '展开对话', exact: true })).toBeVisible()
  expect((await bounds(page.getByTestId('pane-workbench'))).x).toBeLessThan(
    (await bounds(page.getByTestId('pane-chat'))).x,
  )
  await page.reload()
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
  await expect(page.getByRole('complementary', { name: '工作台' })).toBeVisible()

  await expect(page.getByRole('button', { name: '展开对话', exact: true })).toBeVisible()
  expect((await bounds(page.getByTestId('pane-workbench'))).x).toBeLessThan(
    (await bounds(page.getByTestId('pane-chat'))).x,
  )
})

/** 焦点目标必须完整落在可见栏内，不能仅检查 overflow 裁切下仍为 visible 的节点。 */
const expectContainedFocus = async (control: Locator, pane: Locator) => {
  await expect(control).toBeFocused()
  await expect
    .poll(async () => {
      const target = await bounds(control)
      const container = await bounds(pane)
      return (
        target.x >= container.x &&
        target.x + target.width <= container.x + container.width &&
        target.y >= container.y &&
        target.y + target.height <= container.y + container.height
      )
    })
    .toBe(true)
  await expect(control).toBeFocused()
}

const openSettledConversation = async (page: Page) => {
  await openConversation(page, '夜景延时素材生成')
  await expect(page.getByText('镜头表已经更新。')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeHidden()
}

test('Tab 进入裁切的对话按钮后恢复可见宽度并保留焦点', async ({ page }) => {
  await openSettledConversation(page)
  const chat = page.getByTestId('pane-chat')
  await dragBy(
    page,
    page.getByRole('button', { name: '调整工作台宽度' }),
    250 - (await bounds(chat)).width,
  )
  await widthIs(chat, 250)

  await page.getByRole('button', { name: '调整侧边栏宽度' }).focus()
  await page.keyboard.press('Tab')

  await expectContainedFocus(chat.getByRole('button', { name: '交换对话与工作台' }), chat)
})

test('Shift+Tab 进入裁切的工作台标签后恢复可见宽度并保留焦点', async ({ page }) => {
  await openSettledConversation(page)
  const workbench = page.getByTestId('pane-workbench')
  await dragBy(
    page,
    page.getByRole('button', { name: '调整工作台宽度' }),
    (await bounds(workbench)).width - 250,
  )
  await widthIs(workbench, 250)

  await workbench.getByRole('button', { name: '交换对话与工作台' }).focus()
  await page.keyboard.press('Shift+Tab')

  await expectContainedFocus(workbench.getByRole('tab', { name: '分镜' }), workbench)
})

test('Shift+Tab 进入裁切的侧边栏用户菜单后恢复可见宽度并保留焦点', async ({ page }) => {
  await openSettledConversation(page)
  const sidebar = page.getByRole('complementary', { name: '侧边栏' })
  const handle = page.getByRole('button', { name: '调整侧边栏宽度' })
  await dragBy(page, handle, 120 - (await bounds(sidebar)).width)
  await widthIs(sidebar, 120)

  await handle.focus()
  await page.keyboard.press('Shift+Tab')

  await expectContainedFocus(sidebar.getByRole('button', { name: '用户菜单' }), sidebar)
})

for (const compactWidth of [390, 900]) {
  test(`在 ${compactWidth}px 下切换对话与工作台后，回到桌面宽度和刷新都保留对话的裁切宽度`, async ({
    page,
  }) => {
    await openSettledConversation(page)
    const chat = page.getByTestId('pane-chat')
    await dragBy(
      page,
      page.getByRole('button', { name: '调整工作台宽度' }),
      250 - (await bounds(chat)).width,
    )
    await widthIs(chat, 250)

    await page.setViewportSize({ width: compactWidth, height: 900 })
    await page.getByRole('button', { name: '展开对话', exact: true }).click()
    await expect(page.getByLabel('输入消息')).toBeVisible()
    await page.getByRole('button', { name: '展开工作台', exact: true }).click()
    await expect(page.getByRole('complementary', { name: '工作台' })).toBeVisible()
    if (compactWidth === 900) {
      await page.getByRole('button', { name: '回到对话', exact: true }).click()
      await expect(page.getByLabel('输入消息')).toBeVisible()
      await page.getByRole('button', { name: '折叠对话', exact: true }).click()
      await expect(page.getByRole('complementary', { name: '工作台' })).toBeVisible()
    }
    await page.setViewportSize({ width: 1600, height: 900 })
    await widthIs(chat, 250)

    await page.reload()
    await login(page)
    await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
    await widthIs(chat, 250)
  })
}
