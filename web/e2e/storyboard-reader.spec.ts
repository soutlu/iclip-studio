/// <reference lib="dom" />

import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  canvasPng,
  openConversation,
  openStoryboardShot,
  readVideoShots,
  screenshotBothThemes,
  type VideoShot,
} from './helpers'

const openStoryboard = (page: Page, mobile = false) =>
  openConversation(page, '夜景延时素材生成', { mobile })

const readDocument = (page: Page) => readVideoShots(page, '读取工作区失败')

const rawGroupPrompt = (shot: VideoShot) => {
  const lines = shot.prompt.timeline.map(
    (item) => `${item.timestamps[0]}–${item.timestamps[1]}秒 ${item.prompt}`,
  )
  return `${shot.prompt.global_settings}\n\n镜头：\n${lines.join('\n')}\n不要生成字幕，不要生成背景音乐。`
}
const watchGenerationPosts = (page: Page) => {
  const posts: string[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname.startsWith('/api/generations/')
    ) {
      posts.push(request.url())
    }
  })
  return posts
}

test('分镜可以键盘切组、切帧和查看成片，浏览操作不写文件或提交生成', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 700 })
  const writes: string[] = []
  page.on('request', (request) => {
    if (
      request.method() !== 'GET' &&
      /\/api\/(?:generations|conversations\/[^/]+\/workspace\/file)/.test(request.url())
    ) {
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
    }
  })
  const panel = await openStoryboard(page)
  const switcher = panel.getByRole('button', { name: /展开镜头组列表/ })
  await switcher.focus()
  await page.keyboard.press('ArrowDown')
  await expect(switcher).toHaveAccessibleName(/^镜头组 2 \/ 3/)
  await expect(page).toHaveURL(/shot=2/)

  const group = panel.getByRole('region', { name: '镜头组 2', exact: true })
  const scene = group.getByRole('group', { name: '镜头 2', exact: true })
  await scene.getByRole('button', { name: '镜头 2', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(scene).toHaveAttribute('aria-current', 'true')
  await expect(group.getByRole('img', { name: '镜头组 2 第 2 帧' })).toBeVisible()
  await group.getByRole('button', { name: '下一帧', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/frame=3/)
  await expect(group.getByRole('img', { name: '镜头组 2 第 3 帧' })).toBeInViewport({ ratio: 1 })
  await expect(scene).toBeInViewport()
  await expect(group.getByRole('textbox', { name: '镜头 2 的描述' })).toContainText('低头看一眼包')
  await expect(group.getByRole('button', { name: /^生成第 \d+ 组$/ })).toHaveCount(0)
  await expect(group.getByRole('button', { name: '编辑图片', exact: true })).toHaveCount(1)

  // 第 2 组的成片常驻在文案列底部：在途、失败、成功各一张。
  const takes = group.getByRole('region', { name: '本组成片', exact: true })
  await expect(takes.getByRole('listitem')).toHaveCount(3)
  await expect(takes).toBeInViewport({ ratio: 1 })
  await expect(group.getByRole('img', { name: '镜头组 2 第 3 帧' })).toBeVisible()
  expect(writes).toEqual([])
})

for (const width of [1335, 390]) {
  test(`分镜 ${width}px：整组原文、帧图与镜头组列表可读，关闭后恢复选择与焦点`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 880 })
    const panel = await openStoryboard(page, width === 390)
    await openStoryboardShot(panel, 2)
    const group = panel.getByRole('region', { name: '镜头组 2', exact: true })
    await group.getByRole('button', { name: '镜头 2', exact: true }).click()
    await group.getByRole('button', { name: '下一帧', exact: true }).click()
    const frame = group.getByRole('img', { name: '镜头组 2 第 3 帧' })
    await expect(frame).toBeInViewport({ ratio: 1 })
    await screenshotBothThemes(page, `../.artifacts/design-qa/storyboard-reader/main-${width}`)

    // 镜头组列表挂在 body 上，盖过舞台与文案列，整个列表都在视口里。这一段只用鼠标：
    // 之前按过键时 Chrome 会让脚本移过去的焦点也显示焦点环，截图就不是鼠标用户看到的样子。
    const pill = panel.getByRole('button', { name: /展开镜头组列表/ })
    await pill.click()
    const list = page.getByRole('menu', { name: '镜头组列表', exact: true })
    await expect(list.getByRole('menuitemradio')).toHaveCount(3)
    const current = list.getByRole('menuitemradio', { name: /^第 2 组/ })
    await expect(current).toHaveAttribute('aria-checked', 'true')
    await expect(current).toBeFocused()
    await expect(list).toBeInViewport({ ratio: 1 })
    const qa = `../.artifacts/design-qa/shot-group-dropdown`
    await screenshotBothThemes(page, `${qa}/open-${width}`)
    const third = list.getByRole('menuitemradio', { name: /^第 3 组/ })
    await third.hover()
    await page.screenshot({ animations: 'disabled', path: `${qa}/hover-${width}.png` })
    await page.keyboard.press('Escape')
    await expect(list).toBeHidden()
    await expect(pill).toBeFocused()
    await expect(page).toHaveURL(/shot=2/)

    // 整组原文就排在文案列里：全局设定打头，各镜头标出时长与区间。
    const settings = group.getByRole('textbox', { name: '全局设定', exact: true })
    await expect(settings).toContainText('参考锁定：模特的服装与发型跟住')
    await expect(settings.getByRole('button', { name: '查看第 1 帧', exact: true })).toBeVisible()
    await expect(group.getByRole('group', { name: '镜头 1', exact: true })).toContainText(
      '4.0s，0.0s – 4.0s',
    )
    await expect(group.getByRole('group', { name: '镜头 2', exact: true })).toContainText(
      '7.0s，4.0s – 11.0s',
    )
    await expect(panel.getByRole('button', { name: '复制完整提示词' })).toBeInViewport({
      ratio: 1,
    })

    const open = group.getByRole('button', { name: '打开原图', exact: true })
    await open.focus()
    await page.keyboard.press('Enter')
    const preview = page.getByRole('dialog', { name: '镜头组 2 第 3 帧', exact: true })
    await expect(preview).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(preview).toBeHidden()
    await expect(open).toBeFocused()
    const search = new URL(page.url()).searchParams
    expect(search.get('shot')).toBe('2')
    expect(search.get('frame')).toBe('3')

    // 键盘展开：焦点落在当前组，方向键移到下一组，Enter 切过去、列表收起、焦点回到组号。
    await pill.focus()
    await page.keyboard.press('Enter')
    await expect(current).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(third).toBeFocused()
    await page.screenshot({ animations: 'disabled', path: `${qa}/keyboard-${width}.png` })
    await page.keyboard.press('Enter')
    await expect(list).toBeHidden()
    await expect(pill).toBeFocused()
    await expect(panel.getByRole('region', { name: '镜头组 3', exact: true })).toBeInViewport()
    await expect(page).toHaveURL(/shot=3/)
  })
}

