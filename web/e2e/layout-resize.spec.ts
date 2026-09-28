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
  expect(before.width).toBeCloseTo(264, 0)

  const handle = page.getByRole('button', { name: '调整侧栏宽度' })
  const grip = await handle.boundingBox()
  if (!grip) throw new Error('拖柄没有可测量的位置')

  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2 + 60, grip.y + grip.height / 2, { steps: 6 })
  await page.mouse.up()

  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBeCloseTo(324, 0)

  await page.reload()
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBeCloseTo(324, 0)
})

test('双击侧栏拖柄恢复默认宽', async ({ page }) => {
  await page.goto('/')
  await login(page)

  const sidebar = page.getByRole('complementary').first()
  const handle = page.getByRole('button', { name: '调整侧栏宽度' })
  const grip = await handle.boundingBox()
  if (!grip) throw new Error('拖柄没有可测量的位置')

  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2 + 60, grip.y + grip.height / 2, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBeCloseTo(324, 0)

  await handle.dblclick()

  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBeCloseTo(264, 0)
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

test('面板拖宽跨刷新保留，窗口变窄与变宽不覆盖偏好宽度', async ({ page }) => {
  const panel = await openConversation(page, '夜景延时素材生成')
  await widthIs(panel, 820)
  await dragBy(page, page.getByRole('button', { name: '调整面板宽度' }), 80)
  await widthIs(panel, 740)

  await page.setViewportSize({ height: 900, width: 1335 })
  await widthIs(panel, 671)
  await page.setViewportSize({ height: 900, width: 1100 })
  await expect(page.getByTestId('pane-chat')).toBeVisible()
  await page.setViewportSize({ height: 900, width: 1600 })
  await widthIs(panel, 740)

  await page.reload()
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
  await widthIs(panel, 740)
})

test('列边界无占位缝隙，导航与内容栏收起后保留窄栏', async ({ page }) => {
  await openConversation(page, '夜景延时素材生成')
  const sidebar = page.getByRole('complementary', { name: '导航' })
  const chat = page.getByTestId('pane-chat')
  const workbench = page.getByTestId('pane-workbench')
  const sidebarBox = await bounds(sidebar)
  const chatBox = await bounds(chat)
  const workbenchBox = await bounds(workbench)
  expect(chatBox.x).toBeCloseTo(sidebarBox.x + sidebarBox.width, 0)
  expect(workbenchBox.x).toBeCloseTo(chatBox.x + chatBox.width, 0)
  expect(workbenchBox.x + workbenchBox.width).toBeCloseTo(1600, 0)

  for (const [name, seam] of [
    ['调整侧栏宽度', chatBox.x],
    ['调整面板宽度', workbenchBox.x],
  ] as const) {
    const handle = await bounds(page.getByRole('button', { name }))
    expect(handle.width).toBe(8)
    expect(handle.x + handle.width / 2).toBeCloseTo(seam, 0)
  }

  await page.getByRole('button', { name: '折叠侧边栏' }).click()
  await widthIs(sidebar, 56)
  for (const name of ['新建任务', '搜索', '需求单', '资料库', '用户菜单']) {
    await expect(sidebar.getByRole('button', { name, exact: true })).toBeVisible()
  }
  await page.getByRole('button', { name: '折叠对话', exact: true }).click()
  await widthIs(chat, 40)
  await expect(page.getByRole('button', { name: '展开对话', exact: true })).toBeFocused()
  await expect(page.getByRole('main', { includeHidden: true })).toBeHidden()
  await page.getByRole('button', { name: '展开对话', exact: true }).click()
  await page.getByRole('button', { name: '折叠右侧面板', exact: true }).click()
  await widthIs(workbench, 40)
  await expect(page.getByRole('main')).toBeVisible()

  await page.getByRole('button', { name: '展开侧边栏' }).click()
  await dragBy(page, page.getByRole('button', { name: '调整侧栏宽度' }), 600)
  await widthIs(sidebar, 400)
  await dragBy(page, page.getByRole('button', { name: '调整侧栏宽度' }), -400)
  await widthIs(sidebar, 56)
  await dragBy(page, page.getByRole('button', { name: '调整侧栏宽度' }), 160)
  await widthIs(sidebar, 216)
})

test('折叠、恢复和交换保留草稿、聊天滚动及面板选择', async ({ page }) => {
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
  const editorNode = await editor.elementHandle()
  const selectedTab = await panel.getByRole('tab', { selected: true }).textContent()
  if (!editorNode) throw new Error('编辑器没有挂载')

  await page.getByRole('button', { name: '折叠对话', exact: true }).click()
  await expect(editor).toBeHidden()
  expect(await editorNode.evaluate((element) => element.isConnected)).toBe(true)
  await page.getByRole('button', { name: '展开对话', exact: true }).click()
  await expect(editor).toHaveText('这段草稿还没有发送，换位后继续编辑')
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBeCloseTo(scrollTop, 0)

  await page.getByRole('button', { name: '折叠右侧面板', exact: true }).click()
  await page.getByRole('button', { name: '打开右侧面板', exact: true }).click()
  await expect(panel.getByRole('tab', { selected: true })).toHaveText(selectedTab ?? '')
  await swapPanes(page)
  expect((await bounds(page.getByTestId('pane-workbench'))).x).toBeLessThan(
    (await bounds(page.getByTestId('pane-chat'))).x,
  )
  expect(await editorNode.evaluate((element) => element.isConnected)).toBe(true)
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
  test(`边界拖动可收起与重新拉开两栏：工作台${workbenchFirst ? '在前' : '在后'}`, async ({
    page,
  }) => {
    await openConversation(page, '夜景延时素材生成')
    if (workbenchFirst) await swapPanes(page)
    const chat = page.getByTestId('pane-chat')
    const workbench = page.getByTestId('pane-workbench')
    const handle = page.getByRole('button', { name: '调整面板宽度' })
    const direction = workbenchFirst ? 1 : -1

    await dragBy(page, handle, -1000 * direction)
    await widthIs(workbench, 40)
    await expect(page.getByRole('main')).toBeVisible()
    await dragBy(page, handle, 560 * direction)
    await expect(page.getByRole('complementary', { name: '右侧面板' })).toBeVisible()
    await expect(page.getByRole('main')).toBeVisible()
    await expect.poll(async () => (await bounds(workbench)).width).toBeGreaterThanOrEqual(560)

    await dragBy(page, handle, 900 * direction)
    await widthIs(chat, 40)
    await expect(page.getByRole('main', { includeHidden: true })).toBeHidden()
    await dragBy(page, handle, -400 * direction)
    await expect(page.getByRole('main')).toBeVisible()
    await expect(page.getByRole('complementary', { name: '右侧面板' })).toBeVisible()
  })
}

test('最后一栏收起时另一栏展开，离开对话后没有空白内容窄栏', async ({ page }) => {
  await openConversation(page, '夜景延时素材生成')
  const chat = page.getByTestId('pane-chat')
  const workbench = page.getByTestId('pane-workbench')
  await page.getByRole('button', { name: '折叠右侧面板', exact: true }).click()
  await widthIs(workbench, 40)
  await page.getByRole('button', { name: '折叠对话', exact: true }).click()
  await widthIs(chat, 40)
  await expect(page.getByRole('complementary', { name: '右侧面板' })).toBeVisible()
  await page.getByRole('button', { name: '折叠右侧面板', exact: true }).click()
  await widthIs(workbench, 40)
  await expect(page.getByRole('main')).toBeVisible()

  await page.getByRole('button', { name: '需求单', exact: true }).click()
  await expect(page).toHaveURL(/\/tasks$/)
  await expect(page.getByRole('button', { name: '打开右侧面板', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '展开对话', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '调整面板宽度', exact: true })).toHaveCount(0)
  const sidebar = await bounds(page.getByRole('complementary', { name: '导航' }))
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

  const sidebar = page.getByRole('complementary', { name: '导航' })
  const handle = page.getByRole('button', { name: '调整侧栏宽度' })
  const grip = await bounds(handle)
  await page.mouse.move(grip.x + grip.width / 2, 400)
  await page.mouse.down()
  await page.mouse.move(grip.x + 100, 400, { steps: 6 })
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await widthIs(sidebar, 264)
  await handle.focus()
  await page.keyboard.press('ArrowRight')
  await widthIs(sidebar, 280)
  await page.getByRole('button', { name: '折叠侧边栏' }).click()
  await handle.focus()
  await page.keyboard.press('ArrowRight')
  await widthIs(sidebar, 280)
  await page.getByRole('button', { name: '折叠右侧面板' }).click()
  await page.getByRole('button', { name: '调整面板宽度' }).focus()
  await page.keyboard.press('ArrowLeft')
  await widthIs(workbench, 820)
  await page.reload()
  await widthIs(sidebar, 280)
})

test('三种布局浅深主题、窄屏切换与桌面偏好恢复', async ({ page }) => {
  await openConversation(page, '夜景延时素材生成')
  await expect(page.getByText('镜头表已经更新。')).toBeVisible({ timeout: 15_000 })
  const screenshot = async (name: string) => {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await expect
        .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
        .toBe(colorScheme === 'dark')
      await page.mouse.move(0, 899)
      await page.screenshot({
        animations: 'disabled',
        path: `../.artifacts/design-qa/sidebar-${name}-${colorScheme}.png`,
      })
    }
  }
  await screenshot('split')
  await page.getByRole('button', { name: '折叠侧边栏', exact: true }).click()
  await page.getByRole('button', { name: '折叠右侧面板', exact: true }).click()
  await widthIs(page.getByRole('complementary', { name: '导航' }), 56)
  await widthIs(page.getByTestId('pane-workbench'), 40)
  await screenshot('chat')
  await page.getByRole('button', { name: '打开右侧面板', exact: true }).click()
  await swapPanes(page)
  await page.getByRole('button', { name: '折叠对话', exact: true }).click()
  await widthIs(page.getByTestId('pane-chat'), 40)
  await screenshot('workbench')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '展开对话', exact: true }).click()
  await expect(page.getByLabel('输入消息')).toBeVisible()
  await page.getByLabel('输入消息').fill('移动端切换后保留的草稿')
  await screenshot('mobile-chat')
  await page.getByRole('button', { name: '打开右侧面板', exact: true }).click()
  await expect(page.getByRole('complementary', { name: '右侧面板' })).toBeVisible()
  await screenshot('mobile-workbench')
  await expect(page.getByRole('button', { name: '交换对话与工作台' })).toHaveCount(0)
  await page.getByRole('button', { name: '展开对话', exact: true }).click()
  await expect(page.getByLabel('输入消息')).toHaveText('移动端切换后保留的草稿')
  await page.setViewportSize({ width: 1600, height: 900 })
  await widthIs(page.getByTestId('pane-chat'), 40)
  expect((await bounds(page.getByTestId('pane-workbench'))).x).toBeLessThan(
    (await bounds(page.getByTestId('pane-chat'))).x,
  )
  await page.reload()
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
  await expect(page.getByRole('complementary', { name: '右侧面板' })).toBeVisible()
  await widthIs(page.getByTestId('pane-chat'), 40)
  expect((await bounds(page.getByTestId('pane-workbench'))).x).toBeLessThan(
    (await bounds(page.getByTestId('pane-chat'))).x,
  )
})

