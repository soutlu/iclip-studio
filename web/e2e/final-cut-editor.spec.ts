import { expect, test, type Locator, type Page, type Request } from '@playwright/test'
import {
  createFinalCut,
  finalCutPreviewPlayer,
  isMarkedFinalCutPreviewPlayer,
  markFinalCutPreviewPlayer,
  openConversation,
  openFinalCut,
  pauseMockResponses,
  releaseMockResponses,
  widenWorkbench,
} from './helpers'

/**
 * 写工程里文件 `path`（相对工程根）的请求里写的内容：新建工程文件（「新建 final-cut」建的主文件、拷进来的
 * 条目文件、字幕场景这些），或按版本写工作区文件；不是写这个文件的请求时是 null。
 */
const savedFileOf = (request: Request, path: string): string | null => {
  const url = request.url()
  const isCreate = request.method() === 'POST' && url.includes('/final-cut/files')
  const isWrite = request.method() === 'PUT' && url.includes('/workspace/file')
  if (!isCreate && !isWrite) return null
  const body = request.postDataJSON() as { path: string; content: string }
  return body.path === (isCreate ? path : `final-cut/${path}`) ? body.content : null
}

/** 保存工程主文件的请求里写的主文件；不是保存主文件的请求时是 null。 */
const savedHtmlOf = (request: Request): string | null => savedFileOf(request, 'index.html')

/** 存出来的主文件，没有时是空串。 */
const htmlOf = (request: Request) => savedHtmlOf(request) ?? ''

const mainSavedWith = (page: Page, check: (html: string) => boolean) =>
  page.waitForRequest((request) => {
    const html = savedHtmlOf(request)
    return html !== null && check(html)
  })

const mainSaved = (page: Page, clips: number) =>
  mainSavedWith(page, (html) => (html.match(/<video /g) ?? []).length === clips)

const readyPlayer = async (editor: Locator) => {
  const player = finalCutPreviewPlayer(editor)
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

/** 等预览里只有一个播放器（没有正在底下加载的新一份），而且画好了。 */
const settledPlayer = async (editor: Locator) => {
  await expect(
    editor
      .getByRole('region', { name: '预览' })
      .locator('iframe')
      .contentFrame()
      .locator('hyperframes-player'),
  ).toHaveCount(1)
  return readyPlayer(editor)
}

const RUNTIME_FILE = '/hyperframe.runtime.iife.js'

/** 播放器预览页里装的运行库脚本地址。 */
const runtimeScripts = (player: Locator) =>
  player.evaluate(
    (element: HTMLElement & { iframeElement: HTMLIFrameElement }, file) =>
      [
        ...(element.iframeElement.contentDocument?.querySelectorAll<HTMLScriptElement>(
          `script[src$="${file}"]`,
        ) ?? []),
      ].map((script) => script.src),
    RUNTIME_FILE,
  )

test('final-cut 编辑器：选镜头加入轨道、播放、撤销、导出下载，切走再切回 final-cut 还在', async ({
  page,
}) => {
  test.setTimeout(60_000)
  // 预览和悬停预览的运行库都从组件库加载，整个过程不访问外网 CDN
  const cdnRequests: string[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).host === 'cdn.jsdelivr.net') cdnRequests.push(request.url())
  })
  const runtimeRequested = () =>
    page.waitForRequest((request) => new URL(request.url()).pathname.endsWith(RUNTIME_FILE))
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  // 还没有工程：没有 final-cut 页签，「+」里新建按默认模版（竖版 1080×1920 的空工程）建主文件
  await expect(panel.getByRole('tab', { name: 'final-cut', exact: true })).toHaveCount(0)
  await expect(panel.getByRole('toolbar', { name: '剪辑工具' })).toHaveCount(0)
  const created = page.waitForRequest(
    (request) => savedHtmlOf(request) !== null && request.method() === 'POST',
  )
  const editor = await createFinalCut(panel)
  const template = htmlOf(await created)
  expect(template).toContain('data-no-timeline')
  expect(template).toContain('data-width="1080" data-height="1920"')
  expect(template).toMatch(/<script src="vendor\/npm\/gsap@[^"]+">/)
  expect(template).not.toContain('<video ')
  const toolbar = editor.getByRole('toolbar', { name: '剪辑工具' })
  const transport = editor.getByRole('group', { name: '播放控制' })
  await expect(editor.getByText('final-cut 暂无内容，加入内容后可在此预览')).toBeVisible()
  // 「导出」在工作台顶栏右边，不在编辑器里；编辑器是工作台的一个页签，排在「文件」前面，没有标题栏和关闭按钮
  const exportButton = panel.getByRole('button', { name: '导出', exact: true })
  await expect(exportButton).toBeVisible()
  await expect(editor.getByRole('button', { name: '导出', exact: true })).toHaveCount(0)
  // final-cut 是空的：「导出」置灰，点了只说明原因（aria-disabled 的按钮 Playwright 认作不可点，照样点一下）
  await expect(exportButton).toHaveAttribute('aria-disabled', 'true')
  await exportButton.click({ force: true })
  await expect(page.getByRole('tooltip')).toHaveText('final-cut 暂无内容，无法导出；请先加入内容')
  await expect(panel.getByRole('tablist', { name: '面板内容' }).getByRole('tab')).toHaveText([
    '分镜',
    'final-cut',
    '文件',
  ])
  await expect(panel.getByRole('tab', { name: 'final-cut' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(editor.getByRole('button', { name: /关闭/ })).toHaveCount(0)

  const materials = editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
  const first = mainSaved(page, 1)
  const previewRuntime = runtimeRequested()
  await materials.getByRole('button', { name: /^出片 A 镜头 1，/ }).click()
  await page.keyboard.press('Enter')
  // 加进来以后按新建时的版本写主文件：模板的根、画幅不变，视频的 src 直接写素材地址
  const html = htmlOf(await first)
  expect((await first).method()).toBe('PUT')
  expect((await first).postDataJSON()).toMatchObject({ expectedVersion: 1 })
  expect(html).toContain('data-no-timeline')
  expect(html).toContain('data-width="1080" data-height="1920"')
  expect(html).toMatch(/<video [^>]*src="[^"]*sample-video[^"]*"/)
  expect(html).not.toContain('data-var-src')

  // 请求一发出就查：CDN 取不到时预览画不出来，等不到下面的断言
  await previewRuntime
  expect(cdnRequests).toEqual([])
  const player = await readyPlayer(editor)
  // 预览在另一个来源（预览域名）下的预览页里，运行库从那里的组件库目录取
  const appOrigin = new URL(page.url()).origin
  const previewSrc = await editor
    .getByRole('region', { name: '预览' })
    .locator('iframe')
    .getAttribute('src')
  const previewOrigin = new URL(previewSrc ?? '').origin
  expect(previewOrigin).not.toBe(appOrigin)
  const libraryOf = (origin: string) =>
    new RegExp(`^${origin.replaceAll('.', '\\.')}/hyperframes/[^/]+/`)
  const scripts = await runtimeScripts(player)
  expect(scripts).not.toHaveLength(0)
  for (const src of scripts) expect(src).toMatch(libraryOf(previewOrigin))

  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '元素' }).click()
  const card = side.getByRole('list').getByRole('group', { name: /秒$/ }).first()
  const hoverRuntime = runtimeRequested()
  await card.hover()
  await hoverRuntime
  expect(cdnRequests).toEqual([])
  const hoverPlayer = card.locator('hyperframes-player')
  await expect(hoverPlayer).toHaveCount(1)
  await expect
    .poll(() =>
      hoverPlayer.evaluate((element: HTMLElement & { painted: boolean }) => element.painted),
    )
    .toBe(true)
  const hoverScripts = await runtimeScripts(hoverPlayer)
  expect(hoverScripts).not.toHaveLength(0)
  // 悬停预览放的是公共组件库里的组件，仍在应用页面里
  for (const src of hoverScripts) expect(src).toMatch(libraryOf(appOrigin))
  await page.mouse.move(0, 0)
  await expect(hoverPlayer).toHaveCount(0)

  const second = mainSaved(page, 2)
  await side.getByRole('tab', { name: '镜头' }).click()
  await materials.getByRole('button', { name: /^出片 A 镜头 3，/ }).click()
  await page.keyboard.press('Enter')
  await second
  await readyPlayer(editor)
  const total = await transport.locator('.wf-clock span').innerText()
  expect(total).not.toBe('/ 00:00.00')

  const playerTime = () =>
    player.evaluate((element: HTMLElement & { currentTime: number }) => element.currentTime)
  await transport.getByRole('button', { name: '播放', exact: true }).click()
  await expect(transport.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
  await expect.poll(playerTime).toBeGreaterThan(0.2)
  await transport.getByRole('button', { name: '暂停', exact: true }).click()

  // 点在预览画面上以后焦点仍在编辑器里（不进预览页）：空格照常播放、暂停
  await editor.getByRole('region', { name: '预览' }).click()
  await page.keyboard.press(' ')
  await expect(transport.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
  await page.keyboard.press(' ')
  await expect(transport.getByRole('button', { name: '播放', exact: true })).toBeVisible()

  await transport.getByRole('slider', { name: '播放进度' }).focus()
  await page.keyboard.press('Home')
  await expect(transport.locator('.wf-clock')).toContainText('00:00.00 /')
  await expect.poll(playerTime).toBeLessThan(0.1)

  // 缩放：滑杆往右拖片段变宽，读数从「适应」变成百分比；点「适应宽度」回去
  const clip = editor
    .getByRole('group', { name: '画面 1', exact: true })
    .locator('[data-clip-id]')
    .first()
  const widthOf = async () => (await clip.boundingBox())?.width ?? 0
  const fitted = await widthOf()
  const zoom = toolbar.getByRole('slider', { name: '时间线缩放' })
  await expect(zoom).toHaveAttribute('aria-valuetext', '适应')
  await zoom.focus()
  await page.keyboard.press('PageUp')
  await expect(zoom).toHaveAttribute('aria-valuetext', /^\d+%$/)
  expect((await widthOf()) / fitted).toBeGreaterThan(1.5)
  await page.keyboard.press('Home')
  await expect(zoom).toHaveAttribute('aria-valuetext', '10%')
  await toolbar.getByRole('button', { name: '适应宽度' }).click()
  await expect(zoom).toHaveAttribute('aria-valuetext', '适应')
  expect(Math.abs((await widthOf()) - fitted)).toBeLessThan(1)

  // 片段上一直画着画面，没有关掉缩略图的开关
  await expect(clip.locator('.wf-clip-frames')).toBeVisible()
  await expect(toolbar.getByRole('button', { name: /缩略图/ })).toHaveCount(0)

  const undone = mainSaved(page, 1)
  await toolbar.getByRole('button', { name: '撤销' }).click()
  await undone
  const redone = mainSaved(page, 2)
  await toolbar.getByRole('button', { name: '重做' }).click()
  await redone

  const exported = page.waitForResponse(
    (response) => response.url().includes('/whole-film/exports') && response.status() === 202,
  )
  await exportButton.click()
  const { exportId } = (await (await exported).json()) as { exportId: string }
  const tiers = page.waitForResponse(
    (response) => response.url().includes(`/generations/${exportId}/enhancements`),
    { timeout: 20_000 },
  )
  await expect(panel.getByRole('status').filter({ hasText: /排队中|正在渲染/ })).toBeVisible()
  const download = panel.getByRole('button', { name: '下载成片' })
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

  // 切到「分镜」页签再切回来：编辑器重新打开，工程和导出都还在
  await panel.getByRole('tab', { name: '分镜' }).click()
  await expect(editor).toBeHidden()
  const reopened = await openFinalCut(panel)
  await expect(panel.getByRole('button', { name: '下载成片' })).toBeVisible()
  const reopenedToolbar = reopened.getByRole('toolbar', { name: '剪辑工具' })
  await expect(
    reopened.getByRole('group', { name: '播放控制' }).locator('.wf-clock span'),
  ).toHaveText(total)
  await expect(reopenedToolbar.getByRole('button', { name: '撤销' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await readyPlayer(reopened)
  expect(cdnRequests).toEqual([])
})

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox()
  if (box === null) throw new Error('元素不在页面上')
  return box
}

type PlayerSettings = HTMLElement & {
  playbackRate: number
  muted: boolean
  loop: boolean
  currentTime: number
  iframeElement: HTMLIFrameElement
  /** 用例在页面里记下的、播放器报过的最小时刻 */
  lowestTime?: number
}

test('播放条：倍速和静音对素材、final-cut 都生效且换播放器后还在，循环播放、快捷键面板、全屏', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const transport = editor.getByRole('group', { name: '播放控制' })
  const materials = editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })

  // 素材预览：选 2×、按 M 静音
  await materials.getByRole('button', { name: /^出片 A 镜头 1，/ }).click()
  // 菜单打开时编辑器对读屏隐藏，按钮的位置先量好
  const rate = transport.getByRole('button', { name: '播放速度 1×' })
  const rateTop = (await boxOf(rate)).y
  await rate.click()
  const menu = page.getByRole('menu')
  const menuBox = await boxOf(menu)
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(rateTop)
  await menu.getByRole('menuitemradio', { name: '2×' }).click()
  await expect(transport.getByRole('button', { name: '播放速度 2×' })).toHaveText('2×')
  await page.keyboard.press('m')
  await expect(transport.getByRole('button', { name: '开启声音' })).toBeVisible()
  const material = editor.locator('video')
  expect(
    await material.evaluate((video: HTMLVideoElement) => [video.playbackRate, video.muted]),
  ).toEqual([2, true])

  // 加入轨道：final-cut 预览也是 2×、静音
  const first = mainSaved(page, 1)
  await materials.getByRole('button', { name: /^出片 A 镜头 1，/ }).focus()
  await page.keyboard.press('Enter')
  await first
  const player = await readyPlayer(editor)
  // 换播放器时新旧两个同时在，只看换完剩下的那一个
  const settings = () =>
    player.evaluateAll((elements) => {
      const [element] = elements as PlayerSettings[]
      if (elements.length !== 1 || element === undefined) return null
      return {
        rate: element.playbackRate,
        muted: element.muted,
        loop: element.loop,
        clips: element.iframeElement.contentDocument?.querySelectorAll('video[data-start]').length,
      }
    })
  await expect.poll(settings).toEqual({ rate: 2, muted: true, loop: false, clips: 1 })

  const loop = transport.getByRole('button', { name: '循环播放' })
  await loop.click()
  await expect(loop).toHaveAttribute('aria-pressed', 'true')

  // 再加一段（直接打进正在播的预览）：倍速、静音、循环都还在，加进来的片段也静音
  const second = mainSaved(page, 2)
  await materials.getByRole('button', { name: /^出片 A 镜头 3，/ }).click()
  await page.keyboard.press('Enter')
  await second
  await expect.poll(settings).toEqual({ rate: 2, muted: true, loop: true, clips: 2 })
  await readyPlayer(editor)
  await expect
    .poll(() =>
      player.evaluate((element: PlayerSettings) =>
        [...(element.iframeElement.contentDocument?.querySelectorAll('video') ?? [])].map(
          (video) => video.muted,
        ),
      ),
    )
    .toEqual([true, true])

  // 循环开着：从结尾前一点开始放，放到结尾回到开头接着放
  await transport.getByRole('slider', { name: '播放进度' }).focus()
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  // 2× 下一圈只要 1 秒，开头 0.5 秒只占四分之一；轮询间隔退到 1 秒后每次都落在一圈里差不多同一处，
  // 可能一直错过。所以在页面里记下播放器报过的最小时刻，轮询它
  await player.evaluate((element: PlayerSettings) => {
    element.lowestTime = Number.POSITIVE_INFINITY
    element.addEventListener('timeupdate', (event) => {
      const { currentTime } = (event as CustomEvent<{ currentTime: number }>).detail
      element.lowestTime = Math.min(element.lowestTime ?? currentTime, currentTime)
    })
  })
  await transport.getByRole('button', { name: '播放', exact: true }).click()
  await expect
    .poll(() => player.evaluate((element: PlayerSettings) => element.lowestTime))
    .toBeLessThan(0.5)
  await expect(transport.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
  await transport.getByRole('button', { name: '暂停', exact: true }).click()
  await page.keyboard.press('Shift+L')
  await expect(loop).toHaveAttribute('aria-pressed', 'false')

  // 快捷键面板向上打开
  const shortcuts = transport.getByRole('button', { name: '快捷键' })
  const shortcutsTop = (await boxOf(shortcuts)).y
  await shortcuts.click()
  const sheet = page.getByRole('dialog', { name: '快捷键' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText('开启或关闭循环播放')).toBeVisible()
  await expect(sheet.getByText('全屏或退出全屏')).toBeVisible()
  const sheetBox = await boxOf(sheet)
  expect(sheetBox.y + sheetBox.height).toBeLessThanOrEqual(shortcutsTop)
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()

  // 再按 M 恢复声音：final-cut 里的片段不再静音
  await page.keyboard.press('m')
  await expect(transport.getByRole('button', { name: '静音', exact: true })).toBeVisible()
  await expect
    .poll(() =>
      player.evaluate((element: PlayerSettings) =>
        [...(element.iframeElement.contentDocument?.querySelectorAll('video') ?? [])].map(
          (video) => video.muted,
        ),
      ),
    )
    .toEqual([false, false])

  // F 全屏：预览和播放条一起进全屏，倍速菜单在全屏里打得开；Esc 退出，编辑器还在、布局照旧
  const preview = editor.getByRole('region', { name: '预览' })
  const before = [await boxOf(preview), await boxOf(transport)]
  await page.keyboard.press('f')
  await expect(transport.getByRole('button', { name: '退出全屏' })).toBeVisible()
  const inFullscreen = (locator: Locator) =>
    locator.evaluate((element) => document.fullscreenElement?.contains(element) ?? false)
  expect(await inFullscreen(transport)).toBe(true)
  expect(await inFullscreen(preview)).toBe(true)
  await transport.getByRole('button', { name: '播放速度 2×' }).click()
  await expect(menu).toBeVisible()
  expect(await inFullscreen(menu)).toBe(true)
  await menu.getByRole('menuitemradio', { name: '1×' }).click()
  await page.keyboard.press('Escape')
  await expect(transport.getByRole('button', { name: '全屏', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull()
  await expect.poll(async () => [await boxOf(preview), await boxOf(transport)]).toEqual(before)
})

test('预览素材时在时间线上点选片段：素材预览收起，回到 final-cut 的预览、画面上能编辑', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const materials = editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
  const added = mainSaved(page, 1)
  await materials.getByRole('button', { name: /^出片 A 镜头 1，/ }).click()
  await page.keyboard.press('Enter')
  await added
  await readyPlayer(editor)

  const material = editor.getByRole('region', { name: /^素材 · / })
  await materials.getByRole('button', { name: /^出片 A 镜头 2，/ }).click()
  await expect(material).toBeVisible()
  await expect(editor.getByRole('group', { name: '预览画面' })).toHaveCount(0)

  const clip = editor
    .getByRole('group', { name: '画面 1', exact: true })
    .getByRole('button', { name: /^选中：/ })
  await clip.click()
  await expect(clip).toHaveAttribute('aria-pressed', 'true')
  await expect(material).toHaveCount(0)
  await expect(editor.getByRole('group', { name: '预览画面' })).toBeVisible()
})

/** 存下来的主文件里名字是 `title` 的组件或块的片段的属性；没有时是 null。 */
const savedItem = (html: string, title: string) => {
  const tag = [...html.matchAll(/<div [^>]*data-composition-src="[^"]*"[^>]*>/g)]
    .map(([found]) => found)
    .find((found) => found.includes(` data-label="${title}"`))
  if (tag === undefined) return null
  const attribute = (name: string) => new RegExp(` ${name}="([^"]*)"`).exec(tag)?.[1]
  return {
    id: attribute('id'),
    item: attribute('data-composition-id'),
    start: Number(attribute('data-start')),
    duration: Number(attribute('data-duration')),
    track: Number(attribute('data-track-index')),
    values: JSON.parse(
      (attribute('data-variable-values') ?? '{}').replaceAll('&quot;', '"'),
    ) as Record<string, unknown>,
  }
}

test('块页签搜到块点一下卡片加入、组件页签拖一个组件到时间线上，预览里画出来，撤销回去', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const first = mainSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^出片 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  const withVideo = htmlOf(await first)
  const videoSeconds = Number(/<video [^>]*data-duration="([^"]+)"/.exec(withVideo)?.[1])

  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await expect(side.getByRole('tab', { name: '镜头' })).toHaveAttribute('aria-selected', 'true')
  await side.getByRole('tab', { name: '模板' }).click()
  await side.getByRole('searchbox', { name: '搜索模板' }).fill('渐变')
  const cards = side.getByRole('list', { name: '模板' }).getByRole('group')
  await expect(cards).toHaveCount(1)
  const scene = cards.first()
  await expect(scene).toHaveAccessibleName('测试画面，6 秒')
  // 指针停在卡片上时封面右下角出「+」
  await scene.hover()
  await expect(scene.getByRole('button', { name: '加到播放头' })).toBeVisible()

  // 点一下卡片（不是「+」）就加入。播放头在 0：第一行这时有视频片段，块放进它下面新开的一行
  const added = mainSavedWith(page, (html) => savedItem(html, '测试画面') !== null)
  await scene.click()
  const placed = savedItem(htmlOf(await added), '测试画面')
  expect(placed).toMatchObject({ item: 'fixture-scene', start: 0, duration: 6, track: 1 })
  await expect(
    editor
      .getByRole('group', { name: '画面 2', exact: true })
      .getByRole('group', { name: '测试画面，6.0 秒' }),
  ).toBeVisible()

  // 预览里画出了块，按原比例缩进画面、居中
  const player = await readyPlayer(editor)
  await expect
    .poll(() =>
      player.evaluate((element: HTMLElement & { iframeElement: HTMLIFrameElement }, id) => {
        const page = element.iframeElement.contentDocument
        const root = page?.getElementById('film')
        const host = page?.getElementById(id)
        if (!root || !host || host.querySelector('.fs-dot') === null) return null
        const width = Number(root.dataset['width'])
        const height = Number(root.dataset['height'])
        const scale = Math.min(width / 1920, height / 1080)
        const outer = root.getBoundingClientRect()
        const inner = host.getBoundingClientRect()
        const near = (actual: number, expected: number) => Math.abs(actual - expected) < 0.01
        return {
          width: near(inner.width / outer.width, (1920 * scale) / width),
          height: near(inner.height / outer.height, (1080 * scale) / height),
          centered: Math.abs(inner.top - outer.top - (outer.bottom - inner.bottom)) < 1,
        }
      }, placed?.id ?? ''),
    )
    .toEqual({ width: true, height: true, centered: true })

  // 拖一个组件到第一行视频片段后面的空处（离各个吸附点都远）：落在指针的位置
  await side.getByRole('tab', { name: '元素' }).click()
  const overlay = side
    .getByRole('list', { name: '元素' })
    .getByRole('group', { name: '测试叠加，4 秒' })
  const row = editor.getByRole('group', { name: '画面 1', exact: true })
  // 6 秒长、从 0 开始的那个片段量出每秒多少像素
  const sceneBox = await editor
    .getByRole('group', { name: '画面 2', exact: true })
    .locator('[data-clip-id]')
    .first()
    .boundingBox()
  const lane = await row.boundingBox()
  if (sceneBox === null || lane === null) throw new Error('时间线尚未布局')
  const target = videoSeconds + 2.5
  const dropX = sceneBox.x + (sceneBox.width / 6) * target
  const from = await overlay.boundingBox()
  if (from === null) throw new Error('卡片尚未布局')
  await page.mouse.move(from.x + from.width / 2, from.y + 10)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + 20, { steps: 3 })
  await page.mouse.move(dropX, lane.y + lane.height / 2, { steps: 8 })
  await expect(row.getByTestId('drop-ghost')).toBeVisible()
  const dropped = mainSavedWith(page, (html) => savedItem(html, '测试叠加') !== null)
  await page.mouse.up()
  const carried = savedItem(htmlOf(await dropped), '测试叠加')
  expect(carried).toMatchObject({ item: 'fixture-overlay', duration: 4, track: 0 })
  expect(Math.abs((carried?.start ?? 0) - target)).toBeLessThan(0.1)

  const undone = mainSavedWith(
    page,
    (html) => savedItem(html, '测试叠加') === null && savedItem(html, '测试画面') !== null,
  )
  await editor
    .getByRole('toolbar', { name: '剪辑工具' })
    .getByRole('button', { name: '撤销' })
    .click()
  await undone
})

test('属性：选中组件或块的片段自动切到「属性」，改文字可填项，存下来、预览里看得到；「时长」加 0.5 秒；取色板拖方块和色相条只在松手时写一次、拖到灰再拖回来色相还在；Esc 只关取色板，点空白处回到元素页签，撤销一步回去', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const inspector = editor.getByRole('tabpanel', { name: '属性' })
  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await expect(side.getByRole('tab', { name: '镜头' })).toHaveAttribute('aria-selected', 'true')
  await expect(inspector).toHaveCount(0)

  await side.getByRole('tab', { name: '元素' }).click()
  await side.getByRole('searchbox', { name: '搜索元素' }).fill('可填项')
  const card = side.getByRole('group', { name: '测试可填项，5 秒' })
  const added = mainSavedWith(page, (html) => savedItem(html, '测试可填项') !== null)
  await card.hover()
  await card.getByRole('button', { name: '加到播放头' }).click()
  const placed = savedItem(htmlOf(await added), '测试可填项')
  expect(placed).toMatchObject({ item: 'fixture-fields', start: 0, values: {} })

  const row = editor.getByRole('group', { name: '画面 1', exact: true })
  await row.getByRole('button', { name: /^选中：测试可填项，/ }).click()
  await expect(side.getByRole('tab', { name: '属性' })).toHaveAttribute('aria-selected', 'true')
  await expect(inspector.getByRole('heading', { name: '测试可填项' })).toBeVisible()
  await expect(inspector.getByRole('heading', { level: 4 })).toHaveText(['内容与样式'])
  const text = inspector.getByRole('textbox', { name: '文字' })
  await expect(text).toHaveValue('示例文字')

  // 分两下输入，中间停过提交的时间：预览换了一份，焦点还在框里。元素的字运行库只在加载时读，整份重新加载
  await readyPlayer(editor)
  await markFinalCutPreviewPlayer(editor)
  await text.fill('新的')
  await page.waitForTimeout(600)
  const renamed = mainSavedWith(
    page,
    (html) => savedItem(html, '测试可填项')?.values['text'] === '新的标题',
  )
  await text.pressSequentially('标题')
  await renamed
  await expect(text).toBeFocused()
  const player = await readyPlayer(editor)
  await expect
    .poll(() =>
      player.evaluate((element: HTMLElement & { iframeElement: HTMLIFrameElement }, id) => {
        const host = element.iframeElement.contentDocument?.getElementById(id)
        return host?.querySelector('.ff-text')?.textContent ?? null
      }, placed?.id ?? ''),
    )
    .toBe('新的标题')
  expect(await isMarkedFinalCutPreviewPlayer(editor)).toBe(false)

  const length = inspector.getByRole('textbox', { name: '时长' })
  await expect(length).toHaveValue('5.00')
  const longer = mainSavedWith(page, (html) => savedItem(html, '测试可填项')?.duration === 5.5)
  await inspector.getByRole('button', { name: '延长 0.5 秒' }).click()
  await longer
  await expect(length).toHaveValue('5.50')

  // 取色板：方块拖到灰色松手，再从右上按下，色相还是原来的蓝；再拖色相条。拖动中不写，松手各写一次
  const saves: string[] = []
  const rgbOf = (hex: string) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16))
  page.on('request', (request) => {
    const html = savedHtmlOf(request)
    const accent = html === null ? undefined : savedItem(html, '测试可填项')?.values['accent']
    if (typeof accent === 'string') saves.push(accent)
  })
  await inspector.getByRole('button', { name: '底色取色' }).click()
  const picker = page.getByRole('dialog', { name: '取色板' })
  const board = picker.getByRole('slider', { name: '饱和度与明度' })
  // 浮层弹出时有一下缩放：等它停下再量。浮层 176px 宽，方块高 76px
  await expect.poll(async () => Math.round((await picker.boundingBox())?.width ?? 0)).toBe(176)
  const square = await board.boundingBox()
  if (square === null) throw new Error('取色板尚未布局')
  expect(square.height).toBeCloseTo(76, 0)
  const swatchText = inspector.getByRole('textbox', { name: '底色' })
  await page.mouse.move(square.x + square.width - 2, square.y + 2)
  await page.mouse.down()
  await page.mouse.move(square.x + square.width / 2, square.y + square.height / 2, { steps: 4 })
  await page.mouse.move(square.x - 10, square.y + square.height / 2, { steps: 4 })
  await page.waitForTimeout(600)
  expect(saves).toEqual([])
  await expect(swatchText).not.toHaveValue('#2756ff')
  const greyed = mainSavedWith(page, (html) => {
    const accent = savedItem(html, '测试可填项')?.values['accent']
    return typeof accent === 'string' && new Set(rgbOf(accent)).size === 1
  })
  await page.mouse.up()
  await greyed
  const blued = mainSavedWith(page, (html) => {
    const accent = savedItem(html, '测试可填项')?.values['accent']
    if (typeof accent !== 'string') return false
    const [red = 0, green = 0, blue = 0] = rgbOf(accent)
    return blue > red + 100 && blue > green + 60
  })
  await page.mouse.move(square.x + square.width - 1, square.y + 1)
  await page.mouse.down()
  await page.mouse.up()
  await blued
  expect(saves).toHaveLength(2)
  const hue = picker.getByRole('slider', { name: '色相' })
  const bar = await hue.boundingBox()
  if (bar === null) throw new Error('色相条尚未布局')
  expect(bar.height).toBeCloseTo(7, 0)
  const beforeHue = await swatchText.inputValue()
  await page.mouse.move(bar.x + bar.width * 0.1, bar.y + bar.height / 2)
  await page.mouse.down()
  await page.mouse.move(bar.x + bar.width * 0.4, bar.y + bar.height / 2, { steps: 4 })
  await page.waitForTimeout(600)
  expect(saves).toHaveLength(2)
  const hued = mainSavedWith(page, (html) => {
    const accent = savedItem(html, '测试可填项')?.values['accent']
    return typeof accent === 'string' && accent !== beforeHue
  })
  await page.mouse.up()
  await hued
  expect(saves).toHaveLength(3)
  // Esc 只关上取色板，片段还选中着
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  await expect(row.getByRole('button', { name: /^选中：测试可填项，/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  // 缩小时间线让片段后面空出来，点空白处取消选中
  const toolbar = editor.getByRole('toolbar', { name: '剪辑工具' })
  await toolbar.getByRole('slider', { name: '时间线缩放' }).focus()
  await page.keyboard.press('Home')
  const lane = await row.boundingBox()
  if (lane === null) throw new Error('时间线尚未布局')
  await page.mouse.click(lane.x + lane.width - 6, lane.y + lane.height / 2)
  await expect(row.getByRole('button', { name: /^选中：测试可填项，/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await expect(side.getByRole('tab', { name: '元素' })).toHaveAttribute('aria-selected', 'true')
  await expect(side.getByRole('searchbox', { name: '搜索元素' })).toHaveValue('可填项')
  await expect(inspector).toHaveCount(0)

  // 撤销一步：回到拖色相条之前的颜色
  const undone = mainSavedWith(
    page,
    (html) => savedItem(html, '测试可填项')?.values['accent'] === saves[1],
  )
  await toolbar.getByRole('button', { name: '撤销' }).click()
  await undone
})

/** 存下来的主文件里的音频片段，写成「名字@行号 起点 时长」，按起点排。 */
const savedAudio = (html: string) =>
  [...html.matchAll(/<audio [^>]*>/g)]
    .map(([tag]) => {
      const attribute = (name: string) => new RegExp(` ${name}="([^"]*)"`).exec(tag)?.[1]
      return {
        label: attribute('data-label'),
        start: Number(attribute('data-start')),
        duration: Number(attribute('data-duration')),
        track: Number(attribute('data-track-index')),
      }
    })
    .toSorted((left, right) => left.start - right.start)

test('音频栏：试听只播一条，点一下没用过的一行加到播放头新开声音行、final-cut 变长，拖一条到声音行的空处，生成一条音乐，撤销回去', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const first = mainSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^出片 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  const withVideo = htmlOf(await first)
  const videoSeconds = Number(/<video [^>]*data-duration="([^"]+)"/.exec(withVideo)?.[1])
  const progress = editor
    .getByRole('group', { name: '播放控制' })
    .getByRole('slider', { name: '播放进度' })
  await expect(progress).toHaveAttribute('aria-valuetext', /^00:00\.00 \/ 00:0\d\.\d\d$/)

  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '配乐' }).click()
  const list = side.getByRole('list', { name: '音频' })
  const guitar = list.getByRole('listitem').filter({ hasText: '轻快原声吉他，适合秋季穿搭' })
  const uploaded = list.getByRole('listitem').filter({ hasText: /^上传的音乐 · / })
  await expect(guitar).toContainText('0:30')
  // 上传的音频记录上没有时长，读完文件才显示
  await expect(uploaded).toContainText('0:30')

  await guitar.getByRole('button', { name: /^试听：/ }).click()
  await expect(guitar.getByRole('button', { name: /^暂停试听：/ })).toBeVisible()
  await uploaded.getByRole('button', { name: /^试听：/ }).click()
  await expect(uploaded.getByRole('button', { name: /^暂停试听：/ })).toBeVisible()
  await expect(guitar.getByRole('button', { name: /^试听：/ })).toBeVisible()
  await uploaded.getByRole('button', { name: /^暂停试听：/ }).click()
  await expect(list.getByRole('button', { name: /^暂停试听：/ })).toHaveCount(0)

  // 播放头挪到 1 秒；还没有声音行，加进来的音频在画面行下面新开一行
  await editor.evaluate((element: HTMLElement) => element.focus())
  await page.keyboard.press('Shift+ArrowRight')
  await expect(progress).toHaveAttribute('aria-valuetext', /^00:01\.00 \//)
  const added = mainSavedWith(page, (html) => savedAudio(html).length === 1)
  await expect(guitar.getByRole('button', { name: /^放入配乐行：/ })).toBeVisible()
  await guitar.getByRole('button', { name: '轻快原声吉他，适合秋季穿搭', exact: true }).click()
  expect(savedAudio(htmlOf(await added))).toEqual([
    { label: '轻快原声吉他，适合秋季穿搭', start: 1, duration: 30, track: 0 },
  ])
  const soundRow = editor.getByRole('group', { name: '配乐', exact: true })
  const music = soundRow.getByRole('group', { name: '轻快原声吉他，适合秋季穿搭，30.0 秒' })
  await expect(music).toBeVisible()
  await expect(guitar.getByText('已用', { exact: true })).toBeVisible()
  await expect(guitar.getByRole('button', { name: /^放入配乐行：/ })).toHaveCount(0)
  await expect(progress).toHaveAttribute('aria-valuetext', '00:01.00 / 00:31.00')
  expect(videoSeconds).toBeLessThan(31)

  // 点「已用」的那一行：选中它对应的片段，不再加一个，侧栏跟着切到「属性」；再点回「配乐」，选中不变
  await guitar.getByRole('button', { name: '轻快原声吉他，适合秋季穿搭，已用' }).click()
  await expect(music.getByRole('button', { name: /^选中：/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(side.getByRole('tab', { name: '属性' })).toHaveAttribute('aria-selected', 'true')
  await side.getByRole('tab', { name: '配乐' }).click()
  await expect(music.getByRole('button', { name: /^选中：/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  // 拖上传的那条到声音行里这个片段后面的空处：吸到它的结尾
  const box = await music.boundingBox()
  const lane = await soundRow.boundingBox()
  const from = await uploaded.boundingBox()
  if (box === null || lane === null || from === null) throw new Error('尚未布局')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 3 })
  // 一步落到声音行上：分几步拖过去，中途停在两行之间的缝上会先让出新的一行，声音行被挤下去
  await page.mouse.move(box.x + box.width + 4, lane.y + lane.height / 2)
  await expect(soundRow.getByTestId('drop-ghost')).toBeVisible()
  const dropped = mainSavedWith(page, (html) => savedAudio(html).length === 2)
  await page.mouse.up()
  const both = savedAudio(htmlOf(await dropped))
  expect(both.map(({ start, duration, track }) => ({ start, duration, track }))).toEqual([
    { start: 1, duration: 30, track: 0 },
    { start: 31, duration: 30, track: 0 },
  ])
  expect(both[1]?.label).toMatch(/^上传的音乐 · /)
  await expect(editor.getByRole('group', { name: '配乐 2', exact: true })).toHaveCount(0)
  await expect(progress).toHaveAttribute('aria-valuetext', '00:01.00 / 01:01.00')

  // 生成一条音乐：先是生成中，生成完能试听
  await side.getByRole('button', { name: '生成音乐' }).click()
  const popover = page.getByRole('dialog', { name: '生成音乐' })
  await popover.getByRole('textbox', { name: '音乐描述' }).fill('雨夜爵士钢琴')
  await popover.getByRole('button', { name: '生成音乐' }).click()
  await expect(popover).toBeHidden()
  const jazz = list.getByRole('listitem').filter({ hasText: '雨夜爵士钢琴' })
  await expect(jazz.getByRole('img', { name: '生成中' })).toBeVisible()
  await expect(jazz.getByRole('button', { name: '试听：雨夜爵士钢琴' })).toBeVisible({
    timeout: 15_000,
  })

  const undone = mainSavedWith(page, (html) => savedAudio(html).length === 1)
  await editor
    .getByRole('toolbar', { name: '剪辑工具' })
    .getByRole('button', { name: '撤销' })
    .click()
  expect(savedAudio(htmlOf(await undone))).toEqual([
    { label: '轻快原声吉他，适合秋季穿搭', start: 1, duration: 30, track: 0 },
  ])
  await expect(uploaded).not.toContainText('已用')
})

/** 存下来的主文件里第一个 `tag` 片段上的属性 `name`；不写值的属性是空串，没有这个属性时是 undefined。 */
const savedAttribute = (html: string, tag: 'video' | 'audio', name: string) => {
  const element = new RegExp(`<${tag} [^>]*>`).exec(html)?.[0] ?? ''
  const found = new RegExp(` ${name}(?:="([^"]*)")?(?=[ >])`).exec(element)
  return found === null ? undefined : (found[1] ?? '')
}

test('属性：音频片段拉满音量、打开循环播放写进文件；视频片段在「原片截取」上拖出点，松手写一次、一步撤销；调成 2 倍速，片段长不变、用掉的素材翻倍', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const inspector = editor.getByRole('tabpanel', { name: '属性' })
  const first = mainSaved(page, 1)
  const materials = editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
  await materials.getByRole('button', { name: /^出片 A 镜头 1，/ }).click()
  await page.keyboard.press('Enter')
  await first

  // 音频加到播放头（0 秒），在画面行下面新开一行
  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '配乐' }).click()
  const added = mainSavedWith(page, (html) => savedAudio(html).length === 1)
  await side
    .getByRole('list', { name: '音频' })
    .getByRole('button', { name: '轻快原声吉他，适合秋季穿搭', exact: true })
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: '加到播放头' }).click()
  await added

  await editor
    .getByRole('group', { name: '配乐', exact: true })
    .getByRole('button', { name: /^选中：轻快原声吉他/ })
    .click()
  await expect(inspector.getByTitle('轻快原声吉他，适合秋季穿搭', { exact: true })).toBeVisible()
  const louder = mainSavedWith(
    page,
    (html) => savedAttribute(html, 'audio', 'data-volume') === '3.981072',
  )
  await inspector.getByRole('slider', { name: '音量' }).press('End')
  await louder
  await expect(inspector.getByRole('slider', { name: '音量' })).toHaveAttribute(
    'aria-valuetext',
    '+12.0 dB',
  )
  const looped = mainSavedWith(page, (html) => savedAttribute(html, 'audio', 'loop') === 'true')
  await inspector.getByRole('switch', { name: '循环播放' }).click()
  await looped

  // 视频片段：把出点拖到素材的最后，拖动中不写
  await editor
    .getByRole('group', { name: '画面 1', exact: true })
    .getByRole('button', { name: /^选中：A · / })
    .click()
  const summary = inspector.getByTestId('slip-summary')
  await expect(summary).toBeVisible()
  /** 标题行右边的入点、出点和素材总长（秒）。 */
  const points = async () => {
    const [inPoint, outPoint, total] = ((await summary.textContent()) ?? '')
      .match(/[\d.]+/g)
      ?.map(Number) ?? [NaN, NaN, NaN]
    return { inPoint, outPoint, total }
  }
  const before = await points()
  expect(before.outPoint).toBeLessThan(before.total)
  const savedDurations: number[] = []
  page.on('request', (request) => {
    const html = savedHtmlOf(request)
    if (html !== null) savedDurations.push(Number(savedAttribute(html, 'video', 'data-duration')))
  })
  const strip = await inspector.getByRole('group', { name: '原片截取条' }).boundingBox()
  const grip = await inspector.getByRole('slider', { name: '裁剪结尾' }).boundingBox()
  if (strip === null || grip === null) throw new Error('原片截取条尚未布局')
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(strip.x + strip.width + 20, grip.y + grip.height / 2, { steps: 6 })
  await expect.poll(async () => (await points()).outPoint).toBeCloseTo(before.total, 1)
  await page.waitForTimeout(600)
  expect(savedDurations).toEqual([])
  const extended = mainSavedWith(
    page,
    (html) =>
      Number(savedAttribute(html, 'video', 'data-duration')) >
      before.outPoint - before.inPoint + 0.5,
  )
  await page.mouse.up()
  await extended
  expect(savedDurations).toHaveLength(1)

  const undone = mainSavedWith(
    page,
    (html) =>
      Math.abs(
        Number(savedAttribute(html, 'video', 'data-duration')) - (before.outPoint - before.inPoint),
      ) < 0.01,
  )
  await editor
    .getByRole('toolbar', { name: '剪辑工具' })
    .getByRole('button', { name: '撤销' })
    .click()
  await undone
  await expect.poll(async () => (await points()).outPoint).toBeCloseTo(before.outPoint, 2)

  // 2 倍速：片段长不变，用掉的素材翻倍
  const faster = mainSavedWith(
    page,
    (html) => savedAttribute(html, 'video', 'data-playback-rate') === '2',
  )
  await inspector.getByRole('button', { name: /^倍速 1x，/ }).click()
  await inspector.getByRole('textbox', { name: '倍速' }).fill('2')
  await inspector.getByRole('textbox', { name: '倍速' }).press('Enter')
  const html = htmlOf(await faster)
  expect(Number(savedAttribute(html, 'video', 'data-duration'))).toBeCloseTo(
    before.outPoint - before.inPoint,
    2,
  )
  await expect
    .poll(async () => {
      const now = await points()
      return now.outPoint - now.inPoint
    })
    .toBeCloseTo(2 * (before.outPoint - before.inPoint), 1)
})

test('智能调音：把配乐的角色改成人声、打开自动平稳音量，存下的音频片段在人声组里，带着平稳音量的节点和曲线', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const inspector = editor.getByRole('tabpanel', { name: '属性' })
  const first = mainSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^出片 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  await first

  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '配乐' }).click()
  const added = mainSavedWith(page, (html) => savedAudio(html).length === 1)
  await side
    .getByRole('list', { name: '音频' })
    .getByRole('button', { name: '轻快原声吉他，适合秋季穿搭', exact: true })
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: '加到播放头' }).click()
  await added
  await editor
    .getByRole('group', { name: '配乐', exact: true })
    .getByRole('button', { name: /^选中：轻快原声吉他/ })
    .click()
  await expect(inspector.getByRole('heading', { name: '智能调音' })).toBeVisible()
  // 选中配乐时会先分析一次人声（自动压低），分析完开关才能动
  await expect(inspector.getByText('正在分析声音')).toHaveCount(0)

  const regrouped = mainSavedWith(
    page,
    (html) => savedAttribute(html, 'audio', 'data-audio-group') === 'voice',
  )
  await inspector.getByRole('button', { name: '角色：配乐' }).click()
  await page.getByRole('menuitemradio', { name: /^人声/ }).click()
  await regrouped
  await expect(inspector.getByRole('button', { name: '角色：人声' })).toBeVisible()

  const levelled = mainSavedWith(page, (html) =>
    (savedAttribute(html, 'audio', 'data-fx-chain') ?? '').includes('fromLeveller'),
  )
  await inspector.getByRole('switch', { name: '自动平稳人声音量' }).click()
  const html = htmlOf(await levelled)
  const attribute = (name: string) =>
    (savedAttribute(html, 'audio', name) ?? '').replaceAll('&quot;', '"')
  expect(attribute('data-audio-group')).toBe('voice')
  expect(html).not.toContain('data-fx-leveller')
  const leveller = (
    JSON.parse(attribute('data-fx-chain')) as {
      nodes: { id: string; type: string; fromLeveller?: boolean }[]
    }
  ).nodes.find((node) => node.fromLeveller === true)
  expect(leveller?.type).toBe('gain')
  const lanes = (JSON.parse(attribute('data-automation')) as { lanes: { target: string }[] }).lanes
  expect(lanes.map((lane) => lane.target)).toContain(`fx.${leveller?.id ?? ''}.gain`)
  await expect(inspector.getByRole('switch', { name: '自动平稳人声音量' })).toHaveAttribute(
    'aria-checked',
    'true',
  )
})

