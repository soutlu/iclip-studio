/// <reference lib="dom" />

import { expect, test, type Locator, type Page } from '@playwright/test'
import { openConversation, openStoryboardShot, screenshotBothThemes } from './helpers'

/** mock 受理后 3 秒出结果；编辑段与合成各等一轮。 */
const STEP_TIMEOUT = 15_000
const SHOT_DIR = '../.artifacts/design-qa/video-editor'

/** 第 2 组那条成片是竖版，第 3 组是横版，预览黑框的黑边只在横版上出现。 */
const openEditor = async (page: Page, mobile = false, group = 2) => {
  // 编辑器挂在工作台里，紧凑屏要先展开工作台。
  const panel = await openConversation(page, '夜景延时素材生成', { mobile })
  await openStoryboardShot(panel, group)
  // 点成片卡选中它，编辑视频叠在舞台右上。
  await panel
    .getByRole('region', { name: '本组成片', exact: true })
    .getByRole('button', { name: /的成片$/ })
    .first()
    .click()
  await panel.getByRole('button', { name: '编辑视频', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /^编辑视频/ })
  await expect(dialog).toBeVisible()
  await expect(page).toHaveURL(/[?&]video=/)
  return dialog
}

/** 等待浏览器完成 seek，区分精确的逻辑边界与边界内的媒体时间。 */
const expectPausedAt = async (dialog: Locator, clock: number, mediaTime = clock) => {
  await expect(dialog.getByRole('button', { name: '播放', exact: true })).toBeVisible()
  await expect(dialog.getByRole('slider', { name: '时间线播放位置' })).toHaveValue(String(clock))
  await expect
    .poll(() =>
      dialog.getByLabel('视频播放器', { exact: true }).evaluate((element) => {
        const video = element as HTMLVideoElement
        return { paused: video.paused, seeking: video.seeking, time: video.currentTime }
      }),
    )
    .toMatchObject({ paused: true, seeking: false, time: expect.closeTo(mediaTime, 2) })
}

/** 给舞台里两个 `<video>` 挂上 JS 记号；元素一旦重挂，新实例上就没有它。 */
const markPlayers = (scope: Locator) =>
  scope
    .getByLabel('视频预览', { exact: true })
    .locator('video')
    .evaluateAll((videos) => {
      videos.forEach((video, slot) => Object.assign(video, { probe: slot }))
    })

/** 两个 `<video>` 的记号、源与是否已读到元数据，按槽位排。 */
const probePlayers = (scope: Locator) =>
  scope
    .getByLabel('视频预览', { exact: true })
    .locator('video')
    .evaluateAll((videos) =>
      videos.map((element) => {
        const video = element as HTMLVideoElement & { probe?: number }
        return {
          probe: video.probe,
          src: video.getAttribute('src'),
          loaded: video.readyState >= HTMLMediaElement.HAVE_METADATA,
        }
      }),
    )

/** 正在放的那个 `<video>` 的媒体时间；暂停时给 -1。 */
const playingTime = (scope: Locator) =>
  scope.getByLabel('视频播放器', { exact: true }).evaluate((element) => {
    const video = element as HTMLVideoElement
    return video.paused ? -1 : video.currentTime
  })

/** 等放大层的进场动画走完，量到的才是最终尺寸。 */
const openEnlarged = async (page: Page, dialog: Locator) => {
  await dialog.getByRole('button', { name: '放大', exact: true }).click()
  const overlay = page.getByRole('dialog', { name: '放大预览' })
  await expect(overlay).toBeVisible()
  await overlay.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  )
  return overlay
}

