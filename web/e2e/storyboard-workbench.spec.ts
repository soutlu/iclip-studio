/// <reference lib="dom" />

import { expect, test } from '@playwright/test'
import { canvasPng, openConversation, openStoryboardShot } from './helpers'

// 视口需容纳 264px 侧栏、400px 聊天和 560px 面板。
test.use({ viewport: { height: 900, width: 1600 } })

test('短桌面中舞台贴着画面在左、文案列在右，画面完整可见；箭头叠在画面上切帧，到头隐藏、不开原图', async ({
  page,
}) => {
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
  // 舞台列宽跟着画面走：画面左贴主体内距、右边到文案列只隔「间距 + 分隔线 + 间距」，两侧不留边，剩下的宽度都归文案列。
  expect(previewBox.x - groupBox.x).toBeLessThanOrEqual(16 + 1)
  expect(scriptBox.x - (previewBox.x + previewBox.width)).toBeLessThanOrEqual(24 + 1 + 24 + 1)
  // 舞台下面不再有操作行：竖版画面撑满舞台高，舞台一直延伸到出片栏，中间不空出成块空白。
  expect(barBox.y - (previewBox.y + previewBox.height)).toBeLessThanOrEqual(16)
  // 编辑、替换叠在画面右上：点它们只开自己的入口，不开原图。
  const editBox = await group.getByRole('button', { name: '编辑图片', exact: true }).boundingBox()
  if (editBox === null) throw new Error('舞台工具条必须有可见布局')
  expect(editBox.y).toBeGreaterThanOrEqual(previewBox.y)
  expect(editBox.x + editBox.width).toBeLessThanOrEqual(previewBox.x + previewBox.width)

  // 鼠标：悬停画面露出箭头，点箭头只切帧、不开原图；到头的一侧箭头不出现。
  const next = group.getByRole('button', { name: '下一帧', exact: true })
  const previous = group.getByRole('button', { name: '上一帧', exact: true })
  await expect(previous).toHaveCount(0)
  await preview.hover()
  await next.click()
  await expect(group.getByRole('img', { name: '镜头组 2 第 3 帧' })).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(next).toHaveCount(0)
  await expect(previous).toBeVisible()

  await scene.getByRole('button', { name: '看第 2 帧' }).focus()
  await page.keyboard.press('Enter')
  await expect(preview).toBeVisible()
  await expect(previous).toHaveCount(0)

  // 键盘：Enter 切到末帧，这一侧箭头随即消失，焦点落回画面，不掉回页面开头。
  await next.focus()
  await page.keyboard.press('Enter')
  await expect(group.getByRole('img', { name: '镜头组 2 第 3 帧' })).toBeInViewport({ ratio: 1 })
  await expect(next).toHaveCount(0)
  const open = group.getByRole('button', { name: '打开原图', exact: true })
  await expect(open).toBeFocused()

  // 焦点在舞台里时 ←/→ 也切帧，到头不动，焦点一直留在舞台里。
  await page.keyboard.press('ArrowLeft')
  await expect(preview).toBeInViewport({ ratio: 1 })
  await expect(page).toHaveURL(/frame=2/)
  await expect(open).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(page).toHaveURL(/frame=2/)
  await page.keyboard.press('ArrowRight')
  await expect(group.getByRole('img', { name: '镜头组 2 第 3 帧' })).toBeInViewport({ ratio: 1 })
  await expect(open).toBeFocused()
})

