import { expect, test, type Locator, type Page } from '@playwright/test'
import { finalCutPreviewPage, openConversation, openFinalCut } from './helpers'

const draftSaved = (page: Page, clips: number) =>
  page.waitForRequest(
    (request) =>
      request.method() === 'PUT' &&
      request.url().includes('/whole-film/draft') &&
      ((request.postDataJSON() as { html: string }).html.match(/<video /g) ?? []).length === clips,
  )

const readyPlayer = async (editor: Locator) => {
  const player = finalCutPreviewPage(editor).locator('hyperframes-player')
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

test('成片编辑器：选镜头加入成片、播放、撤销、导出下载，切走再切回成片还在', async ({ page }) => {
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
  const editor = await openFinalCut(panel)
  const toolbar = editor.getByRole('toolbar', { name: '剪辑工具' })
  const transport = editor.getByRole('group', { name: '播放控制' })
  await expect(editor.getByText('暂无成片内容，加入内容后可在此预览')).toBeVisible()
  // 「导出」在剪辑工具条的最后；编辑器是工作台的一个页签，排在「文件」前面，没有标题栏和关闭按钮
  await expect(toolbar.getByRole('button', { name: '导出', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await expect(toolbar.getByRole('button').last()).toHaveAccessibleName('导出')
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
  const first = draftSaved(page, 1)
  const previewRuntime = runtimeRequested()
  await materials.getByRole('button', { name: /^生成 A 镜头 1，/ }).click()
  await page.keyboard.press('Enter')
  const { html } = (await first).postDataJSON() as { html: string }
  expect(html).toContain('data-no-timeline')
  expect(html).not.toContain('<script')
  expect(html).toMatch(/<video [^>]*src="[^"]+" data-var-src="src-[0-9a-f-]{36}"/)

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

  const card = editor
    .getByRole('complementary', { name: '贴片、场景、音频和属性' })
    .getByRole('list')
    .getByRole('group', { name: /秒$/ })
    .first()
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

  const second = draftSaved(page, 2)
  await materials.getByRole('button', { name: /^生成 A 镜头 3，/ }).click()
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

  // 缩放：放大一档片段变宽一倍，读数从「适应」变成百分比；点「适应宽度」回去
  const clip = editor.getByRole('group', { name: '第 1 行' }).locator('[data-clip-id]').first()
  const widthOf = async () => (await clip.boundingBox())?.width ?? 0
  const fitted = await widthOf()
  await expect(toolbar.getByText('适应', { exact: true })).toBeVisible()
  await toolbar.getByRole('button', { name: '放大时间线' }).click()
  await expect(toolbar.getByText('200%')).toBeVisible()
  expect((await widthOf()) / fitted).toBeGreaterThan(1.9)
  await toolbar.getByRole('slider', { name: '时间线缩放' }).focus()
  await page.keyboard.press('Home')
  await expect(toolbar.getByText('10%')).toBeVisible()
  await toolbar.getByRole('button', { name: '适应宽度' }).click()
  await expect(toolbar.getByText('适应', { exact: true })).toBeVisible()
  expect(Math.abs((await widthOf()) - fitted)).toBeLessThan(1)

  // 关掉缩略图：片段上不画画面，只剩名字和声音
  await expect(clip.locator('.wf-clip-frames')).toBeVisible()
  await toolbar.getByRole('button', { name: '显示缩略图' }).click()
  await expect(clip.locator('.wf-clip-frames')).toBeHidden()
  await expect(clip.locator('.wf-clip-label')).toBeVisible()
  await toolbar.getByRole('button', { name: '显示缩略图' }).click()
  await expect(clip.locator('.wf-clip-frames')).toBeVisible()

  const undone = draftSaved(page, 1)
  await toolbar.getByRole('button', { name: '撤销' }).click()
  await undone
  const redone = draftSaved(page, 2)
  await toolbar.getByRole('button', { name: '重做' }).click()
  await redone

  const exported = page.waitForResponse(
    (response) => response.url().includes('/whole-film/exports') && response.status() === 202,
  )
  await toolbar.getByRole('button', { name: '导出', exact: true }).click()
  const { exportId } = (await (await exported).json()) as { exportId: string }
  const tiers = page.waitForResponse(
    (response) => response.url().includes(`/generations/${exportId}/enhancements`),
    { timeout: 20_000 },
  )
  await expect(editor.getByRole('status').filter({ hasText: /排队中|正在渲染/ })).toBeVisible()
  const download = editor.getByRole('button', { name: '下载成片' })
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

  // 切到「分镜」页签再切回来：编辑器重新打开，成片和导出都还在
  await panel.getByRole('tab', { name: '分镜' }).click()
  await expect(editor).toBeHidden()
  const reopened = await openFinalCut(panel)
  await expect(reopened.getByRole('button', { name: '下载成片' })).toBeVisible()
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
}

test('播放条：倍速和静音对素材、成片都生效且换播放器后还在，循环播放、快捷键面板、全屏', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await openFinalCut(panel)
  const transport = editor.getByRole('group', { name: '播放控制' })
  const materials = editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })

  // 素材预览：选 2×、按 M 静音
  await materials.getByRole('button', { name: /^生成 A 镜头 1，/ }).click()
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

  // 加入成片：成片预览也是 2×、静音
  const first = draftSaved(page, 1)
  await materials.getByRole('button', { name: /^生成 A 镜头 1，/ }).focus()
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

  // 改动成片后换了播放器：倍速、静音、循环都还在
  const second = draftSaved(page, 2)
  await materials.getByRole('button', { name: /^生成 A 镜头 3，/ }).click()
  await page.keyboard.press('Enter')
  await second
  await expect.poll(settings).toEqual({ rate: 2, muted: true, loop: true, clips: 2 })
  await readyPlayer(editor)

  // 循环开着：从结尾前一点开始放，放到结尾回到开头接着放
  await transport.getByRole('slider', { name: '播放进度' }).focus()
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await transport.getByRole('button', { name: '播放', exact: true }).click()
  await expect
    .poll(() => player.evaluate((element: PlayerSettings) => element.currentTime))
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

  // 再按 M 恢复声音：成片里的片段不再静音
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

/** 存下来的成片里名字是 `title` 的组件或块的片段的属性；没有时是 null。 */
const savedItem = (html: string, title: string) => {
  const tag = new RegExp(`<div [^>]*class="clip component"[^>]*data-label="${title}"[^>]*>`).exec(
    html,
  )?.[0]
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

const draftSavedWith = (page: Page, check: (html: string) => boolean) =>
  page.waitForRequest(
    (request) =>
      request.method() === 'PUT' &&
      request.url().includes('/whole-film/draft') &&
      check((request.postDataJSON() as { html: string }).html),
  )

test('块页签搜到块点「加到播放头」、组件页签拖一个组件到时间线上，预览里画出来，撤销回去', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await openFinalCut(panel)
  const first = draftSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^生成 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  const { html: withVideo } = (await first).postDataJSON() as { html: string }
  const videoSeconds = Number(/<video [^>]*data-duration="([^"]+)"/.exec(withVideo)?.[1])

  const side = editor.getByRole('complementary', { name: '贴片、场景、音频和属性' })
  await expect(side.getByRole('tab', { name: '贴片' })).toHaveAttribute('aria-selected', 'true')
  await side.getByRole('tab', { name: '场景' }).click()
  await side.getByRole('searchbox', { name: '搜索场景' }).fill('渐变')
  const cards = side.getByRole('list', { name: '场景' }).getByRole('group')
  await expect(cards).toHaveCount(1)
  const scene = cards.first()
  await expect(scene).toHaveAccessibleName('测试画面，6 秒')
  const add = scene.getByRole('button', { name: '加到播放头' })
  await expect(add).toHaveCSS('opacity', '0')
  await scene.hover()
  await expect(add).toHaveCSS('opacity', '1')

  // 播放头在 0：第一行这时有视频片段，块放进它下面新开的一行
  const added = draftSavedWith(page, (html) => savedItem(html, '测试画面') !== null)
  await add.click()
  const placed = savedItem(((await added).postDataJSON() as { html: string }).html, '测试画面')
  expect(placed).toMatchObject({ item: 'fixture-scene', start: 0, duration: 6, track: 1 })
  await expect(
    editor.getByRole('group', { name: '第 2 行' }).getByRole('group', { name: '测试画面，6.0 秒' }),
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
  await side.getByRole('tab', { name: '贴片' }).click()
  const overlay = side
    .getByRole('list', { name: '贴片' })
    .getByRole('group', { name: '测试叠加，4 秒' })
  const row = editor.getByRole('group', { name: '第 1 行' })
  // 6 秒长、从 0 开始的那个片段量出每秒多少像素
  const sceneBox = await editor
    .getByRole('group', { name: '第 2 行' })
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
  const dropped = draftSavedWith(page, (html) => savedItem(html, '测试叠加') !== null)
  await page.mouse.up()
  const carried = savedItem(((await dropped).postDataJSON() as { html: string }).html, '测试叠加')
  expect(carried).toMatchObject({ item: 'fixture-overlay', duration: 4, track: 0 })
  expect(Math.abs((carried?.start ?? 0) - target)).toBeLessThan(0.1)

  const undone = draftSavedWith(
    page,
    (html) => savedItem(html, '测试叠加') === null && savedItem(html, '测试画面') !== null,
  )
  await editor
    .getByRole('toolbar', { name: '剪辑工具' })
    .getByRole('button', { name: '撤销' })
    .click()
  await undone
})

test('属性：选中组件或块的片段自动切到「属性」，改文字可填项，存下来、预览里看得到；在「时间」里改开始；点空白处回到贴片页签，撤销回去', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await openFinalCut(panel)
  const inspector = editor.getByRole('tabpanel', { name: '属性' })
  const side = editor.getByRole('complementary', { name: '贴片、场景、音频和属性' })
  await expect(side.getByRole('tab', { name: '贴片' })).toHaveAttribute('aria-selected', 'true')
  await expect(inspector).toHaveCount(0)

  await side.getByRole('searchbox', { name: '搜索贴片' }).fill('可填项')
  const card = side.getByRole('group', { name: '测试可填项，5 秒' })
  const added = draftSavedWith(page, (html) => savedItem(html, '测试可填项') !== null)
  await card.hover()
  await card.getByRole('button', { name: '加到播放头' }).click()
  const placed = savedItem(((await added).postDataJSON() as { html: string }).html, '测试可填项')
  expect(placed).toMatchObject({ item: 'fixture-fields', start: 0, values: {} })

  const row = editor.getByRole('group', { name: '第 1 行' })
  await row.getByRole('button', { name: /^选中：测试可填项，/ }).click()
  await expect(side.getByRole('tab', { name: '属性' })).toHaveAttribute('aria-selected', 'true')
  await expect(inspector.getByRole('heading', { name: '测试可填项' })).toBeVisible()
  await expect(inspector.getByRole('button', { name: '内容' })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  const text = inspector.getByRole('textbox', { name: '文字' })
  await expect(text).toHaveValue('示例文字')

  // 分两下输入，中间停过提交的时间：预览换了一份，焦点还在框里
  await text.fill('新的')
  await page.waitForTimeout(600)
  const renamed = draftSavedWith(
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

  await inspector.getByRole('button', { name: /^时间/ }).click()
  const start = inspector.getByRole('textbox', { name: '开始' })
  await expect(start).toHaveValue('0.00')
  const moved = draftSavedWith(page, (html) => savedItem(html, '测试可填项')?.start === 2)
  await start.fill('2')
  await start.press('Enter')
  await moved
  await expect(start).toHaveValue('2.00')

  const lane = await row.boundingBox()
  if (lane === null) throw new Error('时间线尚未布局')
  await page.mouse.click(lane.x + 6, lane.y + lane.height / 2)
  await expect(row.getByRole('button', { name: /^选中：测试可填项，/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  await expect(side.getByRole('tab', { name: '贴片' })).toHaveAttribute('aria-selected', 'true')
  await expect(side.getByRole('searchbox', { name: '搜索贴片' })).toHaveValue('可填项')
  await expect(inspector).toHaveCount(0)

  const undone = draftSavedWith(page, (html) => savedItem(html, '测试可填项')?.start === 0)
  await editor
    .getByRole('toolbar', { name: '剪辑工具' })
    .getByRole('button', { name: '撤销' })
    .click()
  await undone
})

/** 存下来的成片里的音频片段，写成「名字@行号 起点 时长」，按起点排。 */
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

test('音频栏：试听只播一条，右键加到播放头新开声音行、成片变长，拖一条到声音行的空处，生成一条音乐，撤销回去', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await openFinalCut(panel)
  const first = draftSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^生成 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  const { html: withVideo } = (await first).postDataJSON() as { html: string }
  const videoSeconds = Number(/<video [^>]*data-duration="([^"]+)"/.exec(withVideo)?.[1])
  const progress = editor
    .getByRole('group', { name: '播放控制' })
    .getByRole('slider', { name: '播放进度' })
  await expect(progress).toHaveAttribute('aria-valuetext', /^00:00\.00 \/ 00:0\d\.\d\d$/)

  const side = editor.getByRole('complementary', { name: '贴片、场景、音频和属性' })
  await side.getByRole('tab', { name: '音频' }).click()
  const list = side.getByRole('list', { name: '音频' })
  const guitar = list.getByRole('listitem').filter({ hasText: '轻快原声吉他，适合秋季穿搭' })
  const uploaded = list.getByRole('listitem').filter({ hasText: /^上传的音乐 · / })
  await expect(guitar).toContainText('00:30')
  // 上传的音频记录上没有时长，读完文件才显示
  await expect(uploaded).toContainText('00:30')

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
  const added = draftSavedWith(page, (html) => savedAudio(html).length === 1)
  await guitar
    .getByRole('button', { name: '轻快原声吉他，适合秋季穿搭', exact: true })
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: '加到播放头' }).click()
  expect(savedAudio(((await added).postDataJSON() as { html: string }).html)).toEqual([
    { label: '轻快原声吉他，适合秋季穿搭', start: 1, duration: 30, track: 0 },
  ])
  const soundRow = editor.getByRole('group', { name: '第 2 行' })
  const music = soundRow.getByRole('group', { name: '轻快原声吉他，适合秋季穿搭，30.0 秒' })
  await expect(music).toBeVisible()
  await expect(guitar).toContainText('00:30 · 已使用')
  await expect(progress).toHaveAttribute('aria-valuetext', '00:01.00 / 00:31.00')
  expect(videoSeconds).toBeLessThan(31)

  // 点「已使用」的那一行：选中它对应的片段，侧栏跟着切到「属性」；再点回「音频」，选中不变
  await guitar.getByRole('button', { name: '轻快原声吉他，适合秋季穿搭，已使用' }).click()
  await expect(music.getByRole('button', { name: /^选中：/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(side.getByRole('tab', { name: '属性' })).toHaveAttribute('aria-selected', 'true')
  await side.getByRole('tab', { name: '音频' }).click()
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
  await page.mouse.move(box.x + box.width + 4, lane.y + lane.height / 2, { steps: 8 })
  await expect(soundRow.getByTestId('drop-ghost')).toBeVisible()
  const dropped = draftSavedWith(page, (html) => savedAudio(html).length === 2)
  await page.mouse.up()
  const both = savedAudio(((await dropped).postDataJSON() as { html: string }).html)
  expect(both.map(({ start, duration, track }) => ({ start, duration, track }))).toEqual([
    { start: 1, duration: 30, track: 0 },
    { start: 31, duration: 30, track: 0 },
  ])
  expect(both[1]?.label).toMatch(/^上传的音乐 · /)
  await expect(editor.getByRole('group', { name: '第 3 行' })).toHaveCount(0)
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

  const undone = draftSavedWith(page, (html) => savedAudio(html).length === 1)
  await editor
    .getByRole('toolbar', { name: '剪辑工具' })
    .getByRole('button', { name: '撤销' })
    .click()
  expect(savedAudio(((await undone).postDataJSON() as { html: string }).html)).toEqual([
    { label: '轻快原声吉他，适合秋季穿搭', start: 1, duration: 30, track: 0 },
  ])
  await expect(uploaded).not.toContainText('已使用')
})

/** 存下来的成片里第一个 `tag` 片段上的属性 `name`；不写值的属性是空串，没有这个属性时是 undefined。 */
const savedAttribute = (html: string, tag: 'video' | 'audio', name: string) => {
  const element = new RegExp(`<${tag} [^>]*>`).exec(html)?.[0] ?? ''
  const found = new RegExp(` ${name}(?:="([^"]*)")?(?=[ >])`).exec(element)
  return found === null ? undefined : (found[1] ?? '')
}

test('属性「媒体」：音频片段拉满增益、打开循环写进文件；视频片段调成 2 倍速，片段长不变、能拉到的最长减半', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await openFinalCut(panel)
  const inspector = editor.getByRole('tabpanel', { name: '属性' })
  const first = draftSaved(page, 1)
  const materials = editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
  await materials.getByRole('button', { name: /^生成 A 镜头 1，/ }).click()
  await page.keyboard.press('Enter')
  await first

  // 音频加到播放头（0 秒），在画面行下面新开一行
  const side = editor.getByRole('complementary', { name: '贴片、场景、音频和属性' })
  await side.getByRole('tab', { name: '音频' }).click()
  const added = draftSavedWith(page, (html) => savedAudio(html).length === 1)
  await side
    .getByRole('list', { name: '音频' })
    .getByRole('button', { name: '轻快原声吉他，适合秋季穿搭', exact: true })
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: '加到播放头' }).click()
  await added

  await editor
    .getByRole('group', { name: '第 2 行' })
    .getByRole('button', { name: /^选中：轻快原声吉他/ })
    .click()
  await inspector.getByRole('button', { name: /^媒体/ }).click()
  await expect(inspector.getByText('轻快原声吉他，适合秋季穿搭', { exact: true })).toHaveCount(2)
  const louder = draftSavedWith(
    page,
    (html) => savedAttribute(html, 'audio', 'data-volume') === '3.981072',
  )
  await inspector.getByRole('slider', { name: '增益' }).press('End')
  await louder
  await expect(inspector.getByRole('slider', { name: '增益' })).toHaveAttribute(
    'aria-valuetext',
    '+12.0 dB',
  )
  const looped = draftSavedWith(page, (html) => savedAttribute(html, 'audio', 'loop') === 'true')
  await inspector.getByRole('switch', { name: '循环' }).click()
  await looped

  // 视频片段（选中后展开的是「时间」）：先把时长拉到素材能放的最长
  await editor
    .getByRole('group', { name: '第 1 行' })
    .getByRole('button', { name: /^选中：A · / })
    .click()
  const length = inspector.getByRole('textbox', { name: '时长' })
  const setLength = async (seconds: string) => {
    await length.fill(seconds)
    await length.press('Enter')
  }
  await setLength('999')
  const longest = Number(await length.inputValue())
  expect(longest).toBeGreaterThan(1)

  await inspector.getByRole('button', { name: /^媒体/ }).click()
  const faster = draftSavedWith(
    page,
    (html) => savedAttribute(html, 'video', 'data-playback-rate') === '2',
  )
  await inspector.getByRole('button', { name: /^速度 1x/ }).click()
  await inspector.getByRole('textbox', { name: '速度' }).fill('2')
  await inspector.getByRole('textbox', { name: '速度' }).press('Enter')
  const html = ((await faster).postDataJSON() as { html: string }).html
  expect(Number(savedAttribute(html, 'video', 'data-duration'))).toBeCloseTo(longest, 2)

  // 收短再拉长：2 倍速时素材剩下的那段只够放原来的一半
  await inspector.getByRole('button', { name: /^时间/ }).click()
  await setLength('1')
  await expect(length).toHaveValue('1.00')
  await setLength('999')
  await expect.poll(async () => Number(await length.inputValue())).toBeCloseTo(longest / 2, 1)
})

test('在贴片卡片上按 ] 选中片段：侧栏切到「属性」，焦点交还编辑器，Delete 照常删掉；选中没了回到贴片页签', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await openFinalCut(panel)
  const first = draftSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^生成 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  await first

  const side = editor.getByRole('complementary', { name: '贴片、场景、音频和属性' })
  await side
    .getByRole('list', { name: '贴片' })
    .getByRole('group')
    .first()
    .getByRole('button', { name: '加到播放头' })
    .focus()
  await page.keyboard.press(']')
  await expect(side.getByRole('tab', { name: '属性' })).toHaveAttribute('aria-selected', 'true')
  await expect(editor.getByRole('tabpanel', { name: '属性' })).toBeVisible()
  await expect(editor).toBeFocused()

  const removed = draftSaved(page, 0)
  await page.keyboard.press('Delete')
  await removed
  await expect(side.getByRole('tab', { name: '贴片' })).toHaveAttribute('aria-selected', 'true')
  await expect(side.getByRole('list', { name: '贴片' })).toBeVisible()
})

test('编辑区变窄时只裁不换行：工具条和侧栏页签都排一行，放不下的被卡片裁掉，页面没有横向滚动条', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await openFinalCut(panel)
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
  const zoomIn = await boxOf(toolbar.getByRole('button', { name: '放大时间线' }))
  expect(zoomIn.y).toBe(undo.y)
  expect((await boxOf(toolbar)).height).toBeLessThanOrEqual(32)
  // 「导出」排在工具条最后，超出编辑区右边的部分被时间线卡片裁掉
  const exporting = await boxOf(toolbar.getByRole('button', { name: '导出', exact: true }))
  expect(exporting.x + exporting.width).toBeGreaterThan(workspace.x + workspace.width)

  const side = editor.getByRole('complementary', { name: '贴片、场景、音频和属性' })
  const firstTab = await boxOf(side.getByRole('tab', { name: '贴片' }))
  const propsTab = await boxOf(side.getByRole('tab', { name: '属性' }))
  expect(propsTab.y).toBe(firstTab.y)

  // 裁掉的部分滚不出来：横向滚动、把焦点挪到被裁掉的「导出」上，工具条都不挪
  await page.mouse.move(undo.x + 100, undo.y + undo.height / 2)
  await page.mouse.wheel(300, 0)
  await toolbar
    .getByRole('button', { name: '导出', exact: true })
    .evaluate((button: HTMLElement) => button.focus())
  await expect(toolbar.getByRole('button', { name: '导出', exact: true })).toBeFocused()
  expect((await boxOf(toolbar.getByRole('button', { name: '撤销' }))).x).toBe(undo.x)
  expect((await boxOf(editor)).x).toBe(workspace.x)
})

// 下面几条在默认布局下跑：侧边栏展开，工作台约 776 宽，和对话并排

/** 加一个片段并选中它，返回选中它的按钮。 */
const selectedClip = async (page: Page, editor: Locator) => {
  const saved = draftSaved(page, 1)
  await editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^生成 A 镜头 1，/ })
    .click()
  await page.keyboard.press('Enter')
  await saved
  const clip = editor
    .getByRole('group', { name: '第 1 行' })
    .getByRole('button', { name: /^选中：/ })
  await clip.click()
  await expect(clip).toHaveAttribute('aria-pressed', 'true')
  return clip
}

