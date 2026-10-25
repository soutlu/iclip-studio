import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { canvasPng } from './helpers'
import { login } from './login'

/** 180×320 竖屏测试视频，比悬停卡最小宽度窄。 */
const SAMPLE_VIDEO = new URL('../src/testing/fixtures/sample-video.mp4', import.meta.url)
test('首页附件悬停可查看图片与视频元数据，移开后收起', async ({ page }) => {
  await page.goto('/')
  await login(page)
  await expect(page.getByRole('heading', { name: 'iClip' })).toBeAttached()

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

  await chip(imageName).hover()
  await expect(tip.getByText(/600 × 800 · \d+ KB/)).toBeVisible()
  const image = tip.getByRole('img', { name: imageName })
  await expect(image).toBeVisible()
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBe(600)

  await page.mouse.move(0, 0)
  await expect(tip).toBeHidden()

  await chip(squareName).hover()
  await expect(tip.getByText(/600 × 600 · \d+ KB/)).toBeVisible()
  await expect(tip.getByRole('img', { name: squareName })).toBeVisible()

  await page.mouse.move(0, 0)
  await expect(tip).toBeHidden()

  await chip(videoName).hover()
  await expect(tip.getByText(/^180 × 320 · 0:06$/)).toBeVisible()
  const video = tip.getByLabel(videoName)
  await expect(video).toBeVisible()
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
    .toBeGreaterThanOrEqual(2)
  await page.mouse.move(0, 0)
  await expect(tip).toBeHidden()
})
