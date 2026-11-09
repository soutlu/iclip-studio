import { expect, test, type Locator, type Page } from '@playwright/test'
import { login } from './login'

test.use({ viewport: { height: 900, width: 1440 } })

const bounds = async (locator: Locator) => {
  const box = await locator.boundingBox()
  if (!box) throw new Error('布局控件没有可测量的位置')
  return box
}

const widthIs = async (locator: Locator, width: number) => {
  await expect.poll(async () => (await bounds(locator)).width).toBeCloseTo(width, 0)
}

const dragBy = async (page: Page, handle: Locator, delta: number) => {
  const box = await bounds(handle)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + delta, y, { steps: 10 })
  await page.mouse.up()
}

test('Agent 配置两栏可拖宽，普通与长文本面板各记各的宽度，刷新后保留，双击恢复默认', async ({
  page,
}) => {
  await page.goto('/')
  await login(page, 'governor')
  await page.getByRole('button', { name: 'Agent 配置' }).click()
  await expect(page).toHaveURL(/\/agents/)

  const main = page.getByRole('main', { name: 'Agent 配置' })
  const editor = main.getByRole('region', { name: 'Agent 配置编辑器' })
  const preview = main.getByRole('region', { name: 'Agent 预览' })
  const handle = main.getByRole('button', { name: '调整 Agent 配置栏宽度' })
  const openSkillEditor = async () => {
    await main.getByRole('tab', { name: '技能库' }).click()
    await main
      .getByRole('button', { name: /^编辑技能：/ })
      .first()
      .click()
    await expect(main.getByRole('region', { name: '配置调整' })).toBeVisible()
  }
  const backToAgent = async () => {
    await main.getByRole('tab', { name: 'Agent' }).click()
    await expect(preview).toBeVisible()
  }

  await expect(preview).toBeVisible()
  const total = (await bounds(editor)).width + (await bounds(preview)).width
  const normalDefault = total / 2
  await widthIs(editor, normalDefault)
  await widthIs(preview, normalDefault)

  await dragBy(page, handle, 120)
  await widthIs(editor, normalDefault + 120)
  await widthIs(preview, normalDefault - 120)
  await expect
    .poll(async () => (await bounds(preview)).x)
    .toBeCloseTo((await bounds(editor)).x + normalDefault + 120, 0)

  await openSkillEditor()
  const wideDefault = (total * 2) / 5
  await widthIs(editor, wideDefault)
  await dragBy(page, handle, 80)
  await widthIs(editor, wideDefault + 80)

  await backToAgent()
  await widthIs(editor, normalDefault + 120)

  await page.reload()
  await login(page, 'governor')
  await page.getByRole('button', { name: 'Agent 配置' }).click()
  await expect(preview).toBeVisible()
  await widthIs(editor, normalDefault + 120)
  await openSkillEditor()
  await widthIs(editor, wideDefault + 80)

  await handle.dblclick()
  await widthIs(editor, wideDefault)
  await backToAgent()
  await widthIs(editor, normalDefault + 120)
  await handle.dblclick()
  await widthIs(editor, normalDefault)
  await widthIs(preview, normalDefault)

  await page.setViewportSize({ height: 900, width: 700 })
  await expect(editor).toBeVisible()
  await expect(handle).toBeHidden()
})
