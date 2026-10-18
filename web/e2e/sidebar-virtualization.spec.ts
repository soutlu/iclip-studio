/// <reference lib="dom" />

import { expect, test, type Locator, type Page, type Response } from '@playwright/test'
import { pauseMockResponses, releaseMockResponses } from './helpers'
import { login } from './login'

const COLLECTION_NAME = '千条历史任务'
const COLLECTION_ID = '10000000-0000-4000-8000-000000000000'
const SESSION_COUNT = 1000
const sessionTitle = (number: number) => `历史任务 ${String(number).padStart(4, '0')}`
const paginationPath = `/api/conversations/by-collection/${COLLECTION_ID}`
// 菜单打开时 Radix 会将背景标为 aria-hidden，滚动容器仍在；保留它供离屏交互测试操作。
const listOf = (page: Page) =>
  page.getByRole('region', { name: '任务列表', exact: true, includeHidden: true })
const sessionRows = (page: Page) => listOf(page).getByRole('link', { name: /^历史任务 \d{4}$/ })
const scrollTopOf = (list: Locator) => list.evaluate((element) => element.scrollTop)

const pageEnded = async (response: Response) => {
  if (new URL(response.url()).pathname !== paginationPath) return false
  const payload = (await response.json()) as { nextCursor: string | null }
  return payload.nextCursor === null
}

const prepareHistory = async (page: Page) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(() => {
    window.localStorage.setItem('cue.mock.sidebar-large-collection', 'true')
  })
  await page.goto('/')
  await login(page)
  await expect(
    page.getByRole('button', { name: `${COLLECTION_NAME} (${SESSION_COUNT})`, exact: true }),
  ).toBeVisible()
}

const expandHistory = async (page: Page) => {
  const complete = page.waitForResponse(pageEnded)
  await page
    .getByRole('button', { name: `${COLLECTION_NAME} (${SESSION_COUNT})`, exact: true })
    .click()
  await complete
  await expect(listOf(page).getByRole('link', { name: sessionTitle(1), exact: true })).toBeVisible()
}

test('展开千条合集自动读全，只挂载视口附近的行，滚到底可打开最后一条', async ({ page }) => {
  await prepareHistory(page)
  const pageRequests: string[] = []
  const transcriptRequests: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path === paginationPath) pageRequests.push(request.url())
    if (path.endsWith('/transcript')) transcriptRequests.push(request.url())
  })
  await expandHistory(page)

  expect(pageRequests).toHaveLength(100)
  expect(transcriptRequests).toHaveLength(0)
  expect(await scrollTopOf(listOf(page))).toBe(0)
  expect(await sessionRows(page).count()).toBeLessThan(SESSION_COUNT)
  const earlyRow = listOf(page).getByRole('link', { name: sessionTitle(3), exact: true })
  await expect(earlyRow).toBeInViewport()

  await listOf(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  const last = listOf(page).getByRole('link', { name: sessionTitle(SESSION_COUNT), exact: true })
  await expect(last).toBeVisible()
  expect(await sessionRows(page).count()).toBeLessThan(SESSION_COUNT)
  await expect(earlyRow).toHaveCount(0)
  await last.click()
  await expect(page).toHaveURL(/\/c\/10000000-0000-4000-8000-000000001000$/)
})

test('改名输入框滚出视口后保留草稿，保存后顺序和滚动位置不变', async ({ page }) => {
  await prepareHistory(page)
  await expandHistory(page)
  const list = listOf(page)
  const title = sessionTitle(2)
  const renamed = '历史任务 0002 · 已改名'
  const row = list.getByRole('link', { name: title, exact: true })
  await row.hover()
  await list.getByRole('button', { name: `${title} 的更多操作`, exact: true }).click()
  await list.evaluate((element) => {
    element.scrollTop = 5000
  })
  await expect(page.getByRole('menuitem', { name: '重命名', exact: true })).toBeVisible()
  await list.evaluate((element) => {
    element.scrollTop = 0
  })
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
  const input = list.getByRole('textbox', { name: `重命名 ${title}`, exact: true })
  await input.fill(renamed)

  await list.evaluate((element) => {
    element.scrollTop = 5000
  })
  await expect.poll(() => scrollTopOf(list)).toBe(5000)
  await expect(input).toBeAttached()
  await expect(input).toBeFocused()
  expect(await sessionRows(page).count()).toBeLessThan(SESSION_COUNT)

  await list.evaluate((element) => {
    element.scrollTop = 0
  })
  await expect(input).toBeVisible()
  await expect(input).toHaveValue(renamed)
  await input.press('Enter')
  const saved = list.getByRole('link', { name: renamed, exact: true })
  await expect(saved).toBeFocused()
  expect(await scrollTopOf(list)).toBe(0)
  const names = await list.getByRole('link').allTextContents()
  expect(names.indexOf(renamed)).toBe(names.indexOf(sessionTitle(1)) + 1)
  expect(names.indexOf(sessionTitle(3))).toBe(names.indexOf(renamed) + 1)
})

