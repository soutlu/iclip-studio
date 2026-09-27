/// <reference lib="dom" />

import { readFile } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { login } from './login'

const SHOT_DIR = '../.artifacts/design-qa/task-gallery'
const MY_TITLES = [
  '画廊验收｜秋冬鞋履系列新品内容创作，保留完整需求名称以便跨团队识别与查找',
  '画廊验收｜多款通勤系列',
  '画廊验收｜周末轻运动',
  '画廊验收｜经典正装系列',
  '画廊验收｜日常穿搭系列',
  '画廊验收｜秋季新品系列',
] as const
const OTHER_TITLES = [
  '画廊其他｜细带凉鞋创作任务',
  '画廊其他｜方跟短靴创作任务',
  '画廊其他｜乐福鞋创作任务',
]

test.afterEach(async ({ page }) => {
  expect(await page.pageErrors(), '页面不应出现未捕获异常').toEqual([])
})

/** 复用上传验收的本地图片；无素材时使用现有上传测试 PNG，仅验证加载与布局。 */
const productPng = async () => {
  const fixture = process.env['TASK_GALLERY_QA_IMAGE'] ?? process.env['TASK_FORM_QA_IMAGE']
  if (fixture) return readFile(fixture)
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
}

/** 只通过浏览器 MSW 的已有接口准备数据，不绕过任务认领或图片上传合同。 */
const openGallery = async (page: Page) => {
  await page.goto('/')
  await login(page)
  const png = await productPng()
  await page.evaluate(
    async ({ bytes, mine, others }) => {
      const post = async (path: string, body?: unknown) => {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        if (!response.ok) throw new Error(`测试数据准备失败：${path} (${response.status})`)
        return response.json() as Promise<unknown>
      }
      const uploadImage = async (imageBytes = bytes) => {
        const signed = (await post('/api/uploads/sign', {
          contentType: 'image/png',
          fileName: '商品.png',
          sizeBytes: imageBytes.length,
        })) as { uploadId: string; upload: { url: string; headers: Record<string, string> } }
        const upload = await fetch(signed.upload.url, {
          method: 'PUT',
          headers: signed.upload.headers,
          body: new Uint8Array(imageBytes),
        })
        if (!upload.ok) throw new Error(`测试图片上传失败 (${upload.status})`)
        return (await post(`/api/uploads/${signed.uploadId}/confirm`)) as { url: string }
      }
      const image = await uploadImage()
      // 非方形样本能发现缩略图意外被固定宽高拉伸或裁切。
      const canvas = document.createElement('canvas')
      canvas.width = 80
      canvas.height = 40
      const context = canvas.getContext('2d')
      if (!context) throw new Error('浏览器不支持生成参考图样本')
      context.fillStyle = '#b9c8b9'
      context.fillRect(0, 0, 80, 40)
      context.fillStyle = '#385943'
      context.fillRect(10, 10, 60, 20)
      const wideBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('参考图样本生成失败'))),
          'image/png',
        )
      })
      const wideImage = await uploadImage([...new Uint8Array(await wideBlob.arrayBuffer())])
      const references = [
        wideImage,
        ...(await Promise.all(Array.from({ length: 8 }, () => uploadImage()))),
      ]

      const create = async (title: string, index: number, claimed: boolean) => {
        const created = (await post('/api/tasks', {
          title,
          inputs: {
            creative_requirement: '展示商品原有轮廓与细节，保留调用方填写的需求名称。',
            video_spec: {
              platform: 'douyin',
              video_type: 'product_showcase',
              content_type: 'short_video',
            },
            reference_image_oss_urls: {
              model: index === 1 ? references.map((reference) => reference.url) : [],
              outfit: [],
              prop: [],
            },
            products: Array.from({ length: index === 1 ? 4 : 1 }, (_, productIndex) => ({
              style_no: `QA-${claimed ? 'MINE' : 'ALL'}-${index}-${productIndex}`,
              name: ['黑色乐福鞋', '细带凉鞋', '白色运动鞋'][index % 3],
              image_oss_urls: [image.url],
            })),
          },
        })) as { task: { id: string } }
        await post(`/api/tasks/${created.task.id}/publish`)
        if (claimed) await post(`/api/tasks/${created.task.id}/confirm`)
      }
      // 列表按创建时间倒序；让长标题、多款、单款出现在首排。
      for (let index = mine.length - 1; index >= 0; index -= 1) {
        await create(mine[index], index, true)
      }
      for (let index = others.length - 1; index >= 0; index -= 1) {
        await create(others[index], index, false)
      }
    },
    { bytes: [...png], mine: [...MY_TITLES], others: OTHER_TITLES },
  )
  await page.getByRole('button', { name: '需求单', exact: true }).click()
  if ((page.viewportSize()?.width ?? 1335) < 600) {
    await page.getByRole('button', { name: '折叠侧边栏' }).click()
  }
  await expect(page.getByRole('region', { name: '我的需求单' })).toBeVisible()
}

