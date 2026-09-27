import { expect, test, type Page } from '@playwright/test'
import { login } from './login'

// 日期与分期都按浏览器时区算；固定时区与时刻，按钮上的日期和截图才稳定。
test.use({ timezoneId: 'Asia/Singapore' })

const SCREENSHOTS = '../.artifacts/design-qa/audit-redesign'

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

test('审计总览：快捷档与日历切时间，卡片标题跳到对应一节，其余标签照常', async ({ page }) => {
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

  // 其余标签照旧带自己的筛选条，切回总览时间范围还在。
  await page.getByRole('tab', { name: '异常' }).click()
  await expect(main.getByRole('region', { name: '异常列表' })).toBeVisible()
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
