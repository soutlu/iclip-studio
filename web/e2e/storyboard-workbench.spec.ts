/// <reference lib="dom" />

import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { canvasPng, openConversation, openStoryboardShot, screenshotBothThemes } from './helpers'

/** mock 出片用的测试卡源文件；下载回来的字节要和它一致。 */
const SAMPLE_VIDEO = new URL('../src/testing/fixtures/sample-video.webm', import.meta.url)

// 视口需容纳 264px 侧栏、400px 聊天和 560px 面板。
test.use({ viewport: { height: 900, width: 1600 } })

test('短桌面中舞台在左、文案列在右，画面完整可见且可键盘切帧', async ({ page }) => {
  await page.setViewportSize({ height: 700, width: 1600 })
  const panel = await openConversation(page, '夜景延时素材生成')
  await openStoryboardShot(panel, 2)
  const group = panel.getByRole('region', { name: '镜头组 2' })
  const scene = group.getByRole('group', { name: '镜头 2', exact: true })
  await scene.getByRole('button', { name: '镜头 2', exact: true }).focus()
  await page.keyboard.press('Enter')

  const preview = group.getByRole('img', { name: '镜头组 2 第 2 帧' })
  const script = group.getByRole('region', { name: '分镜文案' })
  const bar = panel.getByRole('group', { name: '出片工具栏' })
  await expect(preview).toBeInViewport({ ratio: 1 })
  await expect(scene).toHaveAttribute('aria-current', 'true')
  await expect(scene).toBeInViewport({ ratio: 1 })
  await expect(bar).toBeInViewport({ ratio: 1 })

  const [groupBox, previewBox, scriptBox, barBox] = await Promise.all([
    group.boundingBox(),
    preview.boundingBox(),
    script.boundingBox(),
    bar.boundingBox(),
  ])
  if (groupBox === null || previewBox === null || scriptBox === null || barBox === null) {
    throw new Error('舞台、文案列和出片栏必须有可见布局')
  }
  // 左右排：画面整个在文案列左边，两者都落在本组区域里、出片栏之上。
  expect(previewBox.height).toBeGreaterThan(0)
  expect(previewBox.x + previewBox.width).toBeLessThanOrEqual(scriptBox.x)
  for (const box of [previewBox, scriptBox]) {
    expect(box.x).toBeGreaterThanOrEqual(groupBox.x)
    expect(box.x + box.width).toBeLessThanOrEqual(groupBox.x + groupBox.width)
    expect(box.y).toBeGreaterThanOrEqual(groupBox.y)
    expect(box.y + box.height).toBeLessThanOrEqual(barBox.y)
  }

  const next = group.getByRole('button', { name: '下一帧', exact: true })
  await next.focus()
  await page.keyboard.press('Enter')
  await expect(group.getByRole('img', { name: '镜头组 2 第 3 帧' })).toBeInViewport({ ratio: 1 })
  await expect(next).toBeDisabled()

  await scene.getByRole('button', { name: '看第 2 帧' }).focus()
  await page.keyboard.press('Enter')
  await expect(preview).toBeVisible()
})

for (const width of [1335, 390]) {
  test(`视频记录空态 ${width}px：说明和返回分镜入口完整可见`, async ({ page }) => {
    await page.setViewportSize({ width, height: 880 })
    const panel = await openConversation(page, '夜景延时素材生成', { mobile: width === 390 })
    await panel.getByRole('button', { name: '生成记录', exact: true }).click()
    const records = panel.getByRole('complementary', { name: '生成记录' })
    await expect(records.getByRole('heading', { name: '暂无视频记录' })).toBeVisible()
    await expect(records).toBeInViewport({ ratio: 1 })
    const back = records.getByRole('button', { name: '返回分镜' })
    await expect(back).toBeInViewport({ ratio: 1 })
    await screenshotBothThemes(page, `../.artifacts/design-qa/video-records-design/empty-${width}`)

    await back.focus()
    await page.keyboard.press('Enter')
    await expect(records).toBeHidden()
    await expect(
      panel.getByRole('region', { name: '镜头组 1' }).getByRole('textbox', { name: '全局设定' }),
    ).toBeVisible()
  })
}

