/// <reference lib="dom" />

import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  canvasPng,
  openConversation,
  openStoryboardShot,
  pauseMockResponses,
  releaseMockResponses,
} from './helpers'

/** mock 受理后 3 秒出结果；编辑段与合成各等一轮，结果时长另由浏览器读。 */
const STEP_TIMEOUT = 15_000

/** 第 2 组那条素材片是竖版、6 秒、每秒一个关键帧（6 个镜头）、带一条原声；第 3 组是横版、无声。
 * mock 的编辑结果是一条 3 秒的样片。 */
const openEditor = async (page: Page, mobile = false, group = 2, useWan = true) => {
  // 编辑器挂在工作台里，紧凑屏要先展开工作台。
  const panel = await openConversation(page, '夜景延时素材生成', { mobile })
  await openStoryboardShot(panel, group)
  // 点素材片卡选中它，编辑视频叠在舞台右上。
  await panel
    .getByRole('region', { name: '本组素材片', exact: true })
    .getByRole('button', { name: /的素材片$/ })
    .first()
    .click()
  await panel.getByRole('button', { name: '编辑视频', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /^编辑视频/ })
  await expect(dialog).toBeVisible()
  await expect(page).toHaveURL(/[?&]video=/)
  if (useWan) {
    // 服务端默认 Seedance 2.5 编辑至少 4 秒；这里的旅程用一两个镜头，显式选 Wan。
    await expect(shots(dialog).first()).toBeVisible({ timeout: STEP_TIMEOUT })
    await shot(dialog, 1).click()
    await card(dialog).getByRole('button', { name: '编辑模型', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'wan3.0-video', exact: true }).click()
  }
  return dialog
}

const timelineOf = (dialog: Locator) =>
  dialog.getByRole('region', { name: '视频编辑时间线', exact: true })
/** 原片轨上的镜头。 */
const shots = (dialog: Locator) =>
  timelineOf(dialog)
    .getByRole('group', { name: '原片', exact: true })
    .getByRole('button', { name: /^镜头 \d+ ·/ })
const shot = (dialog: Locator, no: number) =>
  timelineOf(dialog)
    .getByRole('group', { name: '原片', exact: true })
    .getByRole('button', { name: new RegExp(`^镜头 ${no} ·`) })
/** 编辑轨：编辑片段与第一行的占位。 */
const lane = (dialog: Locator) =>
  timelineOf(dialog).getByRole('group', { name: '编辑片段', exact: true })
const controls = (dialog: Locator) => dialog.getByRole('group', { name: '播放控件' })
/** 版本视图里时间线上一版一行。 */
const versions = (dialog: Locator) => dialog.getByRole('group', { name: '视频版本' })
const view = (dialog: Locator, name: '版本' | '剪辑') =>
  dialog.getByRole('group', { name: '查看方式' }).getByRole('button', { name, exact: true })
/** 选中镜头时盖在舞台上的生成卡；选中草稿里一块时是以它命名的小卡。 */
const card = (dialog: Locator) => dialog.getByRole('region', { name: 'AI 改段' })
const smallCard = (dialog: Locator, name: string) => dialog.getByRole('region', { name })
/** 草稿轨：要合成的内容。 */
const draft = (dialog: Locator) =>
  timelineOf(dialog).getByRole('group', { name: '草稿', exact: true })
/** 原片轨上镜头的小眼睛。 */
const shotEye = (dialog: Locator, no: number) =>
  timelineOf(dialog)
    .getByRole('group', { name: '原片', exact: true })
    .getByRole('button', { name: new RegExp(`^(关闭|开启)镜头 ${no}$`) })
/** 编辑轨上一段的小眼睛。 */
const partEye = (dialog: Locator, name: string) =>
  lane(dialog)
    .getByRole('group', { name, exact: true })
    .getByRole('button', { name: /选用这一段$/ })
/** 卡收起后的小胶囊。 */
const capsule = (dialog: Locator) => dialog.getByRole('button', { name: /^展开镜头 \d/ })
const requestBox = (dialog: Locator) =>
  card(dialog).getByRole('textbox', { name: '修改要求', exact: true })
const generateButton = (dialog: Locator) =>
  card(dialog).getByRole('button', { name: '生成视频', exact: true })
const composeButton = (dialog: Locator) =>
  controls(dialog).getByRole('button', { name: /合成新版本|正在合成/ })

/** 等镜头读好：第 2 组 6 个镜头。 */
const waitForShots = async (dialog: Locator, count = 6) => {
  await expect(shots(dialog)).toHaveCount(count, { timeout: STEP_TIMEOUT })
}

/** 时间线上某个原片时刻的横坐标：刻度上的播放位置滑块铺满整条轨道。 */
const xAt = async (dialog: Locator, time: number) => {
  const ruler = dialog.getByRole('slider', { name: '时间线播放位置' })
  const box = await ruler.boundingBox()
  if (box === null) throw new Error('时间线尚未布局')
  const scale = Number(await ruler.getAttribute('max'))
  return box.x + (time / scale) * box.width
}

