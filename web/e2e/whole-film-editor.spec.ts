import { expect, test, type Locator, type Page } from '@playwright/test'
import { openConversation } from './helpers'

/** 演示对话里：第 2 组一条竖版 6 秒成片，第 3 组一条横版成片；这段对话有一首生成的音乐、一首上传的音乐。 */
const openWholeFilm = async (page: Page, panel: Locator) => {
  await panel.getByRole('button', { name: '整片', exact: true }).click()
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

test('整片编辑器：选段加入成片、修剪、拆分、用音乐，关掉再开草稿还在', async ({ page }) => {
  // 一条走完整片编辑全程的长用例，本地约 15 秒；CI 分片并行时会超过默认的 30 秒
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const dialog = await openWholeFilm(page, panel)

  const materials = dialog
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
  await materials.getByRole('button', { name: /^生成 A 镜头 1，/ }).click()
  await page.keyboard.press('Enter')
  const film = dialog.getByRole('group', { name: '成片画面轨' })
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

  // 在整片中间拆开：时钟写着「当前 / 总长」，总长是「分:秒.百分秒」
  const clock = (await dialog.locator('.wf-clock').textContent()) ?? ''
  const total = Number(/\/\s*\d+:(\d+(?:\.\d+)?)/.exec(clock)?.[1] ?? '0')
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

  // 组件栏：component 卡片放到特效轨、block 卡片插进成片轨、字幕样式
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
  await intro.getByLabel('品牌名').fill('拾步')
  await intro.getByLabel('品牌名').press('Enter')
  // 预览换上改过品牌名的那一版（新页在底下加载好才换上来）
  await expect(dialog.locator('hyperframes-player:not(.is-pending)')).toHaveAttribute(
    'srcdoc',
    /拾步/,
  )
  await expect(dialog.locator('hyperframes-player.is-pending')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(intro).toBeHidden()

  await seek(page, dialog, 0)
  await components.getByRole('button', { name: /^标志片尾，成片轨/ }).click()
  await expect(film.getByRole('group', { name: /^第 1 段 · 组件 · 标志片尾/ })).toBeVisible()

  await seek(page, dialog, 1)
  await categories.getByRole('radio', { name: /^社交/ }).click()
  await components.getByRole('button', { name: /^手绘箭头，特效轨/ }).click()
  await expect(dialog.getByRole('group', { name: /^特效 · 手绘箭头/ })).toBeVisible()

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

  // 预览：播放器拿到的是这份草稿的合成页，包含刚加入的片尾组件。
  await expect(dialog.locator('hyperframes-player:not(.is-pending)')).toHaveAttribute(
    'srcdoc',
    /data-composition-id="main"[\s\S]*compositions\/.*logo-sting/,
  )

  // 导出：mock 渲染排队、渲染、上传后给下载地址；下载时对用到的成片各记一次
  const exported = page.waitForResponse(
    (response) => response.url().includes('/whole-film/exports') && response.status() === 202,
  )
  await dialog.getByRole('button', { name: '导出', exact: true }).click()
  await exported
  await expect(dialog.getByRole('status').filter({ hasText: /排队中|正在渲染/ })).toBeVisible()
  const download = dialog.getByRole('link', { name: '下载整片' })
  await expect(download).toBeVisible({ timeout: 15_000 })
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
  await expect(reopened.getByRole('group', { name: /^音乐 · 音乐 2，/ })).toBeVisible()
  await expect(reopened.getByRole('button', { name: '撤销' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
})

test('素材预览可暂停续播和段尾重播，切回成片后播放实际推进', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const dialog = await openWholeFilm(page, panel)
  const materials = dialog
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
  const shot = materials.getByRole('button', { name: /^生成 A 镜头 1，/ })
  const toolbar = dialog.getByRole('toolbar', { name: '剪辑工具' })
  const video = dialog.locator('video')
  const mediaTime = () => video.evaluate((element: HTMLVideoElement) => element.currentTime)
  const mediaPaused = () => video.evaluate((element: HTMLVideoElement) => element.paused)

  // 成片为空时，工具条仍然控制正在看的素材。
  await shot.click()
  await expect.poll(mediaTime).toBeGreaterThan(0.05)
  const pause = toolbar.getByRole('button', { name: '暂停', exact: true })
  await expect(pause).not.toHaveAttribute('aria-disabled', 'true')
  await pause.click()
  await expect(video).toBeVisible()
  await expect.poll(mediaPaused).toBe(true)
  const pausedAt = await mediaTime()
  await page.waitForTimeout(250)
  expect(await mediaTime()).toBeCloseTo(pausedAt, 2)

  // 竖版素材的媒体元素完整落在预览区内，不能被容器裁掉上下部分。
  const bounds = await video.evaluate((element) => {
    const frame = element.parentElement
    if (frame === null) throw new Error('素材预览尚未布局')
    return {
      video: element.getBoundingClientRect().toJSON() as { top: number; bottom: number },
      frame: frame.getBoundingClientRect().toJSON() as { top: number; bottom: number },
    }
  })
  expect(bounds.video.top).toBeGreaterThanOrEqual(bounds.frame.top - 1)
  expect(bounds.video.bottom).toBeLessThanOrEqual(bounds.frame.bottom + 1)

  await toolbar.getByRole('button', { name: '播放', exact: true }).click()
  await expect.poll(mediaTime).toBeGreaterThan(pausedAt + 0.05)
  await expect.poll(mediaPaused).toBe(true)
  expect(await mediaTime()).toBeCloseTo(1, 1)
  await toolbar.getByRole('button', { name: '播放', exact: true }).click()
  await expect.poll(mediaPaused).toBe(false)
  expect(await mediaTime()).toBeLessThan(1)

  // 扩成 3 秒选区再加入成片，给真实播放器留足观察播放、暂停的时间。
  const end = materials.getByRole('slider', { name: '裁剪该段结尾' })
  await end.focus()
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Enter')
  const film = dialog.getByRole('group', { name: '成片画面轨' })
  const clip = film.getByRole('button', { name: /^选中：第 1 段/ })
  await expect(clip).toBeVisible()
  const player = await readyPlayer(dialog)

  // 成片已有内容时，暂停素材也不能偷偷切回成片播放。
  await materials.getByRole('group', { name: /^选中的范围 0.0–3.0 秒/ }).click()
  await toolbar.getByRole('button', { name: '暂停', exact: true }).click()
  await expect(video).toBeVisible()
  await expect.poll(mediaPaused).toBe(true)
  await toolbar.getByRole('button', { name: '播放', exact: true }).click()
  await expect.poll(mediaPaused).toBe(false)
  await clip.click()
  await expect(video).toHaveCount(0)
  const playhead = dialog.getByRole('slider', { name: '时间线播放位置' })
  await expect.poll(async () => Number(await playhead.inputValue())).toBeGreaterThan(0.2)
  await toolbar.getByRole('button', { name: '暂停', exact: true }).click()
  await expect
    .poll(() => player.evaluate((element) => (element as HTMLElement & { paused: boolean }).paused))
    .toBe(true)
  // iframe 暂停后还有最后一次报时，先等该消息落地，再观察停止后的时间。
  await page.waitForTimeout(250)
  const filmPausedAt = Number(await playhead.inputValue())
  await page.waitForTimeout(250)
  expect(Number(await playhead.inputValue())).toBeCloseTo(filmPausedAt, 1)
})

test('整片编辑器在窄屏上纵向排开', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const panel = await openConversation(page, '夜景延时素材生成', { mobile: true })
  const dialog = await openWholeFilm(page, panel)
  await expect(dialog.getByRole('region', { name: '视频素材区' })).toBeVisible()
})
