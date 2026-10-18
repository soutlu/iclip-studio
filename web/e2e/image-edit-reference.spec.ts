/// <reference lib="dom" />

import { expect, test, type Locator, type Page } from '@playwright/test'
import { canvasPng, openConversation, openStoryboardShot } from './helpers'
import { login } from './login'

/** 在镜头组 1 的第 1 帧上打开图片编辑器，返回弹窗与「修改要求」输入框。 */
const openFrameEditor = async (page: Page, { mobile = false } = {}) => {
  await openConversation(page, '夜景延时素材生成', { mobile })
  const group = page.getByRole('region', { name: '镜头组 1', exact: true })
  await group.getByRole('button', { name: '镜头 1', exact: true }).click()
  const original = group.getByRole('img', { name: '镜头组 1 第 1 帧' })
  const sourceUrl = await original.getAttribute('src')
  await original.hover()
  await group.getByRole('button', { name: '编辑图片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /^编辑图片/ })
  const editor = dialog.getByRole('textbox', { name: '修改要求', exact: true })
  return { dialog, editor, group, sourceUrl }
}

/** 本机文件拖放：文件字节由页面里的 Canvas 画出来。 */
const fileDrag = (page: Page, png: Buffer, names: readonly string[]) =>
  page.evaluateHandle(
    ([bytes, fileNames]) => {
      const transfer = new DataTransfer()
      for (const fileName of fileNames)
        transfer.items.add(new File([new Uint8Array(bytes)], fileName, { type: 'image/png' }))
      return transfer
    },
    [Array.from(png), names] as const,
  )

/** 上传完的图在 mock 对象存储里，浏览器取缩略图时给它一张真图。 */
const serveMockOss = async (page: Page, png: Buffer) => {
  await page.context().route('http://localhost/mock-oss/**', async (route) => {
    if (route.request().method() === 'GET')
      await route.fulfill({ body: png, contentType: 'image/png' })
    else await route.continue()
  })
}

const imageSubmission = (page: Page) =>
  page.waitForRequest(
    (request) => request.url().endsWith('/api/generations/image') && request.method() === 'POST',
  )

const drawPoint = async (dialog: Locator) => {
  await dialog.getByRole('button', { name: '点标注', exact: true }).click()
  await dialog.getByRole('group', { name: '图片标注画布', exact: true }).click()
}

for (const prefix of ['', '把']) {
  for (const method of ['鼠标', '回车'] as const) {
    test(`${prefix ? '文字后' : '空行'}用 @ ${method}选择标注后仍在原行继续输入`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1600, height: 1000 })
      const { dialog, editor } = await openFrameEditor(page)
      await drawPoint(dialog)
      await editor.fill(prefix)
      await editor.press('Shift+Digit2')
      const option = page.getByRole('option', { name: '标注 1', exact: true })
      await expect(option).toBeVisible()
      if (method === '鼠标') await option.click()
      else {
        // 第一项是「编辑底图」，↓ 一下到标注。
        await editor.press('ArrowDown')
        await expect(option).toHaveAttribute('aria-selected', 'true')
        await editor.press('Enter')
      }
      const chip = editor.getByRole('button', { name: '标注 1', exact: true })
      await expect(chip).toBeVisible()
      await page.keyboard.insertText('改成蓝色')
      // chip 里的红色序号也是一个字。
      await expect(editor).toHaveText(`${prefix}1标注 1改成蓝色`)
      // 光标落在刚输入的文字里；它与标注同一行，说明插入标注没有把后文挤到下一行。
      const reference = await chip.boundingBox()
      if (!reference) throw new Error('标注没有可测量的位置')
      const caret = await editor.evaluate(() => {
        const range = document.getSelection()?.getRangeAt(0)
        if (!range) throw new Error('编辑器没有光标')
        const rect = range.getBoundingClientRect()
        return { bottom: rect.bottom, top: rect.top }
      })
      expect(caret.top).toBeLessThan(reference.y + reference.height)
      expect(caret.bottom).toBeGreaterThan(reference.y)
      await expect(editor).toBeFocused()
    })
  }
}