test('agent 更新工作区后重读结构化正文，保留当前组和帧', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const panel = await openStoryboard(page)
  await openStoryboardShot(panel, 2)
  const group = panel.getByRole('region', { name: '镜头组 2', exact: true })
  await group.getByRole('button', { name: '镜头 2', exact: true }).click()
  await group.getByRole('button', { name: '下一帧', exact: true }).click()
  await expect(group.getByRole('textbox', { name: '镜头 2 的描述' })).toContainText(
    '台词并成一句',
    {
      timeout: 20_000,
    },
  )
  await expect(group.getByRole('img', { name: '镜头组 2 第 3 帧' })).toBeVisible()
  await expect(page).toHaveURL(/shot=2/)
  await expect(page).toHaveURL(/frame=3/)
})

test('编辑一镜后保存并读回，复制整组保留 raw 图片标记与空白', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  const generationPosts = watchGenerationPosts(page)
  const panel = await openStoryboard(page)
  await openStoryboardShot(panel, 2)
  const group = panel.getByRole('region', { name: '镜头组 2', exact: true })
  await group.getByRole('button', { name: '镜头 2', exact: true }).click()
  await expect(group.getByRole('textbox', { name: '镜头 2 的描述' })).toContainText(
    '台词并成一句',
    {
      timeout: 20_000,
    },
  )
  const before = await readDocument(page)
  const expected = structuredClone(before.document)
  const secondGroup = expected.shots[1]
  const firstScene = secondGroup?.prompt.timeline[0]
  if (secondGroup === undefined || firstScene === undefined) throw new Error('缺少第二组第一镜')
  const changed = '她从长椅间走向镜头 @Image01，脚步放慢。\n  镜头缓慢推进。  '
  firstScene.prompt = changed
  firstScene.image_indexes = [1]
  await group.getByRole('button', { name: '镜头 1', exact: true }).click()
  await group.getByRole('textbox', { name: '镜头 1 的描述' }).fill(changed)

  await expect.poll(async () => (await readDocument(page)).document).toEqual(expected)
  expect((await readDocument(page)).version).toBeGreaterThan(before.version)
  await expect(panel.getByText('已保存', { exact: true })).toBeVisible()
  await group.getByRole('button', { name: '复制镜头 1', exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(changed)

  await panel.getByRole('button', { name: '复制完整提示词', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(rawGroupPrompt(secondGroup))
  expect(generationPosts).toEqual([])
})

test('无图分镜上传首图后关联到另一镜，替换共享图片只改变同一 URL 槽位', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const generationPosts = watchGenerationPosts(page)
  const uploadRequests: string[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/api\/uploads\/(?:sign|[^/]+\/confirm)$/.test(new URL(request.url()).pathname)
    ) {
      uploadRequests.push(new URL(request.url()).pathname)
    }
  })
  const panel = await openConversation(page, '无图分镜草稿')
  const group = panel.getByRole('region', { name: '镜头组 1', exact: true })
  const initial = await readDocument(page)
  expect(initial.document.shots[0]?.image_urls).toEqual([])
  await group.getByRole('button', { name: '镜头 1', exact: true }).click()
  await expect(group.getByRole('textbox', { name: '镜头 1 的描述' })).toContainText('展示正面')
  await page.screenshot({
    animations: 'disabled',
    path: '../.artifacts/design-qa/storyboard-reader/no-images-desktop.png',
  })
  // 添加图片的入口在正文里：敲 @，点选图弹层末格的「+」。
  const openAddImage = async (scene: string) => {
    const editor = group.getByRole('textbox', { name: `${scene} 的描述`, exact: true })
    await editor.click()
    await page.keyboard.press('End')
    await page.keyboard.type('@')
    await page
      .getByRole('listbox', { name: '插入参考图', exact: true })
      .getByRole('option', { name: '添加图片', exact: true })
      .click()
  }
  await expect(group.getByRole('button', { name: '添加图片', exact: true })).toHaveCount(0)
  await openAddImage('镜头 1')
  const picker = page.getByRole('dialog', { name: '添加图片', exact: true })
  await picker.getByLabel('选择要上传的图片', { exact: true }).setInputFiles({
    buffer: await canvasPng(page, { fill: '#23503e' }),
    mimeType: 'image/png',
    name: '第一张图.png',
  })
  await expect(picker).toBeHidden()
  await expect
    .poll(async () => (await readDocument(page)).document.shots[0]?.image_urls.length)
    .toBe(1)
  const uploaded = await readDocument(page)
  const uploadedShot = uploaded.document.shots[0]
  if (uploadedShot === undefined) throw new Error('缺少上传后的镜头组')
  const firstUrl = uploadedShot.image_urls[0]
  expect(firstUrl).toMatch(/^http:\/\/localhost\/mock-oss\//)
  expect(uploadedShot.prompt.timeline[0]?.image_indexes).toEqual([1])
  expect(uploadedShot.prompt.timeline[0]?.prompt).toContain('@Image1')
  expect(uploadedShot.prompt.timeline[1]).toEqual(initial.document.shots[0]?.prompt.timeline[1])
  expect(uploadRequests.filter((path) => path === '/api/uploads/sign')).toHaveLength(1)
  expect(uploadRequests.filter((path) => path.endsWith('/confirm'))).toHaveLength(1)

  await group.getByRole('button', { name: '镜头 2', exact: true }).click()
  await openAddImage('镜头 2')
  await picker.getByRole('button', { name: '关联第 1 张图片', exact: true }).click()
  await expect(picker).toBeHidden()
  await expect
    .poll(
      async () => (await readDocument(page)).document.shots[0]?.prompt.timeline[1]?.image_indexes,
    )
    .toEqual([1])
  const shared = await readDocument(page)
  const sharedShot = shared.document.shots[0]
  if (sharedShot === undefined) throw new Error('缺少共享图片后的镜头组')
  expect(sharedShot.image_urls).toEqual([firstUrl])
  expect(sharedShot.prompt.timeline[0]).toEqual(uploadedShot.prompt.timeline[0])
  expect(sharedShot.prompt.timeline[1]?.prompt).toContain('@Image1')

  await group.getByLabel('选择替换图片', { exact: true }).setInputFiles({
    buffer: await canvasPng(page, { fill: '#be6838' }),
    mimeType: 'image/png',
    name: '替换共享图.png',
  })
  await expect
    .poll(async () => (await readDocument(page)).document.shots[0]?.image_urls[0])
    .not.toBe(firstUrl)
  const replaced = await readDocument(page)
  const replacementUrl = replaced.document.shots[0]?.image_urls[0]
  expect(replacementUrl).toMatch(/^http:\/\/localhost\/mock-oss\//)
  expect(replaced.document).toEqual({
    ...shared.document,
    shots: [{ ...sharedShot, image_urls: [replacementUrl] }],
  })
  await expect(group.getByRole('img', { name: '镜头组 1 第 1 帧' })).toHaveAttribute(
    'src',
    replacementUrl ?? '',
  )
  await group.getByRole('button', { name: '镜头 1', exact: true }).click()
  await expect(group.getByRole('img', { name: '镜头组 1 第 1 帧' })).toHaveAttribute(
    'src',
    replacementUrl ?? '',
  )
  await expect(group.getByRole('img', { name: '镜头组 1 第 1 帧' })).toHaveJSProperty(
    'naturalWidth',
    600,
  )
  await page.screenshot({
    animations: 'disabled',
    path: '../.artifacts/design-qa/storyboard-reader/first-image-shared-replaced-desktop.png',
  })
  expect(generationPosts).toEqual([])
})

test('翻到第 3 组出片：请求取当前组，成片区先出在途卡、出片后变成可播', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const panel = await openStoryboard(page)
  await openStoryboardShot(panel, 3)
  const group = panel.getByRole('region', { name: '镜头组 3', exact: true })
  await group.getByRole('button', { name: '镜头 1', exact: true }).click()
  await expect(group.getByRole('textbox', { name: '镜头 1 的描述' })).toContainText('低角度拍鞋面')
  const before = await readDocument(page)
  const third = before.document.shots[2]
  if (third === undefined) throw new Error('需要第三组')

  const posted = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/generations/video',
  )
  await panel.getByRole('button', { name: '生成第 3 组', exact: true }).click()
  const request = await posted
  expect(request.postDataJSON()).toMatchObject({ shot_index: 3, shot: third.prompt })

  // 新的一张排在最前，先是在途卡；mock 三秒后出片，推送帧到了就刷新。
  const takes = group.getByRole('region', { name: '本组成片', exact: true })
  await expect(takes.getByRole('listitem')).toHaveCount(2)
  const newest = takes.getByRole('listitem').first()
  await expect(newest.getByRole('button', { name: /生成中$/ })).toBeVisible()
  await expect(newest.getByRole('button', { name: /的成片$/ })).toBeVisible({ timeout: 15_000 })
  await expect(takes.getByRole('button', { name: /生成中$/ })).toHaveCount(0)
  await expect(takes.getByRole('button', { name: /的成片$/ })).toHaveCount(2)
})