// 只断言本用例准备的需求单，不依赖共享浏览器演示数据的数量。
const cardsIn = (region: Locator) =>
  region.getByRole('button', { name: /^查看需求：画廊(?:验收|其他)｜/ })

const boundsOf = async (locator: Locator) => {
  const bounds = await locator.boundingBox()
  if (!bounds) throw new Error('待验收元素未参与可见布局')
  return bounds
}

/** 与首张卡同一排的张数，即网格当前一行放得下的卡片数。 */
const firstRowCount = async (cards: Locator) => {
  const tops = await Promise.all((await cards.all()).map(async (card) => (await boundsOf(card)).y))
  return tops.filter((top) => Math.abs(top - (tops[0] ?? top)) < 1).length
}

test('认领画廊可展开、搜索全部已加载需求，并保留详情与重命名入口', async ({ page }) => {
  await page.setViewportSize({ width: 1335, height: 1197 })
  await openGallery(page)
  const mine = page.getByRole('region', { name: '我的需求单' })
  const all = page.getByRole('region', { name: '全部需求单' })
  // 收起时放满一行：1335 宽主区排 4 列，与「全部需求单」首排张数一致。
  await expect(cardsIn(mine)).toHaveCount(4)
  await expect(cardsIn(all)).toHaveCount(9)
  expect(await firstRowCount(cardsIn(all))).toBe(4)
  await expect(mine.getByRole('button', { name: `查看需求：${MY_TITLES[4]}` })).toHaveCount(0)

  const expand = mine.getByRole('button', { name: '展开更多', exact: true })
  await expect(expand).toHaveAttribute('aria-expanded', 'false')
  // 一行的张数随主区宽度变化。
  await page.setViewportSize({ width: 1600, height: 1197 })
  await expect(cardsIn(mine)).toHaveCount(6)
  expect(await firstRowCount(cardsIn(all))).toBe(6)
  await page.setViewportSize({ width: 1335, height: 1197 })
  await expect(cardsIn(mine)).toHaveCount(4)

  await expand.click()
  await expect(cardsIn(mine)).toHaveCount(6)
  const collapse = mine.getByRole('button', { name: '收起', exact: true })
  await expect(collapse).toHaveAttribute('aria-expanded', 'true')
  await expect(all.getByRole('heading', { name: '全部需求单' })).toBeVisible()
  await page.mouse.move(0, 0)
  await page.screenshot({
    animations: 'disabled',
    path: `${SHOT_DIR}/desktop-expanded.png`,
  })
  await collapse.click()
  await expect(cardsIn(mine)).toHaveCount(4)
  await expect(expand).toHaveAttribute('aria-expanded', 'false')

  // 搜索在页头「新建需求单」之后，同时筛两个分区；匹配范围不能被收起的一行截断。
  const search = page.getByRole('textbox', { name: '搜索需求单' })
  await page.getByRole('button', { name: '新建需求单', exact: true }).focus()
  await page.keyboard.press('Tab')
  await expect(search).toBeFocused()
  await search.fill('画廊验收')
  await expect(cardsIn(mine)).toHaveCount(6)
  await expect(cardsIn(all)).toHaveCount(6)
  await expect(expand).toHaveCount(0)
  await expect(collapse).toHaveCount(0)
  await search.fill(MY_TITLES[4])
  await expect(cardsIn(mine)).toHaveCount(1)
  await expect(cardsIn(all)).toHaveCount(1)

  const matchedCard = cardsIn(mine).first()
  await matchedCard.focus()
  await page.keyboard.press('Enter')
  const detail = page.getByRole('dialog', { name: MY_TITLES[4], exact: true })
  await expect(detail.getByLabel('需求单名称', { exact: true })).toHaveValue(MY_TITLES[4])
  await expect(detail.getByRole('button', { name: '开始创作', exact: true })).toBeVisible()
  await detail.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(detail).toBeHidden()
  await search.clear()
  await expect(cardsIn(mine)).toHaveCount(4)
  await expect(expand).toHaveAttribute('aria-expanded', 'false')

  await mine.getByRole('button', { name: '更多操作', exact: true }).first().click()
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
  const rename = page.getByRole('dialog', { name: '重命名需求单', exact: true })
  await expect(rename.getByRole('textbox', { name: '新的需求单名称' })).toHaveValue(MY_TITLES[0])
  const updatedTitle = '画廊验收｜已更新的秋冬系列'
  await rename.getByRole('textbox', { name: '新的需求单名称' }).fill(updatedTitle)
  await rename.getByRole('button', { name: '保存', exact: true }).click()
  await expect(rename).toBeHidden()
  await expect(mine.getByRole('button', { name: `查看需求：${updatedTitle}` })).toBeVisible()
  await expect(all.getByRole('button', { name: `查看需求：${updatedTitle}` })).toBeVisible()
  await expect(page).toHaveURL('/tasks')
})