test('音色风格与精细调音：给配乐选一个预设、调一段均衡、加一个效果，存下的音频片段的效果链里三样都在', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const inspector = editor.getByRole('tabpanel', { name: '属性' })
  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '配乐' }).click()
  const added = mainSavedWith(page, (html) => savedAudio(html).length === 1)
  await side
    .getByRole('list', { name: '音频' })
    .getByRole('button', { name: '轻快原声吉他，适合秋季穿搭', exact: true })
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: '加到播放头' }).click()
  await added
  await editor
    .getByRole('group', { name: '配乐', exact: true })
    .getByRole('button', { name: /^选中：轻快原声吉他/ })
    .click()
  await expect(inspector.getByRole('heading', { name: '智能调音' })).toBeVisible()

  type Node = { type: string; fromPreset?: string; fromEq?: string; params?: { gain?: number } }
  const chainOf = (html: string) =>
    (
      JSON.parse(
        (savedAttribute(html, 'audio', 'data-fx-chain') ?? '{"nodes":[]}').replaceAll(
          '&quot;',
          '"',
        ),
      ) as { nodes: Node[] }
    ).nodes
  const style = inspector.getByRole('radiogroup', { name: '音色风格' })
  const styled = mainSavedWith(page, (html) =>
    chainOf(html).some((node) => node.fromPreset === 'room-natural'),
  )
  await style.getByRole('radio', { name: '自然空间' }).click()
  await styled
  await expect(style.getByRole('radio', { name: '自然空间' })).toHaveAttribute(
    'aria-checked',
    'true',
  )

  await inspector.getByRole('button', { name: /^精细调音/ }).click()
  const toned = mainSavedWith(page, (html) =>
    chainOf(html).some((node) => node.fromEq !== undefined && node.params?.gain === -6),
  )
  await inspector.getByRole('button', { name: '高频 4kHz 0.0dB，点击可直接输入' }).click()
  await inspector.getByRole('textbox', { name: '高频 4kHz' }).fill('-6')
  await inspector.getByRole('textbox', { name: '高频 4kHz' }).press('Enter')
  await toned

  const limited = mainSavedWith(page, (html) =>
    chainOf(html).some((node) => node.type === 'truepeak'),
  )
  await inspector.getByRole('button', { name: /添加效果/ }).click()
  await page.getByRole('menuitem', { name: /^防爆音峰值限制/ }).click()
  const nodes = chainOf(htmlOf(await limited))
  expect(
    nodes.filter((node) => node.fromPreset === 'room-natural').map((node) => node.type),
  ).toEqual(['reverb'])
  expect(nodes.filter((node) => node.fromEq !== undefined).map((node) => node.type)).toEqual([
    'lowshelf',
    'peaking',
    'highshelf',
  ])
  expect(nodes.at(-1)).toMatchObject({ type: 'truepeak' })
  await expect(inspector.getByRole('group', { name: '防爆音峰值限制' })).toBeVisible()
  await expect(inspector.getByRole('button', { name: /^精细调音/ })).toContainText(
    '均衡 · 1 个效果',
  )
})

test('调音直接打进预览：给配乐选一个音色风格，预览不换播放器，预览里这段配乐带着新的效果链', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const inspector = editor.getByRole('tabpanel', { name: '属性' })
  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '配乐' }).click()
  const added = mainSavedWith(page, (html) => savedAudio(html).length === 1)
  await side
    .getByRole('list', { name: '音频' })
    .getByRole('button', { name: '轻快原声吉他，适合秋季穿搭', exact: true })
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: '加到播放头' }).click()
  await added
  await editor
    .getByRole('group', { name: '配乐', exact: true })
    .getByRole('button', { name: /^选中：轻快原声吉他/ })
    .click()
  await expect(inspector.getByRole('heading', { name: '智能调音' })).toBeVisible()
  await expect(inspector.getByText('正在分析声音')).toHaveCount(0)
  await readyPlayer(editor)
  await markFinalCutPreviewPlayer(editor)

  await inspector
    .getByRole('radiogroup', { name: '音色风格' })
    .getByRole('radio', { name: '自然空间' })
    .click()
  await expect
    .poll(() =>
      finalCutPreviewPlayer(editor).evaluate(
        (element: HTMLElement & { iframeElement: HTMLIFrameElement }) =>
          element.iframeElement.contentDocument
            ?.querySelector('audio')
            ?.getAttribute('data-fx-chain') ?? '',
      ),
    )
    .toContain('"fromPreset":"room-natural"')
  expect(await isMarkedFinalCutPreviewPlayer(editor)).toBe(true)
})

test('波形音量关键帧：打开后在配乐的波形线上按下加一个点往下拖，存下的主文件里这条曲线中间变小；撤销一步回到平的', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const inspector = editor.getByRole('tabpanel', { name: '属性' })
  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '配乐' }).click()
  const added = mainSavedWith(page, (html) => savedAudio(html).length === 1)
  await side
    .getByRole('list', { name: '音频' })
    .getByRole('button', { name: '轻快原声吉他，适合秋季穿搭', exact: true })
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: '加到播放头' }).click()
  await added
  const clip = editor
    .getByRole('group', { name: '配乐', exact: true })
    .getByRole('group', { name: /^轻快原声吉他/ })
  await clip.getByRole('button', { name: /^选中：轻快原声吉他/ }).click()
  await expect(inspector.getByRole('heading', { name: '智能调音' })).toBeVisible()

  type Point = { t: number; v: number }
  const volumeOf = (html: string) =>
    (
      JSON.parse(
        (savedAttribute(html, 'audio', 'data-automation') ?? '{"lanes":[]}').replaceAll(
          '&quot;',
          '"',
        ),
      ) as { lanes: { target: string; points: Point[] }[] }
    ).lanes.find((lane) => lane.target === 'volume')?.points
  await inspector.getByRole('button', { name: /^精细调音/ }).click()
  const flat = mainSavedWith(page, (html) => volumeOf(html)?.length === 2)
  await inspector.getByRole('switch', { name: '波形音量关键帧' }).click()
  expect(volumeOf(htmlOf(await flat))?.every((point) => point.v === 1)).toBe(true)
  await expect(clip.getByRole('slider', { name: /^音量关键帧/ })).toHaveCount(2)

  // 原音量的线在点上；按在线上的正中加点，拖到这一块下面去（指针出了这一块也还跟着）
  const box = await clip.getByTestId('volume-envelope').boundingBox()
  const end = await clip.getByRole('slider', { name: '音量关键帧 1' }).boundingBox()
  if (box === null || end === null) throw new Error('量不到音量曲线的位置')
  const lineY = end.y + end.height / 2

  // 离线 4 像素也算按在线上：加一个点（值是线在那里的值）；双击这个点删掉它
  const inserted = mainSavedWith(page, (html) => volumeOf(html)?.length === 3)
  await page.mouse.click(box.x + box.width * 0.3, lineY - 4)
  expect(volumeOf(htmlOf(await inserted))?.every((point) => point.v === 1)).toBe(true)
  const removed = mainSavedWith(page, (html) => volumeOf(html)?.length === 2)
  await clip.getByRole('slider', { name: '音量关键帧 2' }).dblclick()
  await removed

  const dipped = mainSavedWith(page, (html) => volumeOf(html)?.length === 3)
  await page.mouse.move(box.x + box.width / 2, lineY)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.75, { steps: 4 })
  await expect(clip.getByRole('status')).toContainText('dB')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 20, { steps: 4 })
  await page.mouse.up()
  const points = volumeOf(htmlOf(await dipped)) ?? []
  expect(points.map((point) => point.v)).toEqual([1, 0, 1])
  expect(points[1]?.t ?? 0).toBeGreaterThan(points[0]?.t ?? 0)
  expect(points[1]?.t ?? 0).toBeLessThan(points[2]?.t ?? 0)
  // 选中没变，片段也没挪
  await expect(clip.getByRole('button', { name: /^选中：轻快原声吉他/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  const undone = mainSavedWith(page, (html) => volumeOf(html)?.length === 2)
  await editor
    .getByRole('toolbar', { name: '剪辑工具' })
    .getByRole('button', { name: '撤销' })
    .click()
  const restored = htmlOf(await undone)
  expect(volumeOf(restored)?.every((point) => point.v === 1)).toBe(true)

  // 在波形里离线远的地方按下往右拖：照常是挪片段，不加点
  const startBefore = savedAttribute(restored, 'audio', 'data-start')
  const moved = mainSavedWith(
    page,
    (html) => savedAttribute(html, 'audio', 'data-start') !== startBefore,
  )
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height - 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.7 + 60, box.y + box.height - 2, { steps: 6 })
  await page.mouse.up()
  const shifted = htmlOf(await moved)
  expect(Number(savedAttribute(shifted, 'audio', 'data-start'))).toBeGreaterThan(
    Number(startBefore),
  )
  expect(volumeOf(shifted)).toHaveLength(2)
})

