import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { canvasPng, openConversation } from './helpers'
import { login } from './login'

// 在 dev:mock 中生成视觉验收截图，输出到忽略入库的 .artifacts/design-qa/。
const SHOT_DIR = '../.artifacts/design-qa'
/** 180×320 竖屏测试视频，比悬停卡最小宽度窄。 */
const SAMPLE_VIDEO = new URL('../src/testing/fixtures/sample-video.mp4', import.meta.url)
/** 媒体悬停卡内边距 6px，预览区边框 1px，两侧合计。 */
const TIP_PADDING_X_PX = 12
const TIP_PREVIEW_BORDER_X_PX = 2

test('会话页视觉验收：浅色 / 深色 / 运行中', async ({ page }) => {
  await openConversation(page, '夜景延时素材生成')

  await page.getByRole('button', { name: '停止' }).waitFor()
  await page.getByLabel('输入消息').fill('顺便把配音也排上')
  await page.getByLabel('输入消息').press('Enter')
  await expect(page.getByText('1 条消息等待发送')).toBeVisible()
  // 等待流式活动组可见再截图，避免捕获批次尚未到达的空态。
  await expect(page.getByRole('button', { name: /进行中：/ })).toBeVisible()
  // 移开指针并等待 hover 过渡结束，保证截图稳定。
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${SHOT_DIR}/conversation-busy.png`, fullPage: true })

  await expect(page.getByText('镜头表已经更新。')).toBeVisible({ timeout: 15_000 })
  await page.getByText('看设定').click()
  await expect(page.getByRole('table')).toBeVisible()

  await page.screenshot({ path: `${SHOT_DIR}/conversation-light.png`, fullPage: true })

  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/conversation-dark.png`, fullPage: true })
  await page.emulateMedia({ colorScheme: 'light' })
})

test('首页视觉验收：浅色 / 深色 / 移动', async ({ page }) => {
  await page.goto('/')
  await login(page)
  // 展开后 aria-label 会变成「收起鞋盒」，用前缀匹配保持定位稳定。
  const mascot = page.getByRole('button', { name: /鞋盒/ })
  await expect(mascot).toHaveAccessibleName('展开鞋盒，展示鞋履与服装')
  // 等待入场动画完成。
  await page.waitForTimeout(600)

  await page.screenshot({ path: `${SHOT_DIR}/home-light.png`, fullPage: true })
  // 悬停展开鞋盒，等 300ms 的展开动画走完。
  await mascot.hover()
  await expect(mascot).toHaveAttribute('aria-expanded', 'true')
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${SHOT_DIR}/home-mascot-expanded.png`, fullPage: true })
  await page.mouse.move(0, 0)
  await expect(mascot).toHaveAttribute('aria-expanded', 'false')
  await page.waitForTimeout(400)
  await page.getByRole('button', { name: '关联合集：未关联合集' }).click()
  await page.screenshot({
    path: `${SHOT_DIR}/home-collection-light.png`,
    fullPage: true,
    animations: 'disabled',
  })
  await page.keyboard.press('Escape')

  await page.emulateMedia({ colorScheme: 'dark' })
  // 等待主题切换与交互色过渡完成。
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/home-dark.png`, fullPage: true })
  await page.getByRole('button', { name: '关联合集：未关联合集' }).click()
  await page.screenshot({
    path: `${SHOT_DIR}/home-collection-dark.png`,
    fullPage: true,
    animations: 'disabled',
  })
  await page.keyboard.press('Escape')
  await page.emulateMedia({ colorScheme: 'light' })

  await page.getByRole('button', { name: '折叠侧边栏' }).click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/home-sidebar-collapsed.png`, fullPage: true })
  await page.getByRole('button', { name: '展开侧边栏' }).click()

  await page.getByLabel('输入消息').fill('做一个产品宣传片')
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/home-composer-filled.png`, fullPage: true })

  await page.setViewportSize({ height: 844, width: 390 })
  // 折叠初态只在挂载时读取断点，调整视口后重载；MSW 会话会随重载清空，需重新登录。
  await page.reload()
  await login(page)
  await page.getByRole('button', { name: '折叠侧边栏' }).click()
  await expect(page.getByRole('button', { name: '展开鞋盒，展示鞋履与服装' })).toBeVisible()
  await page.screenshot({ path: `${SHOT_DIR}/home-mobile.png`, fullPage: true })
  await page.getByRole('button', { name: '关联合集：未关联合集' }).click()
  await page.screenshot({
    path: `${SHOT_DIR}/home-collection-mobile.png`,
    fullPage: true,
    animations: 'disabled',
  })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({
    path: `${SHOT_DIR}/home-collection-mobile-dark.png`,
    fullPage: true,
    animations: 'disabled',
  })
})