test('普通编辑只填写要求，回车就提交编辑底图', async ({ page }) => {
  const { dialog, editor, sourceUrl } = await openFrameEditor(page)
  await expect(dialog.getByRole('button', { name: '图片模型' })).toBeEnabled()
  await editor.fill('将衣服改成蓝色')
  const submission = imageSubmission(page)
  await editor.press('Enter')
  const body = (await submission).postDataJSON() as Record<string, unknown>
  expect(body).toMatchObject({
    referenceImageUrls: [sourceUrl],
    prompt: '将衣服改成蓝色',
    sourceUrl,
  })
  expect(body['metadata']).toEqual({ shot: 1, frame: 1 })
  // 提交后输入留着，方便用同一段要求再生成。
  await expect(editor).toHaveText('将衣服改成蓝色')
})

test('@ 引用标注后提交：标注图代替干净底图占 @图片1，正文末尾补说明', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  const { dialog, editor, sourceUrl } = await openFrameEditor(page)
  await expect(dialog.getByRole('button', { name: '图片模型' })).toBeEnabled()
  await drawPoint(dialog)
  await editor.click()
  await page.keyboard.insertText('把')
  await editor.press('Shift+Digit2')
  await page.getByRole('option', { name: '标注 1', exact: true }).click()
  await page.keyboard.insertText('换成蓝色')

  const submission = imageSubmission(page)
  await dialog.getByRole('button', { name: '生成图片', exact: true }).click()
  const body = (await submission).postDataJSON() as Record<string, unknown>
  expect(body['prompt']).toBe(
    '把@标注1换成蓝色\n图中的编号和圈选只表示位置，输出干净的图片，不保留标注。',
  )
  const urls = body['referenceImageUrls'] as string[]
  expect(urls).toHaveLength(1)
  expect(urls[0]).not.toBe(sourceUrl)
  expect(urls[0]).toContain('/mock-oss/')
  expect(body['sourceUrl']).toBe(sourceUrl)
})