test('舞台上的编辑图片打开编辑器，关闭后焦点回到入口', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const panel = await openStoryboard(page)
  const group = panel.getByRole('region', { name: '镜头组 1', exact: true })
  await group.getByRole('img', { name: '镜头组 1 第 1 帧' }).hover()
  const entry = group.getByRole('button', { name: '编辑图片', exact: true })
  await entry.click()
  const editor = page.getByRole('dialog', { name: /^编辑图片/ })
  await expect(editor).toBeVisible()
  await expect(editor).toHaveAccessibleName('编辑图片 镜头组 1 · 帧 @1')
  await expect(editor.getByLabel('图片模型', { exact: true })).toBeVisible()
  // 这一帧还没编辑过，只有当前帧一张：没得切，版本条不显示。
  await expect(editor.getByRole('group', { name: '该帧的图片', exact: true })).toHaveCount(0)
  await page.screenshot({
    animations: 'disabled',
    path: '../.artifacts/design-qa/storyboard-reader/image-edit-entry-desktop.png',
  })
  await editor.getByRole('button', { name: '关闭图片编辑', exact: true }).click()
  await expect(editor).toBeHidden()
  await expect(entry).toBeFocused()
})

/** 页面里直传对象存储的闸门（上传走 XHR，MSW 的 service worker 先于 Playwright 路由收下它，只能在页面里拦）。 */
type StorageGate = {
  __storageHold?: Promise<void>
  __storageRelease?: () => void
  __storageFailures?: number
}