test('缩小窗口后关闭会话菜单，焦点返回已离开视口的原按钮', async ({ page }) => {
  await prepareHistory(page)
  await expandHistory(page)
  const list = listOf(page)
  const title = sessionTitle(12)
  await list.getByRole('link', { name: title, exact: true }).hover()
  const trigger = list.getByRole('button', { name: `${title} 的更多操作`, exact: true })
  await trigger.click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()

  await page.setViewportSize({ width: 1440, height: 450 })
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(trigger).toBeFocused()
  await expect(trigger).toBeInViewport({ ratio: 1 })
})

for (const kind of ['会话', '合集'] as const) {
  test(`离屏关闭${kind}菜单后焦点回到原按钮，离开后释放该行`, async ({ page }) => {
    await prepareHistory(page)
    await expandHistory(page)
    const list = listOf(page)
    const title = sessionTitle(12)
    const row =
      kind === '会话'
        ? list.getByRole('link', { name: title, exact: true })
        : list.getByRole('button', {
            name: `${COLLECTION_NAME} (${SESSION_COUNT})`,
            exact: true,
          })
    const trigger = list.getByRole('button', {
      name: kind === '会话' ? `${title} 的更多操作` : `${COLLECTION_NAME} 的操作`,
      exact: true,
    })
    await row.hover()
    await trigger.click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await list.evaluate((element) => {
      element.scrollTop = 5000
    })
    await expect.poll(() => scrollTopOf(list)).toBe(5000)
    await expect(menu).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(trigger).toBeFocused()
    await expect(trigger).toBeInViewport({ ratio: 1 })

    await page.getByRole('button', { name: '用户菜单', exact: true }).focus()
    await list.evaluate((element) => {
      element.scrollTop = 5000
    })
    await expect.poll(() => scrollTopOf(list)).toBe(5000)
    await expect(trigger).toHaveCount(0)
  })
}