const centerOf = async (locator: Locator) => {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  if (box === null) throw new Error('元素尚未布局')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** 按住一处拖到时间线的某个时刻，不松手；返回松手的函数。 */
const holdDrag = async (page: Page, dialog: Locator, from: Locator, time: number) => {
  const start = await centerOf(from)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(await xAt(dialog, time), start.y, { steps: 6 })
  return () => page.mouse.up()
}

/** 卡里写着要求，点「生成视频」：返回编辑请求体与受理的记录 id。 */
const submitEdit = async (page: Page, dialog: Locator) => {
  const request = page.waitForRequest(
    (sent) => sent.url().endsWith('/api/generations/video-edits') && sent.method() === 'POST',
  )
  await generateButton(dialog).click()
  const sent = await request
  const accepted = (await (await sent.response())?.json()) as { generation: { id: string } }
  return { body: sent.postDataJSON() as Record<string, unknown>, editId: accepted.generation.id }
}

/** 延迟真实直传，不伪造 HTTP 结果；MSW Service Worker 会先于 Playwright route 接收上传。 */
const holdReferenceUpload = async (page: Page) => {
  await page.evaluate(() => {
    const OriginalRequest = XMLHttpRequest
    const pending: (() => void)[] = []
    class GatedRequest extends OriginalRequest {
      private storagePut = false

      override open(method: string, url: string | URL) {
        this.storagePut = method === 'PUT' && String(url).includes('/mock-oss/')
        super.open(method, url)
      }

      override send(body?: Document | XMLHttpRequestBodyInit | null) {
        if (this.storagePut) pending.push(() => super.send(body))
        else super.send(body)
      }
    }
    window.XMLHttpRequest = GatedRequest
    window.addEventListener(
      'release-reference-upload',
      () => {
        window.XMLHttpRequest = OriginalRequest
        pending.forEach((send) => send())
      },
      { once: true },
    )
  })
  return () => page.evaluate(() => window.dispatchEvent(new Event('release-reference-upload')))
}

/** 卡头：第一行选了哪几个镜头，第二行原片区间与做法，或为什么还不能生成。 */
const expectCard = async (dialog: Locator, title: string, detail: string) => {
  await expect(card(dialog).getByText(title, { exact: true })).toBeVisible()
  await expect(card(dialog).getByText(detail, { exact: true })).toBeVisible()
}

test('编辑一段：选镜头生成，结果在编辑轨上按关键帧切段；点段选用、再点取消，各段都选用后合成，完成后自动切到版本视图看新版本', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1335, height: 880 })
  const dialog = await openEditor(page)
  await waitForShots(dialog)
  // 原片有原声：读到的是真实波形，不是「无声」。
  await expect(timelineOf(dialog).getByTestId('timeline-wave').first()).toBeVisible({
    timeout: STEP_TIMEOUT,
  })
  await expect(view(dialog, '剪辑')).toHaveAttribute('aria-pressed', 'true')
  await expect(composeButton(dialog)).toBeDisabled()

  await shot(dialog, 2).click()
  await shot(dialog, 3).click({ modifiers: ['Shift'] })
  await expectCard(dialog, '镜头 2–3 · 视频生成', '原片 1.0 – 3.0 秒 · 视频和原声一起重做')

  // 写要求，再用「+」加一张参考图：落成光标处的图片标签，传好才能生成。
  await requestBox(dialog).fill('换成黄昏的暖光，逆光打在人和滑板上，动作和机位不变，色调参考')
  const fileChooser = page.waitForEvent('filechooser')
  await card(dialog).getByRole('button', { name: '添加附件', exact: true }).click()
  await (
    await fileChooser
  ).setFiles({
    name: '黄昏.png',
    mimeType: 'image/png',
    buffer: await canvasPng(page, { fill: '#be6838', label: 'Dusk' }),
  })
  await expect(requestBox(dialog).getByText('黄昏.png')).toBeVisible()
  await expect(generateButton(dialog)).toBeEnabled({ timeout: STEP_TIMEOUT })

  const { body, editId } = await submitEdit(page, dialog)
  // 基底总是原片，区间正好是镜头 2–3；参考片段由浏览器在关键帧处切好、传上去。
  const baseJobId = new URL(page.url()).searchParams.get('video')
  expect(body).toMatchObject({
    source_job_id: baseJobId,
    range_start_ms: 1000,
    range_end_ms: 3000,
    reference_video_urls: [expect.stringMatching(/\/mock-oss\//)],
    model: 'wan3.0-video',
    prompt: '换成黄昏的暖光，逆光打在人和滑板上，动作和机位不变，色调参考@Image1',
    seconds: -1,
    reference_image_urls: [expect.stringMatching(/\/mock-oss\//)],
  })

  // 结果在编辑轨上正对镜头 2–3：先是生成中；出来的样片 3 秒、关键帧在 0/1/2 秒，切成 3 段，都没选用。
  await expect(lane(dialog).getByRole('button', { name: '镜头 2–3 · 生成中' })).toBeVisible()
  const partName = (seg: number) => `镜头 2–3 的编辑片段 · 第 ${seg} 段 · 1.0 秒`
  await expect(
    lane(dialog).getByRole('button', { name: /^镜头 2–3 的编辑片段 · 第 \d 段 · 1\.0 秒$/ }),
  ).toHaveCount(3, { timeout: STEP_TIMEOUT })
  await expect(partEye(dialog, partName(1))).toHaveAccessibleName('选用这一段')
  await expect(controls(dialog)).toContainText('共 6.0 秒')

  // 点一段就选用：它进草稿并被选中，覆盖的镜头默认关，小卡写这一段。
  const part = lane(dialog).getByRole('button', { name: partName(1), exact: true })
  await part.click()
  const inDraft = draft(dialog).getByRole('button', { name: `${partName(1)} · 已选用` })
  await expect(inDraft).toHaveAttribute('aria-pressed', 'true')
  await expect(shotEye(dialog, 2)).toHaveAccessibleName('开启镜头 2')
  await expect(shotEye(dialog, 3)).toHaveAttribute('aria-pressed', 'false')
  await expect(
    smallCard(dialog, '镜头 2–3 的编辑片段').getByText('第 1 段 · 1.0 秒 · 已选用', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(controls(dialog)).toContainText('共 5.0 秒 · 比原片短 1.0 秒')
  await expect(composeButton(dialog)).toBeEnabled()

  // 再点取消：镜头回来，草稿又是整条原片。
  await part.click()
  await expect(inDraft).toHaveCount(0)
  await expect(smallCard(dialog, '镜头 2–3 的编辑片段')).toHaveCount(0)
  await expect(shotEye(dialog, 2)).toHaveAccessibleName('关闭镜头 2')
  await expect(controls(dialog)).toContainText('共 6.0 秒')
  await expect(composeButton(dialog)).toBeDisabled()

  // 用眼睛把三段都选用：它们按段排在镜头 1 后面，比原片长 1 秒。
  for (const seg of [1, 2, 3]) await partEye(dialog, partName(seg)).click()
  await expect
    .poll(() =>
      draft(dialog)
        .getByRole('button')
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
    )
    .toEqual([
      '镜头 1 · 1.0 秒 · 原片',
      ...[1, 2, 3].map((seg) => `${partName(seg)} · 已选用`),
      ...[4, 5, 6].map((no) => `镜头 ${no} · 1.0 秒 · 原片`),
    ])
  await expect(controls(dialog)).toContainText('共 7.0 秒 · 比原片长 1.0 秒')

  // 合成：草稿按顺序拼，相接的并成一段，编辑段写明用到的起止。
  const request = page.waitForRequest(
    (sent) => sent.url().endsWith('/api/generations/video-composites') && sent.method() === 'POST',
  )
  await composeButton(dialog).click()
  expect((await request).postDataJSON()).toEqual({
    conversationId: expect.any(String),
    taskId: null,
    baseJobId,
    segments: [
      { sourceJobId: baseJobId, start: 0, end: 1 },
      { sourceJobId: editId, start: 0, end: 3 },
      { sourceJobId: baseJobId, start: 3, end: 6 },
    ],
  })

  // 合成完成：自动切到版本视图看新的一版，它在最上面一行；只能下载、不能合成。
  await expect(view(dialog, '版本')).toHaveAttribute('aria-pressed', 'true', {
    timeout: STEP_TIMEOUT,
  })
  const viewed = versions(dialog).getByRole('button', { pressed: true })
  await expect(viewed).toHaveAccessibleName(/^V\d+$/)
  await expect(versions(dialog).getByRole('button').first()).toHaveAttribute('aria-pressed', 'true')
  await expect(controls(dialog).getByRole('button', { name: '下载', exact: true })).toBeEnabled()
  await expect(composeButton(dialog)).toHaveCount(0)
  // 回到剪辑，内容就是刚合成的这版，不能再合成一样的。
  await view(dialog, '剪辑').click()
  await expect(composeButton(dialog)).toBeDisabled()
})

test('拖放：编辑段拖到草稿上出落点占位、松手选用；草稿里的块拖出草稿松手拿掉', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1335, height: 880 })
  const dialog = await openEditor(page)
  await waitForShots(dialog)
  await shot(dialog, 2).click()
  await shot(dialog, 3).click({ modifiers: ['Shift'] })
  await requestBox(dialog).fill('换成黄昏的暖光')
  await expect(generateButton(dialog)).toBeEnabled()
  await submitEdit(page, dialog)
  const partName = '镜头 2–3 的编辑片段 · 第 1 段 · 1.0 秒'
  const part = lane(dialog).getByRole('button', { name: partName, exact: true })
  await expect(part).toBeVisible({ timeout: STEP_TIMEOUT })
  // 按 Escape 收起生成卡，免得挡住时间线
  await page.keyboard.press('Escape')

  // 按住编辑段拖到草稿轨上：落点占位写出按排序放进去的位置（镜头 2 后面），松手前草稿不变
  const from = await centerOf(part)
  const target = await centerOf(draft(dialog).getByRole('button', { name: /^镜头 5 ·/ }))
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(target.x, target.y, { steps: 8 })
  await expect(dialog.getByRole('status').filter({ hasText: '插入 2.0 秒 · 1.0 秒' })).toBeVisible()
  await expect(draft(dialog).getByRole('button')).toHaveCount(6)
  await page.mouse.up()
  const inDraft = draft(dialog).getByRole('button', { name: `${partName} · 已选用` })
  await expect(inDraft).toBeVisible()
  // 等于点它的眼睛：覆盖的镜头默认关，不改选中
  await expect(shotEye(dialog, 2)).toHaveAccessibleName('开启镜头 2')
  await expect(partEye(dialog, partName)).toHaveAccessibleName('取消选用这一段')
  await expect(inDraft).toHaveAttribute('aria-pressed', 'false')
  await expect(controls(dialog)).toContainText('共 5.0 秒')

  // 把草稿里的这一块拖出草稿轨（拖到原片轨上）松手：拿掉它，镜头回来
  const start = await centerOf(inDraft)
  const away = await centerOf(shot(dialog, 1))
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(away.x, away.y, { steps: 8 })
  await page.mouse.up()
  await expect(inDraft).toHaveCount(0)
  await expect(shotEye(dialog, 2)).toHaveAccessibleName('关闭镜头 2')
  await expect(partEye(dialog, partName)).toHaveAccessibleName('选用这一段')
  await expect(controls(dialog)).toContainText('共 6.0 秒')
})

test('图生和编辑按模型分别校验时长，图生 1 张图作首帧时补上描述生成', async ({ page }) => {
  const dialog = await openEditor(page, false, 2, false)
  await waitForShots(dialog)
  await shot(dialog, 2).click()
  await requestBox(dialog).fill('人物缓慢转身')
  await expect(card(dialog).getByText(/编辑至少需要 4 秒/)).toBeVisible()
  await expect(generateButton(dialog)).toBeDisabled()
  for (const no of [3, 4, 5]) await shot(dialog, no).click({ modifiers: ['Shift'] })
  await expect(generateButton(dialog)).toBeEnabled()

  await shot(dialog, 2).click()
  await card(dialog).getByRole('radio', { name: '图生', exact: true }).click()
  await expect(requestBox(dialog)).toHaveText('人物缓慢转身')
  await expect(generateButton(dialog)).toBeDisabled()
  await requestBox(dialog).press('ControlOrMeta+A')
  await requestBox(dialog).press('Backspace')
  await expect(requestBox(dialog)).toHaveText('')
  const fileChooser = page.waitForEvent('filechooser')
  await card(dialog).getByRole('button', { name: '添加附件', exact: true }).click()
  await (
    await fileChooser
  ).setFiles({
    name: '人物造型.png',
    mimeType: 'image/png',
    buffer: await canvasPng(page, { fill: '#556b88', label: 'Reference' }),
  })
  await expect(requestBox(dialog).getByText('人物造型.png')).toBeVisible()
  // 首帧不写进正文，只有它时没有描述可交。
  await expect(generateButton(dialog)).toBeDisabled()
  await requestBox(dialog).press('End')
  await page.keyboard.type('人物转身')
  await expect(generateButton(dialog)).toBeEnabled()

  const duration = card(dialog).getByRole('slider', { name: '生成时长（秒）', exact: true })
  await duration.press('End')
  await card(dialog).getByRole('button', { name: '图生模型', exact: true }).click()
  await page.getByRole('menuitemradio', { name: 'vendor-a-seedance-2-0', exact: true }).click()
  await expect(card(dialog).getByLabel('当前生成时长', { exact: true })).toHaveText(/^30\s*秒$/)
  await expect(card(dialog).getByText(/图生时长须为 4–15 秒/)).toBeVisible()
  await expect(generateButton(dialog)).toBeDisabled()
  await duration.press('Home')
  const thumb = await centerOf(duration)
  await page.mouse.move(thumb.x, thumb.y)
  await page.mouse.down()
  await page.mouse.move(thumb.x + 50, thumb.y, { steps: 6 })
  await page.mouse.up()
  expect(Number(await duration.getAttribute('aria-valuenow'))).toBeGreaterThan(4)
  await duration.press('End')
  await expect(generateButton(dialog)).toBeEnabled()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(card(dialog).getByRole('radio', { name: '图生', exact: true })).toBeVisible()
  await expect(generateButton(dialog)).toBeVisible()

  const expectToolbarInsideCard = async (width: number, state: string) => {
    await expect
      .configure({ soft: true })
      .poll(
        async () => {
          const bounds = await card(dialog).boundingBox()
          if (bounds === null) throw new Error('编辑卡尚未显示')
          const interactive = card(dialog)
            .getByRole('button')
            .or(card(dialog).getByRole('slider'))
            .or(card(dialog).getByRole('radio'))
            .or(card(dialog).getByRole('status'))
          return interactive.evaluateAll(
            (elements, bounds) =>
              elements
                .map((control) => {
                  const box = control.getBoundingClientRect()
                  return {
                    name: control.getAttribute('aria-label') ?? control.textContent,
                    left: Math.max(0, bounds.x - box.left),
                    right: Math.max(0, box.right - bounds.x - bounds.width),
                    top: Math.max(0, bounds.y - box.top),
                    bottom: Math.max(0, box.bottom - bounds.y - bounds.height),
                  }
                })
                .filter(({ left, right, top, bottom }) => left + right + top + bottom > 0),
            bounds,
          )
        },
        { message: `${width}px ${state}时所有工具栏控件应在卡片内`, timeout: 1500 },
      )
      .toEqual([])
  }
  for (const width of [600, 640]) {
    await page.setViewportSize({ width, height: 844 })
    await expectToolbarInsideCard(width, '可提交')
  }

  await pauseMockResponses(page, '/api/generations/video-edits')
  const submitted = page.waitForRequest(
    (request) =>
      request.url().endsWith('/api/generations/video-edits') && request.method() === 'POST',
  )
  await generateButton(dialog).click()
  await expect(card(dialog).getByRole('button', { name: '正在提交', exact: true })).toBeDisabled()
  for (const width of [390, 600, 640, 1280]) {
    await page.setViewportSize({ width, height: 844 })
    await expectToolbarInsideCard(width, '提交中')
  }
  await releaseMockResponses(page, '/api/generations/video-edits')
  const sent = await submitted
  await sent.response()
  const body = sent.postDataJSON() as Record<string, unknown>
  expect(body).toMatchObject({
    model: 'vendor-a-seedance-2-0',
    prompt: '人物转身',
    range_start_ms: 1000,
    range_end_ms: 2000,
    seconds: 15,
    reference_video_urls: [],
  })
  expect(body['reference_image_urls']).toEqual([expect.stringMatching(/\/mock-oss\//)])
  await expect(requestBox(dialog).getByText('人物造型.png')).toBeVisible()
  await expect(card(dialog).getByRole('alert')).toHaveCount(0)
  await page.setViewportSize({ width: 1280, height: 844 })
  await expect(
    lane(dialog).getByRole('button', { name: /^镜头 2 的编辑片段 · 第 \d 段 · 1\.0 秒$/ }),
  ).toHaveCount(3, { timeout: STEP_TIMEOUT })
})

test('提交未受理时保护关闭与站内离开，受理后编辑轨显示生成中并允许退出', async ({ page }) => {
  const dialog = await openEditor(page)
  await waitForShots(dialog)
  await shot(dialog, 2).click()
  await requestBox(dialog).fill('换成暖色光线')
  const release = await holdReferenceUpload(page)
  await generateButton(dialog).click()
  await expect(card(dialog).getByRole('button', { name: '正在提交', exact: true })).toBeDisabled()
  await expect(view(dialog, '版本')).toBeDisabled()
  const editingUrl = page.url()
  await page.evaluate(() => window.history.back())
  await expect(page.getByText('正在提交，请等待提交完成后再离开', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(editingUrl)
  await dialog.getByRole('button', { name: '关闭视频编辑', exact: true }).click()
  await expect(dialog).toBeVisible()

  await release()
  await expect(lane(dialog).getByRole('button', { name: '镜头 2 · 生成中' })).toBeVisible({
    timeout: STEP_TIMEOUT,
  })
  await dialog.getByRole('button', { name: '关闭视频编辑', exact: true }).click()
  await expect(dialog).toBeHidden()
})

test('提交尚未受理时刷新会出现浏览器原生离开提示', async ({ page }) => {
  const dialog = await openEditor(page)
  await waitForShots(dialog)
  await shot(dialog, 2).click()
  await requestBox(dialog).fill('等待上传期间刷新')
  await holdReferenceUpload(page)
  await generateButton(dialog).click()
  await expect(card(dialog).getByRole('button', { name: '正在提交', exact: true })).toBeVisible()
  const leave = page.waitForEvent('dialog')
  const reload = page.reload()
  const warning = await leave
  expect(warning.type()).toBe('beforeunload')
  // MSW 在 beforeunload 时停用 mock；在独立页面接受离开，不让此行为影响提交状态用例。
  await warning.accept()
  await reload
})

test('选中：普通点击只选当前镜头，Shift 点击扩选；键盘左右与 Shift 扩展，卡跟着选区走', async ({
  page,
}) => {
  const dialog = await openEditor(page)
  await waitForShots(dialog)

  await shot(dialog, 2).click()
  await expect(shot(dialog, 2)).toHaveAttribute('aria-pressed', 'true')
  await expectCard(dialog, '镜头 2 · 视频生成', '原片 1.0 – 2.0 秒 · 视频和原声一起重做')
  await shot(dialog, 3).click({ modifiers: ['Shift'] })
  await expectCard(dialog, '镜头 2–3 · 视频生成', '原片 1.0 – 3.0 秒 · 视频和原声一起重做')
  await shot(dialog, 1).click({ modifiers: ['Shift'] })
  await expectCard(dialog, '镜头 1–3 · 视频生成', '原片 0.0 – 3.0 秒 · 视频和原声一起重做')
  // Shift 点两端的镜头把它去掉。
  await shot(dialog, 1).click({ modifiers: ['Shift'] })
  await expect(shot(dialog, 1)).toHaveAttribute('aria-pressed', 'false')
  // 普通点击从这个镜头重新选。
  await shot(dialog, 5).click()
  await expectCard(dialog, '镜头 5 · 视频生成', '原片 4.0 – 5.0 秒 · 视频和原声一起重做')
  await expect(shot(dialog, 2)).toHaveAttribute('aria-pressed', 'false')

  // 卡不抢焦点：键盘左右挪到相邻的镜头，Shift 扩展。
  await shot(dialog, 5).press('ArrowLeft')
  await expect(shot(dialog, 4)).toBeFocused()
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await expectCard(dialog, '镜头 4–6 · 视频生成', '原片 3.0 – 6.0 秒 · 视频和原声一起重做')

  // 卡的尖角指着选区：卡盖在舞台上，水平中线对准选区的中线（夹在舞台内）。
  const box = await card(dialog).boundingBox()
  const first = await shot(dialog, 4).boundingBox()
  const last = await shot(dialog, 6).boundingBox()
  const stage = await dialog.getByRole('region', { name: '预览舞台' }).boundingBox()
  if (box === null || first === null || last === null || stage === null)
    throw new Error('卡或选区尚未布局')
  const anchor = (first.x + last.x + last.width) / 2
  const expected = Math.min(
    stage.x + stage.width - 12 - box.width,
    Math.max(stage.x + 12, anchor - box.width / 2),
  )
  expect(Math.abs(box.x - expected)).toBeLessThan(4)
  expect(box.y + box.height).toBeLessThanOrEqual(stage.y + stage.height)
})

test('原片选区：拖结尾把手停在镜头中间，卡与舞台标签跟着变；提交的区间就是选区', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1335, height: 880 })
  const dialog = await openEditor(page)
  await waitForShots(dialog)
  await shot(dialog, 2).click()
  await expectCard(dialog, '镜头 2 · 视频生成', '原片 1.0 – 2.0 秒 · 视频和原声一起重做')
  await requestBox(dialog).fill('换成黄昏的暖光')
  const label = dialog.getByText(/^原片 · 镜头/)
  await expect(label).toContainText('1.0 秒 · 选区 1.0–2.0')

  // 拖到 3.5 秒：离镜头分界都远，不吸附；覆盖到镜头 2–4，舞台停在结尾那一帧
  const end = timelineOf(dialog).getByRole('slider', { name: '裁剪结尾', exact: true })
  const release = await holdDrag(page, dialog, end, 3.5)
  await expectCard(dialog, '镜头 2–4 · 视频生成', '原片 1.0 – 3.5 秒 · 视频和原声一起重做')
  await expect(label).toContainText('选区 1.0–3.5')
  await expect(label).toHaveText(/^原片 · 镜头 2–4/)
  await release()
  await expect(requestBox(dialog)).toHaveText('换成黄昏的暖光')
  await expect(shot(dialog, 4)).toHaveAttribute('aria-pressed', 'true')
  await expect(shot(dialog, 5)).toHaveAttribute('aria-pressed', 'false')

  const selectedEnd = Number(await end.getAttribute('aria-valuenow'))
  expect(selectedEnd).toBeCloseTo(3.5, 1)
  const { body } = await submitEdit(page, dialog)
  expect(body['range_start_ms']).toBe(1000)
  // 把手的读数取到 0.01 秒
  expect(Math.abs(Number(body['range_end_ms']) - selectedEnd * 1000)).toBeLessThanOrEqual(5)
  // 编辑轨上按这个区间摆，名字按碰到的镜头叫
  await expect(lane(dialog).getByRole('button', { name: '镜头 2–4 · 生成中' })).toBeVisible()
})

test('草稿比原片长、时间线能横向滚动时，拖草稿块的结尾把手到右边缘：自动滚动，把手跟着指针，松手提交指针处的长度', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const dialog = await openEditor(page)
  await waitForShots(dialog)
  // 镜头 1（1 秒）编辑成 3 秒的样片、三段都选用：草稿 8 秒，时间线每秒像素按 6 秒的原片定，能往右滚 2 秒
  await requestBox(dialog).fill('换成黄昏的暖光')
  await expect(generateButton(dialog)).toBeEnabled()
  await submitEdit(page, dialog)
  const partName = (seg: number) => `镜头 1 的编辑片段 · 第 ${seg} 段 · 1.0 秒`
  await expect(partEye(dialog, partName(3))).toBeVisible({ timeout: STEP_TIMEOUT })
  for (const seg of [1, 2, 3]) await partEye(dialog, partName(seg)).click()
  await expect(controls(dialog)).toContainText('共 8.0 秒 · 比原片长 2.0 秒')

  // 草稿里镜头 4 在 5–6 秒，结尾正贴着可视范围右边；先用方向键剪掉 0.5 秒，给把手留出往外拉的余地
  await draft(dialog)
    .getByRole('button', { name: /^镜头 4 ·/ })
    .click()
  const end = timelineOf(dialog).getByRole('slider', { name: '裁剪结尾', exact: true })
  await end.focus()
  for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowLeft')
  await expect(
    draft(dialog).getByRole('button', { name: /^镜头 4 · 0\.5 秒（这个镜头 1\.0 秒）/ }),
  ).toBeVisible()
  const viewport = timelineOf(dialog).getByRole('region', { name: '时间线轨道，可横向滚动' })
  await viewport.evaluate((element) => {
    element.scrollLeft = 0
  })
  const box = await viewport.boundingBox()
  const handle = await end.boundingBox()
  if (box === null || handle === null) throw new Error('时间线尚未布局')
  const handleX = handle.x + handle.width / 2
  const handleY = handle.y + handle.height / 2
  expect(handleX).toBeLessThan(box.x + box.width - 80)

  await page.mouse.move(handleX, handleY)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 10, handleY, { steps: 8 })
  const scrollLeft = () => viewport.evaluate((element) => element.scrollLeft)
  await expect.poll(scrollLeft).toBeGreaterThan(40)
  // 指针停在边上：滚到内容最右端停住
  let last = -1
  await expect
    .poll(
      async () => {
        const now = await scrollLeft()
        const settled = now === last
        last = now
        return settled
      },
      { intervals: [250] },
    )
    .toBe(true)
  // 回到草稿 5.8 秒处（已离开靠边那一截）：不再滚，把手停在指针下（位移算上了滚过的距离）
  const resting = await xAt(dialog, 5.8)
  expect(resting).toBeLessThan(box.x + box.width - 80)
  await page.mouse.move(resting, handleY, { steps: 2 })
  await expect
    .poll(async () => {
      const moved = await end.boundingBox()
      return moved === null ? Infinity : Math.abs(moved.x + moved.width / 2 - resting)
    })
    .toBeLessThanOrEqual(3)
  expect(await scrollLeft()).toBe(last)
  await page.mouse.up()
  // 松手提交指针处：镜头 4 用 5–5.8 秒这 0.8 秒
  await expect(
    draft(dialog).getByRole('button', { name: /^镜头 4 · 0\.8 秒（这个镜头 1\.0 秒）/ }),
  ).toBeVisible()
  await expect(controls(dialog)).toContainText('共 7.8 秒')
})

test('点镜头只选中不播放、播放头在选区开头；空格从播放头播、再按暂停，焦点在镜头上也不改选中', async ({
  page,
}) => {
  const dialog = await openEditor(page)
  await waitForShots(dialog)
  const seek = dialog.getByRole('slider', { name: '时间线播放位置' })
  const play = dialog.getByRole('button', { name: '播放', exact: true })
  const pause = dialog.getByRole('button', { name: '暂停', exact: true })
  const playheadAt = async () => Number(await seek.inputValue())

  await shot(dialog, 2).click({ position: { x: 30, y: 10 } })
  await expect(shot(dialog, 2)).toHaveAttribute('aria-pressed', 'true')
  await expect(play).toBeVisible()
  await expect(seek).toHaveValue('1')
  await shot(dialog, 3).click({ modifiers: ['Shift'] })
  await expect(seek).toHaveValue('1')

  // 焦点停在刚点的镜头上：空格播放、暂停，不会再点一次它。
  await expect(shot(dialog, 3)).toBeFocused()
  await page.keyboard.press(' ')
  await expect(pause).toBeVisible()
  await expect.poll(playheadAt).toBeGreaterThan(3.2)
  await page.keyboard.press(' ')
  await expect(play).toBeVisible()
  await expect(shot(dialog, 2)).toHaveAttribute('aria-pressed', 'true')
  await expect(shot(dialog, 3)).toHaveAttribute('aria-pressed', 'true')
  await expect(shot(dialog, 4)).toHaveAttribute('aria-pressed', 'false')

  // 播放中普通点击另一个镜头：停在它开头，只选中它。
  await page.keyboard.press(' ')
  await expect(pause).toBeVisible()
  await shot(dialog, 4).click()
  await expect(play).toBeVisible()
  await expect(seek).toHaveValue('3')
  await expectCard(dialog, '镜头 4 · 视频生成', '原片 3.0 – 4.0 秒 · 视频和原声一起重做')

  // 在修改要求里打空格只是打字。
  await requestBox(dialog).click()
  await page.keyboard.type('黄昏 暖光')
  await expect(requestBox(dialog)).toHaveText('黄昏 暖光')
  await expect(play).toBeVisible()
})

test('标尺下边缘可拖动播放头，不改选中', async ({ page }) => {
  const dialog = await openEditor(page)
  await waitForShots(dialog)
  await shot(dialog, 2).click()
  const ruler = dialog.getByRole('slider', { name: '时间线播放位置' })
  await ruler.press('Home')
  const box = await ruler.boundingBox()
  if (box === null) throw new Error('标尺尚未布局')
  await page.mouse.move(await xAt(dialog, 2), box.y + box.height - 1)
  const timePreview = page.getByText('00:02.00', { exact: true })
  await expect(timePreview).toContainText('00:02.00')
  const hoverGuide = dialog.getByTestId('timeline-hover-guide')
  await expect(hoverGuide).toBeVisible()
  const guideBox = await hoverGuide.boundingBox()
  const clipBox = await shot(dialog, 2).boundingBox()
  if (guideBox === null || clipBox === null) throw new Error('悬停引导线尚未布局')
  expect(Math.abs(guideBox.x + guideBox.width / 2 - (await xAt(dialog, 2)))).toBeLessThan(1)
  expect(guideBox.y).toBeLessThan(clipBox.y)
  expect(guideBox.y + guideBox.height).toBeGreaterThanOrEqual(clipBox.y + clipBox.height)
  // 编辑器背后的会话仍可能自动滚动，不应清掉时间线上的预览。
  await page.getByTestId('chat-scroller').evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        element.addEventListener('scroll', () => requestAnimationFrame(() => resolve()), {
          once: true,
        })
        element.scrollTop = element.scrollTop === 0 ? element.scrollHeight : 0
      }),
  )
  await expect(timePreview).toBeVisible()
  await expect(hoverGuide).toBeVisible()
  const previewBox = await timePreview.boundingBox()
  if (previewBox === null) throw new Error('时间预览尚未布局')
  expect(previewBox.y + previewBox.height).toBeLessThan(box.y)
  await page.mouse.down()
  await expect(hoverGuide).toHaveCount(0)
  await page.mouse.move(await xAt(dialog, 4.5), box.y + box.height - 1, { steps: 8 })
  await page.mouse.up()
  await expect(hoverGuide).toHaveCount(0)
  expect(Number(await ruler.inputValue())).toBeCloseTo(4.5, 1)
  await expect(shot(dialog, 2)).toHaveAttribute('aria-pressed', 'true')
  await expect(controls(dialog)).toContainText('共 6.0 秒')
  await ruler.press('ArrowLeft')
  expect(Number(await ruler.inputValue())).toBeCloseTo(4.49, 1)
})

