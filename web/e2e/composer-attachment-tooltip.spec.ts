import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { canvasPng } from './helpers'
import { login } from './login'

/** 180×320 竖屏测试视频，比悬停卡最小宽度窄。 */
const SAMPLE_VIDEO = new URL('../src/testing/fixtures/sample-video.mp4', import.meta.url)
/** 媒体悬停卡内边距 6px，预览区边框 1px，两侧合计。 */
const TIP_PADDING_X_PX = 12
const TIP_PREVIEW_BORDER_X_PX = 2

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