/** hold 让之后的直传停在半路直到 release；failNext 让下一次直传断网失败。须在打开页面之前装上。 */
const installStorageGate = async (page: Page) => {
  await page.addInitScript(() => {
    const gate = window as unknown as StorageGate
    class GatedRequest extends XMLHttpRequest {
      private storagePut = false

      override open(method: string, url: string | URL) {
        this.storagePut = method === 'PUT' && String(url).includes('/mock-oss/')
        super.open(method, url)
      }

      override send(body?: Document | XMLHttpRequestBodyInit | null) {
        if (!this.storagePut) {
          super.send(body)
          return
        }
        if ((gate.__storageFailures ?? 0) > 0) {
          gate.__storageFailures = (gate.__storageFailures ?? 0) - 1
          super.send(body)
          // 中断即断网：loadend 到时拿不到状态码。
          this.abort()
          return
        }
        const hold = gate.__storageHold
        if (hold === undefined) super.send(body)
        else void hold.then(() => super.send(body))
      }
    }
    window.XMLHttpRequest = GatedRequest
  })
  return {
    hold: () =>
      page.evaluate(() => {
        const gate = window as unknown as StorageGate
        gate.__storageHold = new Promise<void>((resolve) => {
          gate.__storageRelease = resolve
        })
      }),
    release: () =>
      page.evaluate(() => {
        const gate = window as unknown as StorageGate
        gate.__storageRelease?.()
        delete gate.__storageHold
      }),
    failNext: () =>
      page.evaluate(() => {
        ;(window as unknown as StorageGate).__storageFailures = 1
      }),
  }
}