for (const width of [1600, 390]) {
  test(`图片编辑 ${width}px：键盘展开失败原因，用 + 插入本组的帧后提交`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    const panel = await openConversation(page, '夜景延时素材生成', { mobile: width === 390 })
    await openStoryboardShot(panel, 2)
    const group = page.getByRole('region', { name: '镜头组 2', exact: true })
    await group.getByRole('button', { name: '镜头 2', exact: true }).click()
    await group.getByRole('button', { name: '下一帧', exact: true }).click()
    await group.getByRole('img', { name: '镜头组 2 第 3 帧' }).hover()
    await group.getByRole('button', { name: '编辑图片', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: /^编辑图片/ })
    const history = dialog.getByRole('group', { name: '该帧的图片' })
    // 选中在跑的那一格，舞台显示生成中与已用时长。
    await history.getByRole('button', { name: /^生成中 · / }).click()
    await expect(dialog.getByRole('status')).toHaveAccessibleName(/^生成中，已用 /)
    await history.getByRole('button', { name: /^生成失败 · / }).click()
    await expect(dialog.getByRole('alert')).toHaveText('生成失败')

    const reason = dialog.getByRole('button', { name: '查看原因', exact: true })
    await reason.focus()
    await reason.press('Enter')
    const error = dialog.getByText(/^图像服务未能完成编辑（400）/)
    await expect(error).toBeVisible()
    await expect(reason).toHaveAttribute('aria-expanded', 'true')
    await expect(reason).toBeFocused()
    // 长服务响应在原因卡片内换行、滚动，不把弹窗或移动端页面横向撑开。
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    )
    expect(await error.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await error.hover()
    await page.mouse.wheel(0, 600)
    await expect.poll(() => error.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    // Esc 先收起原因，编辑器留着。
    await page.keyboard.press('Escape')
    await expect(error).toBeHidden()
    await expect(dialog).toBeVisible()

    const editor = dialog.getByRole('textbox', { name: '修改要求', exact: true })
    await editor.click()
    await page.keyboard.insertText('将背景改成暖色，参考')
    await dialog.getByRole('button', { name: '添加参考图', exact: true }).click()
    const popover = page.getByRole('dialog', { name: '添加参考图', exact: true })
    const frame = popover.getByRole('button', { name: '插入帧 @2', exact: true })
    const frameUrl = await frame.locator('img').getAttribute('src')
    if (frameUrl === null) throw new Error('帧 @2 没有图片地址')
    await frame.click()
    await expect(popover).toBeHidden()
    await expect(editor.getByText('帧 @2', { exact: true })).toBeVisible()
    await expect(editor).toBeFocused()

    const submission = imageSubmission(page)
    await editor.press('Enter')
    const body = (await submission).postDataJSON() as Record<string, unknown>
    expect(body['prompt']).toBe('将背景改成暖色，参考@图片2')
    expect(body['referenceImageUrls']).toEqual([body['sourceUrl'], frameUrl])
  })

  test(`提交后关掉编辑器 ${width}px：帧上先显示生成中再变成有新结果，点开看过即清`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    await openConversation(page, '夜景延时素材生成', { mobile: width === 390 })
    const group = page.getByRole('region', { name: '镜头组 1', exact: true })
    await group.getByRole('button', { name: '镜头 1', exact: true }).click()
    await group.getByRole('img', { name: '镜头组 1 第 1 帧' }).hover()
    await group.getByRole('button', { name: '编辑图片', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: /^编辑图片/ })
    await expect(dialog.getByRole('button', { name: '图片模型' })).toBeEnabled()
    await dialog.getByRole('textbox', { name: '修改要求', exact: true }).fill('将衣服改成蓝色')
    const submission = imageSubmission(page)
    await dialog.getByRole('button', { name: '生成图片', exact: true }).click()
    await submission
    await dialog.getByRole('button', { name: '关闭图片编辑', exact: true }).click()
    await expect(dialog).toBeHidden()

    // 关掉编辑器后帧上仍能看到任务在跑；mock 三秒后出图，前端每五秒问一次。
    await expect(group.getByText('生成中', { exact: true })).toBeVisible()
    const view = group.getByRole('button', { name: '有新结果 · 查看', exact: true })
    await expect(view).toBeVisible({ timeout: 15_000 })

    await view.click()
    await expect(dialog).toBeVisible()
    // 从角标进来直接落在那条结果上：和当前帧左右对比，替换就能点。
    await expect(dialog.getByRole('slider', { name: '对比分割线', exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '替换当前帧', exact: true })).toBeEnabled()
    await dialog.getByRole('button', { name: '关闭图片编辑', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(view).toBeHidden()
    await expect(group.getByText('有新结果', { exact: false })).toBeHidden()
  })
}

test('往编辑器拖本地图片：输入卡就地上传，弹窗其余位置拒收，背后的聊天框始终不亮遮罩也不收附件', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  const { dialog, editor } = await openFrameEditor(page)
  await expect(dialog.getByRole('button', { name: '添加参考图', exact: true })).toBeEnabled()
  const png = await canvasPng(page)
  await serveMockOss(page, png)
  // 弹窗输入卡之外不应出现另一个上传遮罩。
  const overlays = page.getByTestId('composer-drop-overlay')
  const cardOverlay = dialog.getByTestId('composer-drop-overlay')

  // 落在输入卡（正文以外的工具行）：卡片就地收下，提示只盖卡片，聊天遮罩从头到尾不亮。
  const card = dialog.getByRole('button', { name: '添加参考图', exact: true })
  const accepted = await fileDrag(page, png, ['拖入参考.png'])
  await card.dispatchEvent('dragenter', { dataTransfer: accepted })
  await card.dispatchEvent('dragover', { dataTransfer: accepted })
  await expect(cardOverlay).toBeVisible()
  await expect(overlays).toHaveCount(1)
  await card.dispatchEvent('drop', { dataTransfer: accepted })
  await expect(cardOverlay).toBeHidden()
  await expect(editor.getByText('拖入参考.png', { exact: true })).toBeVisible()

  // 落在舞台：弹窗拒收，文件不会跑进背后的聊天输入框。
  const stage = dialog.getByRole('img', { name: '当前编辑帧', exact: true })
  const refused = await fileDrag(page, png, ['误投.png'])
  await stage.dispatchEvent('dragenter', { dataTransfer: refused })
  await stage.dispatchEvent('dragover', { dataTransfer: refused })
  await expect(cardOverlay).toBeHidden()
  await expect(overlays).toHaveCount(0)
  await stage.dispatchEvent('drop', { dataTransfer: refused })
  await expect(page.getByText('误投.png')).toHaveCount(0)

  const submission = imageSubmission(page)
  await editor.click()
  await page.keyboard.insertText('参考这张的材质')
  await editor.press('Enter')
  const body = (await submission).postDataJSON() as Record<string, unknown>
  expect(body['prompt']).toBe('@图片2参考这张的材质')
  expect((body['referenceImageUrls'] as string[])[1]).toContain('/mock-oss/')
})

