/// <reference lib="dom" />

import { expect, test, type Locator, type Page } from '@playwright/test'
import { canvasPng, openConversation, openStoryboardShot, screenshotBothThemes } from './helpers'

/** mock 受理后 3 秒出结果；编辑段与合成各等一轮。 */
const STEP_TIMEOUT = 15_000
const SHOT_DIR = '../.artifacts/design-qa/video-editor-version-state'

/** 第 2 组那条成片是竖版、6 秒、每秒一个关键帧、带一条原声；第 3 组是横版、无声。 */
const openEditor = async (page: Page, mobile = false, group = 2, useWan = true) => {
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
  if (useWan) {
    // 既有一秒剪辑旅程显式选 Wan，保留服务端默认 Seedance 2.5 的真实限制。
    await expect(segments(dialog).first()).toBeVisible({ timeout: STEP_TIMEOUT })
    await segment(dialog, 1).click()
    await card(dialog).getByRole('button', { name: '编辑模型', exact: true }).click()
    await page.getByRole('menuitemradio', { name: 'wan3.0-video', exact: true }).click()
    await scope(dialog, '整片').click()
  }
  return dialog
}

const timelineOf = (dialog: Locator) =>
  dialog.getByRole('region', { name: '视频编辑时间线', exact: true })
/** 时间线上可编辑的片段；生成中的结果只在侧栏显示。 */
const segments = (dialog: Locator) => timelineOf(dialog).getByRole('button', { name: /^第 \d+ 段/ })
const segment = (dialog: Locator, position: number) =>
  timelineOf(dialog).getByRole('button', { name: new RegExp(`^第 ${position} 段`) })
const controls = (dialog: Locator) => dialog.getByRole('group', { name: '播放控件' })
const versions = (dialog: Locator) => dialog.getByRole('group', { name: '视频版本' })
const scope = (dialog: Locator, name: '整片' | '片段') =>
  dialog.getByRole('group', { name: '视频预览范围' }).getByRole('button', { name, exact: true })
/** 选中段时盖在舞台上的弹出卡。 */
const card = (dialog: Locator) => dialog.getByRole('region', { name: 'AI 改段' })
/** 卡收起后的小胶囊。 */
const capsule = (dialog: Locator) => dialog.getByRole('button', { name: /^展开第 \d/ })
const requestBox = (dialog: Locator) =>
  card(dialog).getByRole('textbox', { name: '修改要求', exact: true })
const generateButton = (dialog: Locator) =>
  card(dialog).getByRole('button', { name: '生成视频', exact: true })

/** 等分段读好：第 2 组 6 段，原声读到波形。 */
const waitForSegments = async (dialog: Locator, count = 6) => {
  await expect(segments(dialog)).toHaveCount(count, { timeout: STEP_TIMEOUT })
}

/** 时间线上某个时刻的横坐标：刻度上的播放位置滑块铺满整条轨道。 */
const xAt = async (dialog: Locator, clock: number) => {
  const ruler = dialog.getByRole('slider', { name: '时间线播放位置' })
  const box = await ruler.boundingBox()
  if (box === null) throw new Error('时间线尚未布局')
  const scale = Number(await ruler.getAttribute('max'))
  return box.x + (clock / scale) * box.width
}

