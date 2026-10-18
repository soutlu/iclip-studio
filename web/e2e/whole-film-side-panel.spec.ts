import { readFileSync } from 'node:fs'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { ComponentCatalog } from '../src/features/storyboard/whole-film/composition/catalog'
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
  const dialog = page.getByRole('dialog', { name: /^编辑视频\s*整片/ })
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

/** 成片轨上各段的左边缘，用来确认拖动中轨道上的东西没动 */
const clipLefts = (film: Locator) =>
  film
    .getByRole('group', { name: /^第 \d+ 段/ })
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().left))

/** 在素材区「镜头组 2」选一个镜头，按 Enter 插到播放头处，让成片轨上有画面 */
const addShot = async (dialog: Locator, shot: number) => {
  const materials = dialog
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
  await materials.getByRole('button', { name: new RegExp(`^生成 A 镜头 ${shot}，`) }).click()
  await dialog.page().keyboard.press('Enter')
}

const variableDefault = (component: string, label: string) =>
  String(
    catalog.items
      .find((item) => item.name === component)
      ?.variables.find((variable) => variable.label === label)?.default,
  )

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

test('品牌栏、通用栏：小标题带个数、卡片网格，两栏各记自己的小标题', async ({ page }) => {
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

  // 三列网格，卡片只有预览图和名字，说明在悬停提示里
  const grid = dialog.getByRole('list', { name: '组件' })
  const columns = await grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns)
  expect(columns.split(' ')).toHaveLength(3)
  const card = cards(dialog).first()
  await expect(card.locator('img')).toHaveCount(1)
  await card.hover()
  await expect(page.getByRole('tooltip')).toHaveText('暖屿的品牌组件')

  // 通用栏：没有「全部」，默认第一个分类
  await dialog.getByRole('tab', { name: '通用' }).click()
  const categories = chips(dialog, '分类').getByRole('radio')
  await expect(categories.first()).toBeChecked()
  await expect(categories.first()).toHaveText(/^字幕\s*3$/)
  await expect(categories.filter({ hasText: /全部|品牌/ })).toHaveCount(0)
  // 小标题排成一行，放不下时横向滚动，不折行
  const rows = await categories.evaluateAll(
    (elements) => new Set(elements.map((element) => element.getBoundingClientRect().top)).size,
  )
  expect(rows).toBe(1)
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
  await expect(inUse.locator('.wf-component-check')).toBeVisible()
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

test('调整浮层是检查器样式，成片轨的组件段和特效块共用，没有可填项的不弹', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const dialog = await openWholeFilm(page)

  // 特效块：逐词居中（放下就打开浮层）
  await openCategory(dialog, '场景')
  await dialog.getByRole('button', { name: /^逐词居中，/ }).click()
  const pop = page.getByRole('dialog', { name: /逐词居中/ })
  await expect(pop).toHaveCSS('width', '280px')
  // 顶部只有预览图、名字与删除图标；没有说明、时间和底部提示
  await expect(pop.locator('.wf-pop-head')).toHaveText('逐词居中')
  await expect(pop.locator('.wf-pop-head .wf-component-thumb')).toBeVisible()
  await expect(pop.getByText(/秒|只影响/)).toHaveCount(0)
  // 文字空着、默认字是灰色提示；颜色是色块加「其他颜色」；不超过 4 个选项是分段按钮；数字带单位
  const text = pop.getByLabel('文字')
  await expect(text).toHaveValue('')
  await expect(text).toHaveAttribute('placeholder', variableDefault('kinetic-center-build', '文字'))
  const colors = pop.getByRole('group', { name: '颜色' })
  expect(await colors.getByRole('button').count()).toBeGreaterThanOrEqual(4)
  await expect(colors.getByRole('button', { pressed: true })).toHaveCount(1)
  await expect(colors.getByLabel('其他颜色')).toHaveAttribute('type', 'color')
  await expect(pop.getByRole('group', { name: '字体粗细' }).getByRole('button')).toHaveCount(4)
  await expect(pop.getByLabel('字号')).toHaveValue('72')
  await expect(pop.getByText('像素').first()).toBeVisible()
  // 删除图标移除特效块
  await pop.getByRole('button', { name: '移除' }).click()
  await expect(dialog.getByRole('group', { name: /^特效 · 逐词居中/ })).toHaveCount(0)

  // 成片轨的组件段：收起后再点它，同一个浮层又打开
  await openCategory(dialog, '视觉特效')
  await dialog.getByRole('button', { name: /^宇宙星球，成片轨/ }).click()
  const segmentPop = page.getByRole('dialog', { name: /宇宙星球/ })
  await expect(segmentPop).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(segmentPop).toBeHidden()
  const film = dialog.getByRole('group', { name: '成片画面轨' })
  await film.getByRole('button', { name: /^选中：第 1 段 · 组件 · 宇宙星球/ }).click()
  await expect(segmentPop.locator('.wf-pop-head')).toHaveText('宇宙星球')
  await expect(segmentPop.getByRole('group', { name: '背景底色' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(segmentPop).toBeHidden()

  // 没有可填项的组件段：只选中，不弹浮层
  await openCategory(dialog, '场景')
  await dialog.getByRole('button', { name: /^标志片尾，成片轨/ }).click()
  const plain = film.getByRole('button', { name: /^选中：第 \d 段 · 组件 · 标志片尾/ })
  await expect(plain).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('dialog', { name: /标志片尾/ })).toHaveCount(0)
  await plain.click()
  await expect(plain).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('dialog', { name: /标志片尾/ })).toHaveCount(0)
})

test('拖卡片到成片区：缩影跟手，成片轨画插入标记、特效轨画虚线块与新行横线，轨道不动，松手才放', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const dialog = await openWholeFilm(page)
  await addShot(dialog, 1)
  await addShot(dialog, 2)
  const film = dialog.getByRole('group', { name: '成片画面轨' })
  const overlays = dialog.getByRole('group', { name: '特效轨' })
  await expect(film.getByRole('group', { name: /^第 2 段/ })).toBeVisible()
  const before = await clipLefts(film)

  // 成片轨：缩影是预览图加名字的小条，插入标记与气泡写明插到哪
  await openCategory(dialog, '场景')
  await liftCard(page, dialog.getByRole('button', { name: /^标志片尾，/ }))
  const second = await boxOf(film.getByRole('group', { name: /^第 2 段/ }))
  await page.mouse.move(second.x + 4, second.y + second.height / 2, { steps: 8 })
  const ghost = page.locator('.wf-ghost.is-card')
  await expect(ghost).toBeVisible()
  await expect(ghost).toHaveText('标志片尾')
  await expect(ghost.locator('img')).toHaveCount(1)
  // 拖着时卡片的说明收起
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  await expect(dialog.locator('.wf-drop-marker')).toBeVisible()
  await expect(dialog.locator('.wf-drop-bubble')).toHaveText(/^插入到 [\d.]+ 秒 · 第 2 段$/)
  expect(await clipLefts(film)).toEqual(before)

  // 字幕轨不收这张卡：不提示；拖回成片轨松手才插进去
  const captions = await boxOf(dialog.getByRole('group', { name: '字幕轨' }))
  await page.mouse.move(second.x + 4, captions.y + captions.height / 2, { steps: 4 })
  await expect(dialog.locator('.wf-drop-marker')).toHaveCount(0)
  await page.mouse.move(second.x + 4, second.y + second.height / 2, { steps: 4 })
  await page.mouse.up()
  await expect(film.getByRole('group', { name: /^第 2 段 · 组件 · 标志片尾/ })).toBeVisible()
  await expect(ghost).toHaveCount(0)

  // 特效轨：虚线块带预览图和名字，标出落点
  await openCategory(dialog, '社交')
  await liftCard(page, dialog.getByRole('button', { name: /^手绘箭头，/ }))
  const lane = await boxOf(overlays)
  await page.mouse.move(lane.x + 120, lane.y + lane.height / 2, { steps: 8 })
  const dashed = overlays.locator('.wf-overlay.is-ghost')
  await expect(dashed).toBeVisible()
  await expect(dashed).toContainText('手绘箭头')
  await expect(overlays.getByRole('group', { name: /^特效 · / })).toHaveCount(0)
  await page.mouse.up()
  await expect(overlays.getByRole('group', { name: /^特效 · 手绘箭头，第 1 行/ })).toBeVisible()

  // 拖到已有行的下方：只画新行横线，行数不变；松手才多出一行
  const laneNow = await boxOf(overlays)
  await liftCard(page, dialog.getByRole('button', { name: /^手写标题，/ }))
  await page.mouse.move(laneNow.x + 120, laneNow.y + 2 + 24 + 8, { steps: 8 })
  await expect(overlays.locator('.wf-overlay-insert')).toBeVisible()
  expect((await boxOf(overlays)).height).toBe(laneNow.height)
  await page.mouse.up()
  await expect(overlays.getByRole('group', { name: /第 2 行/ })).toHaveCount(1)

  // 拿起后在侧栏松手：没放下，缩影退回，草稿不变
  await liftCard(page, dialog.getByRole('button', { name: /^手绘箭头，/ }))
  await page.mouse.up()
  await expect(overlays.getByRole('group', { name: /^特效 · / })).toHaveCount(2)
  await expect(page.locator('.wf-ghost')).toHaveCount(0)
})

