import { expect, test, type Page } from '@playwright/test'
import { login } from './login'

test.use({ timezoneId: 'America/Los_Angeles' })

test('审计总览：快捷档与日历切时间，卡片标题跳到对应一节，清单共用时间范围', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.clock.setFixedTime(new Date('2026-09-23T06:30:00Z'))
  await page.goto('/')
  await login(page, 'governor')
  await page.getByRole('button', { name: '审计', exact: true }).click()

  const main = page.getByRole('main', { name: '审计' })
  const legend = main.getByRole('group', { name: '图例' })
  await expect(main.getByRole('article', { name: '出片件数' })).toBeVisible()
  await expect(main.getByText('数据截至 9月23日 14:30')).toBeVisible()
  await expect(
    main.getByRole('button', { name: '自定义时间范围：8月25日 – 9月23日' }),
  ).toBeVisible()
  await expect(legend.getByText('7 日均线')).toBeVisible()

  await main.getByRole('radio', { name: '今天' }).click()
  await expect(page).toHaveURL('/audit?period=today')
  await expect(legend.getByText('每小时')).toBeVisible()

  await main.getByRole('button', { name: /^自定义时间范围/ }).click()
  const picker = page.getByRole('dialog', { name: '选择时间范围' })
  await picker.getByRole('button', { name: '上月' }).click()
  await picker.getByRole('button', { name: '应用' }).click()
  await expect(page).toHaveURL('/audit?period=lastMonth')
  await expect(main.getByRole('button', { name: '自定义时间范围：8月1日 – 8月31日' })).toBeVisible()
  await expect(
    main.getByRole('region', { name: '模型消耗' }).getByText('暂无片长数据', { exact: true }),
  ).toBeVisible()

  await main.getByRole('button', { name: /^自定义时间范围/ }).click()
  await picker.getByRole('button', { name: '下个月' }).click()
  await picker.getByRole('button', { name: '9月1日', exact: true }).click()
  await picker.getByRole('button', { name: '9月7日', exact: true }).click()
  await expect(picker.getByText('9月1日 – 9月7日')).toBeVisible()
  await picker.getByRole('button', { name: '应用' }).click()
  await expect(picker).toBeHidden()
  await expect(page).toHaveURL('/audit?period=custom&from=2026-09-01&to=2026-09-07')
  await expect(main.getByText('环比对比 8月25日–31日')).toBeVisible()

  await main
    .getByRole('article', { name: '出片件数' })
    .getByRole('button', { name: '出片件数' })
    .click()
  await expect(main.getByRole('region', { name: '使用人次' })).toBeInViewport()

  await page.getByRole('tab', { name: '清单' }).click()
  await expect(page).toHaveURL('/audit?period=custom&from=2026-09-01&to=2026-09-07&tab=details')
  await expect(main.getByRole('button', { name: '自定义时间范围：9月1日 – 9月7日' })).toBeVisible()
  await page.getByRole('tab', { name: '总览' }).click()
  await expect(main.getByRole('button', { name: '自定义时间范围：9月1日 – 9月7日' })).toBeVisible()
})

test('审计总览在手机宽度不横向滚动', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.clock.setFixedTime(new Date('2026-09-23T06:30:00Z'))
  await page.goto('/')
  await login(page, 'governor')
  await page.getByRole('button', { name: '审计', exact: true }).click()
  const main = page.getByRole('main', { name: '审计' })
  await expect(main.getByRole('article', { name: '出片件数' })).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  const collapse = page.getByRole('button', { name: '折叠侧边栏' })
  if (await collapse.isVisible()) await collapse.click()
  await expect(main.getByRole('article', { name: '出片件数' })).toBeVisible()
  const overflow = await main.evaluate((element) => ({
    document: document.documentElement.scrollWidth - window.innerWidth,
    main: element.scrollWidth - element.clientWidth,
  }))
  expect(overflow).toEqual({ document: 0, main: 0 })
})

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

  await main.getByRole('button', { name: '按人筛选' }).click()
  await page.getByRole('menuitemradio', { name: 'lin.xia' }).click()
  await expect(page).toHaveURL('/audit?tab=details&userName=lin.xia')
  await expect(main.getByRole('button', { name: '按人筛选：lin.xia' })).toBeVisible()
  await expect(people.getByRole('row')).toHaveCount(2)
  const notHis = executions
    .getByRole('row')
    .filter({ hasNot: page.getByRole('cell', { name: 'lin.xia', exact: true }) })
  await expect(notHis).toHaveCount(1)

  const tokens = executions.getByRole('columnheader', { name: 'token 消耗' })
  await tokens.getByRole('button').click()
  await expect(page).toHaveURL('/audit?sort=tokens&tab=details&userName=lin.xia')
  await expect(tokens).toHaveAttribute('aria-sort', 'descending')
  await tokens.getByRole('button').click()
  await expect(page).toHaveURL('/audit?sort=tokens&order=asc&tab=details&userName=lin.xia')
  await expect(tokens).toHaveAttribute('aria-sort', 'ascending')

  const row = executions.getByRole('row').nth(1)
  await row.getByRole('cell').nth(4).click()
  await expect(row).toHaveAttribute('aria-expanded', 'true')
  await expect(main.getByRole('list', { name: '按模型用量' })).toBeVisible()
  await row.getByRole('cell').nth(4).click()
  await expect(row).toHaveAttribute('aria-expanded', 'false')
})

test('审计清单在手机宽度不横向滚动', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const main = await openDetails(page)

  await page.setViewportSize({ width: 390, height: 844 })
  const collapse = page.getByRole('button', { name: '折叠侧边栏' })
  if (await collapse.isVisible()) await collapse.click()
  await expect(main.getByRole('table', { name: '按人' })).toBeVisible()
  const overflow = await main.evaluate((element) => ({
    document: document.documentElement.scrollWidth - window.innerWidth,
    main: element.scrollWidth - element.clientWidth,
  }))
  expect(overflow).toEqual({ document: 0, main: 0 })
})