test('音量关键帧跟着裁剪走：配乐上加一个点，在时间线上裁掉开头 0.1 秒，存下的曲线整条往前挪 0.1 秒', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const inspector = editor.getByRole('tabpanel', { name: '属性' })
  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '配乐' }).click()
  const added = mainSavedWith(page, (html) => savedAudio(html).length === 1)
  await side
    .getByRole('list', { name: '音频' })
    .getByRole('button', { name: '轻快原声吉他，适合秋季穿搭', exact: true })
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: '加到播放头' }).click()
  await added
  const clip = editor
    .getByRole('group', { name: '配乐', exact: true })
    .getByRole('group', { name: /^轻快原声吉他/ })
  await clip.getByRole('button', { name: /^选中：轻快原声吉他/ }).click()

  type Point = { t: number; v: number }
  const volumeOf = (html: string) =>
    (
      JSON.parse(
        (savedAttribute(html, 'audio', 'data-automation') ?? '{"lanes":[]}').replaceAll(
          '&quot;',
          '"',
        ),
      ) as { lanes: { target: string; points: Point[] }[] }
    ).lanes.find((lane) => lane.target === 'volume')?.points
  await inspector.getByRole('button', { name: /^精细调音/ }).click()
  const flat = mainSavedWith(page, (html) => volumeOf(html)?.length === 2)
  await inspector.getByRole('switch', { name: '波形音量关键帧' }).click()
  await flat

  // 按在线上的 30% 处加一个点
  const box = await clip.getByTestId('volume-envelope').boundingBox()
  const end = await clip.getByRole('slider', { name: '音量关键帧 1' }).boundingBox()
  if (box === null || end === null) throw new Error('量不到音量曲线的位置')
  const inserted = mainSavedWith(page, (html) => volumeOf(html)?.length === 3)
  await page.mouse.click(box.x + box.width * 0.3, end.y + end.height / 2)
  const keyed = htmlOf(await inserted)
  const before = volumeOf(keyed) ?? []
  const startBefore = Number(savedAttribute(keyed, 'audio', 'data-start'))

  const trimmed = mainSavedWith(
    page,
    (html) => Number(savedAttribute(html, 'audio', 'data-start')) > startBefore,
  )
  await clip.getByRole('slider', { name: '裁剪开头' }).focus()
  await page.keyboard.press('ArrowRight')
  const html = htmlOf(await trimmed)
  expect(Number(savedAttribute(html, 'audio', 'data-start'))).toBeCloseTo(startBefore + 0.1, 3)
  const after = volumeOf(html) ?? []
  // 原来第 0 秒的点裁掉了、0 秒补一个，后面的点都早了 0.1 秒
  expect(after).toHaveLength(3)
  expect(after[0]?.t).toBe(0)
  expect(after[1]?.t).toBeCloseTo((before[1]?.t ?? 0) - 0.1, 3)
  expect(after[2]?.t).toBeCloseTo((before[2]?.t ?? 0) - 0.1, 3)
})

test('在元素卡片上按 ] 选中片段：侧栏切到「属性」，焦点交还编辑器，Delete 照常删掉；选中没了回到元素页签', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const first = mainSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^出片 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  await first

  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '元素' }).click()
  await side
    .getByRole('list', { name: '元素' })
    .getByRole('group')
    .first()
    .getByRole('button', { name: '加到播放头' })
    .focus()
  await page.keyboard.press(']')
  await expect(side.getByRole('tab', { name: '属性' })).toHaveAttribute('aria-selected', 'true')
  await expect(editor.getByRole('tabpanel', { name: '属性' })).toBeVisible()
  await expect(editor).toBeFocused()

  const removed = mainSaved(page, 0)
  await page.keyboard.press('Delete')
  await removed
  await expect(side.getByRole('tab', { name: '元素' })).toHaveAttribute('aria-selected', 'true')
  await expect(side.getByRole('list', { name: '元素' })).toBeVisible()
})

test('编辑区变窄时只裁不换行：工具条和侧栏页签都排一行，放不下的被卡片裁掉，右栏内容照最窄排、被裁的能横着滑过去，页面没有横向滚动条', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  const sideSplitter = editor.getByRole('button', { name: '调整右栏宽度' })
  const preview = editor.getByRole('region', { name: '预览' })
  /** 右栏分隔条的提示写的是右栏实际排出来的宽度（记着的 432 会被编辑区夹窄）。 */
  const splitterTellsSideWidth = async () =>
    expect(sideSplitter).toHaveAttribute(
      'title',
      new RegExp(`当前 ${Math.round((await boxOf(side)).width)}px`),
    )
  // 默认布局：舞台照常留 360
  expect((await boxOf(preview)).width).toBeGreaterThanOrEqual(360)
  await splitterTellsSideWidth()
  // 把工作台拖到最窄（560），编辑器跟着变窄。正好拖到 560：再往右拖工作台会被收进去一截
  const handle = await boxOf(page.getByRole('button', { name: '调整工作台宽度' }))
  const narrowBy = (await boxOf(panel)).width - 560
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2 + narrowBy, handle.y + handle.height / 2, {
    steps: 10,
  })
  await page.mouse.up()
  await expect.poll(async () => (await boxOf(panel)).width).toBeCloseTo(560, 0)
  const workspace = await boxOf(editor)
  expect(workspace.width).toBeLessThan(600)

  const toolbar = editor.getByRole('toolbar', { name: '剪辑工具' })
  const undo = await boxOf(toolbar.getByRole('button', { name: '撤销' }))
  const fit = await boxOf(toolbar.getByRole('button', { name: '适应宽度' }))
  expect(fit.y).toBe(undo.y)
  expect((await boxOf(toolbar)).height).toBeLessThanOrEqual(44)
  // 纯图标的工具条在最窄时也排得下：最后的缩放滑杆还在编辑区里
  const last = toolbar.getByRole('slider', { name: '时间线缩放' })
  const lastBox = await boxOf(last)
  expect(lastBox.x + lastBox.width).toBeLessThanOrEqual(workspace.x + workspace.width)

  // 舞台优先：至少留 300 宽，播放条整条排得下；右栏让宽
  const stage = await boxOf(preview)
  expect(stage.width).toBeGreaterThanOrEqual(300)
  const controls = await boxOf(editor.getByRole('group', { name: '播放控制' }))
  expect(controls.x + controls.width).toBeLessThanOrEqual(stage.x + stage.width)
  await splitterTellsSideWidth()

  const firstTab = await boxOf(side.getByRole('tab', { name: '镜头' }))
  const propsTab = await boxOf(side.getByRole('tab', { name: '属性' }))
  expect(propsTab.y).toBe(firstTab.y)

  // 工具条不横向滚：横向滚动、把焦点挪到最后的滑杆上，工具条都不挪
  await page.mouse.move(undo.x + 100, undo.y + undo.height / 2)
  await page.mouse.wheel(300, 0)
  await last.evaluate((slider: HTMLElement) => slider.focus())
  await expect(last).toBeFocused()
  expect((await boxOf(toolbar.getByRole('button', { name: '撤销' }))).x).toBe(undo.x)
  expect((await boxOf(editor)).x).toBe(workspace.x)

  // 右栏比内容窄：出片卡片不跟着变窄，右边被裁掉；筛选的三个按钮排一行；收起按钮还在右栏里
  const sideBox = await boxOf(side)
  const card = await boxOf(
    side.getByRole('group', { name: '镜头组 2' }).getByRole('article', { name: '出片 A' }),
  )
  expect(card.width).toBeGreaterThan(sideBox.width)
  expect(card.x + card.width).toBeGreaterThan(sideBox.x + sideBox.width)
  const filters = side.getByRole('group', { name: '素材筛选' }).getByRole('button')
  await expect(filters).toHaveCount(3)
  const filterTops = await Promise.all(
    (await filters.all()).map(async (each) => (await boxOf(each)).y),
  )
  expect(new Set(filterTops).size).toBe(1)
  const toggle = await boxOf(side.getByRole('button', { name: '收起右栏' }))
  expect(toggle.x + toggle.width).toBeLessThanOrEqual(sideBox.x + sideBox.width)
  // 在右栏内容上横向滚轮：内容左移，导航、编辑器和页面都不动
  const shots = side.getByRole('tabpanel', { name: '镜头' })
  const shotsBefore = await boxOf(shots)
  await page.mouse.move(sideBox.x + sideBox.width / 2, shotsBefore.y + 200)
  await page.mouse.wheel(200, 0)
  await expect.poll(async () => (await boxOf(shots)).x).toBeLessThan(shotsBefore.x)
  expect((await boxOf(side.getByRole('tab', { name: '镜头' }))).x).toBe(firstTab.x)
  expect((await boxOf(editor)).x).toBe(workspace.x)
  expect(await page.evaluate(() => window.scrollX)).toBe(0)
})

test('拖右栏分割条：往右拖变窄、内容被裁；拖过头收成竖轨，同一次拖回来又展开；松手、刷新后宽度还在；拖过头松手再展开回到拖之前的宽度', async ({
  page,
}) => {
  const panel = await openConversation(page, '夜景延时素材生成')
  await widenWorkbench(page)
  const editor = await createFinalCut(panel)
  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  const sideSplitter = editor.getByRole('button', { name: '调整右栏宽度' })
  const start = await boxOf(side)
  expect(start.width).toBeGreaterThanOrEqual(376)
  const grip = await boxOf(sideSplitter)
  const y = grip.y + grip.height / 2
  // 指针从分割条中间起，右栏右沿不动：右栏宽 = 右沿 - 指针 - 半条分割条
  const pointerFor = (width: number) => start.x + start.width - width - grip.width / 2

  await page.mouse.move(grip.x + grip.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(pointerFor(240), y, { steps: 8 })
  await expect.poll(async () => Math.round((await boxOf(side)).width)).toBe(240)
  const card = await boxOf(
    side.getByRole('group', { name: '镜头组 2' }).getByRole('article', { name: '出片 A' }),
  )
  expect(card.x + card.width).toBeGreaterThan(start.x + start.width)

  // 拖过头：收成 50 宽的竖轨
  await page.mouse.move(pointerFor(80), y, { steps: 4 })
  await expect(side.getByRole('button', { name: '展开右栏' })).toBeVisible()
  await expect.poll(async () => Math.round((await boxOf(side)).width)).toBe(50)
  // 同一次拖回来又展开、跟着指针
  await page.mouse.move(pointerFor(300), y, { steps: 8 })
  await expect.poll(async () => Math.round((await boxOf(side)).width)).toBe(300)
  await expect(side.getByRole('tabpanel', { name: '镜头' })).toBeVisible()
  await page.mouse.up()

  // 刷新后重新登录会把侧边栏展开（工作台宽度记着）：再收起，免得右栏被窄工作台夹窄
  await page.reload()
  const panelAgain = await openConversation(page, '夜景延时素材生成')
  await page.getByRole('button', { name: '折叠侧边栏' }).click()
  const reopened = await openFinalCut(panelAgain)
  const sideAgain = reopened.getByRole('complementary', {
    name: '镜头、元素、模板、配乐、字幕和属性',
  })
  await expect.poll(async () => Math.round((await boxOf(sideAgain)).width)).toBe(300)

  // 再拖过头松手：收着；点「展开右栏」回到这次拖之前的 300
  const gripAgain = await boxOf(reopened.getByRole('button', { name: '调整右栏宽度' }))
  const yAgain = gripAgain.y + gripAgain.height / 2
  await page.mouse.move(gripAgain.x + gripAgain.width / 2, yAgain)
  await page.mouse.down()
  await page.mouse.move(gripAgain.x + 300, yAgain, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => Math.round((await boxOf(sideAgain)).width)).toBe(50)
  await sideAgain.getByRole('button', { name: '展开右栏' }).click()
  await expect.poll(async () => Math.round((await boxOf(sideAgain)).width)).toBe(300)
})

// 下面几条在默认布局下跑：侧边栏展开，工作台约 776 宽，和对话并排

/** 加一个片段并选中它，返回选中它的按钮。 */
const selectedClip = async (page: Page, editor: Locator) => {
  const saved = mainSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^出片 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  await saved
  const clip = editor
    .getByRole('group', { name: '画面 1', exact: true })
    .getByRole('button', { name: /^选中：/ })
  await clip.click()
  await expect(clip).toHaveAttribute('aria-pressed', 'true')
  return clip
}

/**
 * 把「镜头组 2」第一条原作整条（6 秒）作为一个视频片段放进 final-cut：加入镜头 1，在时间线上把它的结尾拉到素材
 * 末尾，再取消选中。「镜头」页签里跨镜头的选区加入时一个镜头一个片段，拼不出一整条。返回拉满以后保存主文件的请求。
 */
const addWholeTake = async (page: Page, editor: Locator) => {
  await selectedClip(page, editor)
  const whole = mainSavedWith(page, (html) => savedVideoTimings(html)[0]?.duration === 6)
  await editor
    .getByRole('group', { name: '画面 1', exact: true })
    .getByRole('slider', { name: '裁剪结尾' })
    .focus()
  for (let second = 0; second < 6; second += 1) await page.keyboard.press('Shift+ArrowRight')
  const saved = await whole
  await page.keyboard.press('Escape')
  return saved
}

/** 接下来 `ms` 毫秒里工程主文件存过几次。 */
const savesWithin = async (page: Page, ms: number) => {
  let saves = 0
  const count = (request: Request) => {
    if (savedHtmlOf(request) !== null) saves += 1
  }
  page.on('request', count)
  await page.waitForTimeout(ms)
  page.off('request', count)
  return saves
}

/** 存出的主文件里的视频片段，按文件里的先后：起点、时长、入点（秒）。 */
const savedVideoTimings = (html: string) =>
  (html.match(/<video [^>]*>/g) ?? []).map((tag) => {
    const seconds = (name: string) => Number(new RegExp(` ${name}="([\\d.]+)"`).exec(tag)?.[1])
    return {
      start: seconds('data-start'),
      duration: seconds('data-duration'),
      mediaStart: seconds('data-media-start'),
    }
  })

test('切开：选中视频片段、把播放头放进去按 S，存下来多了一个片段、两半接得上；再用切开工具在另一处点一下', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const added = mainSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^出片 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  const [whole] = savedVideoTimings(htmlOf(await added))
  if (whole === undefined) throw new Error('没有加进片段')
  expect(whole).toMatchObject({ start: 0, duration: 1 })
  // 预览加载好以后才挪播放头：加载中报上来的时间会把它拉回去
  await readyPlayer(editor)

  const row = editor.getByRole('group', { name: '画面 1', exact: true })
  await row.getByRole('button', { name: /^选中：/ }).click()
  // 播放头一格一格挪到 0.4 秒：每按一下等它显示出来再按下一下
  for (let step = 1; step <= 4; step += 1) {
    await page.keyboard.press('ArrowRight')
    await expect(editor.getByRole('group', { name: '播放控制' })).toContainText(`00:00.${step}0 /`)
  }
  const cut = mainSaved(page, 2)
  await page.keyboard.press('s')
  const [first, second] = savedVideoTimings(htmlOf(await cut))
  expect(first).toEqual({ ...whole, duration: 0.4 })
  expect(second).toEqual({ start: 0.4, duration: 0.6, mediaStart: whole.mediaStart + 0.4 })

  // 切开工具：指针在行上有一条竖线，在后半段的正中点一下
  await page.keyboard.press('b')
  await expect(
    editor
      .getByRole('toolbar', { name: '剪辑工具' })
      .getByRole('button', { name: '切开工具', pressed: true }),
  ).toBeVisible()
  const back = row.getByRole('group').last()
  const box = await back.boundingBox()
  if (box === null) throw new Error('后半段还没排好')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await expect(editor.getByTestId('timeline-skimmer')).toBeVisible()
  const again = mainSaved(page, 3)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  const [, middle, last] = savedVideoTimings(htmlOf(await again))
  if (second === undefined || middle === undefined || last === undefined)
    throw new Error('没有切成三段')
  expect(middle.start).toBe(0.4)
  expect(middle.start + middle.duration).toBeCloseTo(last.start, 3)
  expect(last.start + last.duration).toBeCloseTo(second.start + second.duration, 3)
  expect(last.start).toBeCloseTo(second.start + second.duration / 2, 1)
  expect(last.mediaStart).toBeCloseTo(middle.mediaStart + middle.duration, 3)
})

/** 存下来的主文件里第一个 `tag` 元素的属性。 */
const savedElementAttributes = (html: string, tag: 'video' | 'audio') => {
  const element = new RegExp(`<${tag} [^>]*>`).exec(html)?.[0] ?? ''
  return Object.fromEntries(
    [...element.matchAll(/ ([a-z-]+)(?:="([^"]*)")?(?=[ >])/g)].map(([, name, value]) => [
      name ?? '',
      value ?? '',
    ]),
  )
}

/** 拖着时间线上的片段横着挪 `dx` 像素。 */
const dragClip = async (page: Page, clip: Locator, dx: number) => {
  const box = await clip.boundingBox()
  if (box === null) throw new Error('片段还没排好')
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + dx, y, { steps: 8 })
  await page.mouse.up()
}

test('默认缩放下选中 1 秒的片段：按在正中拖是挪动、不是裁剪；把手骑在两端的边线上，点按区不伸到片段外面', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const added = mainSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^出片 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  const [whole] = savedVideoTimings(htmlOf(await added))
  if (whole === undefined) throw new Error('没有加进片段')
  expect(whole.duration).toBe(1)
  const clip = editor.getByRole('group', { name: '画面 1', exact: true }).getByRole('group')
  await clip.getByRole('button', { name: /^选中：/ }).click()
  // 时间线至少排 20 秒：1 秒的片段只有几十像素宽
  const box = await clip.boundingBox()
  if (box === null) throw new Error('片段还没排好')
  expect(box.width).toBeLessThan(40)
  for (const [name, edge] of [
    ['裁剪开头', box.x],
    ['裁剪结尾', box.x + box.width],
  ] as const) {
    const handle = await clip.getByRole('slider', { name }).boundingBox()
    if (handle === null) throw new Error('把手还没排好')
    expect(Math.abs(handle.x + handle.width / 2 - edge)).toBeLessThanOrEqual(1)
  }
  // 点按区不伸出去：紧挨着片段两边按下去的不是把手
  const y = box.y + box.height / 2
  for (const x of [box.x - 2, box.x + box.width + 2])
    expect(
      await page.evaluate(
        ([atX, atY]) => document.elementFromPoint(atX ?? 0, atY ?? 0)?.getAttribute('role'),
        [x, y],
      ),
    ).not.toBe('slider')
  const moved = mainSavedWith(page, (html) => (savedVideoTimings(html)[0]?.start ?? 0) > 0)
  await dragClip(page, clip, 60)
  const [after] = savedVideoTimings(htmlOf(await moved))
  expect(after).toMatchObject({ duration: whole.duration, mediaStart: whole.mediaStart })
})

test('节拍吸附：加一首配乐，片段上画出算出来的节拍；把视频片段拖到一拍旁边松手，开头落在这一拍上', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const added = mainSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^出片 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  await added

  // 音频库里这首配乐每 0.5 秒一下鼓点：加到播放头（0 秒），在浏览器里算出节拍画在片段上
  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '配乐' }).click()
  const withMusic = mainSavedWith(page, (html) => savedAudio(html).length === 1)
  await side
    .getByRole('list', { name: '音频' })
    .getByRole('button', { name: '轻快原声吉他，适合秋季穿搭', exact: true })
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: '加到播放头' }).click()
  await withMusic
  const music = editor
    .getByRole('group', { name: '配乐', exact: true })
    .getByRole('group', { name: /^轻快原声吉他，适合秋季穿搭，/ })
  const marks = music.getByTestId('beat-marks')
  await expect(marks).toBeVisible({ timeout: 15_000 })

  // 挑视频片段结尾往后第一拍，把片段拖到它右边 3 像素处：够不着别的片段的边和播放头，只有节拍
  const clip = editor.getByRole('group', { name: '画面 1', exact: true }).getByRole('group')
  const box = await clip.boundingBox()
  if (box === null) throw new Error('片段还没排好')
  const beatXs = await marks
    .locator('span')
    .evaluateAll((spans) => spans.map((span) => span.getBoundingClientRect().left))
  const beatX = beatXs.find((x) => x > box.x + box.width + 40)
  if (beatX === undefined) throw new Error('没有画出节拍')
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(beatX + 3 + box.width / 2, y, { steps: 8 })
  await expect(editor.getByTestId('snap-guide')).toBeVisible()
  const moved = mainSavedWith(page, (html) => (savedVideoTimings(html)[0]?.start ?? 0) > 0)
  await page.mouse.up()
  const [after] = savedVideoTimings(htmlOf(await moved))
  if (after === undefined) throw new Error('没有存下片段')
  // 落在节拍上：片段的左边对着那一拍，开头是鼓点的时间（每 0.5 秒一下，节拍差几毫秒）
  const landed = await clip.boundingBox()
  expect(Math.abs((landed?.x ?? 0) - beatX)).toBeLessThan(1.5)
  expect(Math.abs(after.start * 2 - Math.round(after.start * 2))).toBeLessThan(0.04)
})

test('节拍：从素材栏拖一个镜头到一拍旁边松手，开头落在这一拍上；算出的节拍存进工程，刷新后直接读文件、不再解码配乐', async ({
  page,
}) => {
  test.setTimeout(90_000)
  // 数这一页解了几次声音：算节拍要先把配乐整个解出来
  await page.addInitScript(() => {
    const counter = window as unknown as { audioDecodes: number }
    counter.audioDecodes = 0
    window.OfflineAudioContext = class extends OfflineAudioContext {
      override decodeAudioData(...args: Parameters<BaseAudioContext['decodeAudioData']>) {
        counter.audioDecodes += 1
        return super.decodeAudioData(...args)
      }
    }
  })
  const decodes = () =>
    page.evaluate(() => (window as unknown as { audioDecodes: number }).audioDecodes)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const takes = editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
  const added = mainSaved(page, 1)
  await takes.getByRole('button', { name: /^出片 A 镜头 1，/ }).click()
  await page.keyboard.press('Enter')
  await added

  // 加一首配乐：算出节拍画在片段上，节拍文件建进工程的 beats/ 下
  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '配乐' }).click()
  const withMusic = mainSavedWith(page, (html) => savedAudio(html).length === 1)
  const beatFile = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      request.url().includes('/final-cut/files') &&
      (request.postDataJSON() as { path: string }).path.startsWith('beats/'),
  )
  await side
    .getByRole('list', { name: '音频' })
    .getByRole('button', { name: '轻快原声吉他，适合秋季穿搭', exact: true })
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: '加到播放头' }).click()
  await withMusic
  const marksOf = (where: Locator) =>
    where
      .getByRole('group', { name: '配乐', exact: true })
      .getByRole('group', { name: /^轻快原声吉他，适合秋季穿搭，/ })
      .getByTestId('beat-marks')
  const marks = marksOf(editor)
  await expect(marks).toBeVisible({ timeout: 15_000 })
  expect((await (await beatFile).response())?.status()).toBe(201)
  expect(await decodes()).toBeGreaterThan(0)

  // 从「镜头」页签拖镜头 2 到视频片段结尾往后第一拍的右边 3 像素处松手：只够得着节拍
  await side.getByRole('tab', { name: '镜头' }).click()
  const row = editor.getByRole('group', { name: '画面 1', exact: true })
  const first = await row.getByRole('group').first().boundingBox()
  const lane = await row.boundingBox()
  const from = await takes.getByRole('button', { name: /^出片 A 镜头 2，/ }).boundingBox()
  if (first === null || lane === null || from === null) throw new Error('尚未布局')
  const beatXs = await marks
    .locator('span')
    .evaluateAll((spans) => spans.map((span) => span.getBoundingClientRect().left))
  const beatX = beatXs.find((x) => x > first.x + first.width + 40)
  if (beatX === undefined) throw new Error('没有画出节拍')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 - 10, { steps: 3 })
  await page.mouse.move(beatX + 3, lane.y + lane.height / 2, { steps: 8 })
  await expect(row.getByTestId('drop-ghost')).toBeVisible()
  await expect(editor.getByTestId('snap-guide')).toBeVisible()
  const dropped = mainSavedWith(page, (html) => savedVideoTimings(html).length === 2)
  await page.mouse.up()
  const placed = savedVideoTimings(htmlOf(await dropped)).find((timing) => timing.start > 0)
  if (placed === undefined) throw new Error('没有存下拖进来的镜头')
  // 落在节拍上：左边对着那一拍，开头是鼓点的时间（每 0.5 秒一下，节拍差几毫秒）
  const landed = await row.getByRole('group').nth(1).boundingBox()
  expect(Math.abs((landed?.x ?? 0) - beatX)).toBeLessThan(1.5)
  expect(Math.abs(placed.start * 2 - Math.round(placed.start * 2))).toBeLessThan(0.04)

  // 刷新再打开：节拍从工程里的文件读，画出来了，配乐一次都没解
  await page.reload()
  const reloaded = await openFinalCut(await openConversation(page, '夜景延时素材生成'))
  await expect(marksOf(reloaded)).toBeVisible({ timeout: 15_000 })
  expect(await decodes()).toBe(0)
})