/** 接下来 `ms` 毫秒里成片草稿有没有存过。 */
const savesWithin = async (page: Page, ms: number) => {
  let saves = 0
  const count = (request: { method: () => string; url: () => string }) => {
    if (request.method() === 'PUT' && request.url().includes('/whole-film/draft')) saves += 1
  }
  page.on('request', count)
  await page.waitForTimeout(ms)
  page.off('request', count)
  return saves
}

test('地址带着 ?artifact=final-cut 时直接打开编辑器；正在对话框里打字时不抢焦点', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
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
  const editor = panel.getByRole('group', { name: '成片编辑器', exact: true })
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
  const editor = await openFinalCut(panel)
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

  // 点在预览的空白处：焦点落在编辑器的根节点上，快捷键照常
  await editor.getByRole('region', { name: '预览' }).click()
  await expect(editor).toBeFocused()
  await page.keyboard.press(' ')
  await expect(transport.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
  await page.keyboard.press(' ')
  await expect(transport.getByRole('button', { name: '播放', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(clip).toHaveAttribute('aria-pressed', 'false')
  await clip.click()
  const removed = draftSaved(page, 0)
  await page.keyboard.press('Delete')
  await removed
})

test('编辑器里选中着片段时，侧边栏改名框里的 Esc 照常放弃改名，片段仍选中', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '夜景延时素材生成')
  const editor = await openFinalCut(panel)
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
  const editor = await openFinalCut(panel)
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
  const editor = await openFinalCut(panel)
  const shots = editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
  for (const shot of [1, 2, 3]) {
    const saved = draftSaved(page, shot)
    await shots.getByRole('button', { name: new RegExp(`^生成 A 镜头 ${shot}，`) }).click()
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
  const editor = await openFinalCut(panel)
  const materials = editor
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
  // 加进去以后不等停下来保存就切走：切走时存，切回来等它存完再读
  const first = draftSaved(page, 1)
  await materials.getByRole('button', { name: /^生成 A 镜头 1，/ }).click()
  await page.keyboard.press('Enter')
  const row = editor.getByRole('group', { name: '第 1 行' })
  await expect(row.getByRole('button', { name: /^选中：/ })).toHaveCount(1)
  await panel.getByRole('tab', { name: '分镜' }).click()
  await first
  const back = await openFinalCut(panel)
  await expect(
    back.getByRole('group', { name: '第 1 行' }).getByRole('button', { name: /^选中：/ }),
  ).toHaveCount(1)

  const second = draftSaved(page, 2)
  await back
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
    .getByRole('button', { name: /^生成 A 镜头 3，/ })
    .click()
  await page.keyboard.press('Enter')
  await second
  await expect(page.getByText(/已在别处修改/)).toHaveCount(0)
})
