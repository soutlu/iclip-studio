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

/** 成片编辑器里嵌着的预览页（预览域名下），播放器和成片都在它里面。 */
export const wholeFilmPreviewPage = (dialog: Locator) =>
  dialog.getByRole('region', { name: '预览' }).locator('iframe').contentFrame()

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
