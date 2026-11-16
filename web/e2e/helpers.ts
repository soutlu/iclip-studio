/// <reference lib="dom" />

import { expect, type Locator, type Page } from '@playwright/test'
import { login } from './login'

export const openConversation = async (page: Page, title: string, { mobile = false } = {}) => {
  await page.goto('/')
  await login(page)
  await page.getByRole('link', { name: title, exact: true }).click()
  if (mobile) await page.getByRole('button', { name: '展开工作台' }).click()
  return page.getByRole('complementary', { name: '工作台' })
}

/** 点工作台里的「final-cut」页签打开 final-cut 编辑器，等它读完主文件；返回编辑器的根节点。 */
export const openFinalCut = async (panel: Locator) => {
  await panel.getByRole('tab', { name: 'final-cut', exact: true }).click()
  const editor = panel.getByRole('group', { name: 'final-cut 编辑器', exact: true })
  await expect(editor.getByRole('toolbar', { name: '剪辑工具' })).toBeVisible()
  return editor
}

const CHAT_MIN = 400

const widthOf = async (locator: Locator) => (await locator.boundingBox())?.width ?? Number.NaN

/**
 * 收起侧边栏、把对话收到最窄（400），工作台尽量宽，final-cut 编辑器里放得下更多东西。在对话里、工作台
 * 并排展开时调用；不调用时是默认布局。
 */
export const widenWorkbench = async (page: Page) => {
  const chat = page.getByRole('main')
  const before = await widthOf(chat)
  await page.getByRole('button', { name: '折叠侧边栏' }).click()
  // 侧边栏收起有过渡，对话区跟着变宽：等它的宽度停下来再量
  let last = before
  await expect
    .poll(async () => {
      const width = await widthOf(chat)
      const still = width === last && width !== before
      last = width
      return still
    })
    .toBe(true)
  const handle = await page.getByRole('button', { name: '调整工作台宽度' }).boundingBox()
  if (handle === null) throw new Error('外框布局还没排好')
  const x = handle.x + handle.width / 2
  const y = handle.y + handle.height / 2
  // 正好收到 400：再往左对话会被收进去一截
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - (last - CHAT_MIN), y, { steps: 10 })
  await page.mouse.up()
  await expect.poll(() => widthOf(chat)).toBeCloseTo(CHAT_MIN, 0)
}

/** final-cut 编辑器里嵌着的预览页（预览域名下），播放器和 final-cut 都在它里面。 */
/**
 * 预览里正在显示的那个播放器。改了 final-cut 预览会换一个播放器重新加载，新的那个装好之前对读屏隐藏，
 * 换的那一刻页面里有两个：只认没隐藏的那一个。
 */
export const finalCutPreviewPlayer = (editor: Locator) =>
  editor
    .getByRole('region', { name: '预览' })
    .locator('iframe')
    .contentFrame()
    .locator('hyperframes-player:not([aria-hidden="true"])')

export const openStoryboardShot = async (panel: Locator, index: number) => {
  await panel.getByRole('button', { name: /展开镜头组列表/ }).click()
  const list = panel.page().getByRole('menu', { name: '镜头组列表', exact: true })
  await list.getByRole('menuitemradio', { name: new RegExp(`^第 ${index} 组`) }).click()
  await expect(list).toBeHidden()
}

export const canvasPng = async (
  page: Page,
  {
    fill = '#000000',
    height = 800,
    label,
    width = 600,
  }: { fill?: string; height?: number; label?: string; width?: number } = {},
) => {
  const base64 = await page.evaluate(
    ({ fill, height, label, width }) => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (context === null) throw new Error('测试图片需要 Canvas 2D')
      context.fillStyle = fill
      context.fillRect(0, 0, canvas.width, canvas.height)
      if (label !== undefined) {
        context.fillStyle = '#23503e'
        context.fillRect(70, 180, 460, 440)
        context.font = '36px sans-serif'
        context.fillStyle = '#ffffff'
        context.fillText(label, 180, 420)
      }
      return canvas.toDataURL('image/png').split(',')[1] ?? ''
    },
    { fill, height, label, width },
  )
  return Buffer.from(base64, 'base64')
}

type MockResponseGate = {
  pause: (pathname: string) => void
  release: (pathname: string) => void
}

export const pauseMockResponses = (page: Page, pathname: string) =>
  page.evaluate(
    (path) =>
      (window as unknown as { cueMockResponses: MockResponseGate }).cueMockResponses.pause(path),
    pathname,
  )

export const releaseMockResponses = (page: Page, pathname: string) =>
  page.evaluate(
    (path) =>
      (window as unknown as { cueMockResponses: MockResponseGate }).cueMockResponses.release(path),
    pathname,
  )

export type VideoShot = {
  index: number
  seconds: number
  image_urls: string[]
  prompt: {
    global_settings: string
    timeline: { timestamps: [number, number]; prompt: string; image_indexes: number[] }[]
  }
}

export type VideoShotDocument = { aspect_ratio: string; shots: VideoShot[] }

export const readVideoShots = (page: Page, failure: string) =>
  page.evaluate(async (failure) => {
    const conversationId = window.location.pathname.split('/').at(-1)
    const response = await fetch(
      `/api/conversations/${conversationId}/workspace/file?path=video_shot.json`,
    )
    if (!response.ok) throw new Error(`${failure}：${response.status}`)
    const body = (await response.json()) as { file: { content: string; version: number } }
    return {
      document: JSON.parse(body.file.content) as VideoShotDocument,
      version: body.file.version,
    }
  }, failure)
