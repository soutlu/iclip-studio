/// <reference lib="dom" />

import { expect, test, type Locator, type Page } from '@playwright/test'
import { canvasPng, openConversation, openStoryboardShot, screenshotBothThemes } from './helpers'

/** mock 受理后 3 秒出结果；编辑段与合成各等一轮。 */
const STEP_TIMEOUT = 15_000
const SHOT_DIR = '../.artifacts/design-qa/video-editor-redesign/impl-c'

/** 第 2 组那条成片是竖版、6 秒、每秒一个关键帧、带一条原声；第 3 组是横版、无声。 */
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

const timelineOf = (dialog: Locator) =>
  dialog.getByRole('region', { name: '视频编辑时间线', exact: true })
/** 时间线上能点的段（AI 正在改的占位不是按钮）。 */
const segments = (dialog: Locator) => timelineOf(dialog).getByRole('button', { name: /^第 \d+ 段/ })
const segment = (dialog: Locator, position: number) =>
  timelineOf(dialog).getByRole('button', { name: new RegExp(`^第 ${position} 段`) })
const controls = (dialog: Locator) => dialog.getByRole('group', { name: '播放控件' })
const versions = (dialog: Locator) => dialog.getByRole('group', { name: '视频版本' })
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

/** 卡头：第一行要改哪几段，第二行区间与做法，或为什么还不能改。 */
const expectCard = async (dialog: Locator, title: string, detail: string) => {
  await expect(card(dialog).getByText(title, { exact: true })).toBeVisible()
  await expect(card(dialog).getByText(detail, { exact: true })).toBeVisible()
}