const dragBoundary = async (
  page: Page,
  dialog: Locator,
  boundary: 'start' | 'end',
  clock: number,
) => {
  const handle = dialog.getByRole('slider', {
    name: boundary === 'start' ? '选段开始时间' : '选段结束时间',
  })
  await handle.scrollIntoViewIfNeeded()
  const handleBox = await handle.boundingBox()
  const ruler = dialog.getByRole('slider', { name: '时间线播放位置' })
  const rulerBox = await ruler.boundingBox()
  expect(handleBox).not.toBeNull()
  expect(rulerBox).not.toBeNull()
  if (handleBox === null || rulerBox === null) throw new Error('时间线尚未布局')
  const duration = Number(await ruler.getAttribute('max'))
  const y = handleBox.y + handleBox.height / 2
  await page.mouse.move(handleBox.x + handleBox.width / 2, y)
  await page.mouse.down()
  await expect(dialog.getByRole('button', { name: '播放', exact: true })).toBeVisible()
  await page.mouse.move(rulerBox.x + (clock / duration) * rulerBox.width, y, { steps: 4 })
}

test('选段播放：到终点停止，暂停继续与结束重播保留正确起点', async ({ page }) => {
  const dialog = await openEditor(page)
  const start = dialog.getByLabel('开始时间（秒）')
  const end = dialog.getByLabel('结束时间（秒）')
  await expect(start).toBeEnabled({ timeout: STEP_TIMEOUT })
  await start.fill('1')
  await expectPausedAt(dialog, 1)
  await end.fill('2.3')
  await expectPausedAt(dialog, 2.3, 2.299)

  const video = dialog.getByLabel('视频播放器', { exact: true })
  await dialog.getByRole('button', { name: '播放', exact: true }).click()
  await expect
    .poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime))
    .toBeGreaterThan(1.15)
  await dialog.getByRole('button', { name: '暂停', exact: true }).click()
  const pausedTime = await video.evaluate((element) => (element as HTMLVideoElement).currentTime)
  expect(pausedTime).toBeLessThan(2.3)
  await dialog.getByRole('button', { name: '播放', exact: true }).click()
  expect(
    await video.evaluate((element) => (element as HTMLVideoElement).currentTime),
  ).toBeGreaterThanOrEqual(pausedTime - 0.01)
  await expect
    .poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime))
    .toBeGreaterThan(pausedTime + 0.1)
  await expectPausedAt(dialog, 2.3, 2.299)

  await dialog.getByRole('button', { name: '播放', exact: true }).click()
  await expect
    .poll(() =>
      video.evaluate((element) => {
        const media = element as HTMLVideoElement
        return !media.paused && media.currentTime >= 1 && media.currentTime < 1.5
      }),
    )
    .toBe(true)
  await expectPausedAt(dialog, 2.3, 2.299)
})

test('选段定位：播放中拖动两端立即暂停，边界限制、键盘和数字输入同步预览', async ({ page }) => {
  const dialog = await openEditor(page)
  const start = dialog.getByLabel('开始时间（秒）')
  const end = dialog.getByLabel('结束时间（秒）')
  await expect(start).toBeEnabled({ timeout: STEP_TIMEOUT })
  await start.fill('1')
  await end.fill('5')
  await dialog.getByRole('button', { name: '播放', exact: true }).click()
  await expect
    .poll(() =>
      dialog
        .getByLabel('视频播放器', { exact: true })
        .evaluate((element) => !(element as HTMLVideoElement).paused),
    )
    .toBe(true)

  await dragBoundary(page, dialog, 'start', 2)
  await expect(start).toHaveValue('2')
  await expectPausedAt(dialog, 2)
  await page.mouse.up()
  await expectPausedAt(dialog, 2)

  await dialog.getByRole('button', { name: '播放', exact: true }).click()
  await expect
    .poll(() =>
      dialog
        .getByLabel('视频播放器', { exact: true })
        .evaluate((element) => !(element as HTMLVideoElement).paused),
    )
    .toBe(true)
  await dragBoundary(page, dialog, 'end', 3.5)
  await expect(end).toHaveValue('3.5')
  await expectPausedAt(dialog, 3.5, 3.499)
  await page.mouse.up()
  await expectPausedAt(dialog, 3.5, 3.499)

  // 拖过另一端时使用最终 clamp 后的位置，画面不能继续追随越界指针。
  await dragBoundary(page, dialog, 'start', 5)
  await expect(start).toHaveValue('2.5')
  await expectPausedAt(dialog, 2.5)
  await page.mouse.up()
  await dialog.getByRole('slider', { name: '选段开始时间' }).press('ArrowRight')
  await expect(start).toHaveValue('2.5')
  await expect(end).toHaveValue('3.5')
  await expectPausedAt(dialog, 2.5)
  await start.fill('1')
  await expectPausedAt(dialog, 1)
  await dragBoundary(page, dialog, 'end', 0)
  await expect(end).toHaveValue('2')
  await expectPausedAt(dialog, 2, 1.999)
  await page.mouse.up()
  await dialog.getByRole('slider', { name: '选段结束时间' }).press('ArrowLeft')
  await expect(start).toHaveValue('1')
  await expect(end).toHaveValue('2')
  await expectPausedAt(dialog, 2, 1.999)

  // 数字输入也保持至少 1 秒，不能绕过拖动手柄的限制。
  await end.fill('1.2')
  await expect(end).toHaveValue('2')
  await expectPausedAt(dialog, 2, 1.999)
  await start.fill('1.8')
  await expect(start).toHaveValue('1')
  await expect(end).toHaveValue('2')
  await expectPausedAt(dialog, 1)

  await end.fill('4')
  await expectPausedAt(dialog, 4, 3.999)
  await dialog.getByRole('slider', { name: '选段开始时间' }).press('ArrowRight')
  await expect(start).toHaveValue('1.1')
  await expectPausedAt(dialog, 1.1)
  await dialog.getByRole('slider', { name: '选段结束时间' }).press('ArrowLeft')
  await expect(end).toHaveValue('3.9')
  await expectPausedAt(dialog, 3.9, 3.899)
})