for (const width of [1335, 390]) {
  test(`视频记录预览 ${width}px：播放与关闭复用对话弹层，保留记录和当前分镜`, async ({ page }) => {
    await page.setViewportSize({ width, height: 934 })
    await page.emulateMedia({ colorScheme: 'dark' })
    const panel = await openConversation(page, '夜景延时素材生成', { mobile: width === 390 })
    await openStoryboardShot(panel, 2)
    const group = panel.getByRole('region', { name: '镜头组 2' })
    await group.getByRole('button', { name: '镜头 2', exact: true }).click()
    await expect(group.getByRole('textbox', { name: '镜头 2 的描述' })).toContainText(
      '台词并成一句',
      { timeout: 20_000 },
    )
    await panel.getByRole('button', { name: '生成记录' }).click()
    const records = panel.getByRole('complementary', { name: '生成记录' })
    await expect(records.getByRole('heading', { name: '当前镜头组 · 视频' })).toBeVisible()
    await expect(records.getByRole('radio')).toHaveCount(0)
    await expect(records.getByRole('article')).toHaveCount(3)
    await expect(records).toBeInViewport({ ratio: 1 })
    await page.screenshot({
      animations: 'disabled',
      path: `../.artifacts/design-qa/reuse-video-preview/records-${width}-dark.png`,
    })

    const completed = records.getByRole('article').filter({ hasText: '已完成' })
    await expect(records.locator('video')).toHaveCount(0)
    await completed.getByRole('button', { name: '收起这条记录' }).click()
    const play = completed.getByRole('button', { name: '播放视频' })
    await expect(play).toBeVisible()
    await expect(completed.getByText('视频描述')).toBeHidden()
    await play.click()
    const preview = page.getByRole('dialog', { name: '生成的视频', exact: true })
    await expect(preview).toBeVisible()
    await expect(preview).toBeInViewport({ ratio: 1 })
    await page.screenshot({
      animations: 'disabled',
      path: `../.artifacts/design-qa/reuse-video-preview/player-${width}-dark.png`,
    })
    await expect(records.getByRole('dialog')).toHaveCount(0)
    const video = preview.locator('video')
    // mock 的出片是一条 WebM 测试卡（见 testing/mocks/workspace.ts），弹层放的就是记录上那条地址；
    // dev 下地址没有 hash、带 ?no-inline 查询串，构建产物里有 hash、没查询串。
    await expect(video).toHaveAttribute('src', /\/sample-video(-[^/?]*)?\.webm(\?.*)?$/)
    // 共享播放器：没有原生控件（也就没有全屏入口），进度条是自己的
    expect(await video.evaluate((el: HTMLVideoElement) => el.controls)).toBe(false)
    await expect(preview.getByRole('slider', { name: '播放进度' })).toBeVisible()
    await expect(video).toHaveAttribute('autoplay', '')
    await page.keyboard.press('Escape')
    await expect(preview).toHaveCount(0)
    await expect(video).toHaveCount(0)
    await expect(records.locator('video')).toHaveCount(0)
    await expect(play).toBeFocused()
    await expect(records).toBeVisible()

    await completed.getByRole('button', { name: '展开这条记录' }).click()
    await play.click()
    await expect(preview).toBeVisible()
    await preview.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(preview).toHaveCount(0)
    await expect(video).toHaveCount(0)
    await expect(records.locator('video')).toHaveCount(0)
    await expect(play).toBeFocused()
    await expect(records.getByRole('article')).toHaveCount(3)
    await expect(completed.getByText('视频描述')).toBeVisible()
    await records.getByRole('button', { name: '关闭生成记录' }).click()
    await expect(records).toBeHidden()
    await expect(group.getByRole('textbox', { name: '镜头 2 的描述' })).toContainText(
      '台词并成一句',
    )
    await expect(group.getByRole('img', { name: '镜头组 2 第 2 帧' })).toBeVisible()
  })
}

test.describe('移动触屏分镜', () => {
  test.use({ hasTouch: true, isMobile: true })

  test('选中的末帧完整显示，替换图标可直接点开文件选择器', async ({ page }) => {
    await page.setViewportSize({ height: 844, width: 390 })
    const panel = await openConversation(page, '夜景延时素材生成', { mobile: true })
    await openStoryboardShot(panel, 2)
    const group = panel.getByRole('region', { name: '镜头组 2' })
    await group.getByRole('button', { name: '镜头 2', exact: true }).tap()
    await group.getByRole('button', { name: '下一帧', exact: true }).tap()

    // 上下排：舞台在上，画面整张露出来；触屏没有悬停，帧工具常显。
    await expect(group.getByRole('img', { name: '镜头组 2 第 3 帧' })).toBeInViewport({
      ratio: 1,
    })
    await expect(group.getByRole('button', { name: '添加图片' })).toBeInViewport({ ratio: 1 })
    await expect(panel.getByRole('button', { name: '复制完整提示词' })).toBeInViewport({
      ratio: 1,
    })

    const replaceImage = group.getByRole('button', { name: '替换图片' })
    await expect(replaceImage).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: '../.artifacts/design-qa/storyboard-replace-touch.png' })
    const fileChooserOpened = page.waitForEvent('filechooser')
    await replaceImage.tap()
    await fileChooserOpened
  })
})

