import { expect, test, type Locator, type Page } from '@playwright/test'
import type { WholeFilmDocument } from '../src/shared/api/generated/types.gen'
import { openConversation } from './helpers'

// 组件来自组装好的测试组件库（web/scripts/hyperframes-fixtures/）。

/** 演示对话里有两首音乐；打开它的成片编辑器 */
const openWholeFilm = async (page: Page) => {
  const panel = await openConversation(page, '夜景延时素材生成')
  await panel.getByRole('button', { name: '成片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '夜景延时素材生成' })
  await expect(dialog).toBeVisible()
  return dialog
}

const chips = (dialog: Locator, name: '品牌' | '分类') =>
  dialog.getByRole('radiogroup', { name, exact: true })

/** 切到「通用」栏的某个分类 */
const openCategory = async (dialog: Locator, category: string) => {
  await dialog.getByRole('tab', { name: '通用' }).click()
  await chips(dialog, '分类')
    .getByRole('radio', { name: new RegExp(`^${category}\\s*\\d+$`) })
    .click()
}

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox()
  if (box === null) throw new Error('元素尚未布局')
  return box
}

/** 在卡片上按下并拿起（移过拖动阈值），不松手 */
const liftCard = async (page: Page, card: Locator) => {
  // 网格里靠下的卡片可能在侧栏的可见范围外，先滚进来
  await card.scrollIntoViewIfNeeded()
  const from = await boxOf(card)
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2 + 20, { steps: 4 })
}

/** 从卡片按下、拖到 target 中间松手 */
const dragCard = async (page: Page, card: Locator, target: Locator) => {
  await liftCard(page, card)
  const to = await boxOf(target)
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 })
  await page.mouse.up()
}

/** 画面轨上各段的左边缘，用于核对预演让位与特效不移动画面轨上的段。 */
const clipLefts = (film: Locator) =>
  film
    .getByRole('group', { name: /^第 \d+ 段/ })
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().left))

const readDraft = (page: Page) =>
  page.evaluate(async () => {
    const conversation = location.pathname.split('/').at(-1)
    const response = await fetch(`/api/conversations/${conversation}/whole-film/draft`)
    return ((await response.json()) as { document: WholeFilmDocument | null }).document
  })

const pixelsPerSecond = async (dialog: Locator) => {
  const ruler = dialog.getByRole('slider', { name: '时间线播放位置' })
  return (await boxOf(ruler)).width / Number(await ruler.getAttribute('max'))
}

/** 在素材区「镜头组 2」选一个镜头，按 Enter 插到播放头处，让画面轨上有画面 */
const addShot = async (dialog: Locator, shot: number) => {
  const materials = dialog
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
  await materials.getByRole('button', { name: new RegExp(`^生成 A 镜头 ${shot}，`) }).click()
  await dialog.page().keyboard.press('Enter')
}

test('品牌卡和别的卡一样：点它按组件类型放，拖到哪条轨就放在哪', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const dialog = await openWholeFilm(page)
  await dialog.getByRole('tab', { name: '品牌' }).click()

  // 点卡片：block 进画面轨；它的字体项默认是品牌字体，放下随即打开浮层
  await dialog.getByRole('button', { name: /^示例品牌 片尾，画面轨/ }).click()
  const film = dialog.getByRole('group', { name: '画面轨', exact: true })
  await expect(film.getByRole('group', { name: /^第 1 段 · 组件 · 示例品牌 片尾/ })).toBeVisible()
  await expect(
    film.getByRole('button', { name: /^选中：第 1 段 · 组件 · 示例品牌 片尾/ }),
  ).toHaveAttribute('aria-pressed', 'true')
  const pop = page.getByRole('dialog', { name: /示例品牌 片尾/ })
  await expect(pop.getByLabel('字体')).toHaveText('示例品牌')
  await page.keyboard.press('Escape')
  await expect(pop).toBeHidden()

  // 拖到特效轨
  await dragCard(
    page,
    dialog.getByRole('button', { name: /^示例品牌 片尾，/ }),
    dialog.getByRole('group', { name: '特效轨' }),
  )
  await expect(dialog.getByRole('group', { name: /^特效 · 示例品牌 片尾/ })).toBeVisible()
})