for (const width of [1335, 390]) {
  test(`失败 chip 的卡片在弹窗里能点、能用键盘 ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 880 })
    const { dialog, editor } = await openFrameEditor(page, { mobile: width === 390 })
    await expect(dialog.getByRole('button', { name: '添加参考图', exact: true })).toBeEnabled()
    // 短边不到 300 的图过不了上传前的校验，chip 停在失败态。
    const png = await canvasPng(page, { height: 120, width: 120 })
    await editor.click()
    await page.keyboard.insertText('参考')
    const card = dialog.getByRole('button', { name: '添加参考图', exact: true })
    await card.dispatchEvent('drop', { dataTransfer: await fileDrag(page, png, ['皮革纹理.png']) })
    const chip = editor.getByText('皮革纹理.png', { exact: true })
    await expect(editor.getByRole('img', { name: '上传失败' })).toBeVisible()

    await chip.click()
    const failure = page.getByRole('dialog', { name: '皮革纹理.png上传失败' })
    await expect(failure).toBeVisible()
    await failure.getByRole('button', { name: '移除', exact: true }).click()
    await expect(chip).toHaveCount(0)

    // 键盘：再来一张失败的，选中 chip 按 Enter 打开卡片，Tab 到「移除」回车。
    await card.dispatchEvent('drop', { dataTransfer: await fileDrag(page, png, ['再试.png']) })
    await expect(editor.getByRole('img', { name: '上传失败' })).toBeVisible()
    await editor.press('ArrowLeft')
    await editor.press('Enter')
    const again = page.getByRole('dialog', { name: '再试.png上传失败' })
    await expect(again.getByRole('button', { name: '重试', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(again.getByRole('button', { name: '移除', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(editor.getByText('再试.png', { exact: true })).toHaveCount(0)
    await expect(editor).toBeFocused()
    await expect(dialog).toBeVisible()
  })
}

test('悬停预览卡在弹窗里能点「放大」；首页输入框的预览卡照旧', async ({ page }) => {
  await page.setViewportSize({ width: 1335, height: 880 })
  const png = await canvasPng(page, { fill: '#8a5a3c', label: '皮革' })
  const { dialog, editor } = await openFrameEditor(page)
  await expect(dialog.getByRole('button', { name: '添加参考图', exact: true })).toBeEnabled()
  await serveMockOss(page, png)
  const card = dialog.getByRole('button', { name: '添加参考图', exact: true })
  await card.dispatchEvent('drop', { dataTransfer: await fileDrag(page, png, ['皮革纹理.png']) })
  const chip = editor.getByText('皮革纹理.png', { exact: true })
  // 只有 chip 也能提交：传完按钮就亮。
  await expect(dialog.getByRole('button', { name: '生成图片' })).toBeEnabled()
  await chip.hover()
  const tip = dialog.getByRole('tooltip')
  await expect(tip.getByRole('button', { name: '放大', exact: true })).toBeVisible()
  await tip.getByRole('button', { name: '放大', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '皮革纹理.png' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: '皮革纹理.png' })).toBeHidden()
  await expect(dialog).toBeVisible()

  // 首页对照：同一套 chip 与预览卡，挂载点换了，外观与行为不变。
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await page.goto('/')
  await login(page)
  const home = page.getByRole('textbox', { name: '输入消息', exact: true })
  await home.click()
  await page.keyboard.insertText('参考这张')
  await home.dispatchEvent('drop', { dataTransfer: await fileDrag(page, png, ['皮革纹理.png']) })
  const homeChip = home.getByText('皮革纹理.png', { exact: true })
  await expect(page.getByRole('button', { name: '发送' })).toBeEnabled()
  await homeChip.hover()
  await expect(page.getByRole('tooltip').getByRole('button', { name: '放大' })).toBeVisible()
})