test('按住播放头的竖线拖到片段结尾旁边：吸到结尾、亮吸附线；按住穿过片段的竖线不选中片段、不框选', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const added = mainSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^出片 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  await added

  // 播放头在 0 秒，竖线穿过片段的开头：在片段那一行的高度按住竖线，拖到片段结尾左边 3 像素（片段的结尾就是
  // final-cut 的结尾，拖过头会停在结尾上，看不出吸没吸）
  const lane = editor.getByRole('group', { name: '画面 1', exact: true })
  const box = await lane.getByRole('group').boundingBox()
  const playhead = editor.getByTestId('timeline-playhead')
  const line = await playhead.boundingBox()
  if (box === null || line === null) throw new Error('时间线还没排好')
  const y = box.y + box.height / 2
  // 片段画得比时长窄 2 像素：结尾在框的右边再往右 2 像素
  const end = box.x + box.width + 2
  await page.mouse.move(line.x + line.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(end - 3, y, { steps: 8 })
  await expect(editor.getByTestId('snap-guide')).toBeVisible()
  await expect(editor.getByTestId('marquee')).toHaveCount(0)
  await page.mouse.up()
  await expect(editor.getByTestId('snap-guide')).toHaveCount(0)
  const landed = await playhead.boundingBox()
  expect(Math.abs((landed?.x ?? 0) + (landed?.width ?? 0) / 2 - end)).toBeLessThan(1.5)
  await expect(lane.getByRole('button', { name: /^选中：/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
})

test('分离音频：存下来多一个原声片段、两段属性对；联动着拖原声两段一起挪；关掉联动单独挪出现错开，对齐画面回到同步；合并回视频', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const toolbar = editor.getByRole('toolbar', { name: '剪辑工具' })
  const inspector = editor.getByRole('tabpanel', { name: '属性' })
  const added = mainSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^出片 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  const original = savedElementAttributes(htmlOf(await added), 'video')
  expect(original['data-has-audio']).toBe('true')

  await editor
    .getByRole('group', { name: '画面 1', exact: true })
    .getByRole('button', { name: /^选中：/ })
    .click()
  const detached = mainSavedWith(page, (html) => html.includes('<audio '))
  await toolbar.getByRole('button', { name: '分离音频', exact: true }).click()
  const html = htmlOf(await detached)
  const voice = savedElementAttributes(html, 'audio')
  const shot = savedElementAttributes(html, 'video')
  expect(voice).toMatchObject({
    'data-label': `${original['data-label']} · 原声`,
    src: original['src'],
    'data-start': original['data-start'],
    'data-duration': original['data-duration'],
    'data-media-start': original['data-media-start'],
    'data-volume': '1',
  })
  expect(voice['data-link']).toBeTruthy()
  expect(voice['data-sync-origin']).toBe(voice['data-link'])
  expect(shot).toMatchObject({
    muted: 'true',
    'data-link': voice['data-link'],
    'data-sync-origin': voice['data-link'],
  })
  expect(shot).not.toHaveProperty('data-has-audio')
  expect(shot).not.toHaveProperty('data-volume')
  // 原声在声音区新开的「原声」行里，分离完选中的是它
  const voiceRow = editor.getByRole('group', { name: '原声', exact: true })
  const voiceClip = voiceRow.getByRole('group', { name: /· 原声，/ })
  await expect(voiceClip).toHaveAccessibleName(/，联动$/)
  await expect(inspector.getByTestId('sync-status')).toHaveText('与画面口型同步')

  // 预览：换上分离后的 final-cut、加载完，里面有这段原声，地址就是视频的地址，也不报片段放不出
  const player = await readyPlayer(editor)
  await expect
    .poll(() =>
      player.evaluate((element: HTMLElement & { iframeElement: HTMLIFrameElement }) => {
        const page = element.iframeElement.contentDocument
        const sound = page?.querySelector('audio[data-sync-origin]')?.getAttribute('src')
        const picture = page?.querySelector('video[data-sync-origin]')?.getAttribute('src')
        return sound !== undefined && sound !== null && sound === picture ? sound : null
      }),
    )
    .toContain('sample-video')
  await expect(editor.getByRole('region', { name: '预览' }).getByRole('alert')).toHaveCount(0)

  // 联动开着：拖原声，画面跟着挪同样的距离
  const moved = mainSavedWith(page, (saved) => {
    const start = Number(savedElementAttributes(saved, 'audio')['data-start'])
    return start > 0 && Number(savedElementAttributes(saved, 'video')['data-start']) === start
  })
  await dragClip(page, voiceClip, 120)
  const together = htmlOf(await moved)
  const pairStart = Number(savedElementAttributes(together, 'video')['data-start'])
  expect(savedElementAttributes(together, 'audio')['data-link']).toBe(voice['data-link'])

  // 关掉联动，单独挪原声：画面不动，出现错开
  const unlinked = mainSavedWith(page, (saved) => !saved.includes('data-link'))
  await inspector.getByRole('switch', { name: '联动' }).click()
  await unlinked
  const alone = mainSavedWith(
    page,
    (saved) => Number(savedElementAttributes(saved, 'audio')['data-start']) > pairStart,
  )
  await dragClip(page, voiceClip, 120)
  expect(Number(savedElementAttributes(htmlOf(await alone), 'video')['data-start'])).toBe(pairStart)
  await expect(voiceClip).toHaveAccessibleName(/，错开 \+\d+\.\d+s$/)
  await expect(inspector.getByTestId('sync-status')).toHaveText(/^与画面错开 \+\d+\.\d+ 秒$/)

  // 对齐画面：原声回到画面的位置，联动仍关着
  const synced = mainSavedWith(
    page,
    (saved) => Number(savedElementAttributes(saved, 'audio')['data-start']) === pairStart,
  )
  await inspector.getByRole('button', { name: '对齐画面' }).click()
  expect(htmlOf(await synced)).not.toContain('data-link')
  await expect(inspector.getByTestId('sync-status')).toHaveText('与画面口型同步')

  // 合并回视频：原声片段没了，视频打开原声
  const merged = mainSavedWith(page, (saved) => !saved.includes('<audio '))
  await toolbar.getByRole('button', { name: '合并回视频', exact: true }).click()
  const back = savedElementAttributes(htmlOf(await merged), 'video')
  expect(back).toMatchObject({ 'data-has-audio': 'true', 'data-volume': '1' })
  expect(back).not.toHaveProperty('muted')
  expect(back).not.toHaveProperty('data-sync-origin')
  await expect(editor.getByRole('group', { name: '原声', exact: true })).toHaveCount(0)
})

test('地址带着 ?artifact=final-cut 时直接打开编辑器；正在对话框里打字时不抢焦点', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  // 先有工程（页签只在有主文件时才有），再回到分镜
  const editor = await createFinalCut(panel)
  await panel.getByRole('tab', { name: '分镜', exact: true }).click()
  await expect(editor).toBeHidden()
  const input = page.getByLabel('输入消息')
  await input.click()
  await page.keyboard.type('先剪')
  // 别处把地址换成 final-cut 页签（比如从对话里点开），焦点不动
  await page.evaluate(() => {
    const url = new URL(window.location.href)
    url.searchParams.set('artifact', 'final-cut')
    window.history.pushState(null, '', url)
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await expect(editor.getByRole('toolbar', { name: '剪辑工具' })).toBeVisible()
  await expect(panel.getByRole('tab', { name: 'final-cut' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(input).toBeFocused()
  await page.keyboard.type('一版')
  await expect(input).toContainText('先剪一版')
})

test('焦点在对话框里时空格、Delete、Esc 都不碰剪辑；点编辑器的空白处以后快捷键照常', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const clip = await selectedClip(page, editor)
  const transport = editor.getByRole('group', { name: '播放控制' })

  const input = page.getByLabel('输入消息')
  await input.click()
  await page.keyboard.press(' ')
  await page.keyboard.press('Delete')
  await page.keyboard.press('Escape')
  await page.keyboard.press('[')
  expect(await savesWithin(page, 1_200)).toBe(0)
  await expect(clip).toHaveAttribute('aria-pressed', 'true')
  await expect(transport.getByRole('button', { name: '播放', exact: true })).toBeVisible()
  await expect(input).toBeFocused()

  // 点在预览的空白处（画面外面的角上，躲开舞台的圆角）：焦点落在编辑器的根节点上，快捷键照常
  await editor.getByRole('region', { name: '预览' }).click({ position: { x: 12, y: 12 } })
  await expect(editor).toBeFocused()
  await page.keyboard.press(' ')
  await expect(transport.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
  await page.keyboard.press(' ')
  await expect(transport.getByRole('button', { name: '播放', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(clip).toHaveAttribute('aria-pressed', 'false')
  await clip.click()
  const removed = mainSaved(page, 0)
  await page.keyboard.press('Delete')
  await removed
})

test('编辑器里选中着片段时，侧边栏改名框里的 Esc 照常放弃改名，片段仍选中', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const clip = await selectedClip(page, editor)

  const row = page.getByRole('link', { name: '夜景延时素材生成', exact: true })
  await row.hover()
  await page.getByRole('button', { name: '夜景延时素材生成 的更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
  const rename = page.getByRole('textbox', { name: '重命名 夜景延时素材生成', exact: true })
  await rename.fill('夜景延时 · 改名中')
  await page.keyboard.press('Escape')
  await expect(rename).toHaveCount(0)
  await expect(row).toBeVisible()
  await expect(clip).toHaveAttribute('aria-pressed', 'true')
})

test('文件拖到编辑器上不收，也不落进对话的输入框', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['素材'], '拖进编辑器.png', { type: 'image/png' }))
    return transfer
  })
  const overlay = page.getByTestId('composer-drop-overlay')
  // 拖过对话区时输入框照常提示可以松手
  await page.getByRole('main').dispatchEvent('dragenter', { dataTransfer })
  await expect(overlay).toBeVisible()
  // 拖到编辑器上：输入框不再提示，松手也不收
  const target = editor.getByRole('region', { name: '视频素材区' })
  await target.dispatchEvent('dragover', { dataTransfer })
  await expect(overlay).toBeHidden()
  await target.dispatchEvent('drop', { dataTransfer })
  await expect(overlay).toBeHidden()
  await expect(page.getByText('拖进编辑器.png', { exact: true })).toHaveCount(0)
  await dataTransfer.dispose()
})

test('预览正在播放时折叠工作台：播放停下，展开后停在原处', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const shots = editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
  for (const shot of [1, 2, 3]) {
    const saved = mainSaved(page, shot)
    await shots.getByRole('button', { name: new RegExp(`^出片 A 镜头 ${shot}，`) }).click()
    await page.keyboard.press('Enter')
    await saved
  }
  const player = await readyPlayer(editor)
  // 折叠以后工作台藏起来了，按名字找不到：先拿住播放器
  const handle = await player.elementHandle()
  if (handle === null) throw new Error('预览里没有播放器')
  /** 预览页里正在出声的媒体：没停下的那几个。 */
  const sounding = () =>
    handle.evaluate(
      (element: HTMLElement & { iframeElement: HTMLIFrameElement }) =>
        [...(element.iframeElement.contentDocument?.querySelectorAll('video, audio') ?? [])].filter(
          (media) => !(media as HTMLMediaElement).paused,
        ).length,
    )
  const transport = editor.getByRole('group', { name: '播放控制' })
  await transport.getByRole('button', { name: '播放', exact: true }).click()
  await expect.poll(sounding).toBeGreaterThan(0)

  await panel.hover()
  await panel.getByRole('button', { name: '折叠工作台' }).click()
  await expect(panel).toBeHidden()
  await expect.poll(sounding).toBe(0)

  await page.getByRole('button', { name: '展开工作台' }).click()
  await expect(transport.getByRole('button', { name: '播放', exact: true })).toBeVisible()
  await expect.poll(sounding).toBe(0)
})

test('改完马上切到别的页签再切回来：改动还在，接着改照常保存', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const materials = editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
  // 加进去以后不等停下来保存就切走：切走时存，切回来等它存完再读
  const first = mainSaved(page, 1)
  await materials.getByRole('button', { name: /^出片 A 镜头 1，/ }).click()
  await page.keyboard.press('Enter')
  const row = editor.getByRole('group', { name: '画面 1', exact: true })
  await expect(row.getByRole('button', { name: /^选中：/ })).toHaveCount(1)
  await panel.getByRole('tab', { name: '分镜' }).click()
  await first
  const back = await openFinalCut(panel)
  await expect(
    back
      .getByRole('group', { name: '画面 1', exact: true })
      .getByRole('button', { name: /^选中：/ }),
  ).toHaveCount(1)

  const second = mainSaved(page, 2)
  await back
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^出片 A 镜头 3，/ })
    .click()
  await page.keyboard.press('Enter')
  await second
  await expect(page.getByText(/已在别处修改/)).toHaveCount(0)
})

test('新建工程、加镜头和一个元素：条目文件拷进工程，刷新页面后都还在，预览里画出了元素', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const createdFiles: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/final-cut/files'))
      createdFiles.push((request.postDataJSON() as { path: string }).path)
  })
  const panel = await openConversation(page, '夜景延时素材生成')
  // 「新建 final-cut」按 1080×1920 的空模版建主文件，之后加的东西都按版本写进它
  const created = page.waitForRequest(
    (request) => savedHtmlOf(request) !== null && request.method() === 'POST',
  )
  const editor = await createFinalCut(panel)
  const template = htmlOf(await created)
  expect(template).toContain('data-width="1080" data-height="1920"')
  expect(template).not.toContain('<video ')
  const first = mainSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^出片 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  expect((await first).method()).toBe('PUT')
  expect((await first).postDataJSON()).toMatchObject({ expectedVersion: 1 })

  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '元素' }).click()
  await side.getByRole('searchbox', { name: '搜索元素' }).fill('叠加')
  const card = side.getByRole('group', { name: '测试叠加，4 秒' })
  const added = mainSavedWith(page, (html) => savedItem(html, '测试叠加') !== null)
  await card.hover()
  await card.getByRole('button', { name: '加到播放头' }).click()
  const saved = await added
  const placed = savedItem(htmlOf(saved), '测试叠加')
  expect(placed).toMatchObject({ item: 'fixture-overlay', duration: 4 })
  expect(createdFiles).toEqual(['index.html', 'compositions/fixtures/fixture-overlay.html'])

  // 刷新整页：工程从工作区读回来，镜头和元素都还在。等这次保存有了答复再刷新——请求刚发出就刷新，这一版还没存下来
  await saved.response()
  await page.reload()
  const reloaded = await openFinalCut(await openConversation(page, '夜景延时素材生成'))
  await expect(
    reloaded
      .getByRole('group', { name: '画面 1', exact: true })
      .getByRole('button', { name: /^选中：/ }),
  ).toHaveCount(1)
  await expect(reloaded.getByRole('group', { name: '测试叠加，4.0 秒' })).toBeVisible()

  // 预览里的元素：组件文件凭令牌从工程取，画出了组件里的圆环
  const player = await readyPlayer(reloaded)
  await expect
    .poll(() =>
      player.evaluate((element: HTMLElement & { iframeElement: HTMLIFrameElement }, id) => {
        const host = element.iframeElement.contentDocument?.getElementById(id)
        return host !== null && host !== undefined && host.querySelector('.fo-ring') !== null
      }, placed?.id ?? ''),
    )
    .toBe(true)
})

/** 画面右上角的胶囊平时只露出参考线开关：鼠标移上去，画面尺寸才展开、点得到。 */
const unfoldStageHud = (editor: Locator) =>
  editor.getByRole('button', { name: '参考线', exact: true }).hover()

test('新建工程后在画面右上角把画面尺寸改成横屏：存下的主文件根上是 1920×1080，刷新页面后仍是横屏', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  await unfoldStageHud(editor)
  await editor.getByRole('button', { name: '画面尺寸 9:16 · 1080P', exact: true }).click()
  const sizes = editor
    .getByRole('dialog', { name: '画面设置' })
    .getByRole('group', { name: '画面比例' })
  await expect(sizes.getByRole('button', { name: '9:16', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  const saved = mainSavedWith(page, (html) =>
    /<div [^>]*id="film"[^>]*data-width="1920" data-height="1080"/.test(html),
  )
  await sizes.getByRole('button', { name: '16:9', exact: true }).click()
  const html = htmlOf(await saved)
  expect(html).toContain('<meta name="viewport" content="width=1920, height=1080">')

  // 等这次保存有了答复再刷新：请求刚发出就刷新，这一版还没存下来
  await (await saved).response()
  await page.reload()
  const reloaded = await openFinalCut(await openConversation(page, '夜景延时素材生成'))
  await unfoldStageHud(reloaded)
  await reloaded.getByRole('button', { name: '画面尺寸 16:9 · 1080P', exact: true }).click()
  const reloadedSizes = reloaded
    .getByRole('dialog', { name: '画面设置' })
    .getByRole('group', { name: '画面比例' })
  await expect(reloadedSizes.getByRole('button', { name: '16:9', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(reloadedSizes.getByRole('button', { name: '9:16', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
})

test('导出分辨率：选 720P 后胶囊写「· 720P」、像素尺寸不变，导出带 720p，刷新后还是 720P；改成 3:4 后 480P、720P 置灰、1080P 亮，导出不带档位', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const added = mainSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^出片 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  await added

  const pill = editor.getByRole('button', { name: /^画面尺寸/ })
  const settings = editor.getByRole('dialog', { name: '画面设置' })
  await unfoldStageHud(editor)
  await pill.click()
  // 第一段视频进来时画面跟着视频改过尺寸，先定成 1080×1920
  await settings
    .getByRole('group', { name: '画面比例' })
    .getByRole('button', { name: '9:16', exact: true })
    .click()
  const tiers = settings.getByRole('group', { name: '导出分辨率' })
  await tiers.getByRole('button', { name: '720P', exact: true }).click()
  await expect(tiers.getByRole('button', { name: '720P', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(pill).toHaveAccessibleName('画面尺寸 9:16 · 720P')
  await expect(settings.getByRole('textbox', { name: '宽' })).toHaveValue('1080')
  await expect(settings.getByRole('textbox', { name: '高' })).toHaveValue('1920')
  await page.keyboard.press('Escape')

  const started = page.waitForRequest(
    (request) => request.url().endsWith('/whole-film/exports') && request.method() === 'POST',
  )
  await panel.getByRole('button', { name: '导出', exact: true }).click()
  expect((await started).postDataJSON()).toEqual({ locale: null, resolution: '720p' })
  await expect(panel.getByRole('status').filter({ hasText: /720P/ })).toBeVisible()

  // 选的档位记在浏览器里（mock 的导出记录刷新后就没了，按钮回到「导出」）
  await page.reload()
  const reopenedPanel = await openConversation(page, '夜景延时素材生成')
  const reopened = await openFinalCut(reopenedPanel)
  const reopenedPill = reopened.getByRole('button', { name: /^画面尺寸/ })
  await expect(reopenedPill).toHaveAccessibleName('画面尺寸 9:16 · 720P')

  await unfoldStageHud(reopened)
  await reopenedPill.click()
  const reopenedSettings = reopened.getByRole('dialog', { name: '画面设置' })
  const resized = mainSavedWith(page, (html) =>
    /<div [^>]*id="film"[^>]*data-width="1080" data-height="1440"/.test(html),
  )
  await reopenedSettings
    .getByRole('group', { name: '画面比例' })
    .getByRole('button', { name: '3:4', exact: true })
    .click()
  await resized
  const reopenedTiers = reopenedSettings.getByRole('group', { name: '导出分辨率' })
  for (const name of ['480P', '720P'])
    await expect(reopenedTiers.getByRole('button', { name, exact: true })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  await expect(reopenedTiers.getByRole('button', { name: '1080P', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.keyboard.press('Escape')

  const restarted = page.waitForRequest(
    (request) => request.url().endsWith('/whole-film/exports') && request.method() === 'POST',
  )
  await reopenedPanel.getByRole('button', { name: '导出', exact: true }).click()
  expect((await restarted).postDataJSON()).toEqual({ locale: null })
})

test('画面右上角的胶囊平时只露出参考线开关：鼠标移上去画面尺寸才展开，画面设置开着时鼠标移进浮层也不收；点外面关掉浮层、鼠标点过参考线开关再移开都收起', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const pill = editor.getByRole('button', { name: /^画面尺寸/ })
  const guides = editor.getByRole('button', { name: '参考线', exact: true })
  const settings = editor.getByRole('dialog', { name: '画面设置' })
  // 收起时按钮还在、名字不变，只是看不见
  await expect(pill).toHaveAccessibleName('画面尺寸 9:16 · 1080P')
  await expect(pill).toBeHidden()
  await expect(guides).toBeVisible()

  await guides.hover()
  await expect(pill).toBeVisible()
  await pill.click()
  await expect(settings).toBeVisible()
  await settings.getByRole('group', { name: '画面比例' }).hover()
  // 等胶囊的过渡走完再看：要收起的话这时已经收了
  await pill.evaluate((button) =>
    Promise.all(
      (button.parentElement?.getAnimations({ subtree: true }) ?? []).map(
        (animation) => animation.finished,
      ),
    ),
  )
  await expect(pill).toBeVisible()

  // 点舞台左边的空处关掉浮层，鼠标留在那里
  const stage = await boxOf(editor.getByRole('region', { name: '预览', exact: true }))
  const away = { x: stage.x + 40, y: stage.y + stage.height / 2 }
  await page.mouse.click(away.x, away.y)
  await expect(settings).toBeHidden()
  await expect(pill).toBeHidden()

  // 鼠标点一下参考线开关：焦点留在开关上，鼠标移开就收起
  await guides.click()
  await expect(guides).toHaveAttribute('aria-pressed', 'true')
  await page.mouse.move(away.x, away.y)
  await expect(guides).toBeFocused()
  await expect(pill).toBeHidden()
})

const CAPTIONS_FILE = 'compositions/captions.html'

/** mock 的预览域名不存工程文件（只转到组件库里的同名文件）：字幕场景照后端，答复编辑器最近存下的那一份。 */
const serveSavedCaptions = async (page: Page) => {
  let storedScene: string | null = null
  page.on('request', (request) => {
    storedScene = savedFileOf(request, CAPTIONS_FILE) ?? storedScene
  })
  await page.route(`**/api/final-cut/preview/*/files/${CAPTIONS_FILE}`, (route) =>
    route.fulfill(
      storedScene === null
        ? { status: 404, json: { detail: 'final-cut 工程中不存在该文件' } }
        : {
            status: 200,
            contentType: 'text/html; charset=utf-8',
            headers: { 'Cache-Control': 'no-store' },
            body: storedScene,
          },
    ),
  )
}

test('字幕：在「字幕」页签加一句、改字，字幕文件和主文件都存对了，预览里这个时间点看得到改过的字', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await serveSavedCaptions(page)
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const first = mainSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^出片 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  await first

  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '字幕' }).click()
  const tab = side.getByRole('tabpanel', { name: '字幕' })
  await expect(tab.getByText(/暂无字幕/)).toBeVisible()
  const sceneWith = (text: string) =>
    page.waitForRequest((request) => savedFileOf(request, CAPTIONS_FILE)?.includes(text) === true)
  const created = sceneWith('</template>')
  await tab.getByRole('button', { name: '在播放头处添加字幕' }).click()
  const field = tab.getByRole('textbox', { name: '字幕文字 00:00.00 – 00:02.00' })
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('新字幕')
  await created

  const sceneSaved = sceneWith('>改过的字幕</div>')
  const mainWithText = mainSavedWith(page, (html) => html.includes('改过的字幕'))
  await field.fill('改过的字幕')
  const scene = savedFileOf(await sceneSaved, CAPTIONS_FILE) ?? ''
  const main = htmlOf(await mainWithText)

  // 场景文件：<template> 包着，这句字幕读一个变量，场景自己不声明变量
  expect(scene.trim().startsWith('<template>')).toBe(true)
  expect(scene).not.toContain('data-composition-variables')
  const element = /<div id="(cap-[^"]+)"[^>]* data-var-text="([^"]+)">改过的字幕<\/div>/.exec(scene)
  const [, captionId = '', variable = ''] = element ?? []
  expect(element).not.toBeNull()
  // 主文件：根上声明了这个变量、字是默认值；字幕宿主挂载场景文件，不带取值
  const declared = await page.evaluate((html) => {
    const document = new DOMParser().parseFromString(html, 'text/html')
    const host = document.getElementById('captions')
    return {
      variables: JSON.parse(
        document.documentElement.getAttribute('data-composition-variables') ?? '[]',
      ) as { id: string; default: string }[],
      host:
        host === null
          ? null
          : Object.fromEntries([...host.attributes].map((item) => [item.name, item.value])),
    }
  }, main)
  expect(declared.variables).toEqual([
    expect.objectContaining({ id: variable, default: '改过的字幕' }),
  ])
  expect(declared.host).toMatchObject({
    'data-composition-src': CAPTIONS_FILE,
    'data-no-timeline': '',
  })
  expect(declared.host).not.toHaveProperty('data-variable-values')

  // 预览：场景从工程里取，这句字幕在第 0 秒显示改过的字，在画面靠下的地方、盖在视频上面
  const player = await readyPlayer(editor)
  await expect
    .poll(() =>
      player.evaluate((element: HTMLElement & { iframeElement: HTMLIFrameElement }, id) => {
        const page = element.iframeElement.contentDocument
        const caption = page?.getElementById(id)
        const root = page?.getElementById('film')
        if (!page || !caption || !root) return null
        const box = caption.getBoundingClientRect()
        const frame = root.getBoundingClientRect()
        const style = page.defaultView?.getComputedStyle(caption)
        const hit = page.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return {
          text: caption.textContent,
          shown: style?.visibility !== 'hidden' && style?.display !== 'none' && box.height > 0,
          low: (box.top + box.height / 2 - frame.top) / frame.height > 0.8,
          onTop: hit !== null && caption.contains(hit),
        }
      }, captionId),
    )
    .toEqual({ text: '改过的字幕', shown: true, low: true, onTop: true })
})

/**
 * 预览里正在显示的播放器里的那句字幕：字、起点、播放头这一刻看不看得到，和字里的中文是不是都有加载好的网页字体
 * （粗体）的字形；换播放器的那一刻或没有字幕时是 null。
 */
const previewCaption = (editor: Locator) =>
  finalCutPreviewPlayer(editor).evaluateAll((elements) => {
    if (elements.length !== 1) return null
    const [element] = elements as (HTMLElement & { iframeElement: HTMLIFrameElement })[]
    const caption = element?.iframeElement.contentDocument?.querySelector('.caption')
    if (caption === null || caption === undefined) return null
    const style = caption.ownerDocument.defaultView?.getComputedStyle(caption)
    const faces = [...caption.ownerDocument.fonts].filter(
      (face) => face.status === 'loaded' && face.weight === '700',
    )
    const covers = (face: FontFace, code: number) =>
      face.unicodeRange.split(',').some((range) => {
        const [from = '', to = from] = range.trim().replace(/^U\+/i, '').split('-')
        return parseInt(from, 16) <= code && code <= parseInt(to, 16)
      })
    const text = caption.textContent
    return {
      text,
      start: caption.getAttribute('data-start'),
      shown:
        style?.visibility !== 'hidden' &&
        style?.display !== 'none' &&
        caption.getBoundingClientRect().height > 0,
      glyphs: [...text]
        .map((char) => char.codePointAt(0) ?? 0)
        .filter((code) => code > 0x7e)
        .every((code) => faces.some((face) => covers(face, code))),
    }
  })

test('字幕的改动直接打进预览：改一句的字、挪一句都不换播放器，还没存时预览里已经是新的；撤销回来也对', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  // 预览里的字幕场景是编辑器发过去的那一份，不从预览域名取工作区里存着的
  const sceneFetched: string[] = []
  page.on('request', (request) => {
    if (request.url().includes(`/files/${CAPTIONS_FILE}`)) sceneFetched.push(request.url())
  })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const toolbar = editor.getByRole('toolbar', { name: '剪辑工具' })
  // 整条素材放进 final-cut：字幕在它里面挪，总长不变
  await addWholeTake(page, editor)

  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '字幕' }).click()
  const tab = side.getByRole('tabpanel', { name: '字幕' })
  const created = page.waitForRequest(
    (request) => savedFileOf(request, CAPTIONS_FILE)?.includes('>新字幕</div>') === true,
  )
  await tab.getByRole('button', { name: '在播放头处添加字幕' }).click()
  await created
  // 第一句连着字幕宿主一起加进来，整份重新加载一次
  await readyPlayer(editor)
  await expect
    .poll(() => previewCaption(editor))
    .toEqual({ text: '新字幕', start: '0', shown: true, glyphs: true })
  await markFinalCutPreviewPlayer(editor)

  // 之后的改动都存不下去，预览里看到的只能是编辑器手里没存的那一份
  await pauseMockResponses(page, '/workspace/file')
  // 「龙」是新字形：字体块跟着变，新的中文字体规则随补丁换进预览
  await tab.getByRole('textbox', { name: '字幕文字 00:00.00 – 00:02.00' }).fill('新字幕龙')
  await expect
    .poll(() => previewCaption(editor))
    .toEqual({ text: '新字幕龙', start: '0', shown: true, glyphs: true })
  expect(await isMarkedFinalCutPreviewPlayer(editor)).toBe(true)

  const body = editor
    .getByRole('group', { name: '字幕', exact: true })
    .getByRole('group', { name: /^新字幕龙，/ })
    .getByRole('button', { name: /^选中：/ })
  await dragClip(page, body, 60)
  await expect.poll(async () => Number((await previewCaption(editor))?.start)).toBeGreaterThan(0)
  // 播放头还在 0 秒：挪走以后这一刻看不到
  await expect.poll(async () => (await previewCaption(editor))?.shown).toBe(false)
  expect(await isMarkedFinalCutPreviewPlayer(editor)).toBe(true)

  // 撤销两步：先挪回 0 秒，再回到原来的字
  await toolbar.getByRole('button', { name: '撤销' }).click()
  await expect
    .poll(() => previewCaption(editor))
    .toEqual({ text: '新字幕龙', start: '0', shown: true, glyphs: true })
  await toolbar.getByRole('button', { name: '撤销' }).click()
  await expect
    .poll(() => previewCaption(editor))
    .toEqual({ text: '新字幕', start: '0', shown: true, glyphs: true })
  expect(await isMarkedFinalCutPreviewPlayer(editor)).toBe(true)
  expect(sceneFetched).toEqual([])
  await releaseMockResponses(page, '/workspace/file')
})

/** 存出的字幕场景里各句的起点和时长（秒），按文件里的先后。 */
const savedCaptionTimings = (scene: string) =>
  [
    ...scene.matchAll(/<div id="cap-[^"]+"[^>]* data-start="([\d.]+)" data-duration="([\d.]+)"/g),
  ].map(([, start, duration]) => ({ start: Number(start), duration: Number(duration) }))

/** 字幕列表里写的时间：分:秒，秒带两位小数。 */
const captionClock = (seconds: number) => {
  const hundredths = Math.round(seconds * 100)
  const minutes = String(Math.floor(hundredths / 6000)).padStart(2, '0')
  return `${minutes}:${((hundredths % 6000) / 100).toFixed(2).padStart(5, '0')}`
}

test('字幕行：拖一句挪位置、拖结尾裁短，存下来的字幕场景里时间对；整行隐藏后预览里不出字幕，显示回来又有', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await serveSavedCaptions(page)
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const added = mainSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^出片 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  await added

  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '字幕' }).click()
  const tab = side.getByRole('tabpanel', { name: '字幕' })
  const sceneSavedWith = (check: (scene: string) => boolean) =>
    page.waitForRequest((request) => {
      const scene = savedFileOf(request, CAPTIONS_FILE)
      return scene !== null && check(scene)
    })
  const created = sceneSavedWith((scene) => savedCaptionTimings(scene).length === 1)
  await tab.getByRole('button', { name: '在播放头处添加字幕' }).click()
  await created

  // 加上的那一句是选中的：时间线上「字幕」一行里有它、带着两端的把手，侧栏还停在「字幕」页签
  const row = editor.getByRole('group', { name: '字幕', exact: true })
  const clip = row.getByRole('group', { name: /^新字幕，/ })
  const body = clip.getByRole('button', { name: /^选中：/ })
  await expect(body).toHaveAttribute('aria-pressed', 'true')
  await expect(tab).toBeVisible()
  /** 列表里写着这段时间的那一句的时间按钮。 */
  const timeButton = (timing: { start: number; duration: number }) =>
    tab.getByRole('button', {
      name: `${captionClock(timing.start)} – ${captionClock(timing.start + timing.duration)}`,
      exact: true,
    })
  /** 列表里这一句写的时间和存下来的一样。 */
  const listed = (timing: { start: number; duration: number }) =>
    expect(timeButton(timing)).toBeVisible()

  // 往右拖：整句挪过去，时长不变
  const moved = sceneSavedWith((scene) => (savedCaptionTimings(scene)[0]?.start ?? 0) > 0)
  await dragClip(page, body, 120)
  const [after] = savedCaptionTimings(savedFileOf(await moved, CAPTIONS_FILE) ?? '')
  if (after === undefined) throw new Error('字幕没了')
  expect(after.start).toBeGreaterThan(1)
  expect(after.duration).toBe(2)
  await listed(after)

  // 往左拖结尾的把手：开头不动，变短
  const trimmed = sceneSavedWith((scene) => (savedCaptionTimings(scene)[0]?.duration ?? 2) < 2)
  await dragClip(page, clip.getByRole('slider', { name: '裁剪结尾' }), -20)
  const [shorter] = savedCaptionTimings(savedFileOf(await trimmed, CAPTIONS_FILE) ?? '')
  if (shorter === undefined) throw new Error('字幕没了')
  expect(shorter.start).toBe(after.start)
  expect(shorter.duration).toBeGreaterThan(0.1)
  await listed(shorter)

  // 点列表里这一句的时间：播放头到它的开始，预览里这时看得到字幕；隐藏整行后看不到
  await timeButton(shorter).click()
  const player = await readyPlayer(editor)
  // 改了主文件预览会换一个播放器重新加载，换的那一刻页面里有两个：等只剩一个再看
  const shown = () =>
    player.evaluateAll((elements) => {
      if (elements.length !== 1) return null
      const [element] = elements as (HTMLElement & { iframeElement: HTMLIFrameElement })[]
      const caption = element?.iframeElement.contentDocument?.querySelector('.caption')
      // 隐藏的字幕宿主不进预览
      if (caption === null || caption === undefined) return false
      const style = caption.ownerDocument.defaultView?.getComputedStyle(caption)
      const box = caption.getBoundingClientRect()
      return style?.visibility !== 'hidden' && style?.display !== 'none' && box.height > 0
    })
  await expect.poll(shown).toBe(true)
  const hidden = mainSavedWith(page, (html) =>
    /<div data-hidden="" id="captions"|<div [^>]*id="captions"[^>]* data-hidden=""/.test(html),
  )
  await editor.getByRole('button', { name: '隐藏字幕' }).click()
  await hidden
  await expect.poll(shown).toBe(false)
  // 再显示回来：播放头没动，又看得到了
  await editor.getByRole('button', { name: '显示字幕' }).click()
  await expect.poll(shown).toBe(true)
})

/** 存出的字幕场景里各句的字、起点（秒）和属于哪个视频片段，按文件里的先后。 */
const savedCaptionLines = (scene: string) =>
  [...scene.matchAll(/<div id="cap-[^"]+"([^>]*)>([^<]*)<\/div>/g)].map(
    ([, attributes = '', text]) => ({
      text,
      start: Number(/ data-start="([\d.]+)"/.exec(attributes)?.[1]),
      owner: / data-caption-of="([^"]+)"/.exec(attributes)?.[1] ?? null,
    }),
  )

test('识别字幕：点「识别字幕」发起一次识别，识别完写进字幕场景、属于那个视频片段；拖这个视频片段，字幕跟着挪', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  // 这段对话里还没有字幕识别记录：点了会真的发起识别（模拟环境里几秒后识别出两句）
  const panel = await openConversation(page, '工具过程展示')
  const editor = await createFinalCut(panel)
  // 整条素材放进 final-cut，两句话都在里面
  const added = await addWholeTake(page, editor)
  const videoId = /<video [^>]*id="([^"]+)"/.exec(htmlOf(added))?.[1]
  expect(videoId).toBeDefined()

  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '字幕' }).click()
  const tab = side.getByRole('tabpanel', { name: '字幕' })
  const sceneSavedWith = (check: (lines: ReturnType<typeof savedCaptionLines>) => boolean) =>
    page.waitForRequest((request) => {
      const scene = savedFileOf(request, CAPTIONS_FILE)
      return scene !== null && check(savedCaptionLines(scene))
    })
  const submitted: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/generations/subtitles'))
      submitted.push(request.url())
  })
  const recognized = sceneSavedWith((lines) => lines.length === 2)
  await tab.getByRole('button', { name: '识别字幕', exact: true }).click()
  await expect(tab.getByRole('button', { name: '识别中…', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await expect(tab.getByText('正在识别 1 个视频片段的字幕，可继续编辑')).toBeVisible()
  const lines = savedCaptionLines(savedFileOf(await recognized, CAPTIONS_FILE) ?? '')
  expect(lines).toEqual([
    { text: '夜色里，城市慢慢亮起来', start: 0.3, owner: videoId },
    { text: '车流划出一道道光', start: 2.4, owner: videoId },
  ])
  expect(submitted).toHaveLength(1)
  await expect(tab.getByRole('listitem')).toHaveCount(2)
  // 这个片段已经有字幕了：不再识别
  await expect(tab.getByRole('button', { name: '识别字幕', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  )

  // 往右拖视频片段：两句字幕挪同样的时间
  const moved = sceneSavedWith((saved) => (saved[0]?.start ?? 0) > 0.3)
  const mainMoved = mainSavedWith(page, (html) => (savedVideoTimings(html)[0]?.start ?? 0) > 0)
  const clip = editor.getByRole('group', { name: '画面 1', exact: true }).getByRole('group')
  await dragClip(page, clip.getByRole('button', { name: /^选中：/ }), 120)
  const [video] = savedVideoTimings(htmlOf(await mainMoved))
  const after = savedCaptionLines(savedFileOf(await moved, CAPTIONS_FILE) ?? '')
  if (video === undefined) throw new Error('视频片段没了')
  expect(video.start).toBeGreaterThan(0)
  expect(after).toHaveLength(2)
  expect(after[0]?.start).toBeCloseTo(0.3 + video.start, 3)
  expect(after[1]?.start).toBeCloseTo(2.4 + video.start, 3)
})

const ENGLISH_FILE = 'locales/en.json'

test('语言：加上 English 切过去，给一句字幕写英文，存下的 English 值表对、预览里显示英文；切回原文显示原文', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await serveSavedCaptions(page)
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const added = mainSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^出片 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  await added

  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '字幕' }).click()
  const tab = side.getByRole('tabpanel', { name: '字幕' })
  const sceneCreated = page.waitForRequest(
    (request) => savedFileOf(request, CAPTIONS_FILE)?.includes('data-var-text') === true,
  )
  await tab.getByRole('button', { name: '在播放头处添加字幕' }).click()
  const scene = savedFileOf(await sceneCreated, CAPTIONS_FILE) ?? ''
  const variable = / data-var-text="([^"]+)"/.exec(scene)?.[1] ?? ''
  expect(variable).not.toBe('')

  // 「+」里选 English：建一份空的值表，切过去
  const languages = editor.getByRole('group', { name: '语言' })
  const created = page.waitForRequest((request) => savedFileOf(request, ENGLISH_FILE) !== null)
  await languages.getByRole('button', { name: '添加语言' }).click()
  await page.getByRole('menuitem', { name: 'English（EN）' }).click()
  expect(JSON.parse(savedFileOf(await created, ENGLISH_FILE) ?? '')).toEqual({})
  await expect(languages.getByRole('button', { name: 'English（EN）' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  // 其它语言下框里是空的、占位字提示输入英文，下面写着原文；加一句置灰
  const field = tab.getByRole('textbox', { name: '字幕文字 00:00.00 – 00:02.00' })
  await expect(field).toHaveValue('')
  await expect(field).toHaveAttribute('placeholder', '输入 English 字幕…')
  await expect(field).toHaveAccessibleDescription('原文 新字幕')
  await expect(tab.getByRole('button', { name: '在播放头处添加字幕' })).toHaveAttribute(
    'aria-disabled',
    'true',
  )

  const translated = page.waitForRequest(
    (request) => savedFileOf(request, ENGLISH_FILE)?.includes('Hello world') === true,
  )
  await field.fill('Hello world')
  expect(JSON.parse(savedFileOf(await translated, ENGLISH_FILE) ?? '')).toEqual({
    [variable]: 'Hello world',
  })

  // 预览：这时第 0 秒显示英文；改了值以后预览会换一个播放器重新加载，换的那一刻有两个，等只剩一个再看
  const player = await readyPlayer(editor)
  const captionText = () =>
    player.evaluateAll((elements) => {
      if (elements.length !== 1) return null
      const [element] = elements as (HTMLElement & { iframeElement: HTMLIFrameElement })[]
      return element?.iframeElement.contentDocument?.querySelector('.caption')?.textContent ?? null
    })
  await expect.poll(captionText).toBe('Hello world')

  await languages.getByRole('button', { name: '原文' }).click()
  await expect(field).toHaveValue('新字幕')
  await expect.poll(captionText).toBe('新字幕')
})

test('其它语言下改一句的译文直接打进预览：不换播放器，这一句显示新的字；切走再切回来整份重新加载后也是它', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await serveSavedCaptions(page)
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const added = mainSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^出片 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  await added
  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '字幕' }).click()
  const tab = side.getByRole('tabpanel', { name: '字幕' })
  const sceneCreated = page.waitForRequest(
    (request) => savedFileOf(request, CAPTIONS_FILE)?.includes('data-var-text') === true,
  )
  await tab.getByRole('button', { name: '在播放头处添加字幕' }).click()
  await sceneCreated
  const languages = editor.getByRole('group', { name: '语言' })
  const created = page.waitForRequest((request) => savedFileOf(request, ENGLISH_FILE) !== null)
  await languages.getByRole('button', { name: '添加语言' }).click()
  await page.getByRole('menuitem', { name: 'English（EN）' }).click()
  await created
  const field = tab.getByRole('textbox', { name: '字幕文字 00:00.00 – 00:02.00' })
  const written = page.waitForRequest(
    (request) => savedFileOf(request, ENGLISH_FILE)?.includes('Hello world') === true,
  )
  await field.fill('Hello world')
  await written
  const shownText = async () => (await previewCaption(editor))?.text
  await expect.poll(shownText).toBe('Hello world')
  await settledPlayer(editor)
  await markFinalCutPreviewPlayer(editor)

  await field.fill('Hello again')
  await expect.poll(shownText).toBe('Hello again')
  expect(await isMarkedFinalCutPreviewPlayer(editor)).toBe(true)

  // 同样的文件整份重新加载（切到原文再切回来）：显示的还是这句译文
  await languages.getByRole('button', { name: '原文' }).click()
  await expect.poll(shownText).toBe('新字幕')
  await languages.getByRole('button', { name: 'English（EN）' }).click()
  await expect.poll(shownText).toBe('Hello again')
})

