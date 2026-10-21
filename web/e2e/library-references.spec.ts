import { expect, test } from '@playwright/test'
import { login } from './login'

const SAMPLE_VIDEO = new URL('../src/testing/fixtures/sample-video.mp4', import.meta.url).pathname

test('资料库切到灵感库，页签与标签筛选都在地址里，退回还原；键盘能切页签', async ({ page }) => {
  await page.goto('/')
  await login(page, 'tester')
  await page.getByRole('button', { name: '资料库' }).click()

  const tabs = page.getByRole('tablist', { name: '资料库内容' }).getByRole('tab')
  await expect(tabs).toHaveText(['成片素材', '灵感库', '成片'])
  const videosTab = page.getByRole('tab', { name: '成片素材' })
  await expect(videosTab).toHaveAttribute('aria-selected', 'true')
  await videosTab.focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: '灵感库' })).toHaveAttribute('aria-selected', 'true')
  await expect(page).toHaveURL(/tab=references/)

  const main = page.getByRole('main', { name: '资料库' })
  await expect(main.getByText('共 13 条')).toBeVisible()

  // 选大类也算它的小类：开箱测评型本身一条，标准开箱流程一条。
  await main.getByRole('button', { name: '内容结构：内容结构' }).click()
  const structure = page.getByRole('dialog', { name: '选择内容结构' })
  await structure.getByRole('option', { name: /开箱测评型/ }).click()
  await expect(main.getByText('找到 2 条')).toBeVisible()
  // 不同维度都要命中。
  await main.getByRole('button', { name: '品类：品类' }).click()
  const category = page.getByRole('dialog', { name: '选择品类' })
  await category.getByRole('combobox', { name: '搜索品类' }).fill('拖鞋')
  await category.getByRole('option', { name: /^拖鞋/ }).click()
  await expect(main.getByText('找到 2 条')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/tags=/)

  // mock 会话不跨刷新保存，用离开再退回验证页签与筛选从地址还原。
  await page.getByRole('button', { name: '需求单' }).click()
  await expect(page).toHaveURL('/tasks')
  await page.goBack()
  await expect(page.getByRole('tab', { name: '灵感库' })).toHaveAttribute('aria-selected', 'true')
  await expect(main.getByRole('button', { name: '内容结构：开箱测评型' })).toBeVisible()
  await expect(main.getByRole('button', { name: '品类：拖鞋' })).toBeVisible()
  await expect(main.getByText('找到 2 条')).toBeVisible()
})

test('属主试生成：提交后显示生成中，完成后原片与试生成两格左右并排', async ({ page }) => {
  await page.goto('/')
  await login(page, 'tester')
  await page.getByRole('button', { name: '资料库' }).click()
  await page.getByRole('tab', { name: '灵感库' }).click()
  const main = page.getByRole('main', { name: '资料库' })

  const name = 'TikTok · 短靴 · 卫衣 · 裤子 · 户外/公园散步 · 动态上身展示'
  await main
    .getByRole('article', { name })
    .getByRole('button', { name: /查看详情/ })
    .click()
  const dialog = page.getByRole('dialog', { name })
  await expect(dialog.getByText('用拆解试生成')).toBeVisible()

  // 读到原片元数据（画幅）后按钮才可点，click 会等到它可点。
  await dialog.getByRole('button', { name: '试生成', exact: true }).click()
  await expect(dialog.getByRole('status').filter({ hasText: '试生成中' })).toBeVisible()

  // mock 提交 5 秒后完成，详情每 5 秒轮询一次。
  const tested = dialog.getByRole('group', { name: '播放器：试生成' })
  await expect(tested).toBeVisible({ timeout: 15_000 })
  await expect(dialog.getByRole('button', { name: '重新试生成' })).toBeVisible()

  const original = await dialog.getByRole('group', { name: '播放器：原片' }).boundingBox()
  const result = await tested.boundingBox()
  expect(original).not.toBeNull()
  expect(result).not.toBeNull()
  if (original === null || result === null) return
  // 竖版原片：两格同高、同一行，试生成在原片右边。
  expect(Math.abs(result.y - original.y)).toBeLessThan(1)
  expect(Math.abs(result.height - original.height)).toBeLessThan(1)
  expect(result.x).toBeGreaterThanOrEqual(original.x + original.width)
})

test('上传一条视频：先排队、拆完接着打标、打完自动出标签；改拆解保存；同一个文件再传一次打开原来那条', async ({
  page,
}) => {
  await page.goto('/')
  await login(page, 'tester')
  await page.getByRole('button', { name: '资料库' }).click()
  await page.getByRole('tab', { name: '灵感库' }).click()
  const main = page.getByRole('main', { name: '资料库' })
  await expect(main.getByText('共 13 条')).toBeVisible()

  const upload = async () => {
    const chooser = page.waitForEvent('filechooser')
    await main.getByRole('button', { name: '上传视频' }).click()
    await (await chooser).setFiles(SAMPLE_VIDEO)
  }

  await upload()
  await expect(main.getByText('共 14 条')).toBeVisible()
  const newest = main.getByRole('article').first()
  await expect(newest.getByText(/排队中|拆解中/)).toBeVisible()
  // mock 几秒后拆完、再过几秒打完标，列表每 5 秒轮询一次。
  const tagged = '拖鞋 · 居家/日常放松 · 标准开箱流程'
  await expect(newest).toHaveAccessibleName(tagged, { timeout: 20_000 })

  await newest.getByRole('button', { name: /查看详情/ }).click()
  const dialog = page.getByRole('dialog', { name: tagged })
  await expect(dialog.getByRole('heading', { name: '出场元素' })).toBeVisible()
  await dialog.getByRole('button', { name: '编辑拆解' }).click()
  const editor = dialog.getByRole('textbox', { name: '拆解' })
  await editor.fill('# 我的拆解\n\n只留一句话。')
  await dialog.getByRole('button', { name: '保存' }).click()
  await expect(dialog.getByText('只留一句话。')).toBeVisible()
  await expect(editor).toBeHidden()

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  await upload()
  await expect(page.getByText('该视频此前已上传，已打开其详情')).toBeVisible()
  await expect(dialog.getByText('只留一句话。')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(main.getByText('共 14 条')).toBeVisible()
})
