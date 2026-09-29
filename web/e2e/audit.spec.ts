import { expect, test, type Page } from '@playwright/test'
import { login } from './login'

// 审计页按 UTC+8 统计与显示。浏览器放在洛杉矶：固定时刻 06:30Z 在那里还是 9 月 22 日，
// 页面上写的仍是 UTC+8 的 9 月 23 日，才说明日期不跟浏览器时区。
test.use({ timezoneId: 'America/Los_Angeles' })

const SCREENSHOTS = '../.artifacts/design-qa/audit-redesign'
const DETAILS_SCREENSHOTS = '../.artifacts/design-qa/audit-details'

/** 审计页的滚动容器是 <main>：先截首屏，再把视口拉到内容全高截一张整页，截完恢复。 */
const screenshotPage = async (page: Page, name: string) => {
  const viewport = page.viewportSize()
  if (viewport === null) throw new Error('需要固定视口')
  await page.screenshot({ animations: 'disabled', path: `${SCREENSHOTS}/${name}.png` })
  const height = await page
    .getByRole('main', { name: '审计' })
    .evaluate((main) => main.scrollHeight + (window.innerHeight - main.clientHeight))
  await page.setViewportSize({ height, width: viewport.width })
  await page.screenshot({ animations: 'disabled', path: `${SCREENSHOTS}/${name}-full.png` })
  await page.setViewportSize(viewport)
}

const setTheme = async (page: Page, colorScheme: 'light' | 'dark') => {
  await page.emulateMedia({ colorScheme })
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
    .toBe(colorScheme === 'dark')
}

test('审计总览：快捷档与日历切时间，卡片标题跳到对应一节，清单共用时间范围', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.clock.setFixedTime(new Date('2026-09-23T06:30:00Z'))
  await page.goto('/')
  await login(page, 'governor')
  await page.getByRole('button', { name: '审计', exact: true }).click()

  const main = page.getByRole('main', { name: '审计' })
  const legend = main.getByRole('group', { name: '图例' })
  await expect(main.getByRole('article', { name: '成片数' })).toBeVisible()
  await expect(main.getByText('数据截至 9月23日 14:30')).toBeVisible()
  await expect(
    main.getByRole('button', { name: '自定义时间范围：8月25日 – 9月23日' }),
  ).toBeVisible()
  await expect(legend.getByText('7 日均线')).toBeVisible()

  // 快捷档即点即换；今天按小时分期。
  await main.getByRole('radio', { name: '今天' }).click()
  await expect(page).toHaveURL('/audit?period=today')
  await expect(legend.getByText('每小时')).toBeVisible()

  // 日历左侧的预设：上月整月都在片长有数据之前。
  await main.getByRole('button', { name: /^自定义时间范围/ }).click()
  const picker = page.getByRole('dialog', { name: '选择时间范围' })
  await picker.getByRole('button', { name: '上月' }).click()
  await picker.getByRole('button', { name: '应用' }).click()
  await expect(page).toHaveURL('/audit?period=lastMonth')
  await expect(main.getByRole('button', { name: '自定义时间范围：8月1日 – 8月31日' })).toBeVisible()
  await expect(
    main.getByRole('region', { name: '模型消耗' }).getByText('暂无片长数据', { exact: true }),
  ).toBeVisible()

  // 自定义：点起点再点终点，应用后才生效。当前是上月，日历停在七、八月，往后翻一个月。
  await main.getByRole('button', { name: /^自定义时间范围/ }).click()
  await picker.getByRole('button', { name: '下个月' }).click()
  await picker.getByRole('button', { name: '9月1日', exact: true }).click()
  await picker.getByRole('button', { name: '9月7日', exact: true }).click()
  await expect(picker.getByText('9月1日 – 9月7日')).toBeVisible()
  await picker.getByRole('button', { name: '应用' }).click()
  // 弹层退场后焦点回到日期按钮，等它关干净再往下点，免得焦点把滚动拉回顶部。
  await expect(picker).toBeHidden()
  await expect(page).toHaveURL('/audit?period=custom&from=2026-09-01&to=2026-09-07')
  await expect(main.getByText('环比对比 8月25日–31日')).toBeVisible()

  // 卡片标题点了滚到下面对应的一节。
  await main
    .getByRole('article', { name: '成片数' })
    .getByRole('button', { name: '成片数' })
    .click()
  await expect(main.getByRole('region', { name: '使用人次' })).toBeInViewport()

  // 清单与总览共用时间范围，切过去再切回来都还是这一段。
  await page.getByRole('tab', { name: '清单' }).click()
  await expect(page).toHaveURL('/audit?period=custom&from=2026-09-01&to=2026-09-07&tab=details')
  await expect(main.getByRole('button', { name: '自定义时间范围：9月1日 – 9月7日' })).toBeVisible()
  await page.getByRole('tab', { name: '总览' }).click()
  await expect(main.getByRole('button', { name: '自定义时间范围：9月1日 – 9月7日' })).toBeVisible()
})