test('其它语言下挪一句、裁一句、改一句的字色直接打进预览：不换播放器，这一句的起止和字色是新的、字还是译文；整份重新加载后一样', async ({
  page,
}) => {
  await serveSavedCaptions(page)
  const { editor, side, row, second } = await openWithCaptions(page)
  const languages = editor.getByRole('group', { name: '语言' })
  await languages.getByRole('button', { name: '添加语言' }).click()
  await page.getByRole('menuitem', { name: 'English（EN）' }).click()
  const translated = page.waitForRequest(
    (request) => (savedFileOf(request, ENGLISH_FILE)?.match(/\[EN\]/g) ?? []).length === 2,
  )
  await side
    .getByRole('tabpanel', { name: '字幕' })
    .getByRole('button', { name: '翻译', exact: true })
    .click()
  await translated
  const translatedNotice = page.getByText('已翻译 2 条')
  await expect(translatedNotice).toBeVisible()
  /** 预览里第二句的字、字色和起止（播放头不在它里面时也读得到）；换播放器的那一刻是 null。 */
  const shownSecond = () =>
    finalCutPreviewPlayer(editor).evaluateAll((elements, id) => {
      if (elements.length !== 1) return null
      const [element] = elements as PreviewPlayer[]
      const found = element?.iframeElement.contentDocument?.getElementById(id)
      if (found === null || found === undefined) return null
      return {
        text: found.textContent,
        color: found.ownerDocument.defaultView?.getComputedStyle(found).color,
        start: found.getAttribute('data-start'),
        duration: found.getAttribute('data-duration'),
      }
    }, second)
  await expect
    .poll(shownSecond)
    .toEqual({ text: '[EN] 第二句', color: 'rgb(255, 255, 255)', start: '2', duration: '2' })
  await settledPlayer(editor)
  await markFinalCutPreviewPlayer(editor)

  const sceneSavedWith = (check: (scene: string) => boolean) =>
    page.waitForRequest((request) => {
      const scene = savedFileOf(request, CAPTIONS_FILE)
      return scene !== null && check(scene)
    })
  const timingOf = (scene: string) =>
    savedCaptionTimings(scene).find((timing) => timing.start >= 2) ?? { start: 0, duration: 0 }
  const clip = row.getByRole('group', { name: /第二句，/ })
  const moved = sceneSavedWith((scene) => timingOf(scene).start > 2)
  // 翻译完的提示条（4 秒后消失）盖在时间线的字幕行上，按下去会按在提示条上：等它消失再拖
  await expect(translatedNotice).toBeHidden({ timeout: 10_000 })
  await dragClip(page, clip.getByRole('button', { name: /^选中：/ }), 30)
  const after = timingOf(savedFileOf(await moved, CAPTIONS_FILE) ?? '')
  const trimmed = sceneSavedWith((scene) => timingOf(scene).duration < 2)
  await dragClip(page, clip.getByRole('slider', { name: '裁剪结尾' }), -20)
  const shorter = timingOf(savedFileOf(await trimmed, CAPTIONS_FILE) ?? '')
  expect(shorter.start).toBe(after.start)

  await clip.getByRole('button', { name: /^选中：/ }).click()
  await side.getByRole('tab', { name: '属性' }).click()
  const inspector = side.getByRole('tabpanel', { name: '属性' })
  const owned = sceneSavedWith((scene) =>
    new RegExp(`<div style="[^"]*color: #ffffff;[^"]*" id="${second}"`).test(scene),
  )
  await inspector.getByRole('switch', { name: '单独设置' }).click()
  await owned
  const colored = sceneSavedWith((scene) =>
    new RegExp(`<div style="[^"]*color: #ff3366;[^"]*" id="${second}"`).test(scene),
  )
  await inspector.getByRole('textbox', { name: '颜色' }).fill('#ff3366')
  await colored
  const live = {
    text: '[EN] 第二句',
    color: 'rgb(255, 51, 102)',
    start: String(shorter.start),
    duration: String(shorter.duration),
  }
  await expect.poll(shownSecond).toEqual(live)
  expect(await isMarkedFinalCutPreviewPlayer(editor)).toBe(true)

  // 同样的文件整份重新加载（切到原文再切回来）：和直接打进去的一样
  await languages.getByRole('button', { name: '原文' }).click()
  await expect.poll(async () => (await shownSecond())?.text).toBe('第二句')
  await languages.getByRole('button', { name: 'English（EN）' }).click()
  await expect.poll(shownSecond).toEqual(live)
})

test('按语言导出：切到 English 点「导出」，提示写导出 English 版，发出的请求带 locale en，导出的状态写 English 版', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const added = mainSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^出片 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  await added

  const languages = editor.getByRole('group', { name: '语言' })
  await languages.getByRole('button', { name: '添加语言' }).click()
  await page.getByRole('menuitem', { name: 'English（EN）' }).click()
  await expect(languages.getByRole('button', { name: 'English（EN）' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )

  const exportButton = panel.getByRole('button', { name: '导出', exact: true })
  await exportButton.hover()
  await expect(page.getByRole('tooltip', { name: '导出 English 版' })).toBeVisible()
  const started = page.waitForRequest(
    (request) => request.url().endsWith('/whole-film/exports') && request.method() === 'POST',
  )
  await exportButton.click()
  expect((await started).postDataJSON()).toEqual({ locale: 'en' })
  await expect(panel.getByRole('status').filter({ hasText: /English 版/ })).toBeVisible()
})

/** 存出的主文件里一个属性的值（双引号里、`&quot;` 换回引号）；`tag` 是元素的开始标签。 */
const jsonAttribute = (tag: string, name: string): unknown => {
  const value = new RegExp(` ${name}="([^"]*)"`).exec(tag)?.[1]
  return value === undefined ? undefined : JSON.parse(value.replaceAll('&quot;', '"'))
}

test('元素的文字随语言：加上 English 时主文件里宿主记着根变量、根上声明了它，在「画面文字」里给原文是中文的字段写英文，English 值表里是英文，预览里元素显示英文', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const first = mainSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^出片 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  await first

  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '元素' }).click()
  await side.getByRole('searchbox', { name: '搜索元素' }).fill('可填项')
  const card = side.getByRole('group', { name: '测试可填项，5 秒' })
  const added = mainSavedWith(page, (html) => savedItem(html, '测试可填项') !== null)
  await card.hover()
  await card.getByRole('button', { name: '加到播放头' }).click()
  const id = savedItem(htmlOf(await added), '测试可填项')?.id ?? ''
  expect(id).not.toBe('')
  const variable = `txt_${id}_text`

  // 加上 English：没填的「文字」用的是条目的中文默认值，按默认规则随语言
  const languages = editor.getByRole('group', { name: '语言' })
  const bound = mainSavedWith(page, (html) => html.includes(variable))
  await languages.getByRole('button', { name: '添加语言' }).click()
  await page.getByRole('menuitem', { name: 'English（EN）' }).click()
  // 存下的主文件：宿主记着字段对应的根变量、取值照旧（没填），根上声明了这个变量、默认值是原文
  const saved = htmlOf(await bound)
  const tag = new RegExp(`<div [^>]*\\bid="${id}"[^>]*>`).exec(saved)?.[0] ?? ''
  expect(jsonAttribute(tag, 'data-locale-bindings')).toEqual({ text: variable })
  expect(jsonAttribute(tag, 'data-variable-values')).toEqual({})
  const root = /<html [^>]*>/.exec(saved)?.[0] ?? ''
  expect(jsonAttribute(root, 'data-composition-variables')).toEqual([
    expect.objectContaining({ id: variable, type: 'string', default: '示例文字' }),
  ])

  await side.getByRole('tab', { name: '字幕' }).click()
  const tab = side.getByRole('tabpanel', { name: '字幕' })
  await tab.getByRole('button', { name: '画面文字 1' }).click()
  await expect(tab.getByRole('button', { name: '文字：随语言' })).toBeVisible()
  const field = tab.getByRole('textbox', { name: '测试可填项 文字' })
  await expect(field).toHaveValue('')
  await expect(field).toHaveAccessibleDescription('原文 示例文字')
  const translated = page.waitForRequest(
    (request) => savedFileOf(request, ENGLISH_FILE)?.includes('Hello there') === true,
  )
  await field.fill('Hello there')
  expect(JSON.parse(savedFileOf(await translated, ENGLISH_FILE) ?? '')).toEqual({
    [variable]: 'Hello there',
  })

  // 预览：元素里的字是英文；改了值以后预览会换一个播放器重新加载，等只剩一个再看
  const player = await readyPlayer(editor)
  const shownText = () =>
    player.evaluateAll((elements, hostId) => {
      if (elements.length !== 1) return null
      const [element] = elements as (HTMLElement & { iframeElement: HTMLIFrameElement })[]
      const host = element?.iframeElement.contentDocument?.getElementById(hostId)
      return host?.querySelector('.ff-text')?.textContent ?? null
    }, id)
  await expect.poll(shownText).toBe('Hello there')
})

test('翻译：加上 English 后点「翻译」，字幕和元素里随语言的文字一次翻好，存下的 English 值表里是译文，预览里显示译文', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await serveSavedCaptions(page)
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const first = mainSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^出片 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  await first

  // 播放头处加一个带文字可填项的元素、一句字幕
  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '元素' }).click()
  await side.getByRole('searchbox', { name: '搜索元素' }).fill('可填项')
  const card = side.getByRole('group', { name: '测试可填项，5 秒' })
  const added = mainSavedWith(page, (html) => savedItem(html, '测试可填项') !== null)
  await card.hover()
  await card.getByRole('button', { name: '加到播放头' }).click()
  const id = savedItem(htmlOf(await added), '测试可填项')?.id ?? ''
  expect(id).not.toBe('')
  await side.getByRole('tab', { name: '字幕' }).click()
  const tab = side.getByRole('tabpanel', { name: '字幕' })
  const sceneCreated = page.waitForRequest(
    (request) => savedFileOf(request, CAPTIONS_FILE)?.includes('data-var-text') === true,
  )
  await tab.getByRole('button', { name: '在播放头处添加字幕' }).click()
  const scene = savedFileOf(await sceneCreated, CAPTIONS_FILE) ?? ''
  const variable = / data-var-text="([^"]+)"/.exec(scene)?.[1] ?? ''
  expect(variable).not.toBe('')
  // 原文时没有「翻译」
  await expect(tab.getByRole('button', { name: '翻译', exact: true })).toHaveCount(0)

  const languages = editor.getByRole('group', { name: '语言' })
  const created = page.waitForRequest((request) => savedFileOf(request, ENGLISH_FILE) !== null)
  await languages.getByRole('button', { name: '添加语言' }).click()
  await page.getByRole('menuitem', { name: 'English（EN）' }).click()
  await created

  const translated = page.waitForRequest(
    (request) => savedFileOf(request, ENGLISH_FILE)?.includes('[EN]') === true,
  )
  await tab.getByRole('button', { name: '翻译', exact: true }).click()
  expect(JSON.parse(savedFileOf(await translated, ENGLISH_FILE) ?? '')).toEqual({
    [variable]: '[EN] 新字幕',
    [`txt_${id}_text`]: '[EN] 示例文字',
  })
  await expect(tab.getByRole('textbox', { name: '字幕文字 00:00.00 – 00:02.00' })).toHaveValue(
    '[EN] 新字幕',
  )

  // 预览：第 0 秒字幕和元素都是译文；改了值以后预览会换一个播放器重新加载，等只剩一个再看
  const player = await readyPlayer(editor)
  const shown = () =>
    player.evaluateAll((elements, hostId) => {
      if (elements.length !== 1) return null
      const [element] = elements as (HTMLElement & { iframeElement: HTMLIFrameElement })[]
      const document = element?.iframeElement.contentDocument
      return {
        caption: document?.querySelector('.caption')?.textContent ?? null,
        host: document?.getElementById(hostId)?.querySelector('.ff-text')?.textContent ?? null,
      }
    }, id)
  await expect.poll(shown).toEqual({ caption: '[EN] 新字幕', host: '[EN] 示例文字' })
})

