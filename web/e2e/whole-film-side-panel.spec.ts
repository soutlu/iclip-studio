import { readFileSync } from 'node:fs'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { ComponentCatalog } from '../src/features/storyboard/whole-film/composition/catalog'
import type { WholeFilmDocument } from '../src/shared/api/generated/types.gen'
import { withBrandFixtures } from '../src/testing/whole-film'
import { openConversation } from './helpers'

const catalog = JSON.parse(
  readFileSync(
    new URL('../src/features/storyboard/whole-film/catalog/catalog.json', import.meta.url),
    'utf8',
  ),
) as ComponentCatalog

/**
 * 真实目录里没有品牌组件：把编辑器加载的目录模块（dev 下是 catalog.json，构建后是 catalog-*.js）
 * 换成补了示例品牌卡的同一份目录。请求经过 MSW 的 service worker，所以挂在浏览器上下文上。
 */
const serveBrandFixtures = (page: Page) =>
  page.context().route(
    (url) => /\/catalog\/catalog\.json$|\/assets\/catalog-[\w-]+\.js$/.test(url.pathname),
    (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: `export default ${JSON.stringify(withBrandFixtures(catalog))}`,
      }),
  )

/** 演示对话里有两首音乐；打开它的整片编辑器 */
const openWholeFilm = async (page: Page) => {
  const panel = await openConversation(page, '夜景延时素材生成')
  await panel.getByRole('button', { name: '整片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '夜景延时素材生成' })
  await expect(dialog).toBeVisible()
  return dialog
}

const chips = (dialog: Locator, name: '品牌' | '分类') =>
  dialog.getByRole('radiogroup', { name, exact: true })

const cards = (dialog: Locator) => dialog.getByRole('list', { name: '组件' }).getByRole('button')

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

/** 成片轨上各段的左边缘，用于核对预演让位与特效不移动成片。 */
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

/** 在素材区「镜头组 2」选一个镜头，按 Enter 插到播放头处，让成片轨上有画面 */
const addShot = async (dialog: Locator, shot: number) => {
  const materials = dialog
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
  await materials.getByRole('button', { name: new RegExp(`^生成 A 镜头 ${shot}，`) }).click()
  await dialog.page().keyboard.press('Enter')
}

test('侧栏分素材、品牌、通用；真实目录的品牌栏是空的', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const dialog = await openWholeFilm(page)
  const tabs = dialog.getByRole('tablist', { name: '素材、品牌与通用' }).getByRole('tab')
  await expect(tabs).toHaveText(['素材', '品牌', '通用'])
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true')

  await dialog.getByRole('tab', { name: '品牌' }).click()
  await expect(dialog.getByText('暂无品牌组件')).toBeVisible()
  await expect(chips(dialog, '品牌')).toHaveCount(0)
  await expect(dialog.getByRole('list', { name: '组件' })).toHaveCount(0)
})

test('品牌与分类各自保留选择，字幕样式可切换，品牌卡可插入不同轨道', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await serveBrandFixtures(page)
  const dialog = await openWholeFilm(page)

  // 品牌栏：一排品牌名带个数，默认第一个品牌，只列它的卡
  await dialog.getByRole('tab', { name: '品牌' }).click()
  const brands = chips(dialog, '品牌').getByRole('radio')
  await expect(brands).toHaveText([/^拾步\s*2$/, /^暖屿\s*2$/])
  await expect(brands.first()).toBeChecked()
  await expect(cards(dialog)).toHaveText(['拾步 片头', '拾步 片尾'])
  await chips(dialog, '品牌').getByRole('radio', { name: /^暖屿/ }).click()
  await expect(cards(dialog)).toHaveText(['暖屿 片头', '暖屿 片尾'])

  // 悬停可以查看所选品牌卡的说明。
  await cards(dialog).first().hover()
  await expect(page.getByRole('tooltip')).toContainText('暖屿')

  // 通用栏：没有「全部」，默认第一个分类
  await dialog.getByRole('tab', { name: '通用' }).click()
  const categories = chips(dialog, '分类').getByRole('radio')
  await expect(categories.first()).toBeChecked()
  await expect(categories.first()).toHaveText(/^字幕\s*3$/)
  await expect(categories.filter({ hasText: /全部|品牌/ })).toHaveCount(0)
  await chips(dialog, '分类')
    .getByRole('radio', { name: /^视觉特效/ })
    .click()

  // 切到素材再回来，两栏各自的小标题都还在
  await dialog.getByRole('tab', { name: '素材' }).click()
  await dialog.getByRole('tab', { name: '品牌' }).click()
  await expect(chips(dialog, '品牌').getByRole('radio', { name: /^暖屿/ })).toBeChecked()
  await dialog.getByRole('tab', { name: '通用' }).click()
  await expect(chips(dialog, '分类').getByRole('radio', { name: /^视觉特效/ })).toBeChecked()

  // 字幕样式在「通用 › 字幕」：在用的那张描墨色框并打勾，点别的换样式
  await dialog.getByRole('tab', { name: '品牌' }).click()
  await dialog.getByRole('button', { name: /^字幕样式：白字黑边/ }).click()
  await expect(dialog.getByRole('tab', { name: '通用' })).toHaveAttribute('aria-selected', 'true')
  await expect(chips(dialog, '分类').getByRole('radio', { name: /^字幕/ })).toBeChecked()
  const inUse = dialog.getByRole('button', { name: /^白字黑边，/ })
  await expect(inUse).toHaveAttribute('aria-pressed', 'true')
  await dialog.getByRole('button', { name: /^高亮字幕，/ }).click()
  await expect(dialog.getByRole('button', { name: /^高亮字幕，/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(inUse).toHaveAttribute('aria-pressed', 'false')

  // 品牌卡和别的卡一样：点它按组件类型放（block 进成片轨），拖到哪条轨就放在哪。
  // 暖屿 片尾没有可填项，放下只选中；拾步 片头有可填项，放下就打开浮层
  await dialog.getByRole('tab', { name: '品牌' }).click()
  await dialog.getByRole('button', { name: /^暖屿 片尾，成片轨/ }).click()
  const film = dialog.getByRole('group', { name: '成片画面轨' })
  await expect(film.getByRole('group', { name: /^第 1 段 · 组件 · 暖屿 片尾/ })).toBeVisible()
  await expect(
    film.getByRole('button', { name: /^选中：第 1 段 · 组件 · 暖屿 片尾/ }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('dialog', { name: /暖屿 片尾/ })).toHaveCount(0)
  await chips(dialog, '品牌').getByRole('radio', { name: /^拾步/ }).click()
  await dragCard(
    page,
    dialog.getByRole('button', { name: /^拾步 片头，/ }),
    dialog.getByRole('group', { name: '特效轨' }),
  )
  await expect(dialog.getByRole('group', { name: /^特效 · 拾步 片头/ })).toBeVisible()
  await expect(page.getByRole('dialog', { name: /拾步 片头/ })).toBeVisible()
})

test('放下有可填项的卡片随即打开浮层：点卡片、拖到成片轨、拖到特效轨都一样', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const dialog = await openWholeFilm(page)
  const film = dialog.getByRole('group', { name: '成片画面轨' })
  await openCategory(dialog, '视觉特效')

  // 点卡片（block → 成片轨）
  await dialog.getByRole('button', { name: /^宇宙星球，成片轨/ }).click()
  const first = page.getByRole('dialog', { name: /宇宙星球/ })
  await expect(first).toBeVisible()
  await expect(
    film.getByRole('button', { name: /^选中：第 1 段 · 组件 · 宇宙星球/ }),
  ).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  await expect(first).toBeHidden()

  // 拖到成片轨
  await dragCard(page, dialog.getByRole('button', { name: /^旋涡星系，/ }), film)
  await expect(page.getByRole('dialog', { name: /旋涡星系/ })).toBeVisible()
  await expect(film.getByRole('button', { name: /组件 · 旋涡星系/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.keyboard.press('Escape')

  // 拖到特效轨
  await dragCard(
    page,
    dialog.getByRole('button', { name: /^网点光场，/ }),
    dialog.getByRole('group', { name: '特效轨' }),
  )
  await expect(page.getByRole('dialog', { name: /网点光场/ })).toBeVisible()
  await expect(dialog.getByRole('button', { name: /^选中：特效 · 网点光场/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.keyboard.press('Escape')

  // 没有可填项的拖到特效轨：只选中，不弹
  await dragCard(
    page,
    dialog.getByRole('button', { name: /^液体背景，/ }),
    dialog.getByRole('group', { name: '特效轨' }),
  )
  await expect(dialog.getByRole('button', { name: /^选中：特效 · 液体背景/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(page.getByRole('dialog', { name: /液体背景/ })).toHaveCount(0)
})

test('组件参数可编辑并保存，清空文字恢复默认；删除组件会移除草稿内容', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const dialog = await openWholeFilm(page)
  await openCategory(dialog, '场景')
  await dialog.getByRole('button', { name: /^逐词居中，/ }).click()
  const pop = page.getByRole('dialog', { name: /逐词居中/ })
  const text = pop.getByLabel('文字', { exact: true })
  await text.fill('城市的一天')
  await text.press('Tab')
  const size = pop.getByLabel('字号', { exact: true })
  await size.fill('80')
  await size.press('Tab')
  await pop
    .getByRole('group', { name: '字体粗细' })
    .getByRole('button', { name: '加粗', exact: true })
    .click()
  await expect
    .poll(async () => (await readDraft(page))?.overlays[0]?.variables)
    .toMatchObject({ text: '城市的一天', font_size: 80, font_weight: '700' })
  await page.keyboard.press('Escape')
  await expect(pop).toBeHidden()
  const overlay = dialog.getByRole('button', { name: /^选中：特效 · 逐词居中/ })
  await overlay.click()
  await expect(text).toHaveValue('城市的一天')
  await expect(size).toHaveValue('80')
  await text.fill('')
  await text.press('Tab')
  await expect
    .poll(async () => (await readDraft(page))?.overlays[0]?.variables)
    .not.toHaveProperty('text')
  await pop.getByRole('button', { name: '移除' }).click()
  await expect(dialog.getByRole('group', { name: /^特效 · 逐词居中/ })).toHaveCount(0)
  await expect.poll(async () => (await readDraft(page))?.overlays).toEqual([])

  // 成片轨组件同样可以在关闭后重新打开并修改参数。
  await dialog.getByRole('button', { name: /^AI 答案排名，成片轨/ }).click()
  const segmentPop = page.getByRole('dialog', { name: /AI 答案排名/ })
  await expect(segmentPop).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(segmentPop).toBeHidden()
  const film = dialog.getByRole('group', { name: '成片画面轨' })
  await film.getByRole('button', { name: /^选中：第 1 段 · 组件 · AI 答案排名/ }).click()
  await expect(segmentPop.getByRole('group', { name: '底色' })).toBeVisible()
  await segmentPop.getByRole('button', { name: '移除' }).click()
  await expect(film.getByRole('group', { name: /^第 \d+ 段/ })).toHaveCount(0)
  await expect.poll(async () => (await readDraft(page))?.layer0).toEqual([])
})

test('拖卡片共用落位预演：成片按时长让位、特效不挪成片，松手才新增一次', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const dialog = await openWholeFilm(page)
  await addShot(dialog, 1)
  await addShot(dialog, 2)
  const film = dialog.getByRole('group', { name: '成片画面轨' })
  const overlays = dialog.getByRole('group', { name: '特效轨' })
  await expect(film.getByRole('group', { name: /^第 2 段/ })).toBeVisible()
  await expect.poll(async () => (await readDraft(page))?.layer0.length).toBe(2)
  const before = await clipLefts(film)
  const beforeDraft = await readDraft(page)
  const pps = await pixelsPerSecond(dialog)
  const preview = film.getByTestId('timeline-insertion-preview')
  const effectPreview = overlays.getByTestId('timeline-insertion-preview')

  // 成片轨：预演占用组件的完整时长，邻段让位，但尚未保存新段。
  await openCategory(dialog, '场景')
  await liftCard(page, dialog.getByRole('button', { name: /^标志片尾，/ }))
  const second = await boxOf(film.getByRole('group', { name: /^第 2 段/ }))
  await page.mouse.move(second.x + 4, second.y + second.height / 2, { steps: 8 })
  // 拖着时卡片的说明收起
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await expect(preview).toBeVisible()
  await expect(preview).toContainText('标志片尾')
  await expect.poll(async () => Math.abs((await boxOf(preview)).width - 6 * pps)).toBeLessThan(3)
  await expect.poll(async () => Math.abs((await boxOf(preview)).x - second.x)).toBeLessThan(1)
  await expect(page.getByRole('status').filter({ hasText: /^插入/ })).toBeVisible()
  await expect.poll(async () => (await clipLefts(film))[1] - before[1]).toBeGreaterThan(5.5 * pps)
  await expect(film.getByRole('group', { name: /^第 \d+ 段/ })).toHaveCount(2)
  expect(await readDraft(page)).toEqual(beforeDraft)

  // 字幕轨不收这张卡：不提示；拖回成片轨松手才插进去
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
  await expect(film.getByRole('group', { name: /^第 2 段 · 组件 · 标志片尾/ })).toBeVisible()
  await expect(film.getByRole('group', { name: /^第 \d+ 段/ })).toHaveCount(3)
  await expect(preview).toBeHidden()
  await expect.poll(async () => (await readDraft(page))?.layer0.length).toBe(3)
  const withCard = await readDraft(page)
  expect(withCard?.layer0[1]).toMatchObject({
    type: 'component',
    component: 'logo-outro',
    duration: 6_000,
  })
  const filmBeforeEffect = await clipLefts(film)

  // 特效轨：显示完整占用区间，成片位置和保存的草稿保持不变。
  await openCategory(dialog, '社交')
  await liftCard(page, dialog.getByRole('button', { name: /^手绘箭头，/ }))
  const lane = await boxOf(overlays)
  await page.mouse.move(lane.x + 120, lane.y + lane.height / 2, { steps: 8 })
  await expect(effectPreview).toBeVisible()
  await expect(effectPreview).toContainText('手绘箭头')
  await expect
    .poll(async () => Math.abs((await boxOf(effectPreview)).width - 4 * pps))
    .toBeLessThan(3)
  await expect(page.getByRole('status').filter({ hasText: /^特效 ·/ })).toBeVisible()
  await expect
    .poll(async () =>
      Math.max(...(await clipLefts(film)).map((left, at) => Math.abs(left - filmBeforeEffect[at]))),
    )
    .toBeLessThan(1)
  await expect(overlays.getByRole('group', { name: /^特效 · / })).toHaveCount(0)
  expect(await readDraft(page)).toEqual(withCard)
  await page.mouse.up()
  await expect(overlays.getByRole('group', { name: /^特效 · 手绘箭头，第 1 行/ })).toBeVisible()
  await expect(effectPreview).toBeHidden()
  await expect.poll(async () => (await readDraft(page))?.overlays.length).toBe(1)
  const withEffect = await readDraft(page)
  expect(withEffect?.layer0).toEqual(withCard?.layer0)
  expect(withEffect?.overlays[0]).toMatchObject({
    component: 'hw-arrow',
    duration: 4_000,
    track: 0,
  })

  // 拖到已有行下方预演新行，松手才提交第二个特效。
  const laneNow = await boxOf(overlays)
  await liftCard(page, dialog.getByRole('button', { name: /^手写标题，/ }))
  const firstRow = await boxOf(overlays.getByRole('group', { name: /^特效 · 手绘箭头，第 1 行/ }))
  await page.mouse.move(laneNow.x + laneNow.width / 4, firstRow.y + firstRow.height * 1.5, {
    steps: 8,
  })
  await expect(effectPreview).toBeVisible()
  await expect(effectPreview).toContainText('手写标题')
  await expect(overlays.getByRole('group', { name: /^特效 · / })).toHaveCount(1)
  expect(await readDraft(page)).toEqual(withEffect)
  await page.mouse.up()
  await expect(overlays.getByRole('group', { name: /第 2 行/ })).toHaveCount(1)
  await expect(effectPreview).toBeHidden()
  await expect.poll(async () => (await readDraft(page))?.overlays.length).toBe(2)
  const beforeCancel = await readDraft(page)
  expect(beforeCancel?.layer0).toEqual(withCard?.layer0)

  // 拿起后在侧栏松手，不加入任何轨道。
  await liftCard(page, dialog.getByRole('button', { name: /^手绘箭头，/ }))
  await page.mouse.up()
  await expect(overlays.getByRole('group', { name: /^特效 · / })).toHaveCount(2)
  await expect(effectPreview).toBeHidden()
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
