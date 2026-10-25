import { expect, test, type Locator, type Page } from '@playwright/test'
import { openConversation } from './helpers'

/** 演示对话里：第 2 组一条竖版 6 秒素材片，第 3 组一条横版素材片；这段对话有一首生成的音乐、一首上传的音乐。 */
const openWholeFilm = async (page: Page, panel: Locator) => {
  await panel.getByRole('button', { name: '成片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '夜景延时素材生成' })
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

/** 等真实预览完成加载，避免点击尚未接上控制的播放器。 */
const readyPlayer = async (dialog: Locator) => {
  const player = dialog.getByRole('region', { name: '预览' }).locator('hyperframes-player')
  await expect
    .poll(() =>
      player.evaluateAll(
        (elements) =>
          elements.length === 1 && (elements[0] as HTMLElement & { painted: boolean }).painted,
      ),
    )
    .toBe(true)
  return player
}

test('成片编辑器：选段加入成片、修剪、拆分、用音乐，关掉再开草稿还在', async ({ page }) => {
  // 一条走完成片编辑全程的长用例，本地约 15 秒；CI 分片并行时会超过默认的 30 秒
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const dialog = await openWholeFilm(page, panel)

  const materials = dialog
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
  await materials.getByRole('button', { name: /^生成 A 镜头 1，/ }).click()
  await page.keyboard.press('Enter')
  const film = dialog.getByRole('group', { name: '画面轨', exact: true })
  const first = film.getByRole('group', { name: /^第 1 段/ })
  await expect(first).toBeVisible()

  await readyPlayer(dialog)
  await film.getByRole('button', { name: /^选中：第 1 段/ }).click()
  // 点段会自动播放；编辑流程先暂停，后续插入位置才不会随播放时间漂移。
  await dialog
    .getByRole('toolbar', { name: '剪辑工具' })
    .getByRole('button', { name: '暂停', exact: true })
    .click()
  const before = await first.getAttribute('aria-label')
  await film.getByRole('slider', { name: '裁剪该段结尾' }).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(first).not.toHaveAttribute('aria-label', before ?? '')

  // 当前只有这一段，结尾滑块的值就是总长；从中间拆开。
  const total = Number(
    await film.getByRole('slider', { name: '裁剪该段结尾' }).getAttribute('aria-valuenow'),
  )
  await seek(page, dialog, total / 2)
  await dialog.getByRole('button', { name: '拆分' }).click()
  await expect(film.getByRole('group', { name: /^第 2 段/ })).toBeVisible()

  const songs = dialog.getByRole('list', { name: '这段对话的音乐' })
  await expect(songs.getByRole('listitem')).toHaveCount(2)
  const saved = draftSaved(page)
  await songs.getByRole('button', { name: /^选用：轻快原声吉他/ }).click()
  await expect(dialog.getByRole('group', { name: /^音乐 · 音乐 2，/ })).toBeVisible()
  await saved
  for (const shot of [3, 4]) {
    await materials.getByRole('button', { name: new RegExp(`^生成 A 镜头 ${shot}，`) }).click()
    await page.keyboard.press('Enter')
  }
  await expect(film.getByRole('group', { name: /^第 4 段/ })).toBeVisible()

  // 自动卡点：mock 的音乐是每分钟 120 拍的鼓点，分析出拍点后才能点
  const beatSync = dialog.getByRole('button', { name: '自动卡点' })
  await expect(beatSync).not.toHaveAttribute('aria-disabled', 'true', { timeout: 15_000 })
  await beatSync.click()
  await expect(page.getByText(/^已卡点 \d+ 处，保留 \d+ 处$/)).toBeVisible()

  // 组件栏：component 卡片放到特效轨、block 卡片插进画面轨；字幕样式在字幕轨标题上换
  await dialog.getByRole('tab', { name: '通用' }).click()
  const categories = dialog.getByRole('radiogroup', { name: '分类' })
  await categories.getByRole('radio', { name: /^场景/ }).click()
  const components = dialog.getByRole('list', { name: '组件' })
  const overlays = dialog.getByRole('group', { name: '特效轨' })
  await components.getByRole('button', { name: /^字标定格，特效轨/ }).click()
  await expect(overlays.getByRole('group', { name: /^特效 · 字标定格/ })).toBeVisible()
  // 有可填项的组件放下就打开浮层
  const intro = page.getByRole('dialog', { name: '特效 · 字标定格' })
  await expect(intro.getByLabel('品牌名')).toHaveAttribute('placeholder', '品牌名')
  const brandSaved = page.waitForRequest(
    (request) =>
      request.method() === 'PUT' &&
      request.url().includes('/whole-film/draft') &&
      (request.postData() ?? '').includes('拾步'),
  )
  await intro.getByLabel('品牌名').fill('拾步')
  await intro.getByLabel('品牌名').press('Enter')
  await brandSaved
  await readyPlayer(dialog)
  await page.keyboard.press('Escape')
  await expect(intro).toBeHidden()

  await seek(page, dialog, 0)
  await components.getByRole('button', { name: /^标志片尾，画面轨/ }).click()
  await expect(film.getByRole('group', { name: /^第 1 段 · 组件 · 标志片尾/ })).toBeVisible()

  await seek(page, dialog, 1)
  await categories.getByRole('radio', { name: /^社交/ }).click()
  await components.getByRole('button', { name: /^手绘箭头，特效轨/ }).click()
  await expect(dialog.getByRole('group', { name: /^特效 · 手绘箭头/ })).toBeVisible()

  const captionStyle = dialog.getByRole('button', { name: /^字幕样式：/ })
  await expect(captionStyle).toHaveText('白字黑边')
  await captionStyle.click()
  const highlight = page.getByRole('menuitemradio', { name: '高亮字幕', exact: true })
  await expect(highlight.locator('img')).toHaveAttribute('src', /caption-highlight/)
  await highlight.click()
  await expect(captionStyle).toHaveAccessibleName('字幕样式：高亮字幕')
  await expect(captionStyle).toHaveText('高亮字幕')

  // 字幕开关：关掉存进草稿（预览与导出都按它不放字幕），撤销回到开着；再关上，下面关着改字
  const turnOff = dialog.getByRole('button', { name: '关闭字幕', exact: true })
  const turnOn = dialog.getByRole('button', { name: '打开字幕', exact: true })
  const hiddenSaved = page.waitForRequest(
    (request) =>
      request.method() === 'PUT' &&
      request.url().includes('/whole-film/draft') &&
      (request.postData() ?? '').includes('"hidden":true'),
  )
  await expect(turnOff).toHaveAttribute('aria-pressed', 'true')
  await turnOff.click()
  await expect(turnOn).toHaveAttribute('aria-pressed', 'false')
  await hiddenSaved
  await dialog.getByRole('button', { name: '撤销' }).click()
  await expect(turnOff).toHaveAttribute('aria-pressed', 'true')
  await turnOff.click()
  await expect(turnOn).toBeVisible()

  // 字幕轨（字幕关着）：改一句字。选的范围只有一秒，第一句被切成了几块，输入框里是整句
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

  // 导出：mock 渲染排队、渲染、上传后给下载地址；下载时对用到的素材片各记一次
  const exported = page.waitForResponse(
    (response) => response.url().includes('/whole-film/exports') && response.status() === 202,
  )
  await dialog.getByRole('button', { name: '导出', exact: true }).click()
  const { exportId } = (await (await exported).json()) as { exportId: string }
  // 导出完成后读这次导出能做的高清版；mock 里能做，「下载成片」先开菜单。
  const tiers = page.waitForResponse(
    (response) => response.url().includes(`/generations/${exportId}/enhancements`),
    { timeout: 20_000 },
  )
  await expect(dialog.getByRole('status').filter({ hasText: /排队中|正在渲染/ })).toBeVisible()
  const download = dialog.getByRole('button', { name: '下载成片' })
  await expect(download).toBeVisible({ timeout: 15_000 })
  await tiers
  const tracked = page.waitForRequest(
    (request) => request.url().includes('/tracking/events') && request.method() === 'POST',
  )
  const fileSaved = page.waitForEvent('download')
  await download.click()
  await page.getByRole('menuitem', { name: '下载成片', exact: true }).click()
  expect((await tracked).postDataJSON()).toMatchObject({ name: 'video.downloaded' })
  expect((await fileSaved).suggestedFilename()).toMatch(/\.mp4$/)

  // 关掉再打开：成片留着，接着显示最近一次导出
  await dialog.getByRole('button', { name: '关闭成片编辑' }).click()
  await expect(dialog).toBeHidden()
  const reopened = await openWholeFilm(page, panel)
  await expect(reopened.getByRole('button', { name: '下载成片' })).toBeVisible()
  const reopenedFilm = reopened.getByRole('group', { name: '画面轨', exact: true })
  await expect(reopenedFilm.getByRole('group', { name: /^第 2 段/ })).toBeVisible()
  await expect(reopened.getByRole('group', { name: /^音乐 · 音乐 2，/ })).toBeVisible()
  await expect(reopened.getByRole('button', { name: '撤销' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
})

test('成片编辑器在窄屏上纵向排开', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const panel = await openConversation(page, '夜景延时素材生成', { mobile: true })
  const dialog = await openWholeFilm(page, panel)
  await expect(dialog.getByRole('region', { name: '视频素材区' })).toBeVisible()
})