test('AI 配音：English 下点音色「原声」只记下，点「生成配音」后配音行出现和字幕对齐的配音片段，预览里视频静音、配音在；保留原声时原声回来、配音片段不显示；选资料库的音色后「重配 N 句」；原文下没有配音', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await serveSavedCaptions(page)
  const dubbingRequests: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/generations/dubbings'))
      dubbingRequests.push(request.url())
  })
  // 这段对话里还没有字幕识别记录：先识别出两句，配音按它们配
  const panel = await openConversation(page, '工具过程展示')
  const editor = await createFinalCut(panel)
  await addWholeTake(page, editor)

  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '字幕' }).click()
  const tab = side.getByRole('tabpanel', { name: '字幕' })
  const recognized = page.waitForRequest(
    (request) =>
      (savedFileOf(request, CAPTIONS_FILE)?.match(/data-caption-of/g) ?? []).length === 2,
  )
  await tab.getByRole('button', { name: '识别字幕', exact: true }).click()
  await recognized
  // 原文下没有人声设置
  await expect(tab.getByRole('group', { name: '人声设置' })).toHaveCount(0)

  const languages = editor.getByRole('group', { name: '语言' })
  await languages.getByRole('button', { name: '添加语言' }).click()
  await page.getByRole('menuitem', { name: 'English（EN）' }).click()
  const translated = page.waitForRequest(
    (request) => (savedFileOf(request, ENGLISH_FILE)?.match(/\[EN\]/g) ?? []).length === 2,
  )
  await tab.getByRole('button', { name: '翻译', exact: true }).click()
  await translated

  // AI 配音：每句一个配音片段，起点和字幕一样，从这句在素材里的开始放
  const voice = tab.getByRole('group', { name: '人声设置' })
  await expect(voice.getByRole('button', { name: '保留原声' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  const voices = tab.getByRole('radiogroup', { name: '常用音色' })
  // 选音色只记下（切到配音），不发起
  const chosen = mainSavedWith(
    page,
    (html) =>
      (jsonAttribute(html, 'data-voice-modes') as { en?: { mode?: string } } | undefined)?.en
        ?.mode === 'dub',
  )
  await voices.getByRole('radio', { name: '原声', exact: true }).click()
  await chosen
  expect(dubbingRequests).toEqual([])
  const dubbed = mainSavedWith(page, (html) => (html.match(/data-dub-of=/g) ?? []).length === 2)
  await voice.getByRole('button', { name: '生成配音' }).click()
  const html = htmlOf(await dubbed)
  const dubs = [...html.matchAll(/<audio [^>]*data-dub-of="[^"]+"[^>]*>/g)].map(([tag]) => ({
    start: Number(/ data-start="([\d.]+)"/.exec(tag)?.[1]),
    mediaStart: Number(/ data-media-start="([\d.]+)"/.exec(tag)?.[1]),
    locale: / data-locale="([^"]+)"/.exec(tag)?.[1],
  }))
  expect(dubs.toSorted((left, right) => left.start - right.start)).toEqual([
    { start: 0.3, mediaStart: 0.3, locale: 'en' },
    { start: 2.4, mediaStart: 2.4, locale: 'en' },
  ])
  await expect(voices.getByRole('radio', { name: '原声', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  const dubRow = editor.getByRole('group', { name: '配音', exact: true })
  await expect(dubRow.getByRole('group', { name: /^配音 · \[EN\] / })).toHaveCount(2)

  // 往右拖第二句的配音片段：它配的那句字幕挪同样的时间，第一句不动。只拖一小段，这句还在视频里，
  // 后面换音色重新生成时才配得出来
  const dubStartsOf = (saved: string) =>
    [...saved.matchAll(/<audio [^>]*data-dub-of="[^"]+"[^>]*>/g)]
      .map(([tag]) => Number(/ data-start="([\d.]+)"/.exec(tag)?.[1]))
      .toSorted((left, right) => left - right)
  const dubMoved = mainSavedWith(page, (saved) => (dubStartsOf(saved)[1] ?? 0) > 2.4)
  const captionMoved = page.waitForRequest((request) => {
    const scene = savedFileOf(request, CAPTIONS_FILE)
    return scene !== null && (savedCaptionLines(scene)[1]?.start ?? 0) > 2.4
  })
  await dragClip(page, dubRow.getByRole('button', { name: /^选中：配音 · \[EN\] 车流/ }), 30)
  const movedDub = dubStartsOf(htmlOf(await dubMoved))[1] ?? 0
  const captionLines = savedCaptionLines(savedFileOf(await captionMoved, CAPTIONS_FILE) ?? '')
  expect(movedDub).toBeGreaterThan(2.4)
  expect(captionLines[0]?.start).toBe(0.3)
  expect(captionLines[1]?.start).toBeCloseTo(movedDub, 3)

  // 预览：视频关了原声，English 的配音音轨在；改了以后会换播放器，等只剩一个再看
  const player = await readyPlayer(editor)
  const sounds = () =>
    player.evaluateAll((elements) => {
      if (elements.length !== 1) return null
      const [element] = elements as (HTMLElement & { iframeElement: HTMLIFrameElement })[]
      const document = element?.iframeElement.contentDocument
      return {
        muted: document?.querySelector('video')?.hasAttribute('muted') ?? null,
        dubs: document?.querySelectorAll('audio[data-locale="en"]').length ?? null,
      }
    })
  await expect.poll(sounds).toEqual({ muted: true, dubs: 2 })

  // 保留原声：配音不出声（预览里没有配音音轨），时间线上也没有配音片段和配音行，原声回来
  await voice.getByRole('button', { name: '保留原声' }).click()
  await expect.poll(sounds).toEqual({ muted: false, dubs: 0 })
  await expect(editor.getByRole('group', { name: /^配音 · / })).toHaveCount(0)
  await expect(dubRow).toHaveCount(0)

  // 再点配好的音色「原声」：不重新生成，配音片段回来；撤销后又藏起来
  const requested = dubbingRequests.length
  expect(requested).toBeGreaterThan(0)
  await voices.getByRole('radio', { name: '原声', exact: true }).click()
  await expect(dubRow.getByRole('group', { name: /^配音 · \[EN\] / })).toHaveCount(2)
  await expect.poll(sounds).toEqual({ muted: true, dubs: 2 })
  expect(dubbingRequests).toHaveLength(requested)
  await editor
    .getByRole('toolbar', { name: '剪辑工具' })
    .getByRole('button', { name: '撤销' })
    .click()
  await expect(editor.getByRole('group', { name: /^配音 · / })).toHaveCount(0)
  await expect.poll(sounds).toEqual({ muted: false, dubs: 0 })

  // 在选音面板里选资料库的一个音色：只记下、回到首页；两句都过期，「重配 2 句」用它重配，换掉原来的配音，
  // 配音片段记着这个音色
  await voice.getByRole('button', { name: '更换音色' }).click()
  const picker = tab.getByRole('region', { name: '选择音色' })
  await expect(picker.getByRole('button', { name: '语种：English' })).toBeVisible()
  await picker.getByRole('button', { name: '选用：Emma' }).click()
  await expect(picker).toHaveCount(0)
  expect(dubbingRequests).toHaveLength(requested)
  const asked = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/api/generations/dubbings'),
  )
  // 配音要几秒才配好，存主文件在拿到音色编号之后
  let referenceId: string | null = null
  const regenerated = mainSavedWith(
    page,
    (saved) =>
      referenceId !== null &&
      (saved.match(new RegExp(`data-dub-voice="${referenceId}"`, 'g')) ?? []).length === 2,
  )
  await voice.getByRole('button', { name: '重配 2 句' }).click()
  const reference = ((await asked).postDataJSON() as { reference: unknown }).reference
  expect(reference).toMatchObject({ kind: 'reference_audio' })
  referenceId = (reference as { referenceId: string }).referenceId
  expect(referenceId).toMatch(/^[0-9a-f-]{36}$/)
  await regenerated
  await expect(voices.getByRole('radio', { name: 'Emma', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect.poll(sounds).toEqual({ muted: true, dubs: 2 })

  // 原文：时间线和预览里都没有配音
  await languages.getByRole('button', { name: '原文' }).click()
  await expect(editor.getByRole('group', { name: /^配音 · / })).toHaveCount(0)
  await expect.poll(sounds).toEqual({ muted: false, dubs: 0 })
})

test('配音行引导：有字幕、还没有配音时，声音区最上面那一行写着去哪里配；把一条音频拖到引导上，就在那里新开一行，原来的配乐行往下排', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await serveSavedCaptions(page)
  const panel = await openConversation(page, '工具过程展示')
  const editor = await createFinalCut(panel)
  await addWholeTake(page, editor)
  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '字幕' }).click()
  const recognized = page.waitForRequest(
    (request) =>
      (savedFileOf(request, CAPTIONS_FILE)?.match(/data-caption-of/g) ?? []).length === 2,
  )
  await side
    .getByRole('tabpanel', { name: '字幕' })
    .getByRole('button', { name: '识别字幕', exact: true })
    .click()
  await recognized
  const hint = editor.getByText('当前语言保留原声；在「字幕」页签切到「配音」可生成配音')
  await expect(hint).toBeVisible()

  // 点一下音频库的第一条：放在播放头处新开的配乐行，引导留在它上面
  await side.getByRole('tab', { name: '配乐' }).click()
  await side.getByRole('radio', { name: '音频库' }).click()
  const rows = side.getByRole('list', { name: '音频库' }).getByRole('listitem')
  const added = mainSavedWith(page, (html) => savedAudio(html).length === 1)
  await rows.first().click()
  const [first] = savedAudio(htmlOf(await added))
  expect(first?.track).toBe(0)
  const music = editor.getByRole('group', { name: '配乐', exact: true })
  const hintBox = await boxOf(hint)
  expect(hintBox.y).toBeLessThan((await boxOf(music)).y)

  // 拖第二条到引导上：引导那一行换成要新开的一行，松手后新的在上面、原来的配乐往下排
  const from = await boxOf(rows.nth(1))
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(from.x + from.width / 2 - 10, from.y + from.height / 2 + 10, { steps: 3 })
  await page.mouse.move(hintBox.x + 300, hintBox.y + hintBox.height / 2, { steps: 12 })
  await expect(editor.getByTestId('drop-ghost')).toBeVisible()
  await expect(hint).toHaveCount(0)
  const dropped = mainSavedWith(page, (html) => savedAudio(html).length === 2)
  await page.mouse.up()
  const both = savedAudio(htmlOf(await dropped))
  expect(both.find(({ label }) => label === first?.label)?.track).toBe(1)
  expect(both.find(({ label }) => label !== first?.label)?.track).toBe(0)
  await expect(editor.getByRole('group', { name: '配乐 1', exact: true })).toBeVisible()
  await expect(editor.getByRole('group', { name: '配乐 2', exact: true })).toBeVisible()
  // 还是没有配音：引导回到声音区最上面
  await expect(hint).toBeVisible()
  expect((await boxOf(hint)).y).toBeLessThan(
    (await boxOf(editor.getByRole('group', { name: '配乐 1', exact: true }))).y,
  )
})

test('配音片段调音直接打进预览：English 下 AI 配音，给一个配音片段选音色风格，预览不换播放器，预览里和存下的这个配音片段都带着新的效果链', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await serveSavedCaptions(page)
  // 和上一条一样：加一段镜头、识别出两句、加 English 翻好，用「原声」配好
  const panel = await openConversation(page, '工具过程展示')
  const editor = await createFinalCut(panel)
  await addWholeTake(page, editor)
  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '字幕' }).click()
  const tab = side.getByRole('tabpanel', { name: '字幕' })
  const recognized = page.waitForRequest(
    (request) =>
      (savedFileOf(request, CAPTIONS_FILE)?.match(/data-caption-of/g) ?? []).length === 2,
  )
  await tab.getByRole('button', { name: '识别字幕', exact: true }).click()
  await recognized
  await editor
    .getByRole('group', { name: '语言' })
    .getByRole('button', { name: '添加语言' })
    .click()
  await page.getByRole('menuitem', { name: 'English（EN）' }).click()
  const translated = page.waitForRequest(
    (request) => (savedFileOf(request, ENGLISH_FILE)?.match(/\[EN\]/g) ?? []).length === 2,
  )
  await tab.getByRole('button', { name: '翻译', exact: true }).click()
  await translated
  const dubTags = (html: string) => [...html.matchAll(/<audio [^>]*data-dub-of="[^"]+"[^>]*>/g)]
  const dubbed = mainSavedWith(page, (html) => dubTags(html).length === 2)
  await tab
    .getByRole('radiogroup', { name: '常用音色' })
    .getByRole('radio', { name: '原声', exact: true })
    .click()
  await tab
    .getByRole('group', { name: '人声设置' })
    .getByRole('button', { name: '生成配音' })
    .click()
  await dubbed
  const dubRow = editor.getByRole('group', { name: '配音', exact: true })
  await expect(dubRow.getByRole('group', { name: /^配音 · \[EN\] / })).toHaveCount(2)

  await dubRow
    .getByRole('button', { name: /^选中：配音 · \[EN\] / })
    .first()
    .click()
  // 选中配音片段时侧栏停在「字幕」
  await side.getByRole('tab', { name: '属性' }).click()
  const inspector = editor.getByRole('tabpanel', { name: '属性' })
  await expect(inspector.getByRole('heading', { name: '智能调音' })).toBeVisible()
  await expect(inspector.getByText('正在分析声音')).toHaveCount(0)
  await readyPlayer(editor)
  await markFinalCutPreviewPlayer(editor)

  // 存下的主文件里带着这个预设的配音片段（`data-hf-id`）
  const styledIds = (html: string) =>
    dubTags(html)
      .map(([tag]) => tag.replaceAll('&quot;', '"'))
      .filter((tag) => tag.includes('"fromPreset":"voice-clean"'))
      .map((tag) => / data-hf-id="([^"]+)"/.exec(tag)?.[1] ?? '')
  const styled = mainSavedWith(page, (html) => styledIds(html).length === 1)
  await inspector
    .getByRole('radiogroup', { name: '音色风格' })
    .getByRole('radio', { name: '纯净人声' })
    .click()
  const [saved = ''] = styledIds(htmlOf(await styled))
  expect(saved).not.toBe('')
  await expect
    .poll(() =>
      finalCutPreviewPlayer(editor).evaluate(
        (element: HTMLElement & { iframeElement: HTMLIFrameElement }) =>
          [
            ...(element.iframeElement.contentDocument?.querySelectorAll<HTMLAudioElement>(
              'audio[data-locale="en"]',
            ) ?? []),
          ]
            .filter((audio) =>
              (audio.getAttribute('data-fx-chain') ?? '').includes('"fromPreset":"voice-clean"'),
            )
            .map((audio) => audio.getAttribute('data-hf-id')),
      ),
    )
    .toEqual([saved])
  expect(await isMarkedFinalCutPreviewPlayer(editor)).toBe(true)
})

test('逐句配音：English 下给第二句选资料库的音色只记下，「重配 1 句」只发这一句、带这个音色；给第一句选「不配音」，它的配音片段没了，撤销后回来', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await serveSavedCaptions(page)
  // 和上一条一样：加一段镜头、识别出两句、加 English 翻好，用「原声」配好
  const panel = await openConversation(page, '工具过程展示')
  const editor = await createFinalCut(panel)
  await addWholeTake(page, editor)
  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '字幕' }).click()
  const tab = side.getByRole('tabpanel', { name: '字幕' })
  const recognized = page.waitForRequest(
    (request) =>
      (savedFileOf(request, CAPTIONS_FILE)?.match(/data-caption-of/g) ?? []).length === 2,
  )
  await tab.getByRole('button', { name: '识别字幕', exact: true }).click()
  await recognized
  await editor
    .getByRole('group', { name: '语言' })
    .getByRole('button', { name: '添加语言' })
    .click()
  await page.getByRole('menuitem', { name: 'English（EN）' }).click()
  const translated = page.waitForRequest(
    (request) => (savedFileOf(request, ENGLISH_FILE)?.match(/\[EN\]/g) ?? []).length === 2,
  )
  await tab.getByRole('button', { name: '翻译', exact: true }).click()
  await translated
  const dubTags = (html: string) => [...html.matchAll(/<audio [^>]*data-dub-of="[^"]+"[^>]*>/g)]
  const dubbed = mainSavedWith(page, (html) => dubTags(html).length === 2)
  const voice = tab.getByRole('group', { name: '人声设置' })
  await tab
    .getByRole('radiogroup', { name: '常用音色' })
    .getByRole('radio', { name: '原声', exact: true })
    .click()
  await voice.getByRole('button', { name: '生成配音' }).click()
  // 两句的配音片段配的字幕，按开始排
  const captions = dubTags(htmlOf(await dubbed))
    .map(([tag]) => ({
      caption: / data-dub-of="([^"]+)"/.exec(tag)?.[1] ?? '',
      start: Number(/ data-start="([\d.]+)"/.exec(tag)?.[1]),
    }))
    .toSorted((left, right) => left.start - right.start)
    .map((dub) => dub.caption)
  const [first = '', second = ''] = captions
  const dubRow = editor.getByRole('group', { name: '配音', exact: true })
  await expect(dubRow.getByRole('group', { name: /^配音 · \[EN\] / })).toHaveCount(2)
  const lineChip = (index: number) =>
    tab
      .getByRole('list', { name: '字幕' })
      .getByRole('listitem')
      .nth(index)
      .getByRole('button', { name: /^本句配音：/ })
  await expect(lineChip(1)).toHaveAccessibleName('本句配音：原声，跟随整体音色')

  // 第二句选 Emma：只记下这句的选择；「重配 1 句」只发这一句（最后一句，不带上限），参考是这个音色
  const lineChosen = mainSavedWith(page, (html) => {
    const modes = jsonAttribute(html, 'data-voice-modes') as
      { en?: { lines?: Record<string, unknown> } } | undefined
    return modes?.en?.lines?.[second] !== undefined
  })
  await lineChip(1).click()
  await page.getByRole('menuitemradio', { name: 'Emma' }).click()
  await lineChosen
  await expect(lineChip(1)).toHaveAccessibleName('本句配音：Emma')
  const asked = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/api/generations/dubbings'),
  )
  let referenceId: string | null = null
  const lineVoiced = mainSavedWith(
    page,
    (html) =>
      referenceId !== null &&
      dubTags(html).length === 2 &&
      html.includes(`data-dub-voice="${referenceId}"`),
  )
  await voice.getByRole('button', { name: '重配 1 句' }).click()
  const body = (await asked).postDataJSON() as {
    lines: { startMs: number; slotEndMs?: number }[]
    reference: { kind: string; referenceId?: string }
  }
  expect(body.lines).toHaveLength(1)
  expect(body.lines[0]?.startMs).toBe(2_400)
  expect(body.lines[0]).not.toHaveProperty('slotEndMs')
  expect(body.reference.kind).toBe('reference_audio')
  referenceId = body.reference.referenceId ?? null
  expect(referenceId).toMatch(/^[0-9a-f-]{36}$/)
  await lineVoiced
  await expect(lineChip(1)).toHaveAccessibleName('本句配音：Emma')
  await expect(dubRow.getByRole('group', { name: /^配音 · \[EN\] / })).toHaveCount(2)

  // 第一句「不配音」：不发起，它的配音片段没了；撤销后回来
  const requests: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/generations/dubbings'))
      requests.push(request.url())
  })
  const unvoiced = mainSavedWith(
    page,
    (html) => dubTags(html).length === 1 && !html.includes(`data-dub-of="${first}"`),
  )
  await lineChip(0).click()
  await page.getByRole('menuitemradio', { name: '不配音' }).click()
  expect(jsonAttribute(htmlOf(await unvoiced), 'data-voice-modes')).toMatchObject({
    en: { lines: { [first]: { dub: false } } },
  })
  await expect(dubRow.getByRole('group', { name: /^配音 · \[EN\] / })).toHaveCount(1)
  await expect(lineChip(0)).toHaveAccessibleName('本句配音：不配音')
  const restored = mainSavedWith(page, (html) => dubTags(html).length === 2)
  await editor
    .getByRole('toolbar', { name: '剪辑工具' })
    .getByRole('button', { name: '撤销' })
    .click()
  await restored
  await expect(dubRow.getByRole('group', { name: /^配音 · \[EN\] / })).toHaveCount(2)
  await expect(lineChip(0)).toHaveAccessibleName('本句配音：原声，跟随整体音色')
  expect(requests).toEqual([])
})

test('旁白配音：原文下输入文案、选资料库的音色插入，按文字合成（不带语言），主文件里多一个旁白片段、字幕文件里多一句这段文案', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await serveSavedCaptions(page)
  const panel = await openConversation(page, '工具过程展示')
  const editor = await createFinalCut(panel)
  const added = mainSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^出片 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  await added
  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '字幕' }).click()
  const tab = side.getByRole('tabpanel', { name: '字幕' })

  await tab.getByRole('button', { name: '旁白配音' }).click()
  const narration = tab.getByRole('group', { name: '旁白配音' })
  await narration.getByRole('textbox', { name: '旁白文案' }).fill('欢迎来到新品发布会')
  // 换成 Emma：「更换音色」打开选音面板，选用后回到旁白面板，文案还在
  await narration.getByRole('button', { name: '更换音色' }).click()
  await tab
    .getByRole('region', { name: '选择旁白音色' })
    .getByRole('button', { name: '选用：Emma' })
    .click()
  await expect(narration.getByRole('textbox', { name: '旁白文案' })).toHaveValue(
    '欢迎来到新品发布会',
  )
  await expect(narration.getByRole('button', { name: '试听：Emma' })).toBeVisible()
  const asked = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/api/generations/speeches'),
  )
  const narrationTag = (html: string) =>
    /<audio [^>]*data-dub-of="[^"]+"[^>]*>/.exec(html)?.[0] ?? null
  const saved = mainSavedWith(page, (html) => narrationTag(html) !== null)
  const sceneSaved = page.waitForRequest(
    (request) => savedFileOf(request, CAPTIONS_FILE)?.includes('欢迎来到新品发布会') === true,
  )
  await narration.getByRole('button', { name: '插入配音与字幕' }).click()

  const body = (await asked).postDataJSON() as Record<string, unknown>
  expect(body).toMatchObject({
    text: '欢迎来到新品发布会',
    reference: { kind: 'reference_audio' },
  })
  expect(body).not.toHaveProperty('locale')
  expect(body).not.toHaveProperty('maxDurationMs')
  const referenceId = (body['reference'] as { referenceId?: string }).referenceId ?? ''
  const tag = narrationTag(htmlOf(await saved)) ?? ''
  expect(tag).not.toContain('data-locale')
  expect(tag).toContain(`data-dub-voice="${referenceId}"`)
  expect(tag).toContain('data-dub-text="欢迎来到新品发布会"')
  const caption = / data-dub-of="([^"]+)"/.exec(tag)?.[1] ?? ''
  const scene = savedFileOf(await sceneSaved, CAPTIONS_FILE) ?? ''
  expect(scene).toContain(`id="${caption}"`)
  // 配音行上多一个这段文案的旁白片段，顶行写合成它用的音色名
  await expect(
    editor
      .getByRole('group', { name: '配音', exact: true })
      .getByRole('group', { name: /^旁白 · 欢迎来到新品发布会/ }),
  ).toContainText('Emma')
})

test('素材片的句子配音不压到后面的旁白上：English 下「重新生成」，素材片最后一句的上限是后面那句旁白字幕的开始', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await serveSavedCaptions(page)
  // 加一段 6 秒的镜头、识别出两句，再在后面插一句旁白（还在这个视频片段里）
  const panel = await openConversation(page, '工具过程展示')
  const editor = await createFinalCut(panel)
  await addWholeTake(page, editor)
  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '字幕' }).click()
  const tab = side.getByRole('tabpanel', { name: '字幕' })
  const recognized = page.waitForRequest(
    (request) =>
      (savedFileOf(request, CAPTIONS_FILE)?.match(/data-caption-of/g) ?? []).length === 2,
  )
  await tab.getByRole('button', { name: '识别字幕', exact: true }).click()
  await recognized

  await tab.getByRole('button', { name: '旁白配音' }).click()
  const narration = tab.getByRole('group', { name: '旁白配音' })
  await narration.getByRole('textbox', { name: '旁白文案' }).fill('欢迎来到新品发布会')
  await narration.getByRole('button', { name: '更换音色' }).click()
  await tab
    .getByRole('region', { name: '选择旁白音色' })
    .getByRole('button', { name: '选用：Emma' })
    .click()
  const narrated = page.waitForRequest(
    (request) => savedFileOf(request, CAPTIONS_FILE)?.includes('欢迎来到新品发布会') === true,
  )
  await narration.getByRole('button', { name: '插入配音与字幕' }).click()
  const lines = savedCaptionLines(savedFileOf(await narrated, CAPTIONS_FILE) ?? '')
  const narrationStart = lines.find((line) => line.owner === null)?.start ?? 0
  const lastOwned = Math.max(
    ...lines.filter((line) => line.owner !== null).map((line) => line.start),
  )
  expect(narrationStart).toBeGreaterThan(lastOwned)

  await editor
    .getByRole('group', { name: '语言' })
    .getByRole('button', { name: '添加语言' })
    .click()
  await page.getByRole('menuitem', { name: 'English（EN）' }).click()
  const translated = page.waitForRequest(
    (request) => (savedFileOf(request, ENGLISH_FILE)?.match(/\[EN\]/g) ?? []).length === 3,
  )
  await tab.getByRole('button', { name: '翻译', exact: true }).click()
  await translated
  // 先用「原声」配好：素材片两句和旁白一句
  const englishDubs = (html: string) => (html.match(/<audio [^>]*data-locale="en"/g) ?? []).length
  const dubbed = mainSavedWith(page, (html) => englishDubs(html) === 3)
  const voice = tab.getByRole('group', { name: '人声设置' })
  await tab
    .getByRole('radiogroup', { name: '常用音色' })
    .getByRole('radio', { name: '原声', exact: true })
    .click()
  await voice.getByRole('button', { name: '生成配音' }).click()
  await dubbed

  const asked = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/api/generations/dubbings'),
  )
  await voice.getByRole('button', { name: '重新生成' }).click()
  const body = (await asked).postDataJSON() as { lines: { startMs: number; slotEndMs?: number }[] }
  expect(body.lines).toEqual([
    expect.objectContaining({ startMs: 300, slotEndMs: 2_400 }),
    expect.objectContaining({ startMs: 2_400, slotEndMs: Math.round(narrationStart * 1000) }),
  ])
})

type PreviewPlayer = HTMLElement & { iframeElement: HTMLIFrameElement }

/** 画面区里第 `row` 行的片段 `name` 的选中按钮。 */
const clipButton = (editor: Locator, row: number, name: string) =>
  editor
    .getByRole('group', { name: `画面 ${row}`, exact: true })
    .getByRole('button', { name: new RegExp(`^选中：${name}，`) })

/**
 * 打开 final-cut 编辑器，放进镜头 1（0–1 秒，画面 1 行）和元素「测试可填项」（0–5 秒，叠在上面），播放头停在
 * 0.5 秒（两个都显示着）；返回编辑器、盖在画面上的编辑层和正在显示的播放器。
 */
const openWithCard = async (
  page: Page,
  item: { search: string; title: string; seconds: number } = {
    search: '可填项',
    title: '测试可填项',
    seconds: 5,
  },
) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  const first = mainSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^出片 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  await first
  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '元素' }).click()
  await side.getByRole('searchbox', { name: '搜索元素' }).fill(item.search)
  const card = side.getByRole('group', { name: `${item.title}，${item.seconds} 秒` })
  const added = mainSavedWith(page, (html) => savedItem(html, item.title) !== null)
  await card.hover()
  await card.getByRole('button', { name: '加到播放头' }).click()
  const html = htmlOf(await added)
  await readyPlayer(editor)
  // 播放头挪到 0.5 秒，再取消选中
  await clipButton(editor, 2, item.title).click()
  await stepPlayhead(page, editor, 0, 5)
  await page.keyboard.press('Escape')
  await expect(clipButton(editor, 2, item.title)).toHaveAttribute('aria-pressed', 'false')
  const player = await readyPlayer(editor)
  return {
    editor,
    layer: editor.getByRole('group', { name: '预览画面', exact: true }),
    player,
    html,
  }
}

/** 焦点在时间线上时按 → 把播放头从 `from` 挪 `steps` 格（一格 0.1 秒），每按一下等它显示出来再按下一下。 */
const stepPlayhead = async (page: Page, editor: Locator, from: number, steps: number) => {
  for (let step = from + 1; step <= from + steps; step += 1) {
    await page.keyboard.press('ArrowRight')
    const clock = `00:0${Math.floor(step / 10)}.${step % 10}0 /`
    await expect(editor.getByRole('group', { name: '播放控制' })).toContainText(clock)
  }
}

/**
 * 轮询断言预览画布内的元素位置。预览重载瞬间元素可能短暂不存在导致 `previewRect` 抛错，
 * 用 `toPass` 忽略中间异常持续重试直至超时（`expect.poll` 遇抛错会立即失败）。
 */
const settles = (check: () => Promise<void>) => expect(check).toPass({ timeout: 10_000 })

/** 预览里 final-cut 中 `selector` 那个元素的框，按画面的宽高算成 0–1 的比例。 */
const previewRect = (player: Locator, selector: string) =>
  player.evaluate((element: PreviewPlayer, query) => {
    const page = element.iframeElement.contentDocument
    const root = page?.getElementById('film')?.getBoundingClientRect()
    const target = page?.querySelector(query)?.getBoundingClientRect()
    if (root === undefined || target === undefined) throw new Error(`预览里没有 ${query}`)
    return {
      x: (target.left - root.left) / root.width,
      y: (target.top - root.top) / root.height,
      width: target.width / root.width,
      height: target.height / root.height,
    }
  }, selector)

/** 画面上 final-cut 中 `selector` 那个元素中心在页面上的位置。 */
const canvasSpot = async (layer: Locator, player: Locator, selector: string) => {
  const canvas = await boxOf(layer)
  const rect = await previewRect(player, selector)
  return {
    x: canvas.x + (rect.x + rect.width / 2) * canvas.width,
    y: canvas.y + (rect.y + rect.height / 2) * canvas.height,
  }
}