test('素材页：列表下的空处是上传区，拖音频文件进来即上传', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const dialog = await openWholeFilm(page)
  const songs = dialog.getByRole('list', { name: '这段对话的音乐' })
  await expect(songs.getByRole('listitem')).toHaveCount(2)
  // 标题行只有「上传」，生成音乐在音乐轨的「+」
  await expect(dialog.getByRole('button', { name: '生成', exact: true })).toHaveCount(0)
  const drop = dialog.getByRole('button', { name: '把音频文件拖到这里上传' })
  await expect(drop).toContainText('生成音乐在下方音乐轨的「+」')
  await dialog.getByRole('button', { name: '生成音乐', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '生成音乐' })).toHaveAttribute('data-side', 'top')
  await page.keyboard.press('Escape')
  const box = await drop.boundingBox()
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(64)

  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array(64)], '拖进来的.wav', { type: 'audio/wav' }))
    return transfer
  })
  // 拖到上方时按钮改写「松开即上传」，名字会变，按同一个元素派发
  const zone = await drop.elementHandle()
  await zone?.dispatchEvent('dragenter', { dataTransfer })
  await expect(dialog.getByRole('button', { name: '松开即上传' })).toBeVisible()
  await zone?.dispatchEvent('drop', { dataTransfer })
  await expect(songs.getByRole('listitem')).toHaveCount(3)
  await expect(songs.getByText(/^上传的音乐 · /)).toHaveCount(2)
})