test('移除全屏按钮，折叠和展开仍可用且刷新保留', async ({ page }) => {
  await openConversation(page, '夜景延时素材生成')
  const workbench = page.getByTestId('pane-workbench')
  await widthIs(workbench, 820)
  await expect(
    page.getByRole('button', { name: /专注对话|退出对话专注|放大面板|缩小面板/ }),
  ).toHaveCount(0)
  await page.getByRole('button', { name: '折叠右侧面板', exact: true }).click()
  await widthIs(workbench, 40)
  await page.reload()
  await login(page)
  await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
  await expect(page.getByText('镜头表已经更新。')).toBeVisible({ timeout: 15_000 })
  await widthIs(workbench, 40)
  await page.getByRole('button', { name: '打开右侧面板', exact: true }).click()
  await widthIs(workbench, 820)
  await page.setViewportSize({ width: 900, height: 900 })
  await page.getByRole('button', { name: '展开对话', exact: true }).click()
  await page.getByRole('button', { name: '折叠对话', exact: true }).click()
  await expect(page.getByRole('complementary', { name: '右侧面板' })).toBeVisible()
})

for (const workbenchFirst of [false, true]) {
  test(`连续收窄越过内容阈值后裁切，直到轨道才折叠：工作台${workbenchFirst ? '在前' : '在后'}`, async ({
    page,
  }) => {
    await openConversation(page, '夜景延时素材生成')
    await expect(page.getByText('镜头表已经更新。')).toBeVisible({ timeout: 15_000 })
    const workbench = page.getByTestId('pane-workbench')
    const chat = page.getByTestId('pane-chat')
    await widthIs(workbench, 820)
    if (workbenchFirst) await swapPanes(page)
    const direction = workbenchFirst ? 1 : -1
    const handle = page.getByRole('button', { name: '调整面板宽度' })
    const grip = await bounds(handle)
    const originX = grip.x + grip.width / 2
    await page.mouse.move(originX, 450)
    await page.mouse.down()
    for (const width of [620, 560, 559, 480, 280, 80, 41]) {
      await page.mouse.move(originX + (width - 820) * direction, 450)
      await widthIs(workbench, width)
      await widthIs(workbench.locator('[data-pane-body]'), Math.max(560, width))
      const outer = await bounds(workbench)
      const body = await bounds(workbench.locator('[data-pane-body]'))
      expect(workbenchFirst ? body.x : body.x + body.width).toBeCloseTo(
        workbenchFirst ? outer.x : outer.x + outer.width,
        0,
      )
      await expect(
        workbench.getByRole('button', { name: '打开右侧面板', exact: true }),
      ).toHaveCount(0)
    }
    await page.mouse.move(originX + (40 - 820) * direction, 450)
    await widthIs(workbench, 40)
    await page.mouse.up()
    await expect(workbench.getByRole('button', { name: '打开右侧面板', exact: true })).toBeVisible()

    const rail = await bounds(handle)
    await page.mouse.move(rail.x + rail.width / 2, 450)
    await page.mouse.down()
    for (const width of [41, 100, 300, 559, 560, 640]) {
      await page.mouse.move(rail.x + rail.width / 2 + (width - 40) * direction, 450)
      await widthIs(workbench, width)
    }
    await page.mouse.up()
    // 把对话收窄到裁切区后松手：保留真实宽度，刷新和视口往返都不吸附。
    const available = (await bounds(chat)).width + (await bounds(workbench)).width
    await dragBy(page, handle, (available - 250 - 640) * direction)
    await widthIs(chat, 250)
    await widthIs(chat.locator('[data-pane-body]'), 400)
    await page.screenshot({
      animations: 'disabled',
      path: `../.artifacts/design-qa/sidebar-clipped-${workbenchFirst ? 'reversed' : 'normal'}-light.png`,
    })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({
      animations: 'disabled',
      path: `../.artifacts/design-qa/sidebar-clipped-${workbenchFirst ? 'reversed' : 'normal'}-dark.png`,
    })
    await page.setViewportSize({ width: 900, height: 900 })
    await page.setViewportSize({ width: 1600, height: 900 })
    await widthIs(chat, 250)
    await page.reload()
    await login(page)
    await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
    await widthIs(chat, 250)
    await dragBy(page, handle, 250 * direction)
    await widthIs(chat, 40)
  })
}