test('审计总览在桌面与手机、浅色与深色下可读，手机宽度不横向滚动', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.clock.setFixedTime(new Date('2026-09-23T06:30:00Z'))
  await page.goto('/')
  await login(page, 'governor')
  await page.getByRole('button', { name: '审计', exact: true }).click()
  const main = page.getByRole('main', { name: '审计' })
  await expect(main.getByRole('article', { name: '成片数' })).toBeVisible()

  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme)
    await screenshotPage(page, `desktop-${theme}`)
  }

  await main.getByRole('button', { name: /^自定义时间范围/ }).click()
  await setTheme(page, 'light')
  await page.screenshot({ animations: 'disabled', path: `${SCREENSHOTS}/range-picker-light.png` })
  await page.keyboard.press('Escape')

  await page.setViewportSize({ width: 390, height: 844 })
  const collapse = page.getByRole('button', { name: '折叠侧边栏' })
  if (await collapse.isVisible()) await collapse.click()
  await expect(main.getByRole('article', { name: '成片数' })).toBeVisible()
  const overflow = await main.evaluate((element) => ({
    document: document.documentElement.scrollWidth - window.innerWidth,
    main: element.scrollWidth - element.clientWidth,
  }))
  expect(overflow).toEqual({ document: 0, main: 0 })
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme)
    await screenshotPage(page, `mobile-${theme}`)
  }
})

/** 登录治理者、进审计页的清单标签。 */
const openDetails = async (page: Page) => {
  await page.clock.setFixedTime(new Date('2026-09-23T06:30:00Z'))
  await page.goto('/')
  await login(page, 'governor')
  await page.getByRole('button', { name: '审计', exact: true }).click()
  await page.getByRole('tab', { name: '清单' }).click()
  await expect(page).toHaveURL('/audit?tab=details')
  const main = page.getByRole('main', { name: '审计' })
  await expect(main.getByRole('table', { name: '按人' })).toBeVisible()
  await expect(main.getByRole('table', { name: '按任务执行次数' })).toBeVisible()
  return main
}

test('审计清单：按人筛选两张表都变，表头排序进地址，点整行展开', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const main = await openDetails(page)
  const people = main.getByRole('table', { name: '按人' })
  const executions = main.getByRole('table', { name: '按任务执行次数' })

  // 筛人：按人表只剩他，按任务执行每一行都是他。
  await main.getByRole('button', { name: '按人筛选' }).click()
  await page.getByRole('menuitemradio', { name: 'lin.xia' }).click()
  await expect(page).toHaveURL('/audit?tab=details&userName=lin.xia')
  await expect(main.getByRole('button', { name: '按人筛选：lin.xia' })).toBeVisible()
  await expect(people.getByRole('row')).toHaveCount(2)
  const notHis = executions
    .getByRole('row')
    .filter({ hasNot: page.getByRole('cell', { name: 'lin.xia', exact: true }) })
  // 只剩表头那一行。
  await expect(notHis).toHaveCount(1)

  // 表头排序走接口，排序记在地址里。
  const tokens = executions.getByRole('columnheader', { name: 'token 消耗' })
  await tokens.getByRole('button').click()
  await expect(page).toHaveURL('/audit?sort=tokens&tab=details&userName=lin.xia')
  await expect(tokens).toHaveAttribute('aria-sort', 'descending')
  await tokens.getByRole('button').click()
  await expect(page).toHaveURL('/audit?sort=tokens&order=asc&tab=details&userName=lin.xia')
  await expect(tokens).toHaveAttribute('aria-sort', 'ascending')

  // 点整行展开，再点收起。
  const row = executions.getByRole('row').nth(1)
  await row.getByRole('cell').nth(4).click()
  await expect(row).toHaveAttribute('aria-expanded', 'true')
  await expect(main.getByRole('list', { name: '按模型用量' })).toBeVisible()
  await row.getByRole('cell').nth(4).click()
  await expect(row).toHaveAttribute('aria-expanded', 'false')
})

test('审计清单在桌面与手机、浅色与深色下可读，手机宽度不横向滚动', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const main = await openDetails(page)
  const shot = (name: string) =>
    page.screenshot({ animations: 'disabled', path: `${DETAILS_SCREENSHOTS}/${name}.png` })

  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme)
    await shot(`desktop-${theme}`)
  }
  await setTheme(page, 'light')

  await main.getByRole('button', { name: '按人筛选' }).click()
  await expect(page.getByRole('menu')).toBeVisible()
  await shot('filter-menu-light')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toBeHidden()

  // 展开一行，把它滚到视口中间再截。
  const row = main.getByRole('table', { name: '按任务执行次数' }).getByRole('row').nth(1)
  await row.focus()
  await page.keyboard.press('Enter')
  await expect(row).toHaveAttribute('aria-expanded', 'true')
  await main.getByRole('list', { name: '按模型用量' }).scrollIntoViewIfNeeded()
  await shot('expanded-light')
  await page.keyboard.press('Enter')
  await row.blur()

  await page.setViewportSize({ width: 390, height: 844 })
  const collapse = page.getByRole('button', { name: '折叠侧边栏' })
  if (await collapse.isVisible()) await collapse.click()
  await main.evaluate((element) => element.scrollTo({ top: 0 }))
  await expect(main.getByRole('table', { name: '按人' })).toBeVisible()
  const overflow = await main.evaluate((element) => ({
    document: document.documentElement.scrollWidth - window.innerWidth,
    main: element.scrollWidth - element.clientWidth,
  }))
  expect(overflow).toEqual({ document: 0, main: 0 })
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme)
    await shot(`mobile-${theme}`)
  }
})