/** 本机图片文件的 DataTransfer：字节由页面里的 Canvas 画出来。 */
const imageTransfer = (page: Page, png: Buffer, name: string) =>
  page.evaluateHandle(
    ([bytes, fileName]) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([new Uint8Array(bytes)], fileName, { type: 'image/png' }))
      return transfer
    },
    [Array.from(png), name] as const,
  )

/** 把一张图当剪贴板内容粘进正文：走浏览器真实的 paste 事件。 */
const pasteImage = async (editor: Locator, png: Buffer, name: string) => {
  const transfer = await imageTransfer(editor.page(), png, name)
  await editor.evaluate((element, clipboardData) => {
    element.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }),
    )
  }, transfer)
  await transfer.dispose()
}

for (const width of [1335, 390] as const) {
  test(`正文收图片（${width}）：粘贴落成上传中的 chip，传好换成 @N 写进本组；失败在 chip 上重试；拖到段卡上接到末尾；@ 菜单照常`, async ({
    page,
  }) => {
    const mobile = width === 390
    await page.setViewportSize({ width, height: mobile ? 844 : 900 })
    const gate = await installStorageGate(page)
    const panel = await openConversation(page, '无图分镜草稿', { mobile })
    const group = panel.getByRole('region', { name: '镜头组 1', exact: true })
    const qa = `../.artifacts/design-qa/shot-script-composer/${width}`
    const png = await canvasPng(page, { fill: '#dfe8dd', label: 'Pasted' })
    const editor = group.getByRole('textbox', { name: '镜头 1 的描述', exact: true })
    await editor.click()
    await page.keyboard.press('End')

    // 粘贴：光标处出现上传中的 chip，正文还没变。
    await gate.hold()
    await pasteImage(editor, png, '粘贴.png')
    await expect(editor.getByRole('progressbar', { name: '上传中' })).toBeVisible()
    await screenshotBothThemes(page, `${qa}-uploading`)
    await gate.release()
    // 传好：chip 换成 @1，地址与引用一起写进本组。
    await expect(editor.getByRole('button', { name: '查看第 1 帧', exact: true })).toBeVisible()
    await expect(editor.getByText('粘贴.png')).toHaveCount(0)
    await expect
      .poll(async () => (await readDocument(page)).document.shots[0]?.prompt.timeline[0])
      .toEqual({
        timestamps: [0, 3.2],
        prompt: '开场，中景，模特双手托起帆布包，展示正面。@Image1',
        image_indexes: [1],
      })
    await screenshotBothThemes(page, `${qa}-landed`)

    // 失败：chip 标红，点开失败卡片重试，用原文件再传一次。
    await gate.failNext()
    await pasteImage(editor, png, '断网.png')
    await expect(editor.getByRole('img', { name: '上传失败' })).toBeVisible()
    await editor.getByText('断网.png').click()
    const card = page.getByRole('dialog', { name: '断网.png上传失败' })
    await expect(card).toBeVisible()
    await screenshotBothThemes(page, `${qa}-failed`)
    await card.getByRole('button', { name: '重试' }).click()
    await expect(editor.getByRole('button', { name: '查看第 2 帧', exact: true })).toBeVisible()
    await expect
      .poll(async () => (await readDocument(page)).document.shots[0]?.image_urls.length)
      .toBe(2)

    // 拖到另一段的标题上：只亮这张段卡，聊天输入框不接；落下接到那段末尾。
    const second = group.getByRole('group', { name: '镜头 2', exact: true })
    const heading = second.getByRole('button', { name: '镜头 2', exact: true })
    await heading.scrollIntoViewIfNeeded()
    const dropped = await imageTransfer(page, png, '拖入.png')
    await heading.dispatchEvent('dragenter', { dataTransfer: dropped })
    await expect(second.getByText('松开可添加到镜头 2')).toBeVisible()
    await expect(page.getByTestId('composer-drop-overlay')).toHaveCount(0)
    await screenshotBothThemes(page, `${qa}-drop`)
    await heading.dispatchEvent('drop', { dataTransfer: dropped })
    await dropped.dispose()
    await expect(second.getByText('松开可添加到镜头 2')).toHaveCount(0)
    await expect(second.getByRole('button', { name: '查看第 3 帧', exact: true })).toBeVisible()
    await expect
      .poll(async () => (await readDocument(page)).document.shots[0]?.prompt.timeline[1])
      .toEqual({
        timestamps: [3.2, 8],
        prompt: '硬切，特写，模特转动帆布包，展示侧面与提手。@Image3',
        image_indexes: [3],
      })

    // @ 菜单照常：列本组三张图与「+」，Enter 插入第一张。点在段首，别点到 @N 芯片上（芯片自己接点击）。
    await editor.click({ position: { x: 2, y: 2 } })
    await page.keyboard.type('@')
    const menu = page.getByRole('listbox', { name: '插入参考图', exact: true })
    await expect(menu.getByRole('option')).toHaveCount(4)
    await screenshotBothThemes(page, `${qa}-mention`)
    await page.keyboard.press('Enter')
    await expect(menu).toBeHidden()
    await expect
      .poll(async () => (await readDocument(page)).document.shots[0]?.prompt.timeline[0]?.prompt)
      .toBe('@Image1开场，中景，模特双手托起帆布包，展示正面。@Image1@Image2')
  })
}