for (const width of [1335, 390]) {
  test(`成片区 ${width}px：没出过片的组不占位；有片的组从新到旧排在文案列末尾、出血到工作台边缘`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 880 })
    const panel = await openConversation(page, '夜景延时素材生成', { mobile: width === 390 })
    const first = panel.getByRole('region', { name: '镜头组 1' })
    await expect(first.getByRole('textbox', { name: '全局设定' })).toBeVisible()
    await expect(first.getByRole('region', { name: '本组成片' })).toHaveCount(0)

    await openStoryboardShot(panel, 2)
    const group = panel.getByRole('region', { name: '镜头组 2' })
    const takes = group.getByRole('region', { name: '本组成片', exact: true })
    const cards = takes.getByRole('listitem')
    // 第 2 组的种子：在途（最新）、失败、成功（最早）。
    await expect(cards).toHaveCount(3)
    await expect(cards.nth(0).getByRole('button', { name: /生成中$/ })).toBeVisible()
    await expect(cards.nth(1).getByRole('button', { name: /生成失败$/ })).toBeVisible()
    await expect(cards.nth(2).getByRole('button', { name: /的成片$/ })).toBeVisible()

    const [groupBox, takesBox] = await Promise.all([group.boundingBox(), takes.boundingBox()])
    if (groupBox === null || takesBox === null) throw new Error('成片区必须有可见布局')
    // 右端抵掉主体内距、落在工作台边缘；上下排时左端也出血。
    expect(
      Math.abs(takesBox.x + takesBox.width - (groupBox.x + groupBox.width)),
    ).toBeLessThanOrEqual(1)
    if (width === 390) {
      expect(Math.abs(takesBox.x - groupBox.x)).toBeLessThanOrEqual(1)
      // 上下排：成片区排在正文之后，随主体滚到底才整块露出来。
      await group.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
      await expect(takes).toBeInViewport({ ratio: 1 })
      // 横滑到最旧那张再出一条片：新卡排到最前，行滚回开头让它露出来。
      const conversationId = new URL(page.url()).pathname.split('/').at(-1)
      const submit = async () => {
        const status = await page.evaluate(async (id) => {
          const response = await fetch('/api/generations/video', {
            body: JSON.stringify({
              aspect_ratio: '9:16',
              conversation_id: id,
              model: 'vendor-a-seedance-2-5',
              prompt: '再出一条',
              reference_image_urls: [],
              resolution: '720p',
              seconds: 6,
              shot_index: 2,
            }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
          })
          return response.status
        }, conversationId)
        expect(status).toBe(202)
      }
      await submit()
      await submit()
      await expect(cards).toHaveCount(5)
      const scroller = takes.getByRole('list').locator('..')
      await scroller.evaluate((element) => {
        element.scrollLeft = element.scrollWidth
      })
      await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
      await submit()
      await expect(cards).toHaveCount(6)
      await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBe(0)
    } else {
      // 左右排：成片区钉在列底，正文自己滚到底它也不动。
      await expect(takes).toBeInViewport({ ratio: 1 })
      await group
        .getByRole('region', { name: '分镜文案' })
        .evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
      await expect(takes).toBeInViewport({ ratio: 1 })
    }
  })
}