// 元素「测试可填项」宿主（1920×1080 设计尺寸，按画幅缩放居中）及其内部文字节点
const CARD = '#film > .component'
const TEXT = `${CARD} #ff-text`
const CARD_FILE = 'compositions/fixtures/fixture-fields.html'

/** 解析落盘 HTML 中指定 `id` 元素的属性表；未找到时返回 `null`。 */
const savedElement = (content: string, id: string): Record<string, string> | null => {
  const tag = new RegExp(`<[a-z]+ [^>]*\\bid="${id}"[^>]*>`).exec(content)?.[0]
  if (tag === undefined) return null
  return Object.fromEntries(
    [...tag.matchAll(/ ([a-z-]+)(?:="([^"]*)")?/g)].map(([, name = '', value = '']) => [
      name,
      value,
    ]),
  )
}

/** 将元素的行内 `style` 属性拆解为属性名到值的映射。 */
const styleOf = (attributes: Record<string, string> | null): Record<string, string> =>
  Object.fromEntries(
    (attributes?.['style'] ?? '').split(';').flatMap((declaration) => {
      const at = declaration.indexOf(':')
      return at < 0 ? [] : [[declaration.slice(0, at).trim(), declaration.slice(at + 1).trim()]]
    }),
  )

/** 计算画布 1 像素对应的页面屏幕像素宽度。 */
const canvasZoom = async (layer: Locator, player: Locator) => {
  const width = await player.evaluate((element: PreviewPlayer) =>
    Number(element.iframeElement.contentDocument?.getElementById('film')?.dataset['width']),
  )
  return (await boxOf(layer)).width / width
}

/** 断言叠层绘制框 `drawn` 与页面可见框 `shown` 对齐（屏幕像素误差小于 1.5）。 */
const alignsWith = (
  drawn: { x: number; y: number; width: number; height: number },
  shown: { x: number; y: number; width: number; height: number },
) => {
  expect(Math.abs(drawn.x - shown.x)).toBeLessThan(1.5)
  expect(Math.abs(drawn.y - shown.y)).toBeLessThan(1.5)
  expect(Math.abs(drawn.width - shown.width)).toBeLessThan(1.5)
  expect(Math.abs(drawn.height - shown.height)).toBeLessThan(1.5)
}

/** 计算预览内 `selector` 元素裁剪到画布范围后的页面屏幕矩形。 */
const shownOnPage = async (layer: Locator, player: Locator, selector: string) => {
  const canvas = await boxOf(layer)
  const rect = await previewRect(player, selector)
  const left = Math.max(0, rect.x)
  const top = Math.max(0, rect.y)
  const right = Math.min(1, rect.x + rect.width)
  const bottom = Math.min(1, rect.y + rect.height)
  return {
    x: canvas.x + left * canvas.width,
    y: canvas.y + top * canvas.height,
    width: (right - left) * canvas.width,
    height: (bottom - top) * canvas.height,
  }
}

test('画面上点选：点元素里画出来的字、色底、矢量图形都选中整个元素，框就是宿主、带把手，透明的地方点到下面的视频；同一处再点一下换成压在下面的视频，再点回到元素；时间线上选中元素时也框住宿主、带把手；点空白处取消', async ({
  page,
}) => {
  const { editor, layer, player } = await openWithCard(page)
  const card = clipButton(editor, 2, '测试可填项')
  const video = clipButton(editor, 1, 'A · 镜头 1')
  const spot = await canvasSpot(layer, player, TEXT)
  await page.mouse.click(spot.x, spot.y)
  await expect(card).toHaveAttribute('aria-pressed', 'true')
  await expect(video).toHaveAttribute('aria-pressed', 'false')
  const frame = layer.getByRole('img', { name: '选中：测试可填项' })
  await expect(frame).toBeVisible()
  alignsWith(await boxOf(frame), await shownOnPage(layer, player, CARD))
  await expect(frame.locator('.wf-canvas-handle')).toHaveCount(4)
  await expect(layer.getByRole('button', { name: '旋转' })).toBeVisible()

  // 矢量图形画的内容（下面压着视频）也是整个元素
  await page.keyboard.press('Escape')
  await expect(card).toHaveAttribute('aria-pressed', 'false')
  const mark = await canvasSpot(layer, player, `${CARD} #ff-mark`)
  await page.mouse.click(mark.x, mark.y)
  await expect(card).toHaveAttribute('aria-pressed', 'true')
  await expect(video).toHaveAttribute('aria-pressed', 'false')
  await expect(frame).toBeVisible()
  alignsWith(await boxOf(frame), await shownOnPage(layer, player, CARD))

  // 元素里透明的地方（宿主框里，没有字、没有色底）点到下面的视频
  await page.keyboard.press('Escape')
  await expect(card).toHaveAttribute('aria-pressed', 'false')
  const band = await shownOnPage(layer, player, CARD)
  await page.mouse.click(band.x + band.width * 0.8, band.y + band.height * 0.2)
  await expect(video).toHaveAttribute('aria-pressed', 'true')
  await expect(card).toHaveAttribute('aria-pressed', 'false')

  // 色底上没有字的地方也是整个元素
  await page.keyboard.press('Escape')
  await expect(video).toHaveAttribute('aria-pressed', 'false')
  const panel = await shownOnPage(layer, player, `${CARD} #ff-panel`)
  await page.mouse.click(panel.x + panel.width * 0.9, panel.y + panel.height / 2)
  await expect(card).toHaveAttribute('aria-pressed', 'true')
  await expect(frame).toBeVisible()

  // 隔过 600 毫秒再在同一处很快连点：换成压在下面的视频，再点回到元素（元素里的层不轮到）
  await page.waitForTimeout(700)
  await page.mouse.click(spot.x, spot.y)
  await page.mouse.click(spot.x, spot.y)
  await expect(video).toHaveAttribute('aria-pressed', 'true')
  await expect(card).toHaveAttribute('aria-pressed', 'false')
  await expect(layer.getByRole('img', { name: '选中：A · 镜头 1' })).toBeVisible()
  await page.mouse.click(spot.x, spot.y)
  await expect(card).toHaveAttribute('aria-pressed', 'true')
  await expect(frame).toBeVisible()

  // 时间线上选中元素：同样框住宿主、带把手
  await video.click()
  await card.click()
  await expect(frame).toBeVisible()
  alignsWith(await boxOf(frame), await shownOnPage(layer, player, CARD))
  await expect(frame.locator('.wf-canvas-handle')).toHaveCount(4)
  await expect(layer.getByRole('button', { name: '旋转' })).toBeVisible()

  // 播放头挪到 1.5 秒（视频已经结束），点画面上元素外面没有层的地方：取消选中
  await stepPlayhead(page, editor, 5, 10)
  await expect(card).toHaveAttribute('aria-pressed', 'true')
  const canvas = await boxOf(layer)
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + 4)
  await expect(card).toHaveAttribute('aria-pressed', 'false')
  await expect(layer.getByRole('img')).toHaveCount(0)
})

/** 读取落盘主文件中元素「测试可填项」宿主的属性；未找到时返回 `null`。 */
const savedCard = (html: string) => savedElement(html, savedItem(html, '测试可填项')?.id ?? '')

/** 解析宿主单轴 `translate` 在 `-50%` 居中基准上叠加的像素偏移（`-50%` 或 `calc(-50% ± Npx)`，无法解析时返回 `NaN`）。 */
const centredOffset = (axis: string | undefined) => {
  if (axis === '-50%') return 0
  const calc = /^calc\(-50% ([+-]) ([\d.]+)px\)$/.exec(axis ?? '')
  return calc === null ? Number.NaN : (calc[1] === '-' ? -1 : 1) * Number(calc[2])
}

/** 解析宿主 `translate` 在两个轴向上的居中像素偏移（见 `centredOffset`）。 */
const cardOffset = (attributes: Record<string, string> | null) => {
  const [x, y] =
    /^(calc\([^)]*\)|\S+) (calc\([^)]*\)|\S+)$/
      .exec(styleOf(attributes)['translate'] ?? '')
      ?.slice(1) ?? []
  return { x: centredOffset(x), y: centredOffset(y) }
}

/** 读取预览 DOM 中元素宿主的行内 `transform`（未经 GSAP 解析改写时应为空串）。 */
const previewCardTransform = (editor: Locator) =>
  finalCutPreviewPlayer(editor).evaluate(
    (element: PreviewPlayer, query) =>
      element.iframeElement.contentDocument?.querySelector<HTMLElement>(query)?.style.transform,
    CARD,
  )

/** 统计元素组件文件的落盘保存次数。 */
const countCardSaves = (page: Page, file = CARD_FILE) => {
  const saves = { count: 0 }
  page.on('request', (request) => {
    if (savedFileOf(request, file) !== null) saves.count += 1
  })
  return saves
}

test('画面上拖动元素：拖动中预览跟着动，松手写进主文件里宿主的 translate（不写 data-x），组件文件不动；方向键挪 1 像素、Shift 10 像素；撤销回到原来的位置', async ({
  page,
}) => {
  const { editor, layer, player, html } = await openWithCard(page)
  const original = savedCard(html)
  expect(styleOf(original)['translate']).toBe('-50% -50%')
  const zoom = await canvasZoom(layer, player)
  const before = await previewRect(player, CARD)
  const spot = await canvasSpot(layer, player, TEXT)
  await page.mouse.click(spot.x, spot.y)
  await expect(layer.getByRole('img', { name: '选中：测试可填项' })).toBeVisible()

  const cardSaves = countCardSaves(page)
  const moved = mainSavedWith(
    page,
    (saved) =>
      !Number.isNaN(cardOffset(savedCard(saved)).x) && cardOffset(savedCard(saved)).x !== 0,
  )
  await page.mouse.move(spot.x, spot.y)
  await page.mouse.down()
  await page.mouse.move(spot.x + 20, spot.y + 10, { steps: 4 })
  await page.mouse.move(spot.x + 40, spot.y + 20, { steps: 4 })
  // 还没松手：预览里整块已经挪过去了
  const canvas = await boxOf(layer)
  await settles(async () =>
    expect(((await previewRect(player, CARD)).x - before.x) * canvas.width).toBeCloseTo(40, 0),
  )
  await page.mouse.up()
  // 拖的距离换成画布像素，加在居中用的 -50% 上；宿主上没有挪的属性
  const saved = savedCard(htmlOf(await moved))
  const offset = cardOffset(saved)
  expect(Math.abs(offset.x - 40 / zoom)).toBeLessThan(0.5)
  expect(Math.abs(offset.y - 20 / zoom)).toBeLessThan(0.5)
  expect(Object.keys(saved ?? {}).filter((name) => /^data-(x|y|hf-edit)/.test(name))).toEqual([])
  expect(styleOf(saved)).toMatchObject({ scale: styleOf(original)['scale'] })
  await settles(async () =>
    expect(
      ((await previewRect(finalCutPreviewPlayer(editor), CARD)).x - before.x) * canvas.width,
    ).toBeCloseTo(40, 0),
  )
  expect(await previewCardTransform(editor)).toBe('')

  // 焦点在画面上：方向键挪选中的元素（画布上 1 像素），不挪播放头
  const nudged = mainSavedWith(page, (now) => {
    const at = cardOffset(savedCard(now))
    return Math.abs(at.x - (offset.x - 1)) < 0.01 && Math.abs(at.y - (offset.y + 10)) < 0.01
  })
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Shift+ArrowDown')
  await nudged
  await expect(editor.getByRole('group', { name: '播放控制' })).toContainText('00:00.50 /')

  // 撤销三步：宿主回到居中的写法，预览里也回去
  const undone = mainSavedWith(page, (now) => styleOf(savedCard(now))['translate'] === '-50% -50%')
  const undo = editor
    .getByRole('toolbar', { name: '剪辑工具' })
    .getByRole('button', { name: '撤销' })
  for (let count = 0; count < 3; count += 1) await undo.click()
  await undone
  await settles(async () =>
    expect(
      Math.abs(
        ((await previewRect(finalCutPreviewPlayer(editor), CARD)).x - before.x) * canvas.width,
      ),
    ).toBeLessThan(0.5),
  )
  // 组件文件一次都没存过
  expect(cardSaves.count).toBe(0)
})

test('其它语言下画面上挪元素：存下之前预览里已经挪过去，存下以后还在挪过去的地方，组件文件不动', async ({
  page,
}) => {
  const { editor, layer } = await openWithCard(page)
  const languages = editor.getByRole('group', { name: '语言' })
  // 加第一种语言时文字字段改成随语言，主文件变了，预览整份重新加载一次：等存下、新的播放器换上来、没有在加载的
  const bound = mainSavedWith(page, (html) => html.includes('data-locale-bindings'))
  await languages.getByRole('button', { name: '添加语言' }).click()
  await page.getByRole('menuitem', { name: 'English（EN）' }).click()
  await bound
  const player = await settledPlayer(editor)
  const before = await previewRect(player, CARD)
  const spot = await canvasSpot(layer, player, TEXT)
  await page.mouse.click(spot.x, spot.y)
  await expect(layer.getByRole('img', { name: '选中：测试可填项' })).toBeVisible()
  const cardSaves = countCardSaves(page)

  // 阻塞保存响应验证实时预览已先行到位；保存请求可能在预览渲染完成前已发出，须在按键前开始监听请求
  await pauseMockResponses(page, '/workspace/file')
  const nudged = mainSavedWith(page, (html) => cardOffset(savedCard(html)).x === -10)
  await page.keyboard.press('Shift+ArrowLeft')
  // 按画布像素量（Shift+方向键挪 10 画布像素）：屏幕上的距离随预览缩放变，竖版 1080 宽时不到 3 像素
  const size = await canvasSizeOf(player)
  const shift = async () =>
    ((await previewRect(finalCutPreviewPlayer(editor), CARD)).x - before.x) * size.width
  await settles(async () => expect(await shift()).toBeLessThan(-5))
  const shown = await shift()

  // 存下以后：主文件里宿主挪了 10 像素，预览里还在那里
  await releaseMockResponses(page, '/workspace/file')
  await nudged
  await readyPlayer(editor)
  await expect.poll(shift).toBeCloseTo(shown, 0)
  expect(cardSaves.count).toBe(0)
})

/** 计算预览内 `selector` 元素的画布像素中心坐标。 */
const centreOf = async (
  player: Locator,
  selector: string,
  canvas: { width: number; height: number },
) => {
  const rect = await previewRect(player, selector)
  return {
    x: (rect.x + rect.width / 2) * canvas.width,
    y: (rect.y + rect.height / 2) * canvas.height,
  }
}

/** 读取预览内 final-cut 合成根的画布宽高（画布像素）。 */
const canvasSizeOf = (player: Locator) =>
  player.evaluate((element: PreviewPlayer) => {
    const film = element.iframeElement.contentDocument?.getElementById('film')
    return { width: Number(film?.dataset['width']), height: Number(film?.dataset['height']) }
  })

test('画面上缩放元素：拖右下角的把手往外，整块以中心等比放大，主文件里宿主写 scale（不写宽高、不写挪的属性），中心不动', async ({
  page,
}) => {
  const { editor, layer, player, html } = await openWithCard(page)
  const original = styleOf(savedCard(html))
  const spot = await canvasSpot(layer, player, TEXT)
  await page.mouse.click(spot.x, spot.y)
  const frame = layer.getByRole('img', { name: '选中：测试可填项' })
  await expect(frame).toBeVisible()
  const box = await boxOf(frame)
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const corner = { x: box.x + box.width, y: box.y + box.height }
  const to = { x: corner.x + 30, y: corner.y + 20 }
  const ratio =
    Math.hypot(to.x - center.x, to.y - center.y) /
    Math.hypot(corner.x - center.x, corner.y - center.y)
  const size = await canvasSizeOf(player)
  const before = await centreOf(player, CARD, size)
  const beforeRect = await previewRect(player, CARD)

  const cardSaves = countCardSaves(page)
  const resized = mainSavedWith(
    page,
    (saved) => styleOf(savedCard(saved))['scale'] !== original['scale'],
  )
  await page.mouse.move(corner.x, corner.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up()
  const saved = savedCard(htmlOf(await resized))
  const styles = styleOf(saved)
  expect(Number(styles['scale'])).toBeCloseTo(Number(original['scale']) * ratio, 2)
  expect(styles).toMatchObject({
    width: original['width'],
    height: original['height'],
    translate: original['translate'],
  })
  expect(styles['min-width']).toBeUndefined()
  expect(styles['box-sizing']).toBeUndefined()
  expect(Object.keys(saved ?? {}).filter((name) => /^data-(x|y|hf-edit)/.test(name))).toEqual([])
  await settles(async () =>
    expect(
      (await previewRect(finalCutPreviewPlayer(editor), CARD)).width / beforeRect.width,
    ).toBeCloseTo(ratio, 2),
  )
  const after = await centreOf(finalCutPreviewPlayer(editor), CARD, size)
  expect(Math.abs(after.x - before.x)).toBeLessThan(1)
  expect(Math.abs(after.y - before.y)).toBeLessThan(1)
  expect(await previewCardTransform(editor)).toBe('')
  expect(cardSaves.count).toBe(0)
})

test('画面上旋转元素：按住 Shift 拖旋转把手吸到 15° 的整数倍，主文件里宿主写 rotate；预览里整块跟着转，撤销回去', async ({
  page,
}) => {
  const { editor, layer, player } = await openWithCard(page)
  const spot = await canvasSpot(layer, player, TEXT)
  await page.mouse.click(spot.x, spot.y)
  const frame = layer.getByRole('img', { name: '选中：测试可填项' })
  const box = await boxOf(frame)
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const handle = await boxOf(layer.getByRole('button', { name: '旋转' }))
  const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }

  // 把手在框下面（正下方 90°），拖到中心左边偏下一点（约 172°）：转了约 82°，吸到 75°
  const cardSaves = countCardSaves(page)
  const rotated = mainSavedWith(page, (saved) => styleOf(savedCard(saved))['rotate'] !== undefined)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.keyboard.down('Shift')
  await page.mouse.move(center.x - 100, center.y + 14, { steps: 8 })
  await page.mouse.up()
  await page.keyboard.up('Shift')
  const saved = savedCard(htmlOf(await rotated))
  expect(styleOf(saved)['rotate']).toBe('75deg')
  expect(Object.keys(saved ?? {}).filter((name) => /^data-(x|y|hf-edit)/.test(name))).toEqual([])
  await expect
    .poll(() =>
      finalCutPreviewPlayer(editor).evaluate(
        (element: PreviewPlayer, query) =>
          element.iframeElement.contentDocument?.querySelector<HTMLElement>(query)?.style.rotate,
        CARD,
      ),
    )
    .toBe('75deg')
  expect(await previewCardTransform(editor)).toBe('')

  const undone = mainSavedWith(page, (now) => {
    const host = savedCard(now)
    return host !== null && styleOf(host)['rotate'] === undefined
  })
  await editor
    .getByRole('toolbar', { name: '剪辑工具' })
    .getByRole('button', { name: '撤销' })
    .click()
  await undone
  expect(cardSaves.count).toBe(0)
})

test('组件根不接收指针、宿主没写尺寸（铺满画面）时：点它里面照样选中整个元素，框是整个画面；拖动写宿主的 translate，往里拖角缩小写 scale、中心不动；组件文件不动，点完组件根还是不接收指针', async ({
  page,
}) => {
  const PASS_FILE = 'compositions/fixtures/fixture-passthrough.html'
  const BADGE = `${CARD} .fp-badge`
  const { editor, layer, player, html } = await openWithCard(page, {
    search: '点穿',
    title: '测试点穿',
    seconds: 4,
  })
  const hostOf = (content: string) =>
    savedElement(content, savedItem(content, '测试点穿')?.id ?? '')
  expect(styleOf(hostOf(html))['translate']).toBeUndefined()
  const before = await previewRect(player, BADGE)
  const spot = await canvasSpot(layer, player, BADGE)
  await page.mouse.click(spot.x, spot.y)
  await expect(clipButton(editor, 2, '测试点穿')).toHaveAttribute('aria-pressed', 'true')
  const frame = layer.getByRole('img', { name: '选中：测试点穿' })
  await expect(frame).toBeVisible()
  alignsWith(await boxOf(frame), await boxOf(layer))
  // 点中判断完就撤掉：组件根还是不接收指针，页面上没有多出样式
  expect(
    await player.evaluate((element: PreviewPlayer) => {
      const doc = element.iframeElement.contentDocument
      const root = doc?.querySelector('#film > .component > [data-hf-inner-root]')
      return [
        root === null || root === undefined ? null : getComputedStyle(root).pointerEvents,
        doc?.adoptedStyleSheets.length,
      ]
    }),
  ).toEqual(['none', 0])

  const cardSaves = countCardSaves(page, PASS_FILE)
  const moved = mainSavedWith(
    page,
    (content) => styleOf(hostOf(content))['translate'] !== undefined,
  )
  const zoom = await canvasZoom(layer, player)
  await page.mouse.move(spot.x, spot.y)
  await page.mouse.down()
  await page.mouse.move(spot.x + 20, spot.y + 10, { steps: 4 })
  await page.mouse.move(spot.x + 40, spot.y + 20, { steps: 4 })
  await page.mouse.up()
  const host = hostOf(htmlOf(await moved))
  const [x, y] = (styleOf(host)['translate'] ?? '')
    .split(' ')
    .map((part) => Number.parseFloat(part))
  expect(Math.abs((x ?? Number.NaN) - 40 / zoom)).toBeLessThan(0.5)
  expect(Math.abs((y ?? Number.NaN) - 20 / zoom)).toBeLessThan(0.5)
  expect(Object.keys(host ?? {}).filter((name) => /^data-(x|y|hf-edit)/.test(name))).toEqual([])
  const canvas = await boxOf(layer)
  await settles(async () =>
    expect(
      ((await previewRect(finalCutPreviewPlayer(editor), BADGE)).x - before.x) * canvas.width,
    ).toBeCloseTo(40, 0),
  )

  // 右下角的把手往里拖：整块以中心缩小，写 scale，中心不动
  const size = await canvasSizeOf(player)
  const centre = await centreOf(finalCutPreviewPlayer(editor), CARD, size)
  // 以整块的中心算（框只画看得见的那一块，挪过以后伸出画面的部分不画）
  const middle = { x: canvas.x + centre.x * zoom, y: canvas.y + centre.y * zoom }
  const corner = await boxOf(frame.locator('[data-corner="se"]'))
  const from = { x: corner.x + corner.width / 2, y: corner.y + corner.height / 2 }
  const to = { x: from.x - 60, y: from.y - 40 }
  const ratio =
    Math.hypot(to.x - middle.x, to.y - middle.y) / Math.hypot(from.x - middle.x, from.y - middle.y)
  const scaled = mainSavedWith(page, (content) => styleOf(hostOf(content))['scale'] !== undefined)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up()
  const resized = styleOf(hostOf(htmlOf(await scaled)))
  expect(Number(resized['scale'])).toBeCloseTo(ratio, 2)
  expect(resized['width']).toBeUndefined()
  await settles(async () => {
    const after = await centreOf(finalCutPreviewPlayer(editor), CARD, size)
    expect(Math.abs(after.x - centre.x)).toBeLessThan(1)
    expect(Math.abs(after.y - centre.y)).toBeLessThan(1)
    expect((await previewRect(finalCutPreviewPlayer(editor), CARD)).width).toBeCloseTo(ratio, 2)
  })
  expect(cardSaves.count).toBe(0)
})

test('铺满画面的元素盖在视频上：点元素里空着的地方（没有徽标、裁切窗）选中下面的视频，不选中元素', async ({
  page,
}) => {
  const { editor, layer } = await openWithCard(page, {
    search: '点穿',
    title: '测试点穿',
    seconds: 4,
  })
  const card = clipButton(editor, 2, '测试点穿')
  const video = clipButton(editor, 1, 'A · 镜头 1')
  // 左下角：元素在这里什么都没画
  const canvas = await boxOf(layer)
  await page.mouse.click(canvas.x + canvas.width * 0.2, canvas.y + canvas.height * 0.8)
  await expect(video).toHaveAttribute('aria-pressed', 'true')
  await expect(card).toHaveAttribute('aria-pressed', 'false')
  const frame = layer.getByRole('img', { name: '选中：A · 镜头 1' })
  await expect(frame).toBeVisible()
  await expect(layer.getByRole('img', { name: '选中：测试点穿' })).toHaveCount(0)

  // 视频铺满画面：旋转把手在框下面，整个落在舞台里，不压到进度条
  const drawn = await boxOf(frame)
  alignsWith(drawn, canvas)
  const rotate = await boxOf(layer.getByRole('button', { name: '旋转' }))
  const stage = await boxOf(editor.getByRole('region', { name: '预览', exact: true }))
  const seek = await boxOf(editor.getByTestId('preview-seek'))
  expect(rotate.y).toBeGreaterThan(drawn.y + drawn.height)
  expect(rotate.x).toBeGreaterThanOrEqual(stage.x)
  expect(rotate.x + rotate.width).toBeLessThanOrEqual(stage.x + stage.width)
  expect(rotate.y + rotate.height).toBeLessThanOrEqual(seek.y)
})

test('画面上拖元素靠近画面中线（播放头处没有视频，只有画布可吸）：拖动中画出贯穿画面的对齐线，松手正好落在中线上、线消失；按住 Alt 拖不吸、不画线', async ({
  page,
}) => {
  const { editor, layer, player } = await openWithCard(page)
  // 播放头挪到 1.5 秒：视频已经结束，画面上只有元素
  await clipButton(editor, 2, '测试可填项').click()
  await stepPlayhead(page, editor, 5, 10)
  await page.keyboard.press('Escape')
  const height = await player.evaluate((element: PreviewPlayer) =>
    Number(element.iframeElement.contentDocument?.getElementById('film')?.dataset['height']),
  )
  const canvas = await boxOf(layer)
  const zoom = canvas.height / height
  // 元素和画面差不多一样宽（左右边贴着画面的边），上下拖：只有中心靠得上画面的横中线
  const middle = canvas.y + canvas.height / 2
  /** 元素的中心在横中线下面多少（画布像素）。 */
  const offCentre = async () => {
    const rect = await previewRect(finalCutPreviewPlayer(editor), CARD)
    return (rect.y + rect.height / 2 - 0.5) * height
  }
  const frame = layer.getByRole('img', { name: '选中：测试可填项' })
  const frameCentre = async () => {
    const box = await boxOf(frame)
    return box.y + box.height / 2
  }
  const guides = layer.getByTestId('canvas-guide')
  const spot = await canvasSpot(layer, player, TEXT)
  await page.mouse.click(spot.x, spot.y)
  await expect(frame).toBeVisible()
  expect(Math.abs(await offCentre())).toBeLessThan(0.01)

  // 元素本来就在正中：先按住 Alt 往下拖开 40 个屏幕像素
  const away = mainSavedWith(page, (saved) => cardOffset(savedCard(saved)).y > 0)
  await page.keyboard.down('Alt')
  await page.mouse.move(spot.x, spot.y)
  await page.mouse.down()
  await page.mouse.move(spot.x, spot.y + 40, { steps: 4 })
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await away
  await settles(async () => expect(Math.abs((await offCentre()) - 40 / zoom)).toBeLessThan(0.5))

  // 中心拖到横中线下面 2 个屏幕像素：拖动中有一条贯穿画面的横线在中线上，框已经吸到正中
  const grab = { x: spot.x, y: spot.y + 40 }
  const snapped = mainSavedWith(page, (saved) => cardOffset(savedCard(saved)).y < 20)
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(grab.x, grab.y - 38, { steps: 8 })
  await expect(guides.first()).toBeVisible()
  const lines = await guides.evaluateAll((elements) =>
    elements.map((element) => {
      const { y, width, height: lineHeight } = element.getBoundingClientRect()
      return { y, width, height: lineHeight }
    }),
  )
  expect(
    lines.some(
      (line) =>
        Math.abs(line.y - middle) < 1 &&
        line.height <= 1.5 &&
        Math.abs(line.width - canvas.width) < 1,
    ),
  ).toBe(true)
  await expect.poll(frameCentre).toBeCloseTo(middle, 0)
  await page.mouse.up()
  // 存下的宿主竖着正好回到居中的写法
  expect(cardOffset(savedCard(htmlOf(await snapped))).y).toBe(0)
  await expect(guides).toHaveCount(0)
  await settles(async () => expect(Math.abs(await offCentre())).toBeLessThan(0.01))

  // 按住 Alt 从正中拖开再拖回横中线下面 3 个屏幕像素：不吸，没有线，松手就停在那里
  const from = await canvasSpot(layer, finalCutPreviewPlayer(editor), TEXT)
  const loose = mainSavedWith(page, (saved) => cardOffset(savedCard(saved)).y > 0)
  await page.keyboard.down('Alt')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x, from.y + 40, { steps: 4 })
  await page.mouse.move(from.x, from.y + 3, { steps: 4 })
  await expect.poll(frameCentre).toBeCloseTo(middle + 3, 0)
  await expect(guides).toHaveCount(0)
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await loose
  await settles(async () => expect(Math.abs((await offCentre()) - 3 / zoom)).toBeLessThan(0.5))
})