test('参考缩略图覆盖在主图内，保持原图比例，左右滚动与打开详情独立', async ({ page }) => {
  await page.setViewportSize({ width: 1335, height: 1197 })
  await openGallery(page)
  const mine = page.getByRole('region', { name: '我的需求单' })
  const card = mine.getByRole('button', { name: `查看需求：${MY_TITLES[1]}`, exact: true })
  const wrapper = card.locator('..')
  const strip = wrapper.getByLabel('商品与参考图', { exact: true })
  const thumbnails = strip.getByRole('button', { name: /^打开需求详情：/ })
  await expect(thumbnails).toHaveCount(9)
  const image = thumbnails.first().getByRole('img')
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0)
  const coverBounds = await boundsOf(card.getByRole('img').first())
  const thumbnailBounds = await boundsOf(image)
  expect(thumbnailBounds.y).toBeGreaterThan(coverBounds.y)
  expect(thumbnailBounds.y + thumbnailBounds.height).toBeLessThan(
    coverBounds.y + coverBounds.height,
  )
  const ratio = await image.evaluate(
    (element: HTMLImageElement) => element.naturalWidth / element.naturalHeight,
  )
  expect(Math.abs(thumbnailBounds.width / thumbnailBounds.height - ratio)).toBeLessThan(0.02)
  await expect(card.getByRole('button')).toHaveCount(0)
  await wrapper.getByRole('button', { name: '向右滚动参考图' }).click()
  await expect.poll(() => strip.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const rightPosition = await strip.evaluate((element) => element.scrollLeft)
  await wrapper.getByRole('button', { name: '向左滚动参考图' }).click()
  await expect
    .poll(() => strip.evaluate((element) => element.scrollLeft))
    .toBeLessThan(rightPosition)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await thumbnails.first().focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: MY_TITLES[1], exact: true })).toBeVisible()
})