for (const width of [1335, 390]) {
  test(`成片播放 ${width}px：点卡片在舞台上用共享播放器播、不开灯箱，点文案回到帧，成片区和当前分镜不动`, async ({
    page,
  }) => {
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
    const takes = group.getByRole('region', { name: '本组成片', exact: true })
    await expect(takes.getByRole('listitem')).toHaveCount(3)
    // 卡上只挂封面，不挂 <video>。
    await expect(takes.locator('video')).toHaveCount(0)
    const card = takes.getByRole('button', { name: /的成片$/ })
    await expect(card).toHaveCount(1)
    await card.click()
    const player = group.getByRole('group', { name: '播放器：生成的视频', exact: true })
    await expect(player).toBeInViewport({ ratio: 1 })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(card).toBeFocused()
    await expect(card).toHaveAttribute('aria-pressed', 'true')
    const video = player.locator('video')
    // mock 的出片是一条 MP4 测试卡（见 testing/mocks/workspace.ts），舞台放的就是记录上那条地址；
    // dev 下地址没有 hash、带 ?no-inline 查询串，构建产物里有 hash、没查询串。
    await expect(video).toHaveAttribute('src', /\/sample-video(-[^/?]*)?\.mp4(\?.*)?$/)
    // 共享播放器：没有原生控件（也就没有全屏入口），进度条是自己的；点卡片即开始播，不循环。
    expect(await video.evaluate((el: HTMLVideoElement) => el.controls)).toBe(false)
    await expect(player.getByRole('slider', { name: '播放进度' })).toBeVisible()
    await expect(video).toHaveAttribute('autoplay', '')
    await expect(video).not.toHaveAttribute('loop')
    await expect(takes.locator('video')).toHaveCount(0)
    // 操作叠在舞台右上、完整可见，不在播放器里，与播放器底部的控件胶囊互不遮挡。
    for (const name of ['下载视频', '编辑视频', '回填提示词'])
      await expect(group.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 })
    await expect(player.getByRole('button', { name: '下载视频' })).toHaveCount(0)

    // 点文案回到帧：播放器卸载，舞台回到这一段的帧。
    await group.getByRole('button', { name: '镜头 2', exact: true }).click()
    await expect(video).toHaveCount(0)
    await expect(card).toHaveAttribute('aria-pressed', 'false')
    await expect(takes.getByRole('listitem')).toHaveCount(3)
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

    // 上下排：舞台在上，画面整张露出来；帧的操作叠在舞台右上，常显不靠悬停。舞台上没有添加入口。
    await expect(group.getByRole('img', { name: '镜头组 2 第 3 帧' })).toBeInViewport({
      ratio: 1,
    })
    await expect(group.getByRole('button', { name: '添加图片' })).toHaveCount(0)
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
test('从镜头组列表跳组：地址落在那一组，顶栏组号跟着变，帧号照样点得动', async ({ page }) => {
  const panel = await openConversation(page, '夜景延时素材生成')
  const switcher = panel.getByRole('button', { name: /展开镜头组列表/ })
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

test('替换按钮与拖到舞台上都换掉当前帧，保持当前帧并可继续编辑', async ({ page }) => {
  const panel = await openConversation(page, '夜景延时素材生成')
  await openStoryboardShot(panel, 2)
  const shot2 = panel.getByRole('region', { name: '镜头组 2' })

  // 点第二镜里的 @2，地址记下第 2 帧，替换与拖放都要留在这一帧。
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
  await expect(shot2.getByText('松开替换当前图片', { exact: true })).toBeVisible()
  await expect(page.getByTestId('composer-drop-overlay')).toBeHidden()
  await page.screenshot({ path: '../.artifacts/design-qa/storyboard-replace-drop.png' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({
    animations: 'disabled',
    path: '../.artifacts/design-qa/storyboard-replace-drop-dark.png',
  })
  await page.emulateMedia({ colorScheme: 'light' })
  await imageArea.dispatchEvent('drop', { dataTransfer })
  // 拖入是替换：还是第 2 帧，画面换成刚拖进来的图，不新增帧。
  await expect(preview).not.toHaveAttribute('src', uploadedUrl ?? '')
  await expect(preview).toHaveAttribute('src', /\/mock-oss\//)
  await expect(preview).toHaveJSProperty('naturalWidth', 600)
  await expect(page).toHaveURL(/frame=2/)
  await expect(panel.getByText('已保存')).toBeVisible({ timeout: 5_000 })
  await expect(page.getByText('拖入帧.png', { exact: true })).toBeHidden()
  await dataTransfer.dispose()

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
  // 正文可能折成多行，End 只到点击所在视觉行的行尾；用整段末尾的键把光标放到文末。
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
  await page.keyboard.type(' 与双肩包 @')
  await expect(editor).toHaveText(/台词并成一句。 与双肩包 @$/)
  const menu = page.getByRole('listbox', { name: '插入参考图' })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('option')).toHaveCount(4)
  const [caret, editorBox, menuBox] = await Promise.all([
    editor.evaluate(() => {
      const range = document.getSelection()?.getRangeAt(0)
      if (!range) throw new Error('编辑器没有光标')
      const rect = range.getBoundingClientRect()
      if (rect.height === 0) throw new Error('光标没有可测量的位置')
      return { bottom: rect.bottom }
    }),
    editor.boundingBox(),
    menu.boundingBox(),
  ])
  if (editorBox === null || menuBox === null) throw new Error('正文与弹层必须有可见布局')
  // 弹层整个落在光标所在行下面，不遮住正在打的字；光标在正文最后一行，弹层也就在正文下面。
  expect(menuBox.y).toBeGreaterThanOrEqual(caret.bottom - 1)
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
  await expect(script.getByRole('group', { name: '镜头 1', exact: true })).toContainText(
    '4.0s，0.0s – 4.0s',
  )
  await expect(script.getByRole('group', { name: '镜头 2', exact: true })).toContainText(
    '7.0s，4.0s – 11.0s',
  )
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
  await expect(group.getByRole('img', { name: '镜头组 2 第 3 帧' })).toBeInViewport()
})

test('没有工作区文件的对话仍是折叠空态', async ({ page }) => {
  await openConversation(page, '亚麻衬衫二剪')
  await expect(page).toHaveURL(/\/c\//)

  await expect(page.getByRole('button', { name: '展开工作台' })).toBeVisible()
  await expect(page.getByRole('tab', { name: '分镜' })).toBeHidden()
})