test('画面上拖元素靠近另一个元素的边：吸到那条边上，拖动中在那条边上画出参考线，松手正好落在那里', async ({
  page,
}) => {
  const { editor, layer, player } = await openWithCard(page)
  // 「测试可填项」先往下挪 60 像素：它的上边离开画面的边和中线
  const spot = await canvasSpot(layer, player, TEXT)
  await page.mouse.click(spot.x, spot.y)
  await expect(layer.getByRole('img', { name: '选中：测试可填项' })).toBeVisible()
  const lowered = mainSavedWith(page, (saved) => cardOffset(savedCard(saved)).y === 60)
  for (let step = 0; step < 6; step += 1) await page.keyboard.press('Shift+ArrowDown')
  await lowered

  // 再在播放头处加一个铺满画面的「测试点穿」
  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '元素' }).click()
  await side.getByRole('searchbox', { name: '搜索元素' }).fill('点穿')
  const item = side.getByRole('group', { name: '测试点穿，4 秒' })
  const added = mainSavedWith(page, (html) => savedItem(html, '测试点穿') !== null)
  await item.hover()
  await item.getByRole('button', { name: '加到播放头' }).click()
  const html = htmlOf(await added)
  await readyPlayer(editor)
  const card = `#film > #${savedItem(html, '测试可填项')?.id ?? ''}`
  const pass = `#film > #${savedItem(html, '测试点穿')?.id ?? ''}`
  const passOf = (content: string) =>
    savedElement(content, savedItem(content, '测试点穿')?.id ?? '')

  // 播放头挪到 1.5 秒：视频已经结束，画面上只有这两个元素
  await editor.getByRole('button', { name: /^选中：测试可填项，/ }).click()
  await stepPlayhead(page, editor, 5, 10)
  await page.keyboard.press('Escape')
  const shown = await settledPlayer(editor)
  const canvas = await boxOf(layer)
  const { height } = await canvasSizeOf(shown)
  const zoom = canvas.height / height
  const target = await previewRect(shown, card)
  const before = await previewRect(shown, pass)
  // 「测试点穿」的上边要吸到「测试可填项」的上边：画面上隔着多少屏幕像素
  const gap = (target.y - before.y) * canvas.height
  const edge = canvas.y + target.y * canvas.height
  expect(gap).toBeGreaterThan(20)

  const badge = await canvasSpot(layer, shown, `${pass} .fp-badge`)
  await page.mouse.click(badge.x, badge.y)
  const frame = layer.getByRole('img', { name: '选中：测试点穿' })
  await expect(frame).toBeVisible()
  const snapped = mainSavedWith(page, (saved) => styleOf(passOf(saved))['translate'] !== undefined)
  // 拖到上边离那条边还差 3 个屏幕像素：拖动中框已经吸过去，那条边上有一条横的参考线
  await page.mouse.move(badge.x, badge.y)
  await page.mouse.down()
  await page.mouse.move(badge.x, badge.y + gap - 3, { steps: 10 })
  const guides = layer.getByTestId('canvas-guide')
  await expect(guides.first()).toBeVisible()
  const lines = await guides.evaluateAll((elements) =>
    elements.map((element) => {
      const { y, height: lineHeight } = element.getBoundingClientRect()
      return { y, height: lineHeight }
    }),
  )
  expect(lines.some((line) => Math.abs(line.y - edge) < 1 && line.height <= 1.5)).toBe(true)
  await expect.poll(async () => (await boxOf(frame)).y).toBeCloseTo(edge, 0)
  await page.mouse.up()

  // 存下的宿主竖着正好挪了两条上边之间的距离
  const [, y] = (styleOf(passOf(htmlOf(await snapped)))['translate'] ?? '')
    .split(' ')
    .map((part) => Number.parseFloat(part))
  expect(Math.abs((y ?? Number.NaN) - (target.y - before.y) * height)).toBeLessThan(0.1)
  // 不吸时松手停在差 3 个屏幕像素的地方
  expect(Math.abs((y ?? Number.NaN) - (gap - 3) / zoom)).toBeGreaterThan(2 / zoom)
  await expect(guides).toHaveCount(0)
})

test('元素挪得伸出画面：悬停框、选中框只框画面里看得见的那一块，不伸出画面', async ({ page }) => {
  const { editor, layer, player } = await openWithCard(page)
  const canvas = await boxOf(layer)
  const spot = await canvasSpot(layer, player, TEXT)
  await page.mouse.click(spot.x, spot.y)
  const frame = layer.getByRole('img', { name: '选中：测试可填项' })
  await expect(frame).toBeVisible()
  // 往右拖半个画面宽：右边一截伸出画面
  const moved = mainSavedWith(page, (saved) => cardOffset(savedCard(saved)).x > 0)
  await page.mouse.move(spot.x, spot.y)
  await page.mouse.down()
  await page.mouse.move(spot.x + canvas.width / 2, spot.y, { steps: 8 })
  await page.mouse.up()
  await moved
  const whole = async () => {
    const rect = await previewRect(finalCutPreviewPlayer(editor), CARD)
    return { x: canvas.x + rect.x * canvas.width, width: rect.width * canvas.width }
  }
  await settles(async () =>
    expect((await whole()).x + (await whole()).width).toBeGreaterThan(canvas.x + canvas.width + 20),
  )
  const shown = await shownOnPage(layer, finalCutPreviewPlayer(editor), CARD)
  /** 画出来的框是宿主在画面里的那一块：右边到画面边上为止。 */
  const fitsCanvas = (box: { x: number; y: number; width: number; height: number }) => {
    alignsWith(box, shown)
    expect(box.x + box.width).toBeLessThanOrEqual(canvas.x + canvas.width + 0.5)
  }
  await expect
    .poll(async () => (await boxOf(frame)).x + (await boxOf(frame)).width)
    .toBeLessThanOrEqual(canvas.x + canvas.width + 0.5)
  fitsCanvas(await boxOf(frame))

  // 取消选中再悬停在色底上：悬停框也只框画面里的那一块
  await page.keyboard.press('Escape')
  await expect(layer.getByRole('img')).toHaveCount(0)
  const panel = await shownOnPage(layer, finalCutPreviewPlayer(editor), `${CARD} #ff-panel`)
  await page.mouse.move(panel.x + panel.width / 2, panel.y + panel.height / 2)
  const hover = layer.getByTestId('canvas-hover')
  await expect(hover).toBeVisible()
  fitsCanvas(await boxOf(hover))
})

test('画面上双击元素的文字原地改：悬停在字上是输入光标、色底上不是，框都是整个元素；回车写进可填项的值，预览里换成新的字；Esc 放弃不写', async ({
  page,
}) => {
  const { editor, layer, player } = await openWithCard(page)
  const text = await canvasSpot(layer, player, `${CARD} [data-var-text="text"]`)
  const hover = layer.getByTestId('canvas-hover')
  const whole = await shownOnPage(layer, player, CARD)
  const panel = await shownOnPage(layer, player, `${CARD} #ff-panel`)
  await page.mouse.move(panel.x + panel.width * 0.9, panel.y + panel.height / 2)
  await expect(hover).toBeVisible()
  alignsWith(await boxOf(hover), whole)
  await expect(layer).not.toHaveCSS('cursor', 'text')
  await page.mouse.move(text.x, text.y)
  await expect(layer).toHaveCSS('cursor', 'text')
  alignsWith(await boxOf(hover), whole)

  await page.mouse.dblclick(text.x, text.y)
  await expect(clipButton(editor, 2, '测试可填项')).toHaveAttribute('aria-pressed', 'true')
  const input = layer.getByRole('textbox', { name: '文字' })
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('示例文字')
  // 改的时候预览里那段字藏起来，输入框盖在它上面
  await expect
    .poll(() =>
      player.evaluate(
        (element: PreviewPlayer, query) =>
          element.iframeElement.contentDocument?.querySelector<HTMLElement>(query)?.style
            .visibility,
        `${CARD} [data-var-text="text"]`,
      ),
    )
    .toBe('hidden')

  const renamed = mainSavedWith(
    page,
    (html) => savedItem(html, '测试可填项')?.values['text'] === '画面上改的字',
  )
  await input.fill('画面上改的字')
  await page.keyboard.press('Enter')
  await renamed
  await expect(input).toHaveCount(0)
  await expect(
    editor.getByRole('tabpanel', { name: '属性' }).getByRole('textbox', { name: '文字' }),
  ).toHaveValue('画面上改的字')
  const shownText = () =>
    finalCutPreviewPlayer(editor).evaluate((element: PreviewPlayer, query) => {
      const field = element.iframeElement.contentDocument?.querySelector<HTMLElement>(query)
      return field === null || field === undefined
        ? null
        : `${field.textContent}|${field.style.visibility}`
    }, `${CARD} [data-var-text="text"]`)
  await expect.poll(shownText).toBe('画面上改的字|')

  // 再双击、改了按 Esc：不写，字还是刚才的
  const freshText = await canvasSpot(
    layer,
    finalCutPreviewPlayer(editor),
    `${CARD} [data-var-text="text"]`,
  )
  await page.mouse.dblclick(freshText.x, freshText.y)
  await expect(input).toHaveValue('画面上改的字')
  await input.fill('不要的字')
  await page.keyboard.press('Escape')
  await expect(input).toHaveCount(0)
  expect(await savesWithin(page, 800)).toBe(0)
  await expect.poll(shownText).toBe('画面上改的字|')
})

test('画面上正显示着字幕时点元素：选中的还是元素，铺满画面的字幕宿主不挡', async ({ page }) => {
  const { editor, layer } = await openWithCard(page)
  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '字幕' }).click()
  const added = page.waitForRequest(
    (request) => savedFileOf(request, CAPTIONS_FILE)?.includes('>新字幕</div>') === true,
  )
  await side
    .getByRole('tabpanel', { name: '字幕' })
    .getByRole('button', { name: '在播放头处添加字幕' })
    .click()
  await added
  // 加上的那句选中着、显示着：画面上框住了它，说明预览量到了它的框
  await expect(layer.getByRole('img', { name: '选中：新字幕' })).toBeVisible()

  const player = await readyPlayer(editor)
  const spot = await canvasSpot(layer, player, TEXT)
  await page.mouse.click(spot.x, spot.y)
  await expect(clipButton(editor, 2, '测试可填项')).toHaveAttribute('aria-pressed', 'true')
  await expect(layer.getByRole('img', { name: '选中：测试可填项' })).toBeVisible()
  await expect(layer.getByRole('img', { name: '选中：新字幕' })).toHaveCount(0)
})

/** 存出的字幕场景里写着 `text` 的那句字幕的编号。 */
const captionIdOf = (scene: string, text: string) =>
  new RegExp(`<div [^>]*id="(cap-[^"]+)"[^>]*>${text}</div>`).exec(scene)?.[1] ?? ''

/**
 * 打开 final-cut 编辑器，放进整条镜头 1，加两句字幕「第一句」（0–2 秒）、「第二句」（2–4 秒），播放头停在 2 秒
 * （显示着第二句），侧栏停在「字幕」页签；返回编辑器、侧栏、编辑层、正在显示的播放器和两句的编号。
 */
const openWithCaptions = async (page: Page) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await createFinalCut(panel)
  await addWholeTake(page, editor)

  const side = editor.getByRole('complementary', { name: '镜头、元素、模板、配乐、字幕和属性' })
  await side.getByRole('tab', { name: '字幕' }).click()
  const tab = side.getByRole('tabpanel', { name: '字幕' })
  const sceneWith = (text: string) =>
    page.waitForRequest((request) => savedFileOf(request, CAPTIONS_FILE)?.includes(text) === true)
  const addButton = tab.getByRole('button', { name: '在播放头处添加字幕' })
  const firstAdded = sceneWith('>新字幕</div>')
  await addButton.click()
  await firstAdded
  const firstNamed = sceneWith('>第一句</div>')
  await tab.getByRole('textbox', { name: '字幕文字 00:00.00 – 00:02.00' }).fill('第一句')
  await firstNamed

  // 在时间线上点一下这句（焦点到时间线上），播放头挪到 2 秒再加一句
  const row = editor.getByRole('group', { name: '字幕', exact: true })
  await row
    .getByRole('group', { name: /^第一句，/ })
    .getByRole('button', { name: /^选中：/ })
    .click()
  await stepPlayhead(page, editor, 0, 20)
  const secondAdded = sceneWith('>新字幕</div>')
  await addButton.click()
  await secondAdded
  const bothNamed = sceneWith('>第二句</div>')
  await tab.getByRole('textbox', { name: '字幕文字 00:02.00 – 00:04.00' }).fill('第二句')
  const scene = savedFileOf(await bothNamed, CAPTIONS_FILE) ?? ''
  const player = await readyPlayer(editor)
  return {
    editor,
    side,
    layer: editor.getByRole('group', { name: '预览画面', exact: true }),
    player,
    row,
    first: captionIdOf(scene, '第一句'),
    second: captionIdOf(scene, '第二句'),
  }
}

/** 预览里各句字幕的字、算出来的字色、透明度和看不看得到（按编号）；换播放器的那一刻是 null。 */
const previewCaptions = (editor: Locator) =>
  finalCutPreviewPlayer(editor).evaluateAll((elements) => {
    if (elements.length !== 1) return null
    const [element] = elements as PreviewPlayer[]
    const page = element?.iframeElement.contentDocument
    return Object.fromEntries(
      [...(page?.querySelectorAll<HTMLElement>('.caption') ?? [])].map((caption) => {
        const style = caption.ownerDocument.defaultView?.getComputedStyle(caption)
        return [
          caption.id,
          {
            // <br> 和 pre-line 下的换行都读成 \n
            text: caption.innerText,
            color: style?.color,
            font: style?.fontFamily.split(',')[0]?.replace(/["']/g, '').trim(),
            opacity: caption.style.opacity,
            shown: style?.visibility !== 'hidden' && caption.getBoundingClientRect().height > 0,
          },
        ]
      }),
    )
  })

test('字幕的字体和颜色：默认改的是字幕样式，预览里所有句子一起变色、换上字体，主文件链上字体；打开一句的「单独设置」后再改颜色，只有这一句变、不换播放器', async ({
  page,
}) => {
  const { editor, side, row, first, second } = await openWithCaptions(page)
  await expect
    .poll(async () => (await previewCaptions(editor))?.[second])
    .toMatchObject({ text: '第二句', color: 'rgb(255, 255, 255)', shown: true })

  await row
    .getByRole('group', { name: /^第二句，/ })
    .getByRole('button', { name: /^选中：/ })
    .click()
  await side.getByRole('tab', { name: '属性' }).click()
  const inspector = side.getByRole('tabpanel', { name: '属性' })
  const own = inspector.getByRole('switch', { name: '单独设置' })
  await expect(own).not.toBeChecked()

  // 字幕样式写在场景的一条规则里，各句不写行内样式；这一步预览可以整份重新加载
  const colored = page.waitForRequest((request) => {
    const scene = savedFileOf(request, CAPTIONS_FILE) ?? ''
    return /\.clip\.caption \{\n {2}color: #ff3366;\n\}/.test(scene) && !/<div style=/.test(scene)
  })
  const hex = inspector.getByRole('textbox', { name: '颜色' })
  await hex.fill('#ff3366')
  await colored
  await expect
    .poll(async () => {
      const captions = await previewCaptions(editor)
      return [captions?.[second]?.color, captions?.[first]?.color]
    })
    .toEqual(['rgb(255, 51, 102)', 'rgb(255, 51, 102)'])

  // 字体：要链上新的字体样式表，预览可以整份重新加载；换上来以后两句都是这个字体、颜色还在
  const fonted = page.waitForRequest((request) =>
    /\.clip\.caption \{\n {2}font-family: 'Playfair Display', '[^']+', sans-serif;\n {2}color: #ff3366;\n\}/.test(
      savedFileOf(request, CAPTIONS_FILE) ?? '',
    ),
  )
  const linked = page.waitForRequest((request) =>
    /<link rel="stylesheet" href="[^"]*playfair-display[^"]*\.css">/.test(
      savedHtmlOf(request) ?? '',
    ),
  )
  await inspector.getByRole('button', { name: '字体：默认' }).click()
  await page.getByRole('menuitemradio', { name: 'Playfair Display' }).click()
  await Promise.all([fonted, linked])
  await expect
    .poll(async () => {
      const captions = await previewCaptions(editor)
      return [captions?.[second]?.font, captions?.[first]?.font, captions?.[second]?.color]
    })
    .toEqual(['Playfair Display', 'Playfair Display', 'rgb(255, 51, 102)'])

  // 打开单独设置：这一句行内写上这一刻显示的样子，画面不变；再改颜色只有这一句变，预览直接改、不换播放器
  await markFinalCutPreviewPlayer(editor)
  const owned = page.waitForRequest((request) =>
    new RegExp(
      `<div style="font-family: 'Playfair Display', '[^']+', sans-serif; color: #ff3366; font-size: \\d+px;[^"]*" id="${second}"`,
    ).test(savedFileOf(request, CAPTIONS_FILE) ?? ''),
  )
  await own.click()
  await owned
  await expect(own).toBeChecked()
  const recolored = page.waitForRequest((request) =>
    new RegExp(`<div style="[^"]*color: #33cc99;[^"]*" id="${second}"`).test(
      savedFileOf(request, CAPTIONS_FILE) ?? '',
    ),
  )
  await hex.fill('#33cc99')
  await recolored
  await expect
    .poll(async () => {
      const captions = await previewCaptions(editor)
      return [captions?.[second]?.color, captions?.[first]?.color]
    })
    .toEqual(['rgb(51, 204, 153)', 'rgb(255, 51, 102)'])
  expect(await isMarkedFinalCutPreviewPlayer(editor)).toBe(true)
})

test('字幕的字号：选中一句打开「单独设置」再改字号，预览里只有这一句换成新字号、描边跟着变粗，不换播放器；存下的场景里这一句写着字号、描边和投影', async ({
  page,
}) => {
  const { editor, side, row, first, second } = await openWithCaptions(page)
  /** 预览里各句字幕算出来的字号和描边粗细（像素，按编号）；换播放器的那一刻是 null。 */
  const previewSizes = () =>
    finalCutPreviewPlayer(editor).evaluateAll((elements) => {
      if (elements.length !== 1) return null
      const [element] = elements as PreviewPlayer[]
      const page = element?.iframeElement.contentDocument
      return Object.fromEntries(
        [...(page?.querySelectorAll<HTMLElement>('.caption') ?? [])].map((caption) => {
          const style = caption.ownerDocument.defaultView?.getComputedStyle(caption)
          return [
            caption.id,
            {
              size: Number.parseFloat(style?.fontSize ?? ''),
              stroke: Number.parseFloat(style?.getPropertyValue('-webkit-text-stroke-width') ?? ''),
            },
          ]
        }),
      )
    })
  await expect.poll(async () => (await previewSizes())?.[second]?.size).toBeGreaterThan(0)
  await markFinalCutPreviewPlayer(editor)

  await row
    .getByRole('group', { name: /^第二句，/ })
    .getByRole('button', { name: /^选中：/ })
    .click()
  await side.getByRole('tab', { name: '属性' }).click()
  const inspector = side.getByRole('tabpanel', { name: '属性' })
  const readout = inspector.getByRole('button', { name: /^字号 \d+ px，点击可直接输入$/ })
  const fallback = Number(
    /字号 (\d+) px/.exec((await readout.getAttribute('aria-label')) ?? '')?.[1],
  )
  const before = (await previewSizes())?.[second]
  expect(before?.size).toBe(fallback)
  const owned = page.waitForRequest((request) =>
    new RegExp(`<div style="[^"]*font-size: ${fallback}px;[^"]*" id="${second}"`).test(
      savedFileOf(request, CAPTIONS_FILE) ?? '',
    ),
  )
  await inspector.getByRole('switch', { name: '单独设置' }).click()
  await owned
  const size = Math.round(fallback * 1.5)
  const saved = page.waitForRequest((request) =>
    new RegExp(
      `<div style="[^"]*font-size: ${size}px; -webkit-text-stroke: \\d+px #000000; text-shadow: 0 \\d+px \\d+px rgba\\(0, 0, 0, 0\\.45\\)" id="${second}"`,
    ).test(savedFileOf(request, CAPTIONS_FILE) ?? ''),
  )
  await readout.click()
  await page.keyboard.type(String(size))
  await page.keyboard.press('Enter')
  await saved

  await expect
    .poll(async () => {
      const sizes = await previewSizes()
      return [sizes?.[second]?.size, sizes?.[first]?.size]
    })
    .toEqual([size, fallback])
  const after = (await previewSizes())?.[second]
  expect(after?.stroke).toBeGreaterThan(before?.stroke ?? Number.POSITIVE_INFINITY)
  expect(await isMarkedFinalCutPreviewPlayer(editor)).toBe(true)
})

test('画面上的字幕按句改：点正在显示的那句选中它（下面的视频选中着时也是），带缩放、旋转把手；拖它写进字幕场景里这一句，别的句不动；双击原地改字，回车写进这一句，Esc 放弃', async ({
  page,
}) => {
  const { editor, layer, player, row, first, second } = await openWithCaptions(page)
  const captionButton = row
    .getByRole('group', { name: /^第二句，/ })
    .getByRole('button', { name: /^选中：/ })
  // 在时间线上点一下再按 Esc：焦点在时间线上、什么都没选中
  await captionButton.click()
  await page.keyboard.press('Escape')
  await expect(captionButton).toHaveAttribute('aria-pressed', 'false')
  const selector = `[data-hf-id="${second}"]`
  const spot = await canvasSpot(layer, player, selector)

  await page.mouse.click(spot.x, spot.y)
  await expect(captionButton).toHaveAttribute('aria-pressed', 'true')
  const frame = layer.getByRole('img', { name: '选中：第二句' })
  await expect(frame).toBeVisible()
  await expect(frame.locator('.wf-canvas-handle')).toHaveCount(4)
  await expect(layer.getByRole('button', { name: '旋转' })).toBeVisible()

  // 按句拖：往上挪，写进字幕场景里这一句（data-x / data-y），第一句不动
  const zoom = await canvasZoom(layer, player)
  const firstBefore = await previewRect(player, `[data-hf-id="${first}"]`)
  const secondBefore = await previewRect(player, selector)
  const moved = page.waitForRequest((request) => {
    const saved = savedFileOf(request, CAPTIONS_FILE)
    return saved !== null && savedElement(saved, second)?.['data-y'] !== undefined
  })
  await page.mouse.move(spot.x, spot.y)
  await page.mouse.down()
  await page.mouse.move(spot.x, spot.y - 30, { steps: 4 })
  await page.mouse.move(spot.x, spot.y - 60, { steps: 4 })
  await page.mouse.up()
  const scene = savedFileOf(await moved, CAPTIONS_FILE) ?? ''
  expect(Math.abs(Number(savedElement(scene, second)?.['data-y']) + 60 / zoom)).toBeLessThan(0.5)
  expect(savedElement(scene, first)?.['data-y']).toBeUndefined()
  const canvas = await boxOf(layer)
  await settles(async () =>
    expect(
      ((await previewRect(finalCutPreviewPlayer(editor), selector)).y - secondBefore.y) *
        canvas.height,
    ).toBeCloseTo(-60, 0),
  )
  expect(await previewRect(finalCutPreviewPlayer(editor), `[data-hf-id="${first}"]`)).toEqual(
    firstBefore,
  )
  const moveUndone = page.waitForRequest((request) => {
    const saved = savedFileOf(request, CAPTIONS_FILE)
    const sentence = saved === null ? null : savedElement(saved, second)
    return sentence !== null && sentence['data-y'] === undefined
  })
  await editor
    .getByRole('toolbar', { name: '剪辑工具' })
    .getByRole('button', { name: '撤销' })
    .click()
  await moveUndone

  // 压在下面的视频选中着时，点一下字幕也是选中字幕
  const videoButton = clipButton(editor, 1, 'A · 镜头 1')
  await videoButton.click()
  await expect(videoButton).toHaveAttribute('aria-pressed', 'true')
  await page.waitForTimeout(700)
  await page.mouse.click(spot.x, spot.y)
  await expect(captionButton).toHaveAttribute('aria-pressed', 'true')
  await expect(videoButton).toHaveAttribute('aria-pressed', 'false')

  // 双击原地改：改的时候预览里这句藏起来
  await page.mouse.dblclick(spot.x, spot.y)
  await expect(captionButton).toHaveAttribute('aria-pressed', 'true')
  const input = layer.getByRole('textbox', { name: '字幕' })
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('第二句')
  await expect.poll(async () => (await previewCaptions(editor))?.[second]?.opacity).toBe('0')

  const renamed = page.waitForRequest((request) =>
    new RegExp(`id="${second}"[^>]*>画面上改的<br>字幕</div>`).test(
      savedFileOf(request, CAPTIONS_FILE) ?? '',
    ),
  )
  const mainRenamed = mainSavedWith(page, (html) => html.includes('画面上改的\\n字幕'))
  await input.fill('画面上改的')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('字幕')
  await page.keyboard.press('Enter')
  await renamed
  await mainRenamed
  await expect(input).toHaveCount(0)
  await expect
    .poll(async () => (await previewCaptions(editor))?.[second])
    .toMatchObject({ text: '画面上改的\n字幕', opacity: '' })

  // 再双击、改了按 Esc：不写，字还是刚才的
  const fresh = await canvasSpot(layer, finalCutPreviewPlayer(editor), selector)
  await page.mouse.dblclick(fresh.x, fresh.y)
  await expect(input).toHaveValue('画面上改的\n字幕')
  await input.fill('不要的字')
  await page.keyboard.press('Escape')
  await expect(input).toHaveCount(0)
  expect(await savesWithin(page, 800)).toBe(0)
  await expect
    .poll(async () => (await previewCaptions(editor))?.[second])
    .toMatchObject({ text: '画面上改的\n字幕', opacity: '' })
})