for (const viewport of [
  { name: 'desktop', width: 1335, height: 1197, columns: 4 },
  { name: 'mobile', width: 390, height: 844, columns: 2 },
]) {
  test(`画廊视觉验收：${viewport.name} 浅深主题与长标题`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await openGallery(page)
    const mine = page.getByRole('region', { name: '我的需求单' })
    const all = page.getByRole('region', { name: '全部需求单' })
    const cards = cardsIn(mine)
    await expect(cards).toHaveCount(viewport.columns)
    await expect(cardsIn(all)).toHaveCount(9)
    expect(await firstRowCount(cardsIn(all))).toBe(viewport.columns)
    await expect(page.getByRole('heading', { name: '需求单', exact: true })).toBeVisible()
    await expect(page.getByText('多人协同，打造超级团队', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '新建需求单', exact: true })).toBeVisible()
    await expect(page.getByRole('textbox', { name: '搜索需求单' })).toBeVisible()
    await expect(cards.first()).toHaveAccessibleName(`查看需求：${MY_TITLES[0]}`)
    const row = await Promise.all((await cards.all()).map(boundsOf))
    const [first, second] = row
    if (!first || !second) throw new Error('我的需求单首排不足两张')
    // 同排等宽、从左到右依次排开。
    for (const [index, card] of row.entries()) {
      expect(Math.abs(card.y - first.y)).toBeLessThan(1)
      expect(Math.abs(card.width - first.width)).toBeLessThan(1)
      const previous = row[index - 1]
      if (previous) expect(previous.x + previous.width).toBeLessThan(card.x)
    }
    // 封面宽等于卡宽，按 196:180 随卡宽等比。
    const cover = await boundsOf(cards.first().getByRole('img').first())
    expect(Math.abs(cover.width - first.width)).toBeLessThan(1)
    expect(cover.height).toBeLessThan(first.height)
    expect(Math.abs(cover.width / cover.height - 196 / 180)).toBeLessThan(0.02)
    // 参考条覆盖层随封面等比，仍贴着封面底边。
    const withReferences = mine.getByRole('button', { name: `查看需求：${MY_TITLES[1]}` })
    const referenceCover = await boundsOf(withReferences.getByRole('img').first())
    const strip = await boundsOf(withReferences.locator('..').getByLabel('商品与参考图'))
    const coverBottom = referenceCover.y + referenceCover.height
    expect(strip.y).toBeGreaterThan(referenceCover.y)
    expect(coverBottom - (strip.y + strip.height)).toBeGreaterThan(0)
    expect(coverBottom - (strip.y + strip.height)).toBeLessThan(12)
    await expect(cards.first().getByLabel('发布平台：抖音')).toBeVisible()
    await expect(cards.first().getByLabel('视频类型：产品展示')).toBeVisible()
    await expect(cards.first().getByLabel('内容类型：短视频')).toBeVisible()
    await expect(cards.first().getByText(/^创建于 /)).toBeVisible()

    if (viewport.name === 'desktop') {
      expect(first.width).toBeCloseTo(196, 0)
      await expect(all.getByRole('heading', { name: '全部需求单' })).toBeInViewport()
      for (const card of (await cardsIn(all).all()).slice(0, 3)) {
        const image = card.getByRole('img').first()
        await expect(image).toBeInViewport()
        await expect
          .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
          .toBeGreaterThan(0)
        // 封面加载前透明、加载后淡入，最终必须完全显示。
        await expect(image).toHaveCSS('opacity', '1')
      }
    } else {
      // 两列铺满主区：第三张换到下一排、与第一张左对齐。
      const allFirst = await boundsOf(cardsIn(all).nth(0))
      const allThird = await boundsOf(cardsIn(all).nth(2))
      expect(Math.abs(allThird.x - allFirst.x)).toBeLessThan(1)
      expect(allThird.y).toBeGreaterThanOrEqual(allFirst.y + allFirst.height)
      // 左右留白相等（主区宽不含滚动条）。
      const content = await page
        .getByRole('main')
        .evaluate((main) => ({ left: main.getBoundingClientRect().left, width: main.clientWidth }))
      expect(first.x - content.left).toBeCloseTo(
        content.left + content.width - (second.x + second.width),
        0,
      )
      expect(first.x).toBeGreaterThanOrEqual(0)
      expect(second.x + second.width).toBeLessThanOrEqual(viewport.width)
      expect(
        await page.getByRole('main').evaluate((main) => main.scrollWidth <= main.clientWidth),
      ).toBe(true)
    }

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await expect
        .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
        .toBe(colorScheme === 'dark')
      await page.getByRole('main').evaluate((main) => main.scrollTo(0, 0))
      await expect
        .poll(() =>
          cards
            .first()
            .getByRole('img')
            .first()
            .evaluate((image: HTMLImageElement) => image.naturalWidth),
        )
        .toBeGreaterThan(0)
      await page.mouse.move(0, 0)
      await page.screenshot({
        animations: 'disabled',
        path: `${SHOT_DIR}/${viewport.name}-${colorScheme}.png`,
      })
      if (viewport.name === 'mobile') {
        // 双列下「全部需求单」标题已在首屏；滚到接近顶端（让出侧栏展开钮）才拍得到它的多排卡片。
        const sectionTop = await all.evaluate((section) => section.getBoundingClientRect().top)
        await page.getByRole('main').evaluate((main, top) => main.scrollBy(0, top - 48), sectionTop)
        await expect(cardsIn(all).first().getByRole('img').first()).toBeInViewport()
        await page.screenshot({
          animations: 'disabled',
          path: `${SHOT_DIR}/mobile-all-${colorScheme}.png`,
        })
      }
    }
  })
}
