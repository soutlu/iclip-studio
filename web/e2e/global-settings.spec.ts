/// <reference lib="dom" />

import { expect, test, type Page } from '@playwright/test'
import { openConversation } from './helpers'

const openReplica = async (page: Page, mobile = false) => {
  const panel = await openConversation(page, '乐福鞋 · 完全复刻', { mobile })
  await expect(panel.getByRole('textbox', { name: '全局设定', exact: true })).toBeVisible()
  return panel
}

test('手机上一帧、下一帧逐张切全局参考图，舞台上的画面完整露出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const panel = await openReplica(page, true)
  await expect(panel.getByRole('group', { name: '全局设定', exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  )
  const expectRevealed = async (index: number) => {
    await expect(
      panel.getByRole('img', { name: `镜头组 1 第 ${index} 帧`, exact: true }),
    ).toBeInViewport({ ratio: 1 })
  }
  await expectRevealed(1)
  for (const index of [2, 3, 4, 5, 6]) {
    await panel.getByRole('button', { name: '下一帧', exact: true }).click()
    await expectRevealed(index)
  }
  for (const index of [5, 4, 3, 2, 1]) {
    await panel.getByRole('button', { name: '上一帧', exact: true }).click()
    await expectRevealed(index)
  }
})

for (const viewport of [
  { name: 'desktop', width: 1600, height: 1000, mobile: false },
  { name: 'mobile', width: 390, height: 844, mobile: true },
]) {
  test(`完全复刻 ${viewport.name} 布局`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    const panel = await openReplica(page, viewport.mobile)
    const global = panel.getByRole('group', { name: '全局设定', exact: true })
    await global.getByRole('button', { name: '查看第 1 帧', exact: true }).click()
    await expect(panel.getByRole('textbox', { name: '全局设定', exact: true })).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true)
    await expect(
      panel.getByRole('img', { name: '镜头组 1 第 1 帧', exact: true }),
    ).toHaveJSProperty('naturalWidth', 360)
    const lastReference = global.getByRole('button', { name: '查看第 30 帧', exact: true })
    await lastReference.focus()
    await page.keyboard.press('Enter')
    await expect(lastReference).toBeInViewport({ ratio: 1 })
    await expect(
      panel.getByRole('img', { name: '镜头组 1 第 30 帧', exact: true }),
    ).toHaveAttribute('src', /./)
    await expect(panel.getByRole('button', { name: '替换图片', exact: true })).toBeVisible()
  })
}