test('导航在200px后连续遮蔽，56px才显示图标栏，取消恢复原宽度', async ({ page }) => {
  await openConversation(page, '夜景延时素材生成')
  const sidebar = page.getByRole('complementary', { name: '导航' })
  const handle = page.getByRole('button', { name: '调整侧栏宽度' })
  const grip = await bounds(handle)
  const origin = grip.x + grip.width / 2
  await page.mouse.move(origin, 450)
  await page.mouse.down()
  for (const width of [220, 200, 199, 160, 100, 57]) {
    await page.mouse.move(origin + width - 264, 450)
    await widthIs(sidebar, width)
    await expect(sidebar.getByRole('button', { name: '展开侧边栏' })).toHaveCount(0)
  }
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await widthIs(sidebar, 264)
  await dragBy(page, handle, -144)
  await widthIs(sidebar, 120)
  await page.screenshot({
    animations: 'disabled',
    path: '../.artifacts/design-qa/sidebar-navigation-clipped.png',
  })
  await page.reload()
  await widthIs(sidebar, 120)
  await dragBy(page, handle, -64)
  await widthIs(sidebar, 56)
  await expect(sidebar.getByRole('button', { name: '展开侧边栏' })).toBeVisible()
  await dragBy(page, handle, 1)
  await widthIs(sidebar, 57)
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
    page.getByRole('button', { name: '调整面板宽度' }),
    250 - (await bounds(chat)).width,
  )
  await widthIs(chat, 250)

  await page.getByRole('button', { name: '调整侧栏宽度' }).focus()
  await page.keyboard.press('Tab')

  await expectContainedFocus(chat.getByRole('button', { name: '交换对话与工作台' }), chat)
})