test('首页 composer 附件视觉验收：内联 pill 与悬停卡', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await expect(page.getByRole('heading', { name: 'Cue' })).toBeAttached()

  const png = await canvasPng(page)
  await page
    .locator('input[type="file"]')
    .setInputFiles({ buffer: png, mimeType: 'image/png', name: '夜景参考图.png' })

  const pill = page.getByText('夜景参考图.png')
  await expect(pill).toBeVisible()
  await expect(page.getByRole('button', { name: '发送' })).toBeEnabled()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${SHOT_DIR}/home-composer-attachment.png`, fullPage: true })

  await pill.hover()
  // 传完后卡上第二行报像素尺寸与大小。
  await expect(page.getByRole('tooltip').getByText(/600 × 800 · \d+ KB/)).toBeVisible()
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${SHOT_DIR}/home-composer-attachment-tip.png`, fullPage: true })
})

test('首页 composer 附件悬停卡：卡宽由媒体决定，只有竖屏放宽封顶高度', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await expect(page.getByRole('heading', { name: 'Cue' })).toBeAttached()

  // 文件名的自然宽度大于竖屏图，用来确认文字不撑宽卡片；不超过 32 字，pill 上不截断。
  const imageName = '夜景参考图-外滩灯光延时摄影第三版终稿定稿.png'
  const squareName = '方形参考图.png'
  const videoName = '竖屏样片.mp4'
  const fileInput = page.locator('input[type="file"]')
  await fileInput.setInputFiles({
    buffer: await canvasPng(page),
    mimeType: 'image/png',
    name: imageName,
  })
  await fileInput.setInputFiles({
    buffer: await canvasPng(page, { height: 600, width: 600 }),
    mimeType: 'image/png',
    name: squareName,
  })
  await fileInput.setInputFiles({
    buffer: await readFile(SAMPLE_VIDEO),
    mimeType: 'video/mp4',
    name: videoName,
  })
  const tip = page.getByRole('tooltip')
  // 悬停目标限定在输入框所在的对话栏：悬停卡挂在 body 上，文件名也会出现在卡里。
  const chip = (name: string) => page.getByTestId('pane-chat').getByText(name, { exact: true })
  // 上传后附件标签可能正好落在指针下自己弹出悬停卡，先移开指针，从无卡状态开始。
  await page.mouse.move(0, 0)
  await expect(tip).toBeHidden()

  // 600×800 竖屏图按 320 高封顶，卡宽等于媒体宽加预览边框与卡内边距。
  await chip(imageName).hover()
  await expect(tip.getByText(/600 × 800 · \d+ KB/)).toBeVisible()
  const image = tip.getByRole('img', { name: imageName })
  const imageBox = await image.boundingBox()
  const imageTipBox = await tip.boundingBox()
  expect(imageBox?.height).toBeCloseTo(320, 0)
  expect(imageBox?.width).toBeCloseTo(240, 0)
  expect(imageTipBox?.width).toBeCloseTo(
    (imageBox?.width ?? 0) + TIP_PREVIEW_BORDER_X_PX + TIP_PADDING_X_PX,
    0,
  )

  await page.mouse.move(0, 0)
  await expect(tip).toBeHidden()

  // 方形与横屏保持 220 高、300 宽的封顶。
  await chip(squareName).hover()
  await expect(tip.getByText(/600 × 600 · \d+ KB/)).toBeVisible()
  const squareBox = await tip.getByRole('img', { name: squareName }).boundingBox()
  expect(squareBox?.height).toBeCloseTo(220, 0)
  expect(squareBox?.width).toBeCloseTo(220, 0)

  await page.mouse.move(0, 0)
  await expect(tip).toBeHidden()

  // 180 宽的竖屏视频窄于卡片最小宽度：卡宽落到 200，预览区铺满卡宽，两侧由棋盘格填充。
  await chip(videoName).hover()
  // 视频第二行只有尺寸与时长，不报文件大小。
  await expect(tip.getByText(/^180 × 320 · 0:06$/)).toBeVisible()
  const video = tip.getByLabel(videoName)
  const videoBox = await video.boundingBox()
  const previewBox = await video.locator('xpath=..').boundingBox()
  const videoTipBox = await tip.boundingBox()
  expect(videoBox?.height).toBeCloseTo(320, 0)
  expect(videoTipBox?.width).toBeCloseTo(200, 0)
  expect(previewBox?.width).toBeCloseTo((videoTipBox?.width ?? 0) - TIP_PADDING_X_PX, 0)
})