test('从生成记录打开编辑器：切段、生成、预览、合成成为新版本', async ({ page }) => {
  // 三轮后台任务外，还验证跨素材播放、附件和多尺寸布局。
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1600, height: 1120 })
  const dialog = await openEditor(page)
  await expect(dialog.getByRole('region', { name: '视频编辑时间线' })).toBeVisible({
    timeout: STEP_TIMEOUT,
  })

  const modelPicker = dialog.getByRole('button', { name: '编辑模型', exact: true })
  await modelPicker.click()
  await expect(page.getByRole('menuitemradio', { name: 'vendor-a-seedance-2-5' })).toBeChecked()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await expect(modelPicker).toHaveText('wan3.0-video')
  await expect(modelPicker).toBeFocused()
  await modelPicker.press('ArrowDown')
  await expect(page.getByRole('menuitemradio', { name: 'wan3.0-video' })).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(modelPicker).toBeFocused()

  await dialog.getByLabel('开始时间（秒）').fill('1')
  await dialog.getByLabel('结束时间（秒）').fill('4')
  await dialog.getByRole('slider', { name: '选段开始时间' }).press('ArrowRight')
  await expect(dialog.getByLabel('开始时间（秒）')).toHaveValue('1.1')
  await dialog.getByRole('slider', { name: '选段开始时间' }).press('ArrowLeft')
  await dialog.getByRole('textbox', { name: '修改要求' }).fill('换成浅灰背景，保留运镜。')
  const fileChooser = page.waitForEvent('filechooser')
  await dialog.getByRole('button', { name: '添加参考图片', exact: true }).click()
  await (await fileChooser).setFiles('public/agent-icons/editor.png')
  const reference = dialog.getByRole('img', { name: 'editor.png', exact: true })
  await expect(reference).toBeVisible()
  const referenceUrl = await reference.getAttribute('src')

  const editRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith('/api/generations/video-edits') && request.method() === 'POST',
  )
  await dialog.getByRole('button', { name: '生成', exact: true }).click()

  // 一次提交：基底是正在编辑的那条出片，区间按毫秒给。参考片段由浏览器从基底上切好、传上去：
  // mock 基底每秒一个关键帧，1–4 秒正好落在关键帧上，吸附后不变。
  const editSent = await editRequest
  const edit = editSent.postDataJSON() as Record<string, unknown>
  expect(edit).toMatchObject({
    source_job_id: new URL(page.url()).searchParams.get('video'),
    range_start_ms: 1000,
    range_end_ms: 4000,
    reference_video_urls: [expect.stringMatching(/\/mock-oss\//)],
    model: 'wan3.0-video',
    prompt: '编辑视频，换成浅灰背景，保留运镜。',
    seconds: -1,
    reference_image_urls: [referenceUrl],
  })
  // 传上去的是一段真 MP4，正好是选的那 3 秒。
  const [clipUrl] = edit['reference_video_urls'] as string[]
  const clip = await page.evaluate(async (url) => {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())
    const video = document.createElement('video')
    video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }))
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve
      video.onerror = reject
    })
    return { box: new TextDecoder().decode(bytes.subarray(4, 8)), duration: video.duration }
  }, clipUrl)
  expect(clip).toEqual({ box: 'ftyp', duration: expect.closeTo(3, 1) })
  const accepted = (await (await editSent.response())?.json()) as { generation: { id: string } }

  const summary = dialog.getByRole('status', { name: '视频编辑进度' })
  await expect(summary).toHaveText(/正在生成视频/, { timeout: STEP_TIMEOUT })
  // 生成中的编辑已摆进版本条、挂着走表，结果没回来前点不动，选中的仍是原片。
  const versions = dialog.getByRole('group', { name: '视频版本' })
  await expect(versions.getByRole('button', { name: '未合成 · 生成中' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await expect(versions.getByRole('button', { name: 'V1', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.screenshot({ path: `${SHOT_DIR}/generation-running.png`, animations: 'disabled' })
  await expect(summary).toHaveText(/待预览/, { timeout: STEP_TIMEOUT })
  await expect(summary.getByRole('listitem', { name: '结果预览，当前阶段' })).toHaveAttribute(
    'aria-current',
    'step',
  )
  await page.screenshot({ path: `${SHOT_DIR}/generation-ready.png`, animations: 'disabled' })
  await page.setViewportSize({ width: 1280, height: 900 })
  const referenceBottom = await reference.evaluate(
    (element) => element.getBoundingClientRect().bottom,
  )
  const uploadTop = await dialog
    .getByRole('button', { name: '添加参考图片', exact: true })
    .evaluate((element) => element.getBoundingClientRect().top)
  expect(referenceBottom).toBeLessThanOrEqual(uploadTop)
  await expect(summary).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: `${SHOT_DIR}/generation-compact.png`, animations: 'disabled' })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.screenshot({ path: `${SHOT_DIR}/generation-laptop.png`, animations: 'disabled' })
  await expect(summary).toBeInViewport({ ratio: 1 })
  await page.setViewportSize({ width: 1600, height: 1120 })

  // 结果回来就把视线挪到它的预览上，不用自己去找。
  // 预览拼好的整条：原片放到 1 秒就该切到编辑结果那条，时钟接着走。
  await expect(versions.getByRole('button', { name: '未合成', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(dialog.getByRole('region', { name: '视频编辑时间线' })).toBeVisible({
    timeout: STEP_TIMEOUT,
  })
  await expect(dialog.getByRole('slider', { name: '选段开始时间' })).toHaveCount(0)
  const previewSource = await dialog.getByLabel('视频播放器', { exact: true }).getAttribute('src')
  expect(previewSource).not.toBeNull()
  // 放大不重挂播放器：预载着编辑结果那段的另一个 <video> 带着读好的源进遮罩，点遮罩关掉后原样回来。
  await markPlayers(dialog)
  await expect
    .poll(() => probePlayers(dialog))
    .toEqual([
      { probe: 0, src: previewSource, loaded: true },
      { probe: 1, src: expect.stringMatching(/sample-edited/), loaded: true },
    ])
  const preloaded = await probePlayers(dialog)
  const overlay = await openEnlarged(page, dialog)
  expect(await probePlayers(overlay)).toEqual(preloaded)
  await overlay.getByRole('button', { name: '关闭预览', exact: true }).click({
    position: { x: 8, y: 8 },
  })
  await expect(overlay).toBeHidden()
  expect(await probePlayers(dialog)).toEqual(preloaded)
  await dialog.getByRole('button', { name: '播放', exact: true }).click()
  await expect(dialog.getByLabel('视频播放器', { exact: true })).toHaveAttribute(
    'src',
    /sample-edited/,
    { timeout: 8000 },
  )
  // 待合成的预览没有选区限制：越过原来 4 秒的终点，继续播放第三段。
  await expect(dialog.getByLabel('视频播放器', { exact: true })).toHaveAttribute(
    'src',
    previewSource ?? '',
    { timeout: 8000 },
  )
  await expect
    .poll(async () =>
      Number(
        await dialog
          .getByRole('slider', {
            name: '时间线播放位置',
          })
          .inputValue(),
      ),
    )
    .toBeGreaterThan(4.1)
  await expect(dialog.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '暂停', exact: true }).click()

  const compositeRequest = page.waitForRequest(
    (request) =>
      request.url().endsWith('/api/generations/video-composites') && request.method() === 'POST',
  )
  // 看着待预览的编辑，标题行有「合成成片」；控制条上的下载灰着，预览还不是一个文件。
  const compose = dialog.getByRole('button', { name: '合成成片', exact: true })
  await expect(compose).toBeEnabled({ timeout: STEP_TIMEOUT })
  const downloadButton = dialog.getByRole('button', { name: '下载', exact: true })
  await expect(downloadButton).toBeDisabled()
  await compose.click()
  // 合成给基底与片段列表：基底 [0, 1)、编辑段整条、基底 [4, 结尾)，区间取编辑段上记的值。
  const baseJobId = edit['source_job_id']
  expect((await compositeRequest).postDataJSON()).toEqual({
    conversationId: expect.any(String),
    taskId: null,
    baseJobId,
    segments: [
      { sourceJobId: baseJobId, start: 0, end: 1 },
      { sourceJobId: accepted.generation.id, start: 0 },
      { sourceJobId: baseJobId, start: 4 },
    ],
  })

  // 成片落地后 V2 成为新版本，选中态不跳走：「合成成片」收起，下载可用。
  await expect(versions.getByRole('button', { name: 'V2', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
    { timeout: STEP_TIMEOUT },
  )
  await expect(compose).toHaveCount(0)
  await expect(versions.getByRole('button', { name: /^未合成/ })).toHaveCount(0)
  await expect(downloadButton).toBeEnabled()
  const download = page.waitForEvent('download')
  await downloadButton.click()
  expect((await download).suggestedFilename()).toBeTruthy()
  const previewTabs = dialog.getByRole('group', { name: '预览版本' })
  const versionTab = previewTabs.getByRole('button', { name: '改后', exact: true })
  await expect(versionTab).toHaveAttribute('aria-pressed', 'true')
  const versionSource = await dialog.getByLabel('视频播放器', { exact: true }).getAttribute('src')
  expect(versionSource).not.toBeNull()
  await previewTabs.getByRole('button', { name: '原片', exact: true }).click()
  await expect(previewTabs.getByRole('button', { name: '原片', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await dragBoundary(page, dialog, 'start', 2)
  await page.mouse.up()
  await expect(versionTab).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog.getByLabel('视频播放器', { exact: true })).toHaveAttribute(
    'src',
    versionSource ?? '',
  )
  await expectPausedAt(dialog, 2)
})

test('桌面、移动与深色布局各留一张截图', async ({ page }) => {
  await page.setViewportSize({ width: 1303, height: 1006 })
  const dialog = await openEditor(page)
  await expect(dialog.getByRole('region', { name: '视频编辑时间线' })).toBeVisible({
    timeout: STEP_TIMEOUT,
  })
  await dialog.getByRole('button', { name: '编辑模型', exact: true }).click()
  await expect(page.getByRole('menuitemradio', { name: 'wan3.0-video' })).toBeVisible()
  await page.screenshot({ path: `${SHOT_DIR}/model-menu-light.png`, animations: 'disabled' })
  await page.keyboard.press('Escape')
  await page.screenshot({ path: `${SHOT_DIR}/desktop-light.png`, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: `${SHOT_DIR}/desktop-dark.png`, animations: 'disabled' })
  await dialog.getByRole('button', { name: '编辑模型', exact: true }).click()
  await page.screenshot({ path: `${SHOT_DIR}/model-menu-dark.png`, animations: 'disabled' })
})

test('移动布局：对话框内部自己滚，页面不横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const dialog = await openEditor(page, true)
  await expect(dialog.getByRole('region', { name: '视频编辑时间线' })).toBeVisible({
    timeout: STEP_TIMEOUT,
  })
  await page.screenshot({ path: `${SHOT_DIR}/mobile-light.png`, animations: 'disabled' })
  await dialog
    .getByRole('textbox', { name: '修改要求' })
    .fill('按参考图调整背景和光线，保留鞋款细节与原有运镜，避免改变商品颜色和画面主体的位置。')
  await dialog.getByRole('button', { name: '编辑模型', exact: true }).click()
  await expect(page.getByRole('menuitemradio', { name: 'wan3.0-video' })).toBeVisible()
  await page.screenshot({ path: `${SHOT_DIR}/model-menu-mobile.png`, animations: 'disabled' })
  await page.keyboard.press('Escape')
  await dialog.getByRole('button', { name: '生成', exact: true }).click()
  const status = dialog.getByRole('status', { name: '视频编辑进度' })
  await expect(status).toHaveText(/待预览/, { timeout: STEP_TIMEOUT })
  await status.scrollIntoViewIfNeeded()
  await expect(status).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: `${SHOT_DIR}/generation-mobile.png`, animations: 'disabled' })
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

  // 手机上放大：宽度到 90vw 的上限为止，比例不变，页面仍不横向溢出。
  const overlay = await openEnlarged(page, dialog)
  const stage = await overlay.getByLabel('视频预览', { exact: true }).boundingBox()
  if (stage === null) throw new Error('放大层尚未布局')
  expect(stage.width).toBeCloseTo(390 * 0.9, 0)
  expect(stage.width / stage.height).toBeCloseTo(9 / 16, 2)
  await page.screenshot({ path: `${SHOT_DIR}/enlarge-mobile.png`, animations: 'disabled' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

test('横版素材：舞台按画面比例摆，不留黑边；画面上不压播放控件，放大后控件贴住画面底边', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1303, height: 1006 })
  const dialog = await openEditor(page, false, 3)
  await expect(dialog.getByRole('region', { name: '视频编辑时间线' })).toBeVisible({
    timeout: STEP_TIMEOUT,
  })

  // 读到元数据后画面框换成 16:9，播放器铺满画面框，contain 不再留出上下黑边。
  const preview = dialog.getByLabel('视频预览', { exact: true })
  await expect
    .poll(async () => {
      const box = await preview.boundingBox()
      return box === null ? 0 : box.width / box.height
    })
    .toBeCloseTo(16 / 9, 2)
  const picture = await dialog.getByLabel('视频播放器', { exact: true }).evaluate((element) => {
    const media = element as HTMLVideoElement
    const box = media.getBoundingClientRect()
    return { boxRatio: box.width / box.height, mediaRatio: media.videoWidth / media.videoHeight }
  })
  expect(picture.boxRatio).toBeCloseTo(picture.mediaRatio, 2)
  // 播放控件只在时间线面板顶上那一行，舞台里没有。
  await expect(preview.getByRole('group', { name: '播放控件' })).toHaveCount(0)
  await expect(dialog.getByRole('group', { name: '播放控件' })).toHaveCount(1)

  await page.screenshot({ path: `${SHOT_DIR}/wide-desktop.png`, animations: 'disabled' })

  // 放大后舞台按画面比例取到灯箱的宽度上限，没有黑边，控件贴着画面底边。
  const overlay = await openEnlarged(page, dialog)
  const stage = await overlay.getByLabel('视频预览', { exact: true }).boundingBox()
  const enlargedPill = await overlay.getByRole('group', { name: '播放控件' }).boundingBox()
  if (stage === null || enlargedPill === null) throw new Error('放大层尚未布局')
  expect(stage.width).toBeCloseTo(960, 0)
  expect(stage.width / stage.height).toBeCloseTo(16 / 9, 2)
  expect(enlargedPill.y + enlargedPill.height).toBeLessThanOrEqual(stage.y + stage.height)
  expect(enlargedPill.y + enlargedPill.height).toBeGreaterThan(stage.y + stage.height - 40)
  await page.screenshot({ path: `${SHOT_DIR}/enlarge-wide.png`, animations: 'disabled' })
})

test('放大预览：舞台搬进应用内遮罩，播放不断、不进浏览器全屏，Escape 只关遮罩', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1303, height: 1006 })
  const dialog = await openEditor(page)
  await expect(dialog.getByRole('region', { name: '视频编辑时间线' })).toBeVisible({
    timeout: STEP_TIMEOUT,
  })
  // 放宽到整条，播放够长，放大前后都量得到时间在走。
  await dialog.getByLabel('结束时间（秒）').fill('6')
  await markPlayers(dialog)
  await expect.poll(async () => (await probePlayers(dialog))[0]?.loaded).toBe(true)
  const players = await probePlayers(dialog)

  // 竖版画面按 80vh 的高度上限放大，比例不变。
  let overlay = await openEnlarged(page, dialog)
  await expect(overlay.getByRole('button', { name: '关闭', exact: true })).toBeFocused()
  await expect(overlay.getByRole('button', { name: '放大', exact: true })).toHaveCount(0)
  const stage = await overlay.getByLabel('视频预览', { exact: true }).boundingBox()
  if (stage === null) throw new Error('放大层尚未布局')
  expect(stage.height).toBeCloseTo(1006 * 0.8, 0)
  expect(stage.width / stage.height).toBeCloseTo(9 / 16, 2)
  await screenshotBothThemes(page, `${SHOT_DIR}/enlarge`)
  await overlay.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(overlay).toBeHidden()
  await expect(dialog.getByRole('button', { name: '放大', exact: true })).toBeFocused()

  await dialog.getByRole('button', { name: '播放', exact: true }).click()
  await expect.poll(() => playingTime(dialog)).toBeGreaterThan(0.2)
  overlay = await openEnlarged(page, dialog)
  expect(await probePlayers(overlay)).toEqual(players)
  const openedAt = await playingTime(overlay)
  expect(openedAt).toBeGreaterThan(0.2)
  await expect.poll(() => playingTime(overlay)).toBeGreaterThan(openedAt + 0.3)
  await expect(overlay.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull()

  await page.keyboard.press('Escape')
  await expect(overlay).toBeHidden()
  await expect(dialog).toBeVisible()
  await expect(page).toHaveURL(/[?&]video=/)
  await expect(dialog.getByRole('button', { name: '放大', exact: true })).toBeFocused()
  expect(await probePlayers(dialog)).toEqual(players)
  const closedAt = await playingTime(dialog)
  expect(closedAt).toBeGreaterThan(openedAt)
  await expect.poll(() => playingTime(dialog)).toBeGreaterThan(closedAt + 0.3)
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull()
})

test('只有成功的出片才能进编辑；关掉编辑器回到成片区，地址里不再带 video', async ({ page }) => {
  const dialog = await openEditor(page)
  await dialog.getByRole('button', { name: '关闭视频编辑', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page).not.toHaveURL(/[?&]video=/)
  const takes = page.getByRole('region', { name: '本组成片', exact: true })
  await expect(takes).toBeVisible()
  // 第 2 组只有一条完成的出片：选中失败的那条，编辑置灰；选中在途的那条，没有编辑入口。
  await expect(takes.getByRole('listitem')).toHaveCount(3)
  const edit = page.getByRole('button', { name: '编辑视频', exact: true })
  await takes.getByRole('button', { name: /生成失败$/ }).click()
  await expect(edit).toHaveAttribute('aria-disabled', 'true')
  await takes.getByRole('button', { name: /生成中$/ }).click()
  await expect(edit).toHaveCount(0)
})