// MSW 会话随整页加载清空，无法直接验证带参数刷新；此处验证跳组后地址与组号一致，帧号照样点得动。
test('从组号浮层跳组：地址落在那一组，顶栏组号跟着变，帧号照样点得动', async ({ page }) => {
  const panel = await openConversation(page, '夜景延时素材生成')
  const switcher = panel.getByRole('button', { name: /打开全部镜头组/ })
  await expect(switcher).toHaveAccessibleName(/^镜头组 1 \/ 3/)

  await openStoryboardShot(panel, 3)
  await expect(panel.getByRole('region', { name: '镜头组 3' })).toBeInViewport()
  await expect(page).toHaveURL(/shot=3/)
  await expect(switcher).toHaveAccessibleName(/^镜头组 3 \/ 3/)

  await openStoryboardShot(panel, 2)
  await expect(panel.getByRole('region', { name: '镜头组 2' })).toBeInViewport()
  const shot2 = panel.getByRole('region', { name: '镜头组 2' })
  const scene = shot2.getByRole('group', { name: '镜头 2', exact: true })
  await scene.getByRole('button', { name: '镜头 2', exact: true }).click()
  await scene.getByRole('button', { name: '看第 3 帧' }).click()
  await expect(page).toHaveURL(/frame=3/)
  await expect(shot2.getByRole('img', { name: '镜头组 2 第 3 帧' })).toBeVisible()
})

test('替换图标换掉当前帧，拖到舞台上的图加成新的一帧，都能继续编辑', async ({ page }) => {
  const panel = await openConversation(page, '夜景延时素材生成')
  await openStoryboardShot(panel, 2)
  const shot2 = panel.getByRole('region', { name: '镜头组 2' })

  // 点第二镜里的 @2，地址记下第 2 帧，替换要留在这一帧。
  const secondScene = shot2.getByRole('group', { name: '镜头 2', exact: true })
  await secondScene.getByRole('button', { name: '看第 2 帧' }).click()
  await expect(page).toHaveURL(/frame=2/)
  const preview = shot2.getByRole('img', { name: '镜头组 2 第 2 帧' })
  const imageArea = shot2.getByRole('group', { name: '当前帧图片' })
  // 夹具订阅后会整份重写分镜；等示例 agent 更新完成，避免重置图片打断上传和编辑。
  await expect(shot2.getByRole('textbox', { name: '镜头 2 的描述' })).toContainText(
    '台词并成一句',
    { timeout: 20_000 },
  )
  const png = await canvasPng(page, { fill: '#dfe8dd', label: 'Local frame' })
  await page.context().route('http://localhost/mock-oss/**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ body: png, contentType: 'image/png' })
    } else {
      await route.continue()
    }
  })
  await preview.hover()
  const replaceImage = shot2.getByRole('button', { name: '替换图片' })
  await expect(replaceImage).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: '../.artifacts/design-qa/storyboard-replace-hover.png' })
  await replaceImage.focus()
  await expect(replaceImage).toBeFocused()
  const fileChooserOpened = page.waitForEvent('filechooser')
  await page.keyboard.press('Enter')
  const fileChooser = await fileChooserOpened
  await fileChooser.setFiles({ buffer: png, mimeType: 'image/png', name: '新帧.png' })
  await expect(page).toHaveURL(/frame=2/)
  await expect(preview).toHaveAttribute('src', /\/mock-oss\//)
  await expect(preview).toHaveJSProperty('naturalWidth', 600)
  await expect(panel.getByText('已保存')).toBeVisible({ timeout: 5_000 })
  const uploadedUrl = await preview.getAttribute('src')

  const dataTransfer = await page.evaluateHandle((bytes) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array(bytes)], '拖入帧.png', { type: 'image/png' }))
    return transfer
  }, Array.from(png))
  await imageArea.dispatchEvent('dragenter', { dataTransfer })
  await expect(shot2.getByText('松开添加', { exact: true })).toBeVisible()
  await expect(page.getByTestId('composer-drop-overlay')).toBeHidden()
  await page.screenshot({ path: '../.artifacts/design-qa/storyboard-add-drop.png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({
    animations: 'disabled',
    path: '../.artifacts/design-qa/storyboard-add-drop-dark.png',
  })
  await page.emulateMedia({ colorScheme: 'light' })
  await imageArea.dispatchEvent('drop', { dataTransfer })
  // 拖入是新增：画面换到新加的那一帧，引用插进第二镜；替换过的第 2 帧原样留着。
  await expect(page).not.toHaveURL(/frame=2/)
  const added = shot2.getByRole('img', { name: /^镜头组 2 第 \d+ 帧$/ })
  await expect(added).toHaveAttribute('src', /\/mock-oss\//)
  await expect(added).not.toHaveAttribute('src', uploadedUrl ?? '')
  await expect(added).toHaveJSProperty('naturalWidth', 600)
  await expect(panel.getByText('已保存')).toBeVisible({ timeout: 5_000 })
  await expect(page.getByText('拖入帧.png', { exact: true })).toBeHidden()
  await dataTransfer.dispose()
  await secondScene.getByRole('button', { name: '看第 2 帧' }).click()
  await expect(preview).toHaveAttribute('src', uploadedUrl ?? '')

  const editor = shot2.getByRole('textbox', { name: '镜头 2 的描述' })
  await editor.click()
  await page.keyboard.press('End')
  await page.keyboard.type('镜头缓慢推进。')
  await expect(editor).toContainText('镜头缓慢推进。')
  await expect(panel.getByText('已保存')).toBeVisible({ timeout: 5_000 })
})