test('Shift Tab 进入裁切的工作台标签后恢复可见宽度并保留焦点', async ({ page }) => {
  await openSettledConversation(page)
  const workbench = page.getByTestId('pane-workbench')
  await dragBy(
    page,
    page.getByRole('button', { name: '调整面板宽度' }),
    (await bounds(workbench)).width - 250,
  )
  await widthIs(workbench, 250)

  await workbench.getByRole('button', { name: '交换对话与工作台' }).focus()
  await page.keyboard.press('Shift+Tab')

  await expectContainedFocus(workbench.getByRole('tab', { name: '分镜' }), workbench)
})

test('Shift Tab 进入裁切的导航用户菜单后恢复可见宽度并保留焦点', async ({ page }) => {
  await openSettledConversation(page)
  const sidebar = page.getByRole('complementary', { name: '导航' })
  const handle = page.getByRole('button', { name: '调整侧栏宽度' })
  await dragBy(page, handle, 120 - (await bounds(sidebar)).width)
  await widthIs(sidebar, 120)

  await handle.focus()
  await page.keyboard.press('Shift+Tab')

  await expectContainedFocus(sidebar.getByRole('button', { name: '用户菜单' }), sidebar)
})

for (const compactWidth of [390, 900]) {
  test(`裁切的桌面对话宽度在 ${compactWidth}px 切换内容后返回和刷新保留`, async ({ page }) => {
    await openSettledConversation(page)
    const chat = page.getByTestId('pane-chat')
    await dragBy(
      page,
      page.getByRole('button', { name: '调整面板宽度' }),
      250 - (await bounds(chat)).width,
    )
    await widthIs(chat, 250)

    await page.setViewportSize({ width: compactWidth, height: 900 })
    await page.getByRole('button', { name: '展开对话', exact: true }).click()
    await expect(page.getByLabel('输入消息')).toBeVisible()
    await page.getByRole('button', { name: '打开右侧面板', exact: true }).click()
    await expect(page.getByRole('complementary', { name: '右侧面板' })).toBeVisible()
    if (compactWidth === 900) {
      await page.getByRole('button', { name: '回到聊天', exact: true }).click()
      await expect(page.getByLabel('输入消息')).toBeVisible()
      await page.getByRole('button', { name: '折叠对话', exact: true }).click()
      await expect(page.getByRole('complementary', { name: '右侧面板' })).toBeVisible()
    }
    await page.setViewportSize({ width: 1600, height: 900 })
    await widthIs(chat, 250)

    await page.reload()
    await login(page)
    await page.getByRole('link', { name: '夜景延时素材生成', exact: true }).click()
    await widthIs(chat, 250)
  })
}
