import { expect, test } from '@playwright/test'
import { login } from './login'

test('治理者在灵感库管理标签：添加取值后回到列表，筛选里出现它', async ({ page }) => {
  await page.goto('/')
  await login(page, 'governor')
  await page.getByRole('button', { name: '资料库' }).click()
  await page.getByRole('tab', { name: '灵感库' }).click()
  const main = page.getByRole('main', { name: '资料库' })
  await expect(main.getByRole('article').first()).toBeVisible()

  await main.getByRole('button', { name: '管理标签' }).click()
  const panel = main.getByRole('region', { name: '管理标签' })
  await expect(main.getByRole('article')).toHaveCount(0)
  await expect(panel.getByRole('heading', { name: '场景' })).toBeVisible()
  await panel.getByRole('button', { name: '给场景添加标签' }).click()
  await panel.getByRole('textbox', { name: '场景的标签名称' }).fill('海边度假')
  await panel.getByRole('button', { name: '添加', exact: true }).click()
  await expect(
    panel.getByRole('list', { name: '场景的标签' }).getByText('海边度假', { exact: true }),
  ).toBeVisible()

  await panel.getByRole('button', { name: '完成' }).click()
  await expect(panel).toBeHidden()
  await expect(main.getByRole('article').first()).toBeVisible()
  await main.getByRole('button', { name: '场景：场景' }).click()
  await expect(
    page.getByRole('dialog', { name: '选择场景' }).getByRole('checkbox', { name: /^海边度假/ }),
  ).toBeVisible()
})

test('三级标签连续创建后可补充到资料，父级筛选覆盖最末级', async ({ page }) => {
  await page.goto('/')
  await login(page, 'governor')
  await page.getByRole('button', { name: '资料库' }).click()
  await page.getByRole('tab', { name: '爆款素材库' }).click()
  const main = page.getByRole('main', { name: '资料库' })
  await main.getByRole('button', { name: '管理标签' }).click()
  const panel = main.getByRole('region', { name: '管理标签' })

  await panel.getByRole('button', { name: '给场景添加标签' }).click()
  const topName = panel.getByRole('textbox', { name: '场景的标签名称' })
  await topName.fill('旅行出行')
  await topName.press('Enter')
  await expect(topName).toHaveValue('')
  await panel.getByRole('button', { name: '给旅行出行添加下级' }).click()
  const groupName = panel.getByRole('textbox', { name: '旅行出行的小类名称' })
  await groupName.fill('海边度假')
  await groupName.press('Enter')
  await expect(groupName).toHaveValue('')
  await panel.getByRole('button', { name: '给海边度假添加下级' }).click()
  const leafName = panel.getByRole('textbox', { name: '海边度假的小类名称' })
  const leaf = '海边/港口沿岸长距离散步（透气/防滑/轻便）'
  await leafName.fill(leaf)
  await leafName.press('Enter')
  await expect(leafName).toHaveValue('')
  await expect(leafName).toBeFocused()
  await page.keyboard.insertText('沙滩玩水')
  await page.keyboard.press('Enter')
  await expect(leafName).toHaveValue('')
  await page.keyboard.press('Escape')
  await expect(leafName).toBeHidden()
  await expect(panel.getByRole('button', { name: `给${leaf}添加下级` })).toHaveCount(0)
  const children = panel.getByRole('list', { name: '海边度假的小类' })
  await expect(children.getByText(leaf, { exact: true })).toBeVisible()
  await expect(children.getByText('沙滩玩水', { exact: true })).toBeVisible()

  const search = panel.getByRole('textbox', { name: '搜索标签名称' })
  await search.fill('港口沿岸')
  await expect(panel.getByRole('button', { name: '旅行出行', exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: '海边度假', exact: true })).toBeVisible()
  await expect(panel.getByText(leaf, { exact: true })).toBeVisible()
  await search.clear()
  await panel.getByRole('button', { name: '完成' }).click()

  const title = '春夏凉鞋合集'
  await main.getByRole('button', { name: `查看详情：${title}`, exact: true }).click()
  const viewer = page.getByRole('dialog', { name: title, exact: true })
  await viewer.getByRole('tab', { name: '爆款素材', exact: true }).click()
  await viewer.getByRole('button', { name: '添加场景', exact: true }).click()
  const picker = page.getByRole('dialog', { name: '添加场景', exact: true })
  await picker.getByRole('combobox', { name: '搜索场景', exact: true }).fill('港口沿岸')
  await picker.getByRole('option', { name: leaf, exact: true }).click()
  await expect(picker).toBeHidden()
  await expect(
    viewer.getByRole('group', { name: '场景', exact: true }).getByText(leaf),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(viewer).toBeHidden()
  await main.getByRole('button', { name: '场景：场景' }).click()
  await page
    .getByRole('dialog', { name: '选择场景' })
    .getByRole('checkbox', { name: /^旅行出行/ })
    .click()
  await page.keyboard.press('Escape')
  await expect(main.getByRole('article')).toHaveCount(1)
  await expect(main.getByRole('article', { name: title })).toBeVisible()
})