test('选中：点段选中、点相邻连选、点两端去掉、点别处重选；键盘左右与 Shift 扩展，卡跟着选区走', async ({
  page,
}) => {
  const dialog = await openEditor(page)
  await waitForSegments(dialog)
  await expect(card(dialog)).toHaveCount(0)

  await segment(dialog, 2).click()
  await expect(segment(dialog, 2)).toHaveAttribute('aria-pressed', 'true')
  await expectCard(dialog, '第 2 段 · 视频生成', '1.0 – 2.0 秒 · 视频和原声一起重做')
  await segment(dialog, 3).click()
  await expectCard(dialog, '第 2–3 段 · 视频生成', '1.0 – 3.0 秒 · 视频和原声一起重做')
  await segment(dialog, 1).click()
  await expectCard(dialog, '第 1–3 段 · 视频生成', '0.0 – 3.0 秒 · 视频和原声一起重做')
  // 点两端的段把它去掉。
  await segment(dialog, 1).click()
  await expect(segment(dialog, 1)).toHaveAttribute('aria-pressed', 'false')
  await expectCard(dialog, '第 2–3 段 · 视频生成', '1.0 – 3.0 秒 · 视频和原声一起重做')
  // 点不相邻的段从那段重新选。
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

test('删除、拆分、撤销与重做：总长跟着变，多出「未合成」；刷新后草稿还在', async ({ page }) => {
  const dialog = await openEditor(page)
  await waitForSegments(dialog)
  await expect(versions(dialog)).toHaveCount(0)

  await segment(dialog, 2).click()
  await controls(dialog).getByRole('button', { name: '删除', exact: true }).click()
  await waitForSegments(dialog, 5)
  await expect(controls(dialog)).toContainText('共 5.0 秒 · 比 V1 短 1.0 秒')
  await expect(versions(dialog).getByRole('button', { name: '未合成' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  // 有改动时下的是这一版本身，看着草稿时灰着。
  await expect(controls(dialog).getByRole('button', { name: '下载', exact: true })).toBeDisabled()

  // 撤销按钮与 Cmd/Ctrl+Z、Shift+Cmd/Ctrl+Z。
  await controls(dialog).getByRole('button', { name: '撤销', exact: true }).click()
  await waitForSegments(dialog, 6)
  await expect(versions(dialog)).toHaveCount(0)
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
  await expect(controls(dialog)).toContainText('共 4.0 秒 · 比 V1 短 2.0 秒')

  // 拆分：在播放头处把所在的段一分为二，总长不变。
  const split = controls(dialog).getByRole('button', { name: '拆分', exact: true })
  await dialog.getByRole('slider', { name: '时间线播放位置' }).fill('0.5')
  await expect(split).toBeEnabled()
  await split.click()
  await waitForSegments(dialog, 5)
  await expect(segment(dialog, 1)).toHaveAccessibleName('第 1 段 · 0–0.5 秒')
  await expect(controls(dialog)).toContainText('共 4.0 秒')
  // 拆过的段不能直接让 AI 改：卡头写原因，写了要求也生成不了。拆完选中的是右边那半，点左边那半连上它。
  await segment(dialog, 1).click()
  await expectCard(dialog, '第 1–2 段 · 视频生成', '含已剪辑的段，无法生成视频；请先点「合成成片」')
  await requestBox(dialog).fill('换成黄昏的暖光')
  await expect(generateButton(dialog)).toBeDisabled()

  // 草稿只存在浏览器：刷新后（mock 的登录随页面清掉，重新登录）重开，还是这份。
  await page.reload()
  const reopened = await openEditor(page)
  await waitForSegments(reopened, 5)
  await expect(controls(reopened)).toContainText('共 4.0 秒 · 比 V1 短 2.0 秒')
  await expect(versions(reopened).getByRole('button', { name: '未合成' })).toBeVisible()
})

test('裁剪 1 秒的原片段：气泡说裁剪后多长，松手后总长变短，裁过的段不能再让 AI 改', async ({
  page,
}) => {
  const dialog = await openEditor(page)
  await waitForSegments(dialog)

  await segment(dialog, 2).click()
  const release = await holdDrag(
    page,
    dialog,
    dialog.getByRole('slider', { name: '裁剪这段的结尾' }),
    1.4,
  )
  await expect(timelineOf(dialog).getByRole('status')).toHaveText('裁剪后 0.4 秒 · 缩短 0.6 秒')
  // 一拖手柄卡就收成胶囊，画面不被挡。
  await expect(card(dialog)).toHaveCount(0)
  await expect(capsule(dialog)).toBeVisible()
  await release()
  await expect(segment(dialog, 2)).toHaveAccessibleName('第 2 段 · 1–1.4 秒')
  await expect(controls(dialog)).toContainText('共 5.4 秒 · 比 V1 短 0.6 秒')
  await capsule(dialog).click()
  await expectCard(dialog, '第 2 段 · 视频生成', '含已剪辑的段，无法生成视频；请先点「合成成片」')

  // 拖过头停在最短的 0.2 秒。
  const tooFar = await holdDrag(
    page,
    dialog,
    dialog.getByRole('slider', { name: '裁剪这段的结尾' }),
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
  await expect(versions(dialog).getByRole('button', { name: '未合成' })).toBeVisible()
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
  // 连上后面那段，按基底时间不连续，不能交给 AI。
  await segment(dialog, 2).click()
  await expectCard(dialog, '第 1–2 段 · 视频生成', '含已剪辑的段，无法生成视频；请先点「合成成片」')

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

test('AI 改两段：参考片段与区间对上段边界，占位锁住，结果换进草稿；裁短后合成成新的一版', async ({
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
  await expect(dialog.getByRole('slider', { name: '裁剪这段的结尾' })).toBeVisible()
  await expect(card(dialog)).toBeVisible()

  await segment(dialog, 3).click()
  await expect(dialog.getByRole('slider', { name: '裁剪这段的结尾' })).toHaveCount(0)
  await expectCard(dialog, '第 2–3 段 · 视频生成', '1.0 – 3.0 秒 · 视频和原声一起重做')
  // 模型菜单向上展开（菜单开着时别处对读屏隐藏，按钮位置先量好）。
  const modelPicker = card(dialog).getByRole('button', { name: '编辑模型', exact: true })
  const pickerBox = await modelPicker.boundingBox()
  await modelPicker.click()
  await expect(page.getByRole('menuitemradio', { name: 'vendor-a-seedance-2-5' })).toBeChecked()
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
    prompt: '编辑视频，换成黄昏的暖光，逆光打在人和滑板上，动作和机位不变，色调参考@Image1',
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

  // 这两段换成锁定的占位：盖着「生成中」，点不了；合成灰着；选区没了，卡也收走。
  const running = timelineOf(dialog).getByRole('img', { name: /AI 生成中/ })
  await expect(running).toBeVisible()
  await expect(card(dialog)).toHaveCount(0)
  await expect(capsule(dialog)).toHaveCount(0)
  await expect(timelineOf(dialog).getByRole('status')).toHaveText(/生成中 \d+:\d{2}/)
  await expect(segments(dialog)).toHaveCount(4)
  await expect(dialog.getByRole('button', { name: '合成成片', exact: true })).toBeDisabled()
  await expect(versions(dialog).getByRole('button', { name: '未合成' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await screenshotBothThemes(page, `${SHOT_DIR}/running`)

  // 结果回来：占位换成 AI 结果整条（3 秒），总长跟着变，底下一道「改过」的灰线。
  await expect(running).toHaveCount(0, { timeout: STEP_TIMEOUT })
  await waitForSegments(dialog, 5)
  await expect(segment(dialog, 2)).toHaveAccessibleName('第 2 段 · 1–4 秒')
  await expect(controls(dialog)).toContainText('共 7.0 秒 · 比 V1 长 1.0 秒')
  await expect(timelineOf(dialog).getByTestId('timeline-mark')).toHaveCount(1)
  await expect(dialog.getByRole('group', { name: '预览版本' })).toBeVisible()

  // 整条没动过的 AI 结果可以在它当初那一段上再改。
  await segment(dialog, 2).click()
  await expectCard(dialog, '第 2 段 · 视频生成', '1.0 – 3.0 秒 · 视频和原声一起重做')

  // 裁短 AI 结果：拖结尾手柄，卡收成胶囊；气泡说裁剪后多长、缩短多少；松手后后面的段跟上。
  const release = await holdDrag(
    page,
    dialog,
    dialog.getByRole('slider', { name: '裁剪这段的结尾' }),
    3,
  )
  await expect(timelineOf(dialog).getByRole('status')).toHaveText('裁剪后 2.0 秒 · 缩短 1.0 秒')
  await expect(card(dialog)).toHaveCount(0)
  await release()
  await expect(segment(dialog, 2)).toHaveAccessibleName('第 2 段 · 1–3 秒')
  await expect(controls(dialog)).toContainText('共 6.0 秒')
  // 裁过的段不能再让 AI 改：展开卡，卡头写原因，写了要求也生成不了。
  await capsule(dialog).click()
  await expectCard(dialog, '第 2 段 · 视频生成', '含已剪辑的段，无法生成视频；请先点「合成成片」')
  await expect(requestBox(dialog)).toBeFocused()
  await page.keyboard.type('再暖一点')
  await expect(generateButton(dialog)).toBeDisabled()
  await screenshotBothThemes(page, `${SHOT_DIR}/blocked`)

  // 删一段：后面的跟上，右边留细框。
  await segment(dialog, 5).click()
  await page.keyboard.press('Delete')
  await waitForSegments(dialog, 4)
  await expect(controls(dialog)).toContainText('共 5.0 秒 · 比 V1 短 1.0 秒')
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
  await expect(versions(dialog).getByRole('button', { name: '未合成 · 合成中' })).toBeVisible()

  // 合成完成：选中新的一版，基底那份草稿清掉。
  await expect(versions(dialog).getByRole('button', { name: 'V2', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
    { timeout: STEP_TIMEOUT },
  )
  await expect(versions(dialog).getByRole('button', { name: /^未合成/ })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: '合成成片', exact: true })).toHaveCount(0)
  await expect(controls(dialog).getByRole('button', { name: '下载', exact: true })).toBeEnabled()
  expect(
    await page.evaluate(
      (key) => Object.keys(localStorage).filter((name) => name.endsWith(`:${key}`)),
      baseJobId ?? '',
    ),
  ).toEqual([])
  await waitForSegments(dialog)
  await screenshotBothThemes(page, `${SHOT_DIR}/composed`)
  // V1 还在，点回去看到的是原片本身。
  await versions(dialog).getByRole('button', { name: 'V1', exact: true }).click()
  await expect(controls(dialog)).toContainText('共 6.0 秒')
  await expect(versions(dialog).getByRole('button', { name: /^未合成/ })).toHaveCount(0)
})

test('改和看不冲突：拖播放头、按播放卡收成胶囊，点胶囊展开字还在；Escape 先收卡再关编辑器', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1335, height: 880 })
  const dialog = await openEditor(page)
  await waitForSegments(dialog)
  await segment(dialog, 2).click()
  await segment(dialog, 3).click()
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
  await expectCard(dialog, '第 2–3 段 · 视频生成', '1.0 – 3.0 秒 · 视频和原声一起重做')
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