const centerOf = async (locator: Locator) => {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  if (box === null) throw new Error('元素尚未布局')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** 按住一处拖到时间线的某个时刻，不松手；返回松手的函数。 */
const holdDrag = async (page: Page, dialog: Locator, from: Locator, clock: number) => {
  const start = await centerOf(from)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(await xAt(dialog, clock), start.y, { steps: 6 })
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

test('图生和编辑按模型分别校验时长，仅上传图片也能生成同一选区的新版本', async ({ page }) => {
  const dialog = await openEditor(page, false, 2, false)
  await waitForSegments(dialog)
  await segment(dialog, 2).click()
  await requestBox(dialog).fill('人物缓慢转身')
  await expect(card(dialog).getByText(/编辑至少需要 4 秒/)).toBeVisible()
  await expect(generateButton(dialog)).toBeDisabled()
  for (const position of [3, 4, 5]) await segment(dialog, position).click({ modifiers: ['Shift'] })
  await expect(generateButton(dialog)).toBeEnabled()

  await segment(dialog, 2).click()
  await card(dialog).getByRole('radio', { name: '图生', exact: true }).click()
  await expect(requestBox(dialog)).toHaveText('人物缓慢转身')
  await expect(generateButton(dialog)).toBeDisabled()
  await requestBox(dialog).fill('')
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
  await expect(generateButton(dialog)).toBeEnabled()

  await card(dialog).getByRole('button', { name: '生成时长', exact: true }).click()
  await page.getByRole('menuitemradio', { name: '30 秒', exact: true }).click()
  await card(dialog).getByRole('button', { name: '图生模型', exact: true }).click()
  await page.getByRole('menuitemradio', { name: 'vendor-a-seedance-2-0', exact: true }).click()
  await expect(card(dialog).getByRole('button', { name: '生成时长' })).toHaveText('30 秒')
  await expect(card(dialog).getByText(/图生时长须为 4–15 秒/)).toBeVisible()
  await expect(generateButton(dialog)).toBeDisabled()
  await card(dialog).getByRole('button', { name: '生成时长', exact: true }).click()
  await expect(page.getByRole('menuitemradio', { name: '16 秒', exact: true })).toHaveCount(0)
  await page.getByRole('menuitemradio', { name: '15 秒', exact: true }).click()
  await expect(generateButton(dialog)).toBeEnabled()
  await screenshotBothThemes(page, '../.artifacts/design-qa/video-generation-modes/image-card')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(card(dialog).getByRole('radio', { name: '图生', exact: true })).toBeVisible()
  await expect(generateButton(dialog)).toBeVisible()
  await screenshotBothThemes(page, '../.artifacts/design-qa/video-generation-modes/image-mobile')

  const { body } = await submitEdit(page, dialog)
  expect(body).toMatchObject({
    prompt: '@Image1',
    range_start_ms: 1000,
    range_end_ms: 2000,
    seconds: 15,
    reference_video_urls: [],
  })
  expect(body['reference_image_urls']).toEqual([expect.stringMatching(/\/mock-oss\//)])
  await expect(versions(dialog).getByRole('button', { name: '原片', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  const candidate = versions(dialog).getByRole('button', { name: 'V1 · 新结果', exact: true })
  await expect(candidate).toBeEnabled({ timeout: STEP_TIMEOUT })
  await candidate.click()
  await scope(dialog, '整片').click()
  await expect(segment(dialog, 2).getByText('V1', { exact: true })).toBeVisible()
})

test('整片预览使用时间线选用的版本，历史原片与当前剪辑分别显示对应画面和时长', async ({ page }) => {
  const dialog = await openEditor(page)
  await waitForSegments(dialog)
  const video = dialog.getByLabel('视频播放器', { exact: true })
  const originalUrl = await video.getAttribute('src')
  if (originalUrl === null) throw new Error('原片尚未加载')
  await segment(dialog, 2).click()
  await requestBox(dialog).fill('把这一秒改成暖色')
  await submitEdit(page, dialog)
  const candidate = versions(dialog).getByRole('button', { name: / · 新结果$/ })
  await expect(candidate).toBeEnabled({ timeout: STEP_TIMEOUT })
  await candidate.click()
  await expect(video).not.toHaveAttribute('src', originalUrl)
  const editedUrl = await video.getAttribute('src')
  if (editedUrl === null) throw new Error('编辑结果尚未加载')

  // 一秒原片换成三秒结果，总长八秒；切整片后该位置仍播放被选用的文件。
  await scope(dialog, '整片').click()
  await dialog.getByRole('slider', { name: '时间线播放位置' }).fill('1.5')
  await expect(video).toHaveAttribute('src', editedUrl)
  await expect(segment(dialog, 2).getByText('V1', { exact: true })).toBeVisible()
  await expect(controls(dialog)).toContainText('共 8.0 秒')
  await dialog.getByRole('slider', { name: '时间线播放位置' }).fill('4.5')
  await expect(video).toHaveAttribute('src', originalUrl)
  await expect
    .poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime))
    .toBeCloseTo(2.5, 1)

  await versions(dialog).getByRole('button', { name: '原片', exact: true }).click()
  await expect(video).toHaveAttribute('src', originalUrl)
  await waitForSegments(dialog, 6)
  await expect(controls(dialog)).toContainText('共 6.0 秒')
  await expect(timelineOf(dialog).getByText(/^V\d+$/)).toHaveCount(0)
  await scope(dialog, '整片').click()
  await expect(controls(dialog)).toContainText('共 8.0 秒')
  await expect(segment(dialog, 2).getByText('V1', { exact: true })).toBeVisible()
  await dialog.getByRole('slider', { name: '时间线播放位置' }).fill('1.5')
  await expect(video).toHaveAttribute('src', editedUrl)
  await screenshotBothThemes(page, `${SHOT_DIR}/whole-current`)
})

test('提交立即显示提交中且保护关闭与站内离开，受理后显示生成中并允许退出，完成未看才有绿点', async ({
  page,
}) => {
  const dialog = await openEditor(page)
  await waitForSegments(dialog)
  await segment(dialog, 2).click()
  await requestBox(dialog).fill('换成暖色光线')
  const release = await holdReferenceUpload(page)
  await generateButton(dialog).click()
  const submitting = versions(dialog).getByRole('button', { name: 'V1 · 提交中', exact: true })
  await expect(submitting).toBeVisible()
  await expect(submitting).toBeDisabled()
  await expect(versions(dialog).getByRole('img', { name: '新结果', exact: true })).toHaveCount(0)
  const editingUrl = page.url()
  await page.evaluate(() => window.history.back())
  await expect(dialog.getByText('正在提交，请等待提交完成后再离开', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(editingUrl)
  await expect(submitting).toBeVisible()
  await dialog.getByRole('button', { name: '关闭视频编辑', exact: true }).click()
  await expect(dialog).toBeVisible()

  await screenshotBothThemes(page, `${SHOT_DIR}/submitting`)

  await release()
  const generating = versions(dialog).getByRole('button', { name: 'V1 · 生成中', exact: true })
  await expect(generating).toBeVisible({ timeout: STEP_TIMEOUT })
  await expect(submitting).toHaveCount(0)
  await expect(generating.getByRole('img', { name: '新结果', exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: '关闭视频编辑', exact: true }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: '编辑视频', exact: true }).click()
  await expect(dialog).toBeVisible()
  await waitForSegments(dialog)
  await segment(dialog, 2).click()
  const completed = versions(dialog).getByRole('button', { name: 'V1 · 新结果', exact: true })
  await expect(completed).toBeEnabled({ timeout: STEP_TIMEOUT })
  await expect(completed.getByRole('img', { name: '新结果', exact: true })).toBeVisible()
  await completed.click()
  await expect(versions(dialog).getByRole('button', { name: 'V1', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(versions(dialog).getByRole('img', { name: '新结果', exact: true })).toHaveCount(0)
})

test('提交尚未受理时刷新会出现浏览器原生离开提示', async ({ page }) => {
  const dialog = await openEditor(page)
  await waitForSegments(dialog)
  await segment(dialog, 2).click()
  await requestBox(dialog).fill('等待上传期间刷新')
  await holdReferenceUpload(page)
  await generateButton(dialog).click()
  await expect(
    versions(dialog).getByRole('button', { name: 'V1 · 提交中', exact: true }),
  ).toBeVisible()
  const leave = page.waitForEvent('dialog')
  const reload = page.reload()
  const warning = await leave
  expect(warning.type()).toBe('beforeunload')
  // MSW 在 beforeunload 时停用 mock；在独立页面接受离开，不让此行为影响提交状态用例。
  await warning.accept()
  await reload
})

/** 卡头：第一行要改哪几段，第二行区间与做法，或为什么还不能改。 */
const expectCard = async (dialog: Locator, title: string, detail: string) => {
  await expect(card(dialog).getByText(title, { exact: true })).toBeVisible()
  await expect(card(dialog).getByText(detail, { exact: true })).toBeVisible()
}

test('选中：普通点击只选当前片段，Shift 点击扩选；键盘左右与 Shift 扩展，卡跟着选区走', async ({
  page,
}) => {
  const dialog = await openEditor(page)
  await waitForSegments(dialog)
  await expect(card(dialog)).toHaveCount(0)

  await segment(dialog, 2).click()
  await expect(segment(dialog, 2)).toHaveAttribute('aria-pressed', 'true')
  await expectCard(dialog, '第 2 段 · 视频生成', '1.0 – 2.0 秒 · 视频和原声一起重做')
  await segment(dialog, 3).click({ modifiers: ['Shift'] })
  await expectCard(dialog, '第 2–3 段 · 视频生成', '1.0 – 3.0 秒 · 视频和原声一起重做')
  await segment(dialog, 1).click({ modifiers: ['Shift'] })
  await expectCard(dialog, '第 1–3 段 · 视频生成', '0.0 – 3.0 秒 · 视频和原声一起重做')
  // Shift 点两端的段把它去掉。
  await segment(dialog, 1).click({ modifiers: ['Shift'] })
  await expect(segment(dialog, 1)).toHaveAttribute('aria-pressed', 'false')
  await expectCard(dialog, '第 2–3 段 · 视频生成', '1.0 – 3.0 秒 · 视频和原声一起重做')
  // 普通点击从该段重新选，不会自动扩成多选。
  await segment(dialog, 5).click()
  await expectCard(dialog, '第 5 段 · 视频生成', '4.0 – 5.0 秒 · 视频和原声一起重做')
  await expect(segment(dialog, 2)).toHaveAttribute('aria-pressed', 'false')

  // 卡不抢焦点：键盘左右挪到相邻的段，Shift 扩展。
  await segment(dialog, 5).press('ArrowLeft')
  await expect(segment(dialog, 4)).toBeFocused()
  await expectCard(dialog, '第 4 段 · 视频生成', '3.0 – 4.0 秒 · 视频和原声一起重做')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await expectCard(dialog, '第 4–6 段 · 视频生成', '3.0 – 6.0 秒 · 视频和原声一起重做')
  await page.keyboard.press('Shift+ArrowLeft')
  await expectCard(dialog, '第 4–5 段 · 视频生成', '3.0 – 5.0 秒 · 视频和原声一起重做')

  // 卡的尖角指着选区：卡盖在舞台上，水平中线对准选区的中线（夹在舞台内）。
  const box = await card(dialog).boundingBox()
  const first = await segment(dialog, 4).boundingBox()
  const last = await segment(dialog, 5).boundingBox()
  const stage = await dialog.getByRole('region', { name: '预览舞台' }).boundingBox()
  if (box === null || first === null || last === null || stage === null)
    throw new Error('卡或选区尚未布局')
  const anchor = (first.x + last.x + last.width) / 2
  const expected = Math.min(
    stage.x + stage.width - 12 - box.width,
    Math.max(stage.x + 12, anchor - box.width / 2),
  )
  // 选区外框比段宽出两三像素，只要求对准到几像素以内。
  expect(Math.abs(box.x - expected)).toBeLessThan(4)
  expect(box.y + box.height).toBeLessThanOrEqual(stage.y + stage.height)
})

test('点击片段从该段起点自动播放并在末尾停止，普通点击相邻段不会扩选', async ({ page }) => {
  const dialog = await openEditor(page)
  await waitForSegments(dialog)
  const seek = dialog.getByRole('slider', { name: '时间线播放位置' })
  await segment(dialog, 2).click()
  await expect(dialog.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
  await expect.poll(async () => Number(await seek.inputValue())).toBeGreaterThanOrEqual(1)
  await expect(dialog.getByRole('button', { name: '播放', exact: true })).toBeVisible()
  await expect(seek).toHaveValue('2')
  await segment(dialog, 3).click()
  await expect(segment(dialog, 2)).toHaveAttribute('aria-pressed', 'false')
  await expect(segment(dialog, 3)).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
  await expectCard(dialog, '第 3 段 · 视频生成', '2.0 – 3.0 秒 · 视频和原声一起重做')
})

test('标尺下边缘可拖动播放头，不触发相邻裁剪手柄、片段选中或调序', async ({ page }) => {
  const dialog = await openEditor(page)
  await waitForSegments(dialog)
  await segment(dialog, 2).click()
  const names = await segments(dialog).evaluateAll((items) =>
    items.map((item) => item.getAttribute('aria-label')),
  )
  const ruler = dialog.getByRole('slider', { name: '时间线播放位置' })
  const box = await ruler.boundingBox()
  if (box === null) throw new Error('标尺尚未布局')
  expect(box.height).toBeGreaterThanOrEqual(32)
  await page.mouse.move(await xAt(dialog, 2), box.y + box.height - 1)
  await page.mouse.down()
  await page.mouse.move(await xAt(dialog, 4.5), box.y + box.height - 1, { steps: 8 })
  await page.mouse.up()
  expect(Number(await ruler.inputValue())).toBeCloseTo(4.5, 1)
  await expect(segment(dialog, 2)).toHaveAttribute('aria-pressed', 'true')
  expect(
    await segments(dialog).evaluateAll((items) =>
      items.map((item) => item.getAttribute('aria-label')),
    ),
  ).toEqual(names)
  await expect(controls(dialog)).toContainText('共 6.0 秒')
  await ruler.press('ArrowLeft')
  expect(Number(await ruler.inputValue())).toBeCloseTo(4.49, 1)
})

test('删除、拆分、撤销与重做：总长跟着变，版本栏只显示实际版本；刷新后剪辑选择还在', async ({
  page,
}) => {
  const dialog = await openEditor(page)
  await waitForSegments(dialog)
  await expect(versions(dialog).getByRole('button', { name: '原片', exact: true })).toBeVisible()

  await segment(dialog, 2).click()
  await controls(dialog).getByRole('button', { name: '删除', exact: true }).click()
  await waitForSegments(dialog, 5)
  await expect(controls(dialog)).toContainText('共 5.0 秒 · 比 原片 短 1.0 秒')
  await expect(versions(dialog).getByRole('button', { name: /^未合成/ })).toHaveCount(0)
  // 有改动时下的是这一版本身，看着草稿时灰着。
  await expect(controls(dialog).getByRole('button', { name: '下载', exact: true })).toBeDisabled()

  // 撤销按钮与 Cmd/Ctrl+Z、Shift+Cmd/Ctrl+Z。
  await controls(dialog).getByRole('button', { name: '撤销', exact: true }).click()
  await waitForSegments(dialog, 6)
  await expect(versions(dialog).getByRole('button', { name: '原片', exact: true })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await waitForSegments(dialog, 5)
  await page.keyboard.press('ControlOrMeta+z')
  await waitForSegments(dialog, 6)
  await controls(dialog).getByRole('button', { name: '重做', exact: true }).click()
  await waitForSegments(dialog, 5)

  // 删除键删掉聚焦着的选中段。
  await segment(dialog, 1).click()
  await page.keyboard.press('Delete')
  await waitForSegments(dialog, 4)
  await expect(controls(dialog)).toContainText('共 4.0 秒 · 比 原片 短 2.0 秒')

  // 拆分：在播放头处把所在的段一分为二，总长不变。
  const split = controls(dialog).getByRole('button', { name: '拆分', exact: true })
  await dialog.getByRole('slider', { name: '时间线播放位置' }).fill('0.5')
  await expect(split).toBeEnabled()
  await split.click()
  await waitForSegments(dialog, 5)
  await expect(segment(dialog, 1)).toHaveAccessibleName('第 1 段 · 0–0.5 秒')
  await expect(controls(dialog)).toContainText('共 4.0 秒')
  // 拆完选中右半，Shift 点左半连成原来的 1 秒区间，仍可以继续编辑。
  await segment(dialog, 1).click({ modifiers: ['Shift'] })
  await expectCard(dialog, '第 1–2 段 · 视频生成', '2.0 – 3.0 秒 · 视频和原声一起重做')
  await requestBox(dialog).fill('换成黄昏的暖光')
  await expect(generateButton(dialog)).toBeEnabled()

  // 草稿只存在浏览器：刷新后（mock 的登录随页面清掉，重新登录）重开，还是这份。
  await page.reload()
  const reopened = await openEditor(page)
  await waitForSegments(reopened, 5)
  await expect(controls(reopened)).toContainText('共 4.0 秒 · 比 原片 短 2.0 秒')
  await expect(versions(reopened).getByRole('button', { name: /^未合成/ })).toHaveCount(0)
})

test('裁剪 1 秒的原片段：气泡说裁剪后多长，松手后总长变短；不足 1 秒时提示合并选择', async ({
  page,
}) => {
  const dialog = await openEditor(page)
  await waitForSegments(dialog)

  await segment(dialog, 2).click()
  const release = await holdDrag(
    page,
    dialog,
    dialog.getByRole('slider', { name: '裁剪该段结尾' }),
    1.4,
  )
  await expect(timelineOf(dialog).getByRole('status')).toHaveText('裁剪后 0.4 秒 · 缩短 0.6 秒')
  // 一拖手柄卡就收成胶囊，画面不被挡。
  await expect(card(dialog)).toHaveCount(0)
  await expect(capsule(dialog)).toBeVisible()
  await release()
  await expect(segment(dialog, 2)).toHaveAccessibleName('第 2 段 · 1–1.4 秒')
  await expect(controls(dialog)).toContainText('共 5.4 秒 · 比 原片 短 0.6 秒')
  await capsule(dialog).click()
  await expectCard(
    dialog,
    '第 2 段 · 视频生成',
    '该模型编辑至少需要 1 秒；请按住 Shift 选择相邻片段',
  )

  // 拖过头停在最短的 0.2 秒。
  const tooFar = await holdDrag(
    page,
    dialog,
    dialog.getByRole('slider', { name: '裁剪该段结尾' }),
    1,
  )
  await expect(timelineOf(dialog).getByRole('status')).toHaveText('裁剪后 0.2 秒 · 缩短 0.2 秒')
  await tooFar()
  await expect(segment(dialog, 2)).toHaveAccessibleName('第 2 段 · 1–1.2 秒')
})

test('拖动调序：插入处一条墨线，原声跟着走；合成请求就是草稿', async ({ page }) => {
  await page.setViewportSize({ width: 1335, height: 880 })
  const dialog = await openEditor(page)
  await waitForSegments(dialog)
  await segment(dialog, 2).click()
  await expect(card(dialog)).toBeVisible()

  // 按住最后一段拖到最前：卡收成胶囊；收的动画还没走完就松手，胶囊落定后也要对准新选区。
  const release = await holdDrag(page, dialog, segment(dialog, 6), 0.2)
  await expect(timelineOf(dialog).getByTestId('timeline-insert')).toBeVisible()
  await expect(card(dialog)).toHaveCount(0)
  await release()
  await expect(controls(dialog)).toContainText('共 6.0 秒')
  await expect(versions(dialog).getByRole('button', { name: /^未合成/ })).toHaveCount(0)
  // 挪过去的那段仍选中，胶囊跟到它上方（夹在舞台内）。
  await expect(segment(dialog, 1)).toHaveAttribute('aria-pressed', 'true')
  const pillOffset = async () => {
    const pill = await capsule(dialog).boundingBox()
    const moved = await segment(dialog, 1).boundingBox()
    const stage = await dialog.getByRole('region', { name: '预览舞台' }).boundingBox()
    if (pill === null || moved === null || stage === null) throw new Error('胶囊或选区尚未布局')
    const expectedLeft = Math.min(
      stage.x + stage.width - 12 - pill.width,
      Math.max(stage.x + 12, moved.x + moved.width / 2 - pill.width / 2),
    )
    return Math.abs(pill.x - expectedLeft)
  }
  // 选区外框比段宽出两三像素，只要求对准到几像素以内。
  await expect.poll(pillOffset).toBeLessThan(4)
  // Shift 连上后面那段，按基底时间不连续，不能交给 AI。
  await segment(dialog, 2).click({ modifiers: ['Shift'] })
  await expectCard(dialog, '第 1–2 段 · 视频生成', '请选择原片时间连续的片段，再生成新版本')

  const request = page.waitForRequest(
    (sent) => sent.url().endsWith('/api/generations/video-composites') && sent.method() === 'POST',
  )
  await dialog.getByRole('button', { name: '合成成片', exact: true }).click()
  const baseJobId = new URL(page.url()).searchParams.get('video')
  expect((await request).postDataJSON()).toEqual({
    conversationId: expect.any(String),
    taskId: null,
    baseJobId,
    segments: [5, 0, 1, 2, 3, 4].map((start) => ({
      sourceJobId: baseJobId,
      start,
      end: start + 1,
    })),
  })
})

test('AI 改两段：参考片段与区间对齐，结果由用户选用；裁短后按选用版本合成并保留时间线', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1335, height: 880 })
  const dialog = await openEditor(page)
  await waitForSegments(dialog)
  // 原片有原声：读到的是真实波形，不是「无声」。
  await expect(timelineOf(dialog).getByTestId('timeline-wave').first()).toBeVisible({
    timeout: STEP_TIMEOUT,
  })
  await expect(timelineOf(dialog).getByText('无声')).toHaveCount(0)

  // 只选中一段：两端出手柄，卡弹在舞台上。
  await segment(dialog, 2).click()
  await expect(dialog.getByRole('slider', { name: '裁剪该段结尾' })).toBeVisible()
  await expect(card(dialog)).toBeVisible()

  await segment(dialog, 3).click({ modifiers: ['Shift'] })
  await expect(dialog.getByRole('slider', { name: '裁剪该段结尾' })).toHaveCount(0)
  await expectCard(dialog, '第 2–3 段 · 视频生成', '1.0 – 3.0 秒 · 视频和原声一起重做')
  // 模型菜单向上展开（菜单开着时别处对读屏隐藏，按钮位置先量好）。
  const modelPicker = card(dialog).getByRole('button', { name: '编辑模型', exact: true })
  const pickerBox = await modelPicker.boundingBox()
  await modelPicker.click()
  await expect(page.getByRole('menuitemradio', { name: 'wan3.0-video' })).toBeChecked()
  const menu = await page.getByRole('menu', { name: '编辑模型' }).boundingBox()
  if (menu === null || pickerBox === null) throw new Error('模型菜单尚未布局')
  expect(menu.y + menu.height).toBeLessThanOrEqual(pickerBox.y)
  await page.getByRole('menuitemradio', { name: 'wan3.0-video' }).click()
  await expect(modelPicker).toHaveText('wan3.0-video')

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
  await screenshotBothThemes(page, `${SHOT_DIR}/card`)

  const { body, editId } = await submitEdit(page, dialog)
  // 基底是正在编辑的那一版，区间正好是第 2–3 段的关键帧；参考片段由浏览器在关键帧处切好、传上去；
  // 参考图按 `@ImageN` 写进正文，地址进 reference_image_urls。
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
  expect(body['reference_image_urls']).not.toEqual(body['reference_video_urls'])
  const [clipUrl] = body['reference_video_urls'] as string[]
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
  expect(clip).toEqual({ box: 'ftyp', duration: expect.closeTo(2, 1) })

  // 多段选区归成一段，仍用原素材；生成状态只在侧栏，不遮住时间线。
  await expect(versions(dialog).getByRole('button', { name: /V1 · 生成中/ })).toBeVisible()
  await expect(timelineOf(dialog).getByRole('img', { name: /AI 生成中/ })).toHaveCount(0)
  await expect(timelineOf(dialog).getByRole('status')).toHaveCount(0)
  await waitForSegments(dialog, 5)
  await expect(segment(dialog, 2)).toHaveAttribute('aria-pressed', 'true')
  await expect(versions(dialog).getByRole('button', { name: '原片', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(controls(dialog)).toContainText('共 6.0 秒')
  await screenshotBothThemes(page, `${SHOT_DIR}/running`)

  // 结果回来只新增候选，不覆盖已选的 原片；点击 V1 才替换为 3 秒结果。
  await expect(versions(dialog).getByRole('button', { name: /V1 · 生成中/ })).toHaveCount(0, {
    timeout: STEP_TIMEOUT,
  })
  const candidate = versions(dialog).getByRole('button', { name: /^V1(?: · 新结果)?$/ })
  await expect(candidate).toBeVisible()
  await expect(controls(dialog)).toContainText('共 6.0 秒')
  await candidate.click()
  await expect(segment(dialog, 2)).toHaveAccessibleName('第 2 段 · 1–4 秒')
  await expect(segment(dialog, 2).getByText('V1', { exact: true })).toBeVisible()
  await expect(timelineOf(dialog).getByText(/^V\d+$/)).toHaveCount(1)
  await expect(controls(dialog)).toContainText('共 7.0 秒 · 比 原片 长 1.0 秒')

  // 再编辑预览当前结果，候选仍归属基底区间；可继续裁剪，不要求先合成。
  await segment(dialog, 2).click()
  await expectCard(dialog, '第 2 段 · 视频生成', '1.0 – 3.0 秒 · 视频和原声一起重做')
  const release = await holdDrag(
    page,
    dialog,
    dialog.getByRole('slider', { name: '裁剪该段结尾' }),
    3,
  )
  await expect(timelineOf(dialog).getByRole('status')).toHaveText('裁剪后 2.0 秒 · 缩短 1.0 秒')
  await expect(card(dialog)).toHaveCount(0)
  await release()
  await expect(segment(dialog, 2)).toHaveAccessibleName('第 2 段 · 1–3 秒')
  await expect(controls(dialog)).toContainText('共 6.0 秒')
  await capsule(dialog).click()
  await expectCard(dialog, '第 2 段 · 视频生成', '1.0 – 2.3 秒 · 视频和原声一起重做')
  await expect(requestBox(dialog)).toBeFocused()
  await page.keyboard.type('再暖一点')
  await expect(generateButton(dialog)).toBeEnabled()
  await screenshotBothThemes(page, `${SHOT_DIR}/selected`)

  // 删一段：后面的跟上，右边留细框。
  await segment(dialog, 5).click()
  await page.keyboard.press('Delete')
  await waitForSegments(dialog, 4)
  await expect(controls(dialog)).toContainText('共 5.0 秒 · 比 原片 短 1.0 秒')
  await expect(timelineOf(dialog).getByTestId('timeline-tail')).toBeVisible()

  // 合成：请求体就是草稿。
  const request = page.waitForRequest(
    (sent) => sent.url().endsWith('/api/generations/video-composites') && sent.method() === 'POST',
  )
  await dialog.getByRole('button', { name: '合成成片', exact: true }).click()
  expect((await request).postDataJSON()).toEqual({
    conversationId: expect.any(String),
    taskId: null,
    baseJobId,
    segments: [
      { sourceJobId: baseJobId, start: 0, end: 1 },
      { sourceJobId: editId, start: 0, end: 2 },
      { sourceJobId: baseJobId, start: 3, end: 4 },
      { sourceJobId: baseJobId, start: 4, end: 5 },
    ],
  })
  await expect(versions(dialog).getByRole('button', { name: /^未合成/ })).toHaveCount(0)

  // 整片按钮预览当前时间线；明确点击合成版本才查看历史文件。
  await scope(dialog, '整片').click()
  const composite = versions(dialog).getByRole('button', { name: 'V1', exact: true })
  await expect(composite).toBeEnabled({ timeout: STEP_TIMEOUT })
  await scope(dialog, '整片').click()
  await waitForSegments(dialog, 4)
  await expect(segment(dialog, 2).getByText('V1', { exact: true })).toBeVisible()
  const retained = await page.evaluate(
    (key) =>
      Object.keys(localStorage).filter(
        (name) => name.startsWith('video-editor-draft:') && name.endsWith(`:${key}`),
      ),
    baseJobId ?? '',
  )
  expect(retained).toHaveLength(1)
  await screenshotBothThemes(page, `${SHOT_DIR}/composed`)
  await composite.click()
  await expect(composite).toHaveAttribute('aria-pressed', 'true')
  await waitForSegments(dialog, 6)
  await expect(controls(dialog).getByRole('button', { name: '下载', exact: true })).toBeEnabled()
  await versions(dialog).getByRole('button', { name: '原片', exact: true }).click()
  await waitForSegments(dialog, 6)
  await expect(timelineOf(dialog).getByText(/^V\d+$/)).toHaveCount(0)
  await scope(dialog, '整片').click()
  await waitForSegments(dialog, 4)
  await expect(segment(dialog, 2).getByText('V1', { exact: true })).toBeVisible()
  await expect(versions(dialog).getByRole('button', { name: /^未合成/ })).toHaveCount(0)
})

test('扩大已编辑区间：参考包含当前版本和相邻原片，新版本按基底时间替换一次', async ({ page }) => {
  const dialog = await openEditor(page)
  await waitForSegments(dialog)
  const baseJobId = new URL(page.url()).searchParams.get('video')
  await segment(dialog, 3).click()
  await segment(dialog, 4).click({ modifiers: ['Shift'] })
  await requestBox(dialog).fill('把这段背景换成海边')
  const first = await submitEdit(page, dialog)
  await expect(versions(dialog).getByRole('button', { name: /V1 · 生成中/ })).toHaveCount(0, {
    timeout: STEP_TIMEOUT,
  })
  await versions(dialog)
    .getByRole('button', { name: /^V1(?: · 新结果)?$/ })
    .click()
  await expect(segment(dialog, 3)).toHaveAccessibleName('第 3 段 · 2–5 秒')
  await expect(controls(dialog)).toContainText('共 7.0 秒')

  await segment(dialog, 4).click({ modifiers: ['Shift'] })
  await segment(dialog, 5).click({ modifiers: ['Shift'] })
  await expectCard(dialog, '第 3–5 段 · 视频生成', '2.0 – 6.0 秒 · 视频和原声一起重做')
  await expect(
    versions(dialog).getByRole('button', { name: '当前选用', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await requestBox(dialog).fill('相邻两段光线保持一致')
  const second = await submitEdit(page, dialog)
  expect(second.body).toMatchObject({
    source_job_id: baseJobId,
    range_start_ms: 2000,
    range_end_ms: 6000,
  })
  expect(second.editId).not.toBe(first.editId)
  const [referenceUrl] = second.body['reference_video_urls'] as string[]
  const duration = await page.evaluate(async (url) => {
    const video = document.createElement('video')
    video.src = url
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve
      video.onerror = reject
    })
    return video.duration
  }, referenceUrl)
  expect(duration).toBeCloseTo(5, 1)
  await expect(versions(dialog).getByRole('button', { name: /V1 · 生成中/ })).toHaveCount(0, {
    timeout: STEP_TIMEOUT,
  })
  await versions(dialog)
    .getByRole('button', { name: /^V1(?: · 新结果)?$/ })
    .click()
  await waitForSegments(dialog, 3)
  await expect(segment(dialog, 3)).toHaveAccessibleName('第 3 段 · 2–5 秒')
  const request = page.waitForRequest(
    (sent) => sent.url().endsWith('/api/generations/video-composites') && sent.method() === 'POST',
  )
  await dialog.getByRole('button', { name: '合成成片', exact: true }).click()
  expect((await request).postDataJSON()).toMatchObject({
    baseJobId,
    segments: [
      { sourceJobId: baseJobId, start: 0, end: 1 },
      { sourceJobId: baseJobId, start: 1, end: 2 },
      { sourceJobId: second.editId, start: 0, end: 3 },
    ],
  })
})

test('改和看不冲突：拖播放头、按播放卡收成胶囊，点胶囊展开字还在；Escape 先收卡再关编辑器', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1335, height: 880 })
  const dialog = await openEditor(page)
  await waitForSegments(dialog)
  await segment(dialog, 2).click()
  await segment(dialog, 3).click({ modifiers: ['Shift'] })
  await requestBox(dialog).fill('换成黄昏的暖光')

  // 按住播放头拖：卡收成画面底部的小胶囊，标着未提交。
  const release = await holdDrag(
    page,
    dialog,
    dialog.getByRole('slider', { name: '时间线播放位置' }),
    4.6,
  )
  await expect(card(dialog)).toHaveCount(0)
  await expect(capsule(dialog)).toHaveAccessibleName('展开第 2–3 段 · 视频生成，未提交')
  await expect(capsule(dialog)).toContainText('· 未提交')
  await capsule(dialog).evaluate((element) =>
    Promise.all(
      (element.parentElement?.getAnimations() ?? []).map((animation) => animation.finished),
    ),
  )
  // 指针按住拖的焦点不画焦点环。
  const seek = dialog.getByRole('slider', { name: '时间线播放位置' })
  const rulerOutline = () =>
    seek.evaluate((element) => getComputedStyle(element.parentElement as HTMLElement).outlineStyle)
  await expect(seek).toBeFocused()
  expect(await rulerOutline()).toBe('none')
  await screenshotBothThemes(page, `${SHOT_DIR}/scrub`)
  await release()
  expect(await rulerOutline()).toBe('none')
  // 键盘走开再走回来：刻度区画出焦点环。
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expect(seek).toBeFocused()
  expect(await rulerOutline()).toBe('solid')

  // 停下后点胶囊展开：字还在，光标在输入框里。
  await capsule(dialog).click()
  await expect(requestBox(dialog)).toHaveText('换成黄昏的暖光')
  await expect(requestBox(dialog)).toBeFocused()

  // 按播放也收起；暂停后点选区里的段展开，选中不变。
  await dialog.getByRole('button', { name: '播放', exact: true }).click()
  await expect(card(dialog)).toHaveCount(0)
  await expect(capsule(dialog)).toBeVisible()
  await dialog.getByRole('button', { name: '暂停', exact: true }).click()
  await segment(dialog, 3).click()
  await expectCard(dialog, '第 3 段 · 视频生成', '2.0 – 3.0 秒 · 视频和原声一起重做')
  await expect(requestBox(dialog)).toHaveText('换成黄昏的暖光')

  // Escape：第一下收卡，编辑器还在；第二下关编辑器。
  await page.keyboard.press('Escape')
  await expect(card(dialog)).toHaveCount(0)
  await expect(capsule(dialog)).toBeVisible()
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('移动布局：对话框内部自己滚，页面不横向溢出；卡与胶囊铺满舞台宽减两边留白', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const dialog = await openEditor(page, true)
  await waitForSegments(dialog)
  await segment(dialog, 2).click()
  await requestBox(dialog).fill('换成黄昏的暖光，动作和机位不变')
  const stage = await dialog.getByRole('region', { name: '预览舞台' }).boundingBox()
  const box = await card(dialog).boundingBox()
  if (stage === null || box === null) throw new Error('舞台或卡尚未布局')
  expect(box.x).toBeCloseTo(stage.x + 12, 0)
  expect(box.width).toBeCloseTo(stage.width - 24, 0)
  expect(box.y + box.height).toBeLessThanOrEqual(stage.y + stage.height)
  await dialog.getByRole('region', { name: '预览舞台' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOT_DIR}/mobile-card-light.png`, animations: 'disabled' })
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

  // 拖播放头：卡收成胶囊，仍在舞台里。
  await dialog.getByRole('slider', { name: '时间线播放位置' }).fill('3.5')
  await expect(capsule(dialog)).toBeVisible()
  const pill = await capsule(dialog).boundingBox()
  const stageNow = await dialog.getByRole('region', { name: '预览舞台' }).boundingBox()
  if (pill === null || stageNow === null) throw new Error('胶囊尚未布局')
  expect(pill.x).toBeGreaterThanOrEqual(stageNow.x + 12)
  expect(pill.x + pill.width).toBeLessThanOrEqual(stageNow.x + stageNow.width - 12)
  await dialog.getByRole('region', { name: '预览舞台' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOT_DIR}/mobile-capsule-light.png`, animations: 'disabled' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

  // 手机上放大：宽度到 90vw 的上限为止，比例不变，页面仍不横向溢出。
  await dialog.getByRole('button', { name: '放大', exact: true }).click()
  const overlay = page.getByRole('dialog', { name: '放大预览' })
  await expect(overlay).toBeVisible()
  await overlay.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  )
  const enlarged = await overlay.getByLabel('视频预览', { exact: true }).boundingBox()
  if (enlarged === null) throw new Error('放大层尚未布局')
  expect(enlarged.width).toBeCloseTo(390 * 0.9, 0)
  expect(enlarged.width / enlarged.height).toBeCloseTo(9 / 16, 2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

test('横版素材：舞台按画面比例摆，不留黑边；原声轨写「无声」，放大后控件贴住画面底边', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1303, height: 1006 })
  const dialog = await openEditor(page, false, 3)
  await waitForSegments(dialog)
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
  expect(stage.width).toBeCloseTo(960, 0)
  expect(stage.width / stage.height).toBeCloseTo(16 / 9, 2)
  expect(enlargedPill.y + enlargedPill.height).toBeLessThanOrEqual(stage.y + stage.height)
  expect(enlargedPill.y + enlargedPill.height).toBeGreaterThan(stage.y + stage.height - 40)
})

test('播放：草稿连着放，跨过删掉的段；剪一刀播放头留在原处', async ({ page }) => {
  const dialog = await openEditor(page)
  await waitForSegments(dialog)
  await segment(dialog, 1).click()
  await page.keyboard.press('Delete')
  await waitForSegments(dialog, 5)

  const seek = dialog.getByRole('slider', { name: '时间线播放位置' })
  await seek.fill('2.5')
  await dialog.getByRole('button', { name: '播放', exact: true }).click()
  const video = dialog.getByLabel('视频播放器', { exact: true })
  // 草稿第 2.5 秒是原片第 3.5 秒：删了第 1 段，后面整体往前挪了一秒。
  await expect
    .poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime))
    .toBeGreaterThan(3.5)
  await dialog.getByRole('button', { name: '暂停', exact: true }).click()
  expect(Number(await seek.inputValue())).toBeGreaterThan(2.5)

  // 拆一刀：段列表变了，播放头不回到开头。
  await seek.fill('2.5')
  await controls(dialog).getByRole('button', { name: '拆分', exact: true }).click()
  await waitForSegments(dialog, 6)
  await expect(seek).toHaveValue('2.5')
})

test('放大预览：舞台搬进应用内遮罩，播放不断、不进浏览器全屏，Escape 只关遮罩', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1303, height: 1006 })
  const dialog = await openEditor(page)
  await waitForSegments(dialog)

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

test('镜头提示词：可连续追加到修改要求，浮窗保持打开且不改变预览尺寸', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1024 })
  const dialog = await openEditor(page)
  await waitForSegments(dialog)
  await segment(dialog, 2).click()
  const preview = dialog.getByRole('region', { name: '预览舞台' })
  const before = await preview.boundingBox()
  await dialog.getByRole('button', { name: '镜头提示词', exact: true }).click()
  const prompts = page.getByRole('dialog', { name: '镜头提示词', exact: true })
  await expect(prompts).toBeVisible()
  await expect(requestBox(dialog)).toHaveText('')
  await screenshotBothThemes(page, '../.artifacts/design-qa/video-prompt-viewer/empty')
  const text = await prompts.locator('ol > li').first().locator('p').innerText()
  await requestBox(dialog).fill('保留手动要求')
  const append = prompts.getByRole('button', { name: '复制镜头 1 到输入框' })
  await append.click()
  await append.click()
  await expect(requestBox(dialog)).toHaveText(`保留手动要求\n${text}\n${text}`)
  await expect(prompts).toBeVisible()
  expect(await preview.boundingBox()).toEqual(before)
  await screenshotBothThemes(page, '../.artifacts/design-qa/video-prompt-viewer/desktop')
  await prompts.getByRole('button', { name: '关闭镜头提示词' }).click()
  await expect(prompts).toBeHidden()
  await expect(card(dialog)).toBeVisible()
})

test('镜头提示词：窄屏浮窗可以滚动且不溢出视口', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const dialog = await openEditor(page, true)
  await waitForSegments(dialog)
  await dialog.getByRole('button', { name: '镜头提示词', exact: true }).click()
  const prompts = page.getByRole('dialog', { name: '镜头提示词', exact: true })
  await expect(prompts).toBeVisible()
  const box = await prompts.boundingBox()
  if (box === null) throw new Error('镜头提示词浮窗尚未布局')
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  expect(box.y + box.height).toBeLessThanOrEqual(844)
  await screenshotBothThemes(page, '../.artifacts/design-qa/video-prompt-viewer/mobile')
})
