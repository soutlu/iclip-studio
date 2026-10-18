import { expect, test, type Locator, type Page } from '@playwright/test'
import { openConversation, screenshotBothThemes } from './helpers'

const SHOT_DIR = '../.artifacts/design-qa/whole-film-editor'

/** 演示对话里：第 2 组一条竖版 6 秒成片，第 3 组一条横版成片；这段对话有一首生成的音乐、一首上传的音乐。 */
const openWholeFilm = async (page: Page, panel: Locator) => {
  await panel.getByRole('button', { name: '整片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /^编辑视频\s*整片/ })
  await expect(dialog).toBeVisible()
  await expect(page).toHaveURL(/[?&]wholeFilm=true/)
  return dialog
}

/** 点刻度上某个时刻：播放位置滑块铺满整条时间区 */
const seek = async (page: Page, dialog: Locator, seconds: number) => {
  const ruler = dialog.getByRole('slider', { name: '时间线播放位置' })
  const box = await ruler.boundingBox()
  if (box === null) throw new Error('时间线尚未布局')
  const scale = Number(await ruler.getAttribute('max'))
  await page.mouse.click(box.x + (seconds / scale) * box.width, box.y + box.height / 2)
}

const draftSaved = (page: Page) =>
  page.waitForResponse(
    (response) =>
      response.url().includes('/whole-film/draft') &&
      response.request().method() === 'PUT' &&
      response.ok(),
  )

test('整片编辑器：选段加入成片、修剪、拆分、用音乐，关掉再开草稿还在', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const dialog = await openWholeFilm(page, panel)

  const materials = dialog.getByRole('region', { name: '视频素材区' })
  await materials.getByRole('button', { name: /^生成 A 镜头 1，/ }).click()
  await materials.getByRole('button', { name: '加入成片' }).click()
  const film = dialog.getByRole('group', { name: '成片画面轨' })
  const first = film.getByRole('group', { name: /^第 1 段/ })
  await expect(first).toBeVisible()

  await film.getByRole('button', { name: /^选中：第 1 段/ }).click()
  const before = await first.getAttribute('aria-label')
  await film.getByRole('slider', { name: '裁剪该段结尾' }).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(first).not.toHaveAttribute('aria-label', before ?? '')

  // 在整片中间拆开：读数是「共 X 秒」
  const total = Number((await dialog.locator('.wf-readout b').textContent()) ?? '0')
  await seek(page, dialog, total / 2)
  await dialog.getByRole('button', { name: '拆分' }).click()
  await expect(film.getByRole('group', { name: /^第 2 段/ })).toBeVisible()

  const songs = dialog.getByRole('list', { name: '这段对话的音乐' })
  await expect(songs.getByRole('listitem')).toHaveCount(2)
  const saved = draftSaved(page)
  await songs.getByRole('button', { name: /^用这首：轻快原声吉他/ }).click()
  await expect(dialog.getByRole('group', { name: /^音乐 · 轻快原声吉他/ })).toBeVisible()
  await saved
  for (const shot of [3, 4]) {
    await materials.getByRole('button', { name: new RegExp(`^生成 A 镜头 ${shot}，`) }).click()
    await materials.getByRole('button', { name: '加入成片' }).click()
  }
  await expect(film.getByRole('group', { name: /^第 4 段/ })).toBeVisible()

  // 自动卡点：mock 的音乐是每分钟 120 拍的鼓点，分析出拍点后才能点
  const beatSync = dialog.getByRole('button', { name: '自动卡点' })
  await expect(beatSync).not.toHaveAttribute('aria-disabled', 'true', { timeout: 15_000 })
  await beatSync.click()
  await expect(page.getByText(/^已卡点 \d+ 处，保留 \d+ 处$/)).toBeVisible()

  // 组件栏：片头、转场、包装、字幕样式
  await dialog.getByRole('tab', { name: '组件' }).click()
  const components = dialog.getByRole('list', { name: '组件' })
  await components.getByRole('button', { name: /^字标定格，片头/ }).click()
  await expect(film.getByRole('group', { name: /^片头 · 字标定格/ })).toBeVisible()
  await film.getByRole('button', { name: /^选中：片头 · 字标定格/ }).click()
  const intro = page.getByRole('dialog', { name: '片头 · 字标定格' })
  await expect(intro.getByLabel('品牌名')).toHaveValue('品牌名')
  await intro.getByLabel('品牌名').fill('拾步')
  await intro.getByLabel('品牌名').press('Enter')
  // 预览换上改过品牌名的那一版再截图（新页在底下加载好才换上来）
  await expect(dialog.locator('hyperframes-player:not(.is-pending)')).toHaveAttribute(
    'srcdoc',
    /拾步/,
  )
  await expect(dialog.locator('hyperframes-player.is-pending')).toHaveCount(0)
  await screenshotBothThemes(page, `${SHOT_DIR}/editor-popover`)
  await page.keyboard.press('Escape')
  await expect(intro).toBeHidden()

  await film.getByRole('button', { name: /^选中：第 1 段/ }).click()
  await components.getByRole('button', { name: /^淡入淡出，两段之间/ }).click()
  await expect(film.getByRole('button', { name: /^选中：转场 · 淡入淡出/ })).toBeVisible()

  await seek(page, dialog, 1)
  await components.getByRole('button', { name: /^手绘箭头，包装轨/ }).click()
  await expect(dialog.getByRole('group', { name: /^包装 · 手绘箭头/ })).toBeVisible()

  await dialog.getByRole('button', { name: /^字幕样式：白字黑边/ }).click()
  await components.getByRole('button', { name: /^高亮字幕，字幕样式/ }).click()
  await expect(dialog.getByRole('button', { name: /^字幕样式：高亮字幕/ })).toBeVisible()

  // 字幕轨：改一句字。选的范围只有一秒，第一句被切成了几块，输入框里是整句
  const captions = dialog.getByRole('group', { name: '字幕轨' })
  await captions
    .getByRole('button', { name: /^字幕：/ })
    .first()
    .click()
  const captionInput = captions.getByRole('textbox')
  await expect(captionInput).toHaveValue('夜色里，城市慢慢亮起来')
  const captionSaved = page.waitForRequest(
    (request) =>
      request.method() === 'PUT' &&
      request.url().includes('/whole-film/draft') &&
      (request.postData() ?? '').includes('夜色里，整座城亮了'),
  )
  await captionInput.fill('夜色里，整座城亮了')
  await captionInput.press('Enter')
  await captionSaved

  // 预览：播放器拿到的是这份草稿的合成页（组件文件 CI 不同步，这里不看画面）
  await expect(dialog.locator('hyperframes-player:not(.is-pending)')).toHaveAttribute(
    'srcdoc',
    /data-composition-id="main"[\s\S]*compositions\/.*logo-sting/,
  )
  await screenshotBothThemes(page, `${SHOT_DIR}/editor`)

  // 导出：mock 渲染排队、渲染、上传后给下载地址；下载时对用到的成片各记一次
  const exported = page.waitForResponse(
    (response) => response.url().includes('/whole-film/exports') && response.status() === 202,
  )
  await dialog.getByRole('button', { name: '导出', exact: true }).click()
  await exported
  await expect(dialog.getByRole('status').filter({ hasText: /排队中|正在渲染/ })).toBeVisible()
  const download = dialog.getByRole('link', { name: '下载整片' })
  await expect(download).toBeVisible({ timeout: 15_000 })
  await screenshotBothThemes(page, `${SHOT_DIR}/editor-exported`)
  const tracked = page.waitForRequest(
    (request) => request.url().includes('/tracking/events') && request.method() === 'POST',
  )
  const fileSaved = page.waitForEvent('download')
  await download.click()
  expect((await tracked).postDataJSON()).toMatchObject({ name: 'video.downloaded' })
  await fileSaved

  await dialog.getByRole('button', { name: '关闭整片编辑' }).click()
  await expect(dialog).toBeHidden()
  const reopened = await openWholeFilm(page, panel)
  const reopenedFilm = reopened.getByRole('group', { name: '成片画面轨' })
  await expect(reopenedFilm.getByRole('group', { name: /^第 2 段/ })).toBeVisible()
  await expect(reopened.getByRole('group', { name: /^音乐 · 轻快原声吉他/ })).toBeVisible()
  await expect(reopened.getByRole('button', { name: '撤销' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
})

test('整片编辑器在窄屏上纵向排开', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const panel = await openConversation(page, '夜景延时素材生成', { mobile: true })
  const dialog = await openWholeFilm(page, panel)
  await expect(dialog.getByRole('region', { name: '视频素材区' })).toBeVisible()
  await screenshotBothThemes(page, `${SHOT_DIR}/editor-mobile`)
})