test('改和看不冲突：拖播放头、按播放卡收成胶囊，点胶囊展开字还在；Escape 先收卡再关编辑器', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1335, height: 880 })
  const dialog = await openEditor(page)
  await waitForShots(dialog)
  await shot(dialog, 2).click()
  await shot(dialog, 3).click({ modifiers: ['Shift'] })
  await requestBox(dialog).fill('换成黄昏的暖光')
  // 按住播放头拖：卡收成画面底部的小胶囊，标着未提交。
  const release = await holdDrag(
    page,
    dialog,
    dialog.getByRole('slider', { name: '时间线播放位置' }),
    4.6,
  )
  await expect(card(dialog)).toHaveCount(0)
  await expect(capsule(dialog)).toHaveAccessibleName('展开镜头 2–3 · 视频生成，未提交')
  await expect(capsule(dialog)).toContainText('· 未提交')
  await expect(dialog.getByRole('slider', { name: '时间线播放位置' })).toBeFocused()
  await release()

  // 停下后点胶囊展开：字还在，光标在输入框里。
  await capsule(dialog).click()
  await expect(requestBox(dialog)).toHaveText('换成黄昏的暖光')
  await expect(requestBox(dialog)).toBeFocused()

  // 按播放也收起；暂停后点选区里的镜头展开。
  await dialog.getByRole('button', { name: '播放', exact: true }).click()
  await expect(card(dialog)).toHaveCount(0)
  await expect(capsule(dialog)).toBeVisible()
  await dialog.getByRole('button', { name: '暂停', exact: true }).click()
  await shot(dialog, 3).click()
  await expectCard(dialog, '镜头 3 · 视频生成', '原片 2.0 – 3.0 秒 · 视频和原声一起重做')
  await expect(requestBox(dialog)).toHaveText('换成黄昏的暖光')

  // Escape：第一下收卡，编辑器还在；第二下关编辑器。
  await page.keyboard.press('Escape')
  await expect(card(dialog)).toHaveCount(0)
  await expect(capsule(dialog)).toBeVisible()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('移动编辑：输入卡与胶囊可操作，放大预览不撑出页面', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const dialog = await openEditor(page, true)
  await waitForShots(dialog)
  await shot(dialog, 2).click()
  await requestBox(dialog).fill('换成黄昏的暖光，动作和机位不变')
  const stage = await dialog.getByRole('region', { name: '预览舞台' }).boundingBox()
  const box = await card(dialog).boundingBox()
  if (stage === null || box === null) throw new Error('舞台或卡尚未布局')
  expect(box.x).toBeGreaterThanOrEqual(stage.x)
  expect(box.x + box.width).toBeLessThanOrEqual(stage.x + stage.width)
  expect(box.y + box.height).toBeLessThanOrEqual(stage.y + stage.height)
  await dialog.getByRole('region', { name: '预览舞台' }).scrollIntoViewIfNeeded()
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

  // 拖播放头：卡收成胶囊，仍在舞台里。
  await dialog.getByRole('slider', { name: '时间线播放位置' }).fill('3.5')
  await expect(capsule(dialog)).toBeVisible()
  const pill = await capsule(dialog).boundingBox()
  const stageNow = await dialog.getByRole('region', { name: '预览舞台' }).boundingBox()
  if (pill === null || stageNow === null) throw new Error('胶囊尚未布局')
  expect(pill.x).toBeGreaterThanOrEqual(stageNow.x)
  expect(pill.x + pill.width).toBeLessThanOrEqual(stageNow.x + stageNow.width)
  await dialog.getByRole('region', { name: '预览舞台' }).scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

  // 手机上仍能放大查看，比例不变，页面不横向溢出。
  await dialog.getByRole('button', { name: '放大', exact: true }).click()
  const overlay = page.getByRole('dialog', { name: '放大预览' })
  await expect(overlay).toBeVisible()
  await overlay.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  )
  const enlarged = await overlay.getByLabel('视频预览', { exact: true }).boundingBox()
  if (enlarged === null) throw new Error('放大层尚未布局')
  await expect(overlay.getByLabel('视频预览', { exact: true })).toBeInViewport({ ratio: 1 })
  expect(enlarged.width / enlarged.height).toBeCloseTo(9 / 16, 2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

test('横版素材：舞台按画面比例摆，不留黑边；原声行写「无声」，放大后控件贴住画面底边', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1303, height: 1006 })
  const dialog = await openEditor(page, false, 3, false)
  await expect(shots(dialog).first()).toBeVisible({ timeout: STEP_TIMEOUT })
  await expect(timelineOf(dialog).getByText('无声').first()).toBeVisible({ timeout: STEP_TIMEOUT })

  // 读到元数据后画面框换成 16:9，播放器铺满画面框，contain 不再留出上下黑边。
  const preview = dialog.getByLabel('视频预览', { exact: true })
  await expect
    .poll(async () => {
      const box = await preview.boundingBox()
      return box === null ? 0 : box.width / box.height
    })
    .toBeCloseTo(16 / 9, 2)
  // 播放控件只在时间线面板顶上那一行，舞台里没有。
  await expect(preview.getByRole('group', { name: '播放控件' })).toHaveCount(0)
  await expect(dialog.getByRole('group', { name: '播放控件' })).toHaveCount(1)

  await dialog.getByRole('button', { name: '放大', exact: true }).click()
  const overlay = page.getByRole('dialog', { name: '放大预览' })
  await overlay.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  )
  const stage = await overlay.getByLabel('视频预览', { exact: true }).boundingBox()
  const enlargedPill = await overlay.getByRole('group', { name: '播放控件' }).boundingBox()
  if (stage === null || enlargedPill === null) throw new Error('放大层尚未布局')
  expect(stage.width / stage.height).toBeCloseTo(16 / 9, 2)
  expect(enlargedPill.y + enlargedPill.height).toBeLessThanOrEqual(stage.y + stage.height)
  await expect(overlay.getByRole('group', { name: '播放控件' })).toBeInViewport({ ratio: 1 })
})