test('正文里敲 @ 弹出本组图片：弹层在光标行下方，方向键加 Enter 插入引用、光标留在引用后，Esc 只关弹层', async ({
  page,
}) => {
  const panel = await openConversation(page, '夜景延时素材生成')
  await openStoryboardShot(panel, 2)
  const shot2 = panel.getByRole('region', { name: '镜头组 2' })
  const editor = shot2.getByRole('textbox', { name: '镜头 2 的描述' })
  // 夹具订阅后会整份重写分镜；等它落定再编辑，免得打的字被重置。
  await expect(editor).toContainText('台词并成一句', { timeout: 20_000 })
  const chips = editor.getByRole('button', { name: '看第 2 帧' })
  const before = await chips.count()

  await editor.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' 与双肩包 @')
  const menu = page.getByRole('listbox', { name: '插入参考图' })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('option')).toHaveCount(4)
  const [editorBox, menuBox] = await Promise.all([editor.boundingBox(), menu.boundingBox()])
  if (editorBox === null || menuBox === null) throw new Error('正文与弹层必须有可见布局')
  // 光标在正文最后一行：弹层整个落在这一行下面，不遮住正在打的字。
  expect(menuBox.y).toBeGreaterThanOrEqual(editorBox.y + editorBox.height - 1)

  await page.keyboard.press('ArrowRight')
  await expect(menu.getByRole('option', { name: '插入第 2 帧' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  // 只有一行时 ↑↓ 不动。
  await page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('option', { name: '插入第 2 帧' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await page.keyboard.press('Enter')
  await expect(menu).toBeHidden()
  await expect(chips).toHaveCount(before + 1)
  await page.keyboard.type('接着写')
  await expect(editor).toContainText('与双肩包 @2接着写')
  await expect(editor).not.toContainText('包 @@')

  await page.keyboard.type(' @')
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(editor).toContainText('接着写 @')
  await expect(chips).toHaveCount(before + 1)
  await expect(panel.getByText('已保存')).toBeVisible({ timeout: 5_000 })
})

test('短桌面深色：文案列整组原文可读，看大图后回到原帧与焦点', async ({ page }) => {
  await page.setViewportSize({ height: 700, width: 1600 })
  await page.emulateMedia({ colorScheme: 'dark' })
  const panel = await openConversation(page, '夜景延时素材生成')
  await openStoryboardShot(panel, 2)
  const group = panel.getByRole('region', { name: '镜头组 2' })
  await group.getByRole('button', { name: '镜头 2', exact: true }).click()
  await group.getByRole('button', { name: '下一帧', exact: true }).click()

  const script = group.getByRole('region', { name: '分镜文案' })
  const settings = script.getByRole('textbox', { name: '全局设定', exact: true })
  await expect(settings).toContainText('参考锁定：模特的服装与发型跟住')
  await expect(settings.getByRole('button', { name: '看第 1 帧', exact: true })).toBeVisible()
  await expect(settings).toContainText('剪辑形式：硬切。')
  await expect(script.getByRole('group', { name: '镜头 1', exact: true })).toContainText('0–4s')
  await expect(script.getByRole('group', { name: '镜头 2', exact: true })).toContainText('4–11s')
  await expect(panel.getByRole('button', { name: '复制完整提示词' })).toBeInViewport({
    ratio: 1,
  })
  await page.screenshot({
    path: '../.artifacts/design-qa/shot-group-prompt/desktop-dark-mock.png',
  })
  const open = group.getByRole('button', { name: '打开原图', exact: true })
  await open.click()
  const preview = page.getByRole('dialog', { name: '镜头组 2 第 3 帧', exact: true })
  await expect(preview).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(preview).toBeHidden()
  await expect(open).toBeFocused()
  const search = new URL(page.url()).searchParams
  expect(search.get('shot')).toBe('2')
  expect(search.get('frame')).toBe('3')
  expect(search.has('sheet')).toBe(false)
  await expect(group.getByRole('img', { name: '镜头组 2 第 3 帧' })).toBeInViewport()
})

test('选中即上下文：输入框上出现芯片，× 掉不再回来，发出去的正文带前缀', async ({ page }) => {
  const panel = await openConversation(page, '夜景延时素材生成')
  await expect(panel.getByRole('button', { name: /打开全部镜头组/ })).toHaveAccessibleName(
    /^镜头组 1 \/ 3/,
  )

  await openStoryboardShot(panel, 2)
  const chip = page.getByText('镜头组 2 · 全局设定 · @Image1', { exact: true })
  await expect(chip).toBeVisible()

  await page.getByRole('button', { name: '不再引用 镜头组 2 · 全局设定 · @Image1' }).click()
  await expect(chip).toBeHidden()

  await openStoryboardShot(panel, 1)
  await openStoryboardShot(panel, 2)
  await expect(chip).toBeVisible()

  const composer = page.getByLabel('输入消息')
  await composer.click()
  await page.keyboard.type('把这一组的节奏放慢')
  await page.getByRole('button', { name: '发送' }).click()

  await expect(page.getByText('针对镜头组 2 的全局设定（参考图 @Image1）：').first()).toBeVisible()
})

test('没有工作区文件的对话仍是折叠空态', async ({ page }) => {
  await openConversation(page, '亚麻衬衫二剪')
  await expect(page).toHaveURL(/\/c\//)

  await expect(page.getByRole('button', { name: '展开工作台' })).toBeVisible()
  await expect(page.getByRole('tab', { name: '分镜' })).toBeHidden()
})

for (const width of [1335, 390]) {
  test(`记录下载 ${width}px：保存视频字节并保留记录界面`, async ({ page }) => {
    await page.setViewportSize({ width, height: 934 })
    const panel = await openConversation(page, '夜景延时素材生成', { mobile: width === 390 })
    await openStoryboardShot(panel, 2)
    await panel.getByRole('button', { name: '生成记录' }).click()
    const records = panel.getByRole('complementary', { name: '生成记录' })
    const downloadButton = records.getByRole('button', { name: '下载视频' })
    await expect(downloadButton).toHaveCount(1)
    await expect(downloadButton).toBeInViewport({ ratio: 1 })
    // 等入场动画结束，避免祖先滚动在聚焦后关闭 tooltip。
    await records.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished))
    })
    await downloadButton.focus()
    await expect(downloadButton).toBeFocused()
    await expect(page.getByRole('tooltip', { name: '下载视频' })).toBeVisible()
    await screenshotBothThemes(page, `../.artifacts/design-qa/download-record-video/${width}`)
    // 这条记录上游给了水印版：回车先弹出选单，原片和水印版各自可下。
    await downloadButton.press('Enter')
    const menu = page.getByRole('menu')
    await expect(menu.getByRole('menuitem', { name: '下载水印版' })).toBeVisible()
    const saved = page.waitForEvent('download')
    await menu.getByRole('menuitem', { name: '下载原片' }).click()
    const download = await saved
    expect(await download.failure()).toBeNull()
    // 文件名取自地址（mock 的出片是构建产物里那条 WebM 测试卡），字节要和源文件一致。
    expect(download.suggestedFilename()).toMatch(/^sample-video(-[^/]*)?\.webm$/)
    const path = await download.path()
    expect(path).not.toBeNull()
    expect(await readFile(path)).toEqual(await readFile(SAMPLE_VIDEO))
    await expect(records).toBeVisible()
    await expect(downloadButton).toBeEnabled()
    await expect(records.locator('video')).toHaveCount(0)

    await downloadButton.press('Enter')
    const savedMarked = page.waitForEvent('download')
    await menu.getByRole('menuitem', { name: '下载水印版' }).click()
    expect((await savedMarked).suggestedFilename()).toMatch(/^sample-video(-[^/]*)?\.webm$/)
    await expect(downloadButton).toBeEnabled()
  })
}