test('Tab 与 Shift+Tab 连续走过未挂载的历史行，Enter 可打开聚焦的会话', async ({ page }) => {
  await prepareHistory(page)
  await expandHistory(page)
  const list = listOf(page)
  await list.getByRole('link', { name: sessionTitle(1), exact: true }).focus()

  for (let number = 1; number < 46; number += 1) {
    await page.keyboard.press('Tab')
    await expect(
      list.getByRole('button', { name: `${sessionTitle(number)} 的更多操作`, exact: true }),
    ).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(
      list.getByRole('link', { name: sessionTitle(number + 1), exact: true }),
    ).toBeFocused()
  }
  expect(await scrollTopOf(list)).toBeGreaterThan(0)
  expect(await sessionRows(page).count()).toBeLessThan(SESSION_COUNT)

  await page.keyboard.press('Shift+Tab')
  await expect(
    list.getByRole('button', { name: `${sessionTitle(45)} 的更多操作`, exact: true }),
  ).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(list.getByRole('link', { name: sessionTitle(45), exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/c\/10000000-0000-4000-8000-000000000045$/)

  await list.evaluate((element) => {
    element.scrollTop = 0
  })
  const footer = page.getByRole('button', { name: '用户菜单', exact: true })
  await footer.focus()
  await page.keyboard.press('Shift+Tab')
  await expect(
    list.getByRole('button', { name: '夜景延时素材生成 的更多操作', exact: true }),
  ).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(footer).toBeFocused()
})

test('连续追加剩余分页和切换会话不改变侧栏的阅读位置', async ({ page }) => {
  await prepareHistory(page)
  const complete = page.waitForResponse(pageEnded)
  const middle = page.waitForResponse(async (response) => {
    if (new URL(response.url()).pathname !== paginationPath) return false
    const payload = (await response.json()) as { items: { title: string }[] }
    return payload.items.some((item) => item.title === sessionTitle(200))
  })
  await page
    .getByRole('button', { name: `${COLLECTION_NAME} (${SESSION_COUNT})`, exact: true })
    .click()
  await middle
  const list = listOf(page)
  await list.evaluate((element) => {
    element.scrollTop = 2500
  })
  await expect.poll(() => scrollTopOf(list)).toBe(2500)
  await complete
  expect(await scrollTopOf(list)).toBe(2500)

  // 虚拟列表的 overscan 行也有盒子；选择与滚动区实际相交的一行。
  const listBounds = await list.boundingBox()
  if (listBounds === null) throw new Error('任务列表必须可见')
  const rows = await sessionRows(page).all()
  const inside = []
  for (const row of rows) {
    const bounds = await row.boundingBox()
    if (
      bounds &&
      bounds.y >= listBounds.y + 40 &&
      bounds.y + bounds.height <= listBounds.y + listBounds.height
    ) {
      inside.push(row)
    }
  }
  const target = inside[0]
  if (target === undefined) throw new Error('滚动后的视口必须显示历史任务')
  const href = await target.getAttribute('href')
  if (href === null) throw new Error('任务链接必须有会话地址')
  await target.click()
  await expect(page).toHaveURL(href)
  await expect.poll(() => scrollTopOf(list)).toBe(2500)
})

test('上方合集继续追加时，下方正在阅读的未分组会话留在原来的屏幕位置', async ({ page }) => {
  await prepareHistory(page)
  await page.setViewportSize({ width: 1440, height: 600 })
  await pauseMockResponses(page, paginationPath)
  const complete = page.waitForResponse(pageEnded)
  const firstContinuation = page.waitForRequest(
    (request) => new URL(request.url()).pathname === paginationPath,
  )
  await page
    .getByRole('button', { name: `${COLLECTION_NAME} (${SESSION_COUNT})`, exact: true })
    .click()
  await firstContinuation
  const list = listOf(page)
  await list.hover()
  await page.mouse.wheel(0, 100_000)
  const reading = list.getByRole('link', { name: '夜景延时素材生成', exact: true })
  await expect(reading).toBeInViewport({ ratio: 1 })
  const before = await reading.boundingBox()
  if (before === null) throw new Error('未分组任务必须在视口内')
  const initialScrollTop = await scrollTopOf(list)
  const listTop = (await list.boundingBox())?.y ?? 0
  const firstVisibleTitle = await list
    .getByRole('link')
    .evaluateAll(
      (links, top) => links.find((link) => link.getBoundingClientRect().top >= top)?.textContent,
      listTop,
    )
  expect(firstVisibleTitle).toBeDefined()
  expect(firstVisibleTitle).not.toMatch(/^历史任务 /)
  await releaseMockResponses(page, paginationPath)

  await complete
  await expect
    .poll(async () => {
      const after = await reading.boundingBox()
      return after === null ? Number.POSITIVE_INFINITY : Math.abs(after.y - before.y)
    })
    .toBeLessThanOrEqual(1)
  expect(await scrollTopOf(list)).toBeGreaterThan(initialScrollTop + 1000)
  expect(await sessionRows(page).count()).toBeLessThan(SESSION_COUNT)
})

test('拖拽期间滚出源行，再移到任务区和原合集都正常且不误打开会话', async ({ page }) => {
  await prepareHistory(page)
  await expandHistory(page)
  const list = listOf(page)
  const title = sessionTitle(1)

  const dragAcrossList = async (source: Locator, scrollToEnd: boolean, target: Locator) => {
    await source.scrollIntoViewIfNeeded()
    const start = await source.boundingBox()
    if (start === null) throw new Error('拖拽源必须可见')
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
    await page.mouse.down()
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2 + 12, { steps: 4 })
    // 源行可能在滚动区边缘；先将指针移到中间，避免 dnd-kit 的边缘自动滚动与下方滚动互相拉扯。
    const bounds = await list.boundingBox()
    if (bounds === null) throw new Error('任务列表必须可见')
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 4 })
    await list.evaluate((element, end) => {
      element.scrollTop = end ? element.scrollHeight : 0
    }, scrollToEnd)
    await expect(target).toBeVisible()
    await target.hover()
    await page.mouse.up()
  }

  const movedOut = page.waitForResponse(pageEnded)
  await dragAcrossList(
    list.getByRole('link', { name: title, exact: true }),
    true,
    list.getByRole('heading', { name: '任务', exact: true }),
  )
  await movedOut
  await expect(page).toHaveURL('/')
  const source = list.getByRole('link', { name: title, exact: true })
  await expect(source).toHaveCount(1)
  await expect(source).toBeVisible()
  const movedBack = page.waitForResponse(pageEnded)
  await dragAcrossList(
    source,
    false,
    list.getByRole('button', { name: `${COLLECTION_NAME} (999)`, exact: true }),
  )
  await movedBack
  await expect(page).toHaveURL('/')
  await expect(
    list.getByRole('button', { name: `${COLLECTION_NAME} (1000)`, exact: true }),
  ).toBeVisible()
  await expect(source).toBeVisible()
})