test('放大预览：舞台搬进应用内遮罩，播放不断、不进浏览器全屏，Escape 只关遮罩', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1303, height: 1006 })
  const dialog = await openEditor(page, false, 2, false)
  await waitForShots(dialog)

  await dialog.getByRole('button', { name: '播放', exact: true }).click()
  const playing = () =>
    dialog
      .getByLabel('视频播放器', { exact: true })
      .evaluate((element) => !(element as HTMLVideoElement).paused)
  await expect.poll(playing).toBe(true)
  await dialog.getByRole('button', { name: '放大', exact: true }).click()
  const overlay = page.getByRole('dialog', { name: '放大预览' })
  await expect(overlay).toBeVisible()
  await expect(overlay.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull()

  await page.keyboard.press('Escape')
  await expect(overlay).toBeHidden()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: '放大', exact: true })).toBeFocused()
  await expect.poll(playing).toBe(true)
})

test('只有成功的出片才能进编辑；关掉编辑器回到素材片区，地址里不再带 video', async ({ page }) => {
  const dialog = await openEditor(page, false, 2, false)
  await dialog.getByRole('button', { name: '关闭视频编辑', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page).not.toHaveURL(/[?&]video=/)
  const takes = page.getByRole('region', { name: '本组素材片', exact: true })
  await expect(takes).toBeVisible()
  // 第 2 组只有一条完成的出片：选中失败的那条，编辑置灰；选中在途的那条，没有编辑入口。
  await expect(takes.getByRole('listitem')).toHaveCount(3)
  const edit = page.getByRole('button', { name: '编辑视频', exact: true })
  await takes.getByRole('button', { name: /生成失败$/ }).click()
  await expect(edit).toHaveAttribute('aria-disabled', 'true')
  await takes.getByRole('button', { name: /生成中$/ }).click()
  await expect(edit).toHaveCount(0)
})

test('镜头提示词：在工具条里往上弹，生成卡让到它左边；可连续追加到修改要求，浮窗保持打开且不改变预览尺寸', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1536, height: 1024 })
  const dialog = await openEditor(page)
  await waitForShots(dialog)
  await shot(dialog, 2).click()
  const preview = dialog.getByRole('region', { name: '预览舞台' })
  const before = await preview.boundingBox()
  const trigger = controls(dialog).getByRole('button', { name: '镜头提示词', exact: true })
  await trigger.click()
  const prompts = page.getByRole('dialog', { name: '镜头提示词', exact: true })
  await expect(prompts).toBeVisible()
  await prompts.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  )
  const panelBox = await prompts.boundingBox()
  const triggerBox = await trigger.boundingBox()
  const dialogBox = await dialog.boundingBox()
  if (panelBox === null || triggerBox === null || dialogBox === null)
    throw new Error('镜头提示词浮窗尚未布局')
  // 从按钮往上弹、右端对齐按钮，顶上不超出编辑器。
  expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(triggerBox.y)
  expect(Math.abs(panelBox.x + panelBox.width - (triggerBox.x + triggerBox.width))).toBeLessThan(1)
  expect(panelBox.y).toBeGreaterThanOrEqual(dialogBox.y)
  // 生成卡停在浮窗左边，「生成视频」不被挡住。
  await expect
    .poll(async () => {
      const generate = await generateButton(dialog).boundingBox()
      return generate === null ? Infinity : generate.x + generate.width
    })
    .toBeLessThanOrEqual(panelBox.x)
  await expect(requestBox(dialog)).toHaveText('')
  const text = await prompts.getByRole('listitem').first().getByRole('paragraph').innerText()
  await requestBox(dialog).fill('保留手动要求')
  const append = prompts.getByRole('button', { name: '复制镜头 1 到输入框' })
  await append.click()
  await append.click()
  await expect(requestBox(dialog)).toHaveText(`保留手动要求\n${text}\n${text}`)
  await expect(prompts).toBeVisible()
  expect(await preview.boundingBox()).toEqual(before)
  await prompts.getByRole('button', { name: '关闭镜头提示词' }).click()
  await expect(prompts).toBeHidden()
  await expect(card(dialog)).toBeVisible()
})

test('镜头提示词：窄屏浮窗可以滚动且不溢出视口', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const dialog = await openEditor(page, true, 2, false)
  await waitForShots(dialog)
  await dialog.getByRole('button', { name: '镜头提示词', exact: true }).click()
  const prompts = page.getByRole('dialog', { name: '镜头提示词', exact: true })
  await expect(prompts).toBeVisible()
  const box = await prompts.boundingBox()
  if (box === null) throw new Error('镜头提示词浮窗尚未布局')
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  expect(box.y + box.height).toBeLessThanOrEqual(844)
})