test('放下有可填项的卡片随即打开浮层：点卡片、拖到画面轨、拖到特效轨都一样', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const dialog = await openWholeFilm(page)
  const film = dialog.getByRole('group', { name: '画面轨', exact: true })
  const overlays = dialog.getByRole('group', { name: '特效轨' })
  const pop = page.getByRole('dialog', { name: /测试可填项/ })
  await openCategory(dialog, '文字效果')

  // 点卡片（component → 特效轨）
  await dialog.getByRole('button', { name: /^测试可填项，特效轨/ }).click()
  await expect(pop).toBeVisible()
  await expect(
    overlays.getByRole('button', { name: /^选中：特效 · 测试可填项/, pressed: true }),
  ).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(pop).toBeHidden()

  // 拖到画面轨
  await dragCard(page, dialog.getByRole('button', { name: /^测试可填项，/ }), film)
  await expect(pop).toBeVisible()
  await expect(film.getByRole('button', { name: /组件 · 测试可填项/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.keyboard.press('Escape')

  // 拖到特效轨
  await dragCard(page, dialog.getByRole('button', { name: /^测试可填项，/ }), overlays)
  await expect(pop).toBeVisible()
  await expect(overlays.getByRole('group', { name: /^特效 · 测试可填项/ })).toHaveCount(2)
  await expect(
    overlays.getByRole('button', { name: /^选中：特效 · 测试可填项/, pressed: true }),
  ).toHaveCount(1)
  await page.keyboard.press('Escape')

  // 没有可填项的拖到特效轨：只选中，不弹
  await openCategory(dialog, '场景')
  await dragCard(page, dialog.getByRole('button', { name: /^测试画面，/ }), overlays)
  await expect(overlays.getByRole('button', { name: /^选中：特效 · 测试画面/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByRole('dialog', { name: /测试画面/ })).toHaveCount(0)
})

test('拖卡片到画面轨：按时长让位，离开恢复，松手才新增一次', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const dialog = await openWholeFilm(page)
  await addShot(dialog, 1)
  await addShot(dialog, 2)
  const film = dialog.getByRole('group', { name: '画面轨', exact: true })
  await expect(film.getByRole('group', { name: /^第 2 段/ })).toBeVisible()
  await expect.poll(async () => (await readDraft(page))?.layer0.length).toBe(2)
  const before = await clipLefts(film)
  const beforeDraft = await readDraft(page)
  const pps = await pixelsPerSecond(dialog)
  const preview = film.getByTestId('timeline-insertion-preview')

  // 画面轨：预演占用组件的完整时长，邻段让位，但尚未保存新段。
  await openCategory(dialog, '场景')
  await liftCard(page, dialog.getByRole('button', { name: /^测试画面，/ }))
  const second = await boxOf(film.getByRole('group', { name: /^第 2 段/ }))
  await page.mouse.move(second.x + 4, second.y + second.height / 2, { steps: 8 })
  // 拖着时卡片的说明收起
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await expect(preview).toBeVisible()
  await expect(preview).toContainText('测试画面')
  await expect.poll(async () => Math.abs((await boxOf(preview)).width - 6 * pps)).toBeLessThan(3)
  await expect.poll(async () => Math.abs((await boxOf(preview)).x - second.x)).toBeLessThan(1)
  await expect(page.getByRole('status').filter({ hasText: /^插入/ })).toBeVisible()
  await expect.poll(async () => (await clipLefts(film))[1] - before[1]).toBeGreaterThan(5.5 * pps)
  await expect(film.getByRole('group', { name: /^第 \d+ 段/ })).toHaveCount(2)
  expect(await readDraft(page)).toEqual(beforeDraft)

  // 字幕轨不收这张卡：不提示；拖回画面轨松手才插进去
  const captions = await boxOf(dialog.getByRole('group', { name: '字幕轨' }))
  await page.mouse.move(second.x + 4, captions.y + captions.height / 2, { steps: 4 })
  await expect(preview).toBeHidden()
  await expect
    .poll(async () =>
      Math.max(...(await clipLefts(film)).map((left, at) => Math.abs(left - before[at]))),
    )
    .toBeLessThan(1)
  expect(await readDraft(page)).toEqual(beforeDraft)
  await page.mouse.move(second.x + 4, second.y + second.height / 2, { steps: 4 })
  await expect(preview).toBeVisible()
  await page.mouse.up()
  await expect(film.getByRole('group', { name: /^第 2 段 · 组件 · 测试画面/ })).toBeVisible()
  await expect(film.getByRole('group', { name: /^第 \d+ 段/ })).toHaveCount(3)
  await expect(preview).toBeHidden()
  await expect.poll(async () => (await readDraft(page))?.layer0.length).toBe(3)
  const withCard = await readDraft(page)
  expect(withCard?.layer0[1]).toMatchObject({
    type: 'component',
    component: 'fixture-scene',
    duration: 6_000,
  })
})

test('组件按自己的时长放：拖着时缩影写的、落下的段都是组件时长，与成片多长无关', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const dialog = await openWholeFilm(page)
  await addShot(dialog, 1)
  const film = dialog.getByRole('group', { name: '画面轨', exact: true })
  await expect.poll(async () => (await readDraft(page))?.layer0.length).toBe(1)

  // 示例品牌 片尾 3 秒
  await dialog.getByRole('tab', { name: '品牌' }).click()
  await liftCard(page, dialog.getByRole('button', { name: /^示例品牌 片尾，/ }))
  await expect(page.locator('.timeline-insertion-ghost')).toContainText('3.0 秒')
  const lane = await boxOf(film)
  await page.mouse.move(lane.x + lane.width - 20, lane.y + lane.height / 2, { steps: 8 })
  await expect(page.getByRole('status').filter({ hasText: /^插入.*3\.0\s*秒$/ })).toBeVisible()
  await page.mouse.up()
  await expect.poll(async () => (await readDraft(page))?.layer0.length).toBe(2)
  expect((await readDraft(page))?.layer0[1]).toMatchObject({
    type: 'component',
    component: 'fixture-brand-card',
    duration: 3_000,
  })
})

test('拖卡片到特效轨：预演不挪画面轨，新行落位或取消后保存正确草稿', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const dialog = await openWholeFilm(page)
  await addShot(dialog, 1)
  await addShot(dialog, 2)
  const film = dialog.getByRole('group', { name: '画面轨', exact: true })
  const overlays = dialog.getByRole('group', { name: '特效轨' })
  const effectPreview = overlays.getByTestId('timeline-insertion-preview')
  await expect.poll(async () => (await readDraft(page))?.layer0.length).toBe(2)
  const beforeDraft = await readDraft(page)
  const pps = await pixelsPerSecond(dialog)
  const filmBeforeEffect = await clipLefts(film)

  // 特效轨：显示完整占用区间，画面轨上各段的位置和保存的草稿保持不变。
  await openCategory(dialog, '效果')
  await liftCard(page, dialog.getByRole('button', { name: /^测试叠加，/ }))
  const lane = await boxOf(overlays)
  await page.mouse.move(lane.x + 120, lane.y + lane.height / 2, { steps: 8 })
  await expect(effectPreview).toBeVisible()
  await expect(effectPreview).toContainText('测试叠加')
  await expect
    .poll(async () => Math.abs((await boxOf(effectPreview)).width - 4 * pps))
    .toBeLessThan(3)
  await expect(page.getByRole('status').filter({ hasText: /^新增特效轨 ·/ })).toBeVisible()
  await expect
    .poll(async () =>
      Math.max(...(await clipLefts(film)).map((left, at) => Math.abs(left - filmBeforeEffect[at]))),
    )
    .toBeLessThan(1)
  await expect(overlays.getByRole('group', { name: /^特效 · / })).toHaveCount(0)
  expect(await readDraft(page)).toEqual(beforeDraft)
  await page.mouse.up()
  await expect(overlays.getByRole('group', { name: /^特效 · 测试叠加，第 1 行/ })).toBeVisible()
  await expect(effectPreview).toBeHidden()
  await expect.poll(async () => (await readDraft(page))?.overlays.length).toBe(1)
  const withEffect = await readDraft(page)
  expect(withEffect?.layer0).toEqual(beforeDraft?.layer0)
  expect(withEffect?.overlays[0]).toMatchObject({
    component: 'fixture-overlay',
    duration: 4_000,
    track: 0,
  })

  // 拖到已有行下方预演新行，松手才提交第二个特效。
  const laneNow = await boxOf(overlays)
  await openCategory(dialog, '文字效果')
  await liftCard(page, dialog.getByRole('button', { name: /^测试可填项，/ }))
  const firstRow = await boxOf(overlays.getByRole('group', { name: /^特效 · 测试叠加，第 1 行/ }))
  // 快速经过上边缘再到下边缘：展开动画不改变最终命中行。
  await page.mouse.move(laneNow.x + laneNow.width / 4, firstRow.y - firstRow.height / 4)
  await page.mouse.move(laneNow.x + laneNow.width / 4, firstRow.y + firstRow.height * 1.5, {
    steps: 8,
  })
  await expect(effectPreview).toBeVisible()
  await expect(effectPreview).toContainText('测试可填项')
  await expect(page.getByRole('status').filter({ hasText: /^新增特效轨 ·/ })).toContainText(
    '松开添加',
  )
  await expect.poll(async () => (await boxOf(overlays)).height).toBeGreaterThan(laneNow.height)
  await expect(overlays.getByRole('group', { name: /^特效 · / })).toHaveCount(1)
  expect(await readDraft(page)).toEqual(withEffect)
  await page.mouse.up()
  await expect(overlays.getByRole('group', { name: /第 2 行/ })).toHaveCount(1)
  await expect(effectPreview).toBeHidden()
  await expect.poll(async () => (await readDraft(page))?.overlays.length).toBe(2)
  const beforeCancel = await readDraft(page)
  expect(beforeCancel?.layer0).toEqual(beforeDraft?.layer0)

  // 已展开第三行后拖回侧栏：新行收回，缩影退回，草稿不变。
  const cancelLane = await boxOf(overlays)
  const lastRow = await boxOf(overlays.getByRole('group', { name: /第 2 行/ }))
  const cancelCard = dialog.getByRole('button', { name: /^测试可填项，/ })
  await liftCard(page, cancelCard)
  const cancelSource = await boxOf(cancelCard)
  await page.mouse.move(cancelLane.x + cancelLane.width / 4, lastRow.y + lastRow.height * 1.5, {
    steps: 8,
  })
  await expect(page.getByRole('status').filter({ hasText: /^新增特效轨 ·/ })).toBeVisible()
  await expect.poll(async () => (await boxOf(overlays)).height).toBeGreaterThan(cancelLane.height)
  await page.mouse.move(
    cancelSource.x + cancelSource.width / 2,
    cancelSource.y + cancelSource.height / 2,
    { steps: 8 },
  )
  await page.mouse.up()
  await expect(overlays.getByRole('group', { name: /^特效 · / })).toHaveCount(2)
  await expect(effectPreview).toBeHidden()
  await expect.poll(async () => (await boxOf(overlays)).height).toBe(cancelLane.height)
  expect(await readDraft(page)).toEqual(beforeCancel)
})

test('素材页：整个音乐面板接收文件，小入口仍可选择上传', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const dialog = await openWholeFilm(page)
  const panel = dialog.getByRole('region', { name: '音乐素材' })
  const songs = panel.getByRole('list', { name: '这段对话的音乐' })
  await expect(songs.getByRole('listitem')).toHaveCount(2)
  const upload = panel.getByRole('button', { name: '添加音频', exact: true })
  await expect(upload).toBeVisible()
  await expect(panel.getByRole('button', { name: '上传', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: /^用这首/ })).toHaveCount(0)
  await dialog.getByRole('button', { name: '生成音乐', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '生成音乐' })).toBeVisible()
  await page.keyboard.press('Escape')
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array(64)], '拖进来的.wav', { type: 'audio/wav' }))
    return transfer
  })
  await panel.dispatchEvent('dragenter', { dataTransfer })
  await panel.dispatchEvent('drop', { dataTransfer })
  await expect(songs.getByRole('listitem')).toHaveCount(3)
  await expect(songs.getByText(/^音乐 \d+ · 上传的音乐 · /)).toHaveCount(2)
})
