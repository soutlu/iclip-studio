import { expect, test, type Locator, type Page } from '@playwright/test'
import type { WholeFilmDocument } from '../src/shared/api/generated/types.gen'
import { openConversation } from './helpers'

// 整片编辑器的成片区：拖放、排序、特效轨、刻度、工具栏与声音行。草稿直接存进 mock 再打开编辑器。

const WIDTH = 1440
const HEIGHT = 900

const CONVERSATION = '0d3e5a10-7c4b-4e2f-9a61-000000000001'
/** 演示对话第 2 组那条 6 秒的竖版成片，每秒一个镜头 */
const SOURCE = '5b2f3071-0b2f-4d30-8d9c-2e3f4a5b6c7d'

type Clip = WholeFilmDocument['layer0'][number]
type Overlay = WholeFilmDocument['overlays'][number]

const video = (id: string, from: number, to: number): Clip => ({
  id,
  type: 'video',
  start: 0,
  duration: to - from,
  playbackStart: from,
  sourceJobId: SOURCE,
  volume: 1,
})

const card = (id: string, component: string, duration: number): Clip => ({
  id,
  type: 'component',
  start: 0,
  duration,
  playbackStart: 0,
  component,
  variables: {},
})

const overlay = (
  id: string,
  component: string,
  start: number,
  duration: number,
  track: number,
  zIndex = track + 1,
): Overlay => ({ id, component, start, duration, playbackStart: 0, track, zIndex, variables: {} })

/** 组件段 2 秒 + 五段视频，共 8 秒 */
const BASE = [
  card('c1', 'hw-title', 2_000),
  video('v1', 0, 1_500),
  video('v2', 1_500, 3_200),
  video('v3', 3_200, 4_000),
  video('v4', 4_000, 5_100),
  video('v5', 5_100, 6_000),
]

/** 登录后把草稿直接存进 mock（片段按顺序首尾相接），再打开整片编辑器 */
const openWith = async (
  page: Page,
  {
    layer0,
    overlays = [],
    music = false,
  }: { layer0: Clip[]; overlays?: Overlay[]; music?: boolean },
) => {
  await page.setViewportSize({ width: WIDTH, height: HEIGHT })
  const panel = await openConversation(page, '夜景延时素材生成')
  let at = 0
  const placed = layer0.map((clip) => {
    const next = { ...clip, start: at }
    at += clip.duration
    return next
  })
  await page.evaluate(
    async ({ conversation, layer0, overlays, music }) => {
      const base = `/api/conversations/${conversation}/whole-film/draft`
      let song = null
      if (music) {
        const list = (await (
          await fetch(`/api/generations?conversationId=${conversation}&kind=audio&limit=50`)
        ).json()) as { items: { id: string; operation: string | null }[] }
        // 这段对话生成的那首（另一首是上传的）
        const found = list.items.find((job) => job.operation !== 'upload')
        if (found === undefined) throw new Error('mock 里没有那首音乐')
        song = { jobId: found.id, offset: 0, volume: 1 }
      }
      const current = (await (await fetch(base)).json()) as { revision: number }
      const saved = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: current.revision,
          document: {
            canvas: { width: 180, height: 320 },
            layer0,
            captions: { component: 'default-caption', edits: [] },
            music: song,
            overlays,
          },
        }),
      })
      if (!saved.ok) throw new Error(`草稿没存上：${saved.status}`)
    },
    { conversation: CONVERSATION, layer0: placed, overlays, music },
  )
  await panel.getByRole('button', { name: '整片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /^编辑视频\s*整片/ })
  const film = dialog.getByRole('group', { name: '成片画面轨' })
  await expect(
    film.getByRole('group', { name: new RegExp(`^第 ${layer0.length} 段`) }),
  ).toBeVisible()
  // 预览播放器换上来时会报一次它的时刻：等它换上来，之后点段、走播放头才不会被它拨回去
  await expect(dialog.locator('hyperframes-player:not(.is-pending)')).toHaveCount(1)
  await expect(dialog.locator('hyperframes-player.is-pending')).toHaveCount(0)
  // 时间区量好宽度、按它排好刻度之后再量位置
  let last = ''
  await expect
    .poll(async () => {
      const now = JSON.stringify(await clipLefts(film))
      const settled = now === last
      last = now
      return settled
    })
    .toBe(true)
  return { dialog, film }
}

const readDraft = (page: Page) =>
  page.evaluate(async (conversation) => {
    const response = await fetch(`/api/conversations/${conversation}/whole-film/draft`)
    return ((await response.json()) as { document: WholeFilmDocument | null }).document
  }, CONVERSATION)

const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox()
  if (box === null) throw new Error('元素还没布局')
  return { ...box, cx: box.x + box.width / 2, cy: box.y + box.height / 2 }
}

/** 时间区每秒多少像素：刻度尺上的播放位置滑块铺满整个时间区 */
const pixelsPerSecond = async (dialog: Locator) => {
  const ruler = dialog.getByRole('slider', { name: '时间线播放位置' })
  const box = await boxOf(ruler)
  return { pps: box.width / Number(await ruler.getAttribute('max')), left: box.x }
}

/** 播放器按 30 帧报时刻，读数与播放头最多差一帧 */
const FRAME_MS = 34

/** 播放时间读数「00:02.60 / 00:07.50」里当前时刻的毫秒数 */
const clockMs = (text: string | null) => {
  const match = /^(\d+):(\d+)\.(\d+)/.exec(text ?? '')
  if (match === null) throw new Error(`读不出播放时间：${text}`)
  return Number(match[1]) * 60_000 + Number(match[2]) * 1_000 + Number(match[3]) * 10
}

/** 播放器暂停后还会补报时刻：等读数两次一样再读 */
const settledClockMs = async (clock: Locator) => {
  let last = ''
  await expect
    .poll(
      async () => {
        const now = (await clock.textContent()) ?? ''
        const settled = now === last
        last = now
        return settled
      },
      { intervals: [250] },
    )
    .toBe(true)
  return clockMs(last)
}

/** 成片轨上各段左边缘的位置：拖动中确认轨道上的段没动 */
const clipLefts = (film: Locator) =>
  film
    .locator('.wf-clip')
    .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().left))

/** 在素材区「镜头组 2」里点一个镜头选中它，按住它的范围拿起来 */
const liftShot = async (page: Page, dialog: Locator, shotNumber: number) => {
  const materials = dialog
    .getByRole('region', { name: '视频素材区' })
    .getByRole('group', { name: '镜头组 2' })
  await materials.getByRole('button', { name: new RegExp(`^生成 A 镜头 ${shotNumber}，`) }).click()
  const range = await boxOf(materials.getByRole('group', { name: /^选中的范围/ }))
  await page.mouse.move(range.cx, range.cy)
  await page.mouse.down()
  await page.mouse.move(range.cx + 10, range.cy - 30, { steps: 4 })
}

test.describe('整片编辑器 · 成片区', () => {
  test('从素材拖镜头到成片轨：缩影跟手、只画插入标记、轨道不动，松手才插入；拖到别的轨退回', async ({
    page,
  }) => {
    const { dialog, film } = await openWith(page, { layer0: BASE, music: true })
    const before = await clipLefts(film)
    const filmBox = await boxOf(film)
    const third = await boxOf(film.getByRole('group', { name: /^第 3 段/ }))

    await liftShot(page, dialog, 4)
    // 指针在第 3 段前半：插在它前面的切点
    const x = third.x + 6
    const y = filmBox.y + 12
    await page.mouse.move(x, y, { steps: 8 })
    const ghost = page.locator('.wf-ghost')
    await expect(ghost).toBeVisible()
    const ghostBox = await boxOf(ghost)
    expect(Math.abs(ghostBox.x - (x + 12))).toBeLessThan(2)
    expect(Math.abs(ghostBox.y - (y + 12))).toBeLessThan(2)
    await expect(dialog.locator('.wf-drop-marker')).toBeVisible()
    await expect(dialog.locator('.wf-drop-marker')).not.toHaveClass(/is-blocked/)
    await expect(dialog.locator('.wf-drop-bubble')).toHaveText('插入到 3.5 秒 · 第 3 段')
    expect(await clipLefts(film)).toEqual(before)

    // 字幕轨不收镜头：不提示
    const captions = await boxOf(dialog.getByRole('group', { name: '字幕轨' }))
    await page.mouse.move(x, captions.cy, { steps: 4 })
    await expect(dialog.locator('.wf-drop-marker')).toHaveCount(0)
    await page.mouse.move(x, y, { steps: 4 })
    await page.mouse.up()
    await expect(film.getByRole('group')).toHaveCount(7)
    await expect(film.getByRole('group', { name: /^第 3 段 · A · 镜头 4，1\.0 秒/ })).toBeVisible()
    await expect(ghost).toHaveCount(0)

    // 在字幕轨上松手：不放下，缩影退回
    await liftShot(page, dialog, 5)
    await page.mouse.move(x, captions.cy, { steps: 8 })
    await page.mouse.up()
    await expect(ghost).toHaveClass(/is-returning/)
    await expect(ghost).toHaveCount(0)
    await expect(film.getByRole('group')).toHaveCount(7)
  })

  test('放大时间线后，带着镜头到时间区边缘时自动横向滚动', async ({ page }) => {
    const { dialog } = await openWith(page, { layer0: BASE })
    for (let i = 0; i < 4; i += 1) await dialog.getByRole('button', { name: '放大时间线' }).click()
    const viewport = dialog.locator('.wf-track-scroll')
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollWidth > element.clientWidth))
      .toBe(true)
    const box = await boxOf(viewport)
    const film = await boxOf(dialog.getByRole('group', { name: '成片画面轨' }))
    await liftShot(page, dialog, 2)
    await page.mouse.move(box.x + box.width - 10, film.cy, { steps: 8 })
    await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(40)
    await page.mouse.up()
  })

  test('整片最长 120 秒：放不下时标记变虚线并写原因，松手不加入；拉长与挪动到上限停住', async ({
    page,
  }) => {
    const nineteen = Array.from({ length: 19 }, (_, k) => video(`v${k + 1}`, 0, 6_000))
    const { dialog, film } = await openWith(page, {
      layer0: [...nineteen, card('c1', 'hw-title', 5_500)],
      overlays: [overlay('o1', 'hw-arrow', 116_000, 4_000, 0)],
    })
    const filmBox = await boxOf(film)
    await liftShot(page, dialog, 2)
    await page.mouse.move(filmBox.x + filmBox.width / 2, filmBox.y + 12, { steps: 8 })
    await expect(dialog.locator('.wf-drop-marker')).toHaveClass(/is-blocked/)
    await expect(dialog.locator('.wf-drop-bubble')).toHaveText(
      '加入后整片超过 120 秒，无法加入；请先缩短或删除其他片段',
    )
    await expect(page.locator('.wf-ghost')).toHaveClass(/is-blocked/)
    await page.mouse.up()
    await expect(film.getByRole('group')).toHaveCount(20)
    await expect(
      page.getByText('加入后整片超过 120 秒，无法加入；请先缩短或删除其他片段'),
    ).toBeVisible()

    // 拉长最后一段：到 120 秒停住，写明原因
    await film.getByRole('button', { name: /^选中：第 20 段/ }).click()
    const handle = await boxOf(film.getByRole('slider', { name: '裁剪该段结尾' }))
    await page.mouse.move(handle.cx, handle.cy)
    await page.mouse.down()
    await page.mouse.move(handle.cx + 200, handle.cy, { steps: 6 })
    await expect(
      dialog.getByRole('status').filter({ hasText: '整片最长 120 秒，不能再拉长' }),
    ).toBeVisible()
    await page.mouse.up()
    await expect(dialog.locator('.wf-clock')).toContainText('/ 02:00.00')

    // 特效块挪不过 120 秒
    const overlays = dialog.getByRole('group', { name: '特效轨' })
    await overlays.getByRole('button', { name: /^选中：特效 · 手绘箭头/ }).click()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByText('整片最长 120 秒，不能再拉长')).toBeVisible()
    await expect(overlays.getByRole('group', { name: /116\.0–120\.0 秒$/ })).toBeVisible()
  })

  test('成片轨内拖动排序：拿起的段变淡、只画插入标记，松手才挪；拖出成片轨不动', async ({
    page,
  }) => {
    const { dialog, film } = await openWith(page, { layer0: BASE })
    const before = await clipLefts(film)
    const second = await boxOf(film.getByRole('button', { name: /^选中：第 2 段/ }))
    const fifth = await boxOf(film.getByRole('group', { name: /^第 5 段/ }))
    await page.mouse.move(second.cx, second.cy)
    await page.mouse.down()
    await page.mouse.move(second.cx + 20, second.cy, { steps: 3 })
    await page.mouse.move(fifth.x + fifth.width - 4, second.cy, { steps: 8 })
    await expect(film.getByRole('group', { name: /^第 2 段/ })).toHaveClass(/is-lifted/)
    await expect(dialog.locator('.wf-drop-bubble')).toHaveText('挪到第 5 段')
    expect(await clipLefts(film)).toEqual(before)
    await page.mouse.up()
    await expect
      .poll(async () => (await readDraft(page))?.layer0.map((clip) => clip.id))
      .toEqual(['c1', 'v2', 'v3', 'v4', 'v1', 'v5'])

    // 拖出成片轨（到素材区）松手：不挪，缩影退回
    const third = await boxOf(film.getByRole('button', { name: /^选中：第 3 段/ }))
    const materials = await boxOf(dialog.getByRole('region', { name: '视频素材区' }))
    await page.mouse.move(third.cx, third.cy)
    await page.mouse.down()
    await page.mouse.move(third.cx, materials.cy, { steps: 8 })
    await expect(dialog.locator('.wf-drop-marker')).toHaveCount(0)
    await page.mouse.up()
    await expect(page.locator('.wf-ghost')).toHaveCount(0)
    expect((await readDraft(page))?.layer0.map((clip) => clip.id)).toEqual([
      'c1',
      'v2',
      'v3',
      'v4',
      'v1',
      'v5',
    ])
  })

  test('点段移到段首、Delete 删除、⌘Z 撤销、⌥→ 挪一位、修剪与 ←/→ 微调、方向键走播放头', async ({
    page,
  }) => {
    const { dialog, film } = await openWith(page, {
      layer0: [BASE[1], BASE[2], card('c2', 'hw-title', 1_500), BASE[3], BASE[4], BASE[5]],
    })
    const clock = dialog.locator('.wf-clock')
    // 组件可以放在成片轨任意位置：中间这一段是组件段
    await film.getByRole('button', { name: /^选中：第 3 段 · 组件 · 手写标题/ }).click()
    await expect(clock).toContainText('00:03.20 /')
    await expect(dialog.getByText('当前片段 · 第 3 段 · 没有原声')).toBeVisible()

    await film.getByRole('button', { name: /^选中：第 2 段/ }).click()
    await expect(clock).toContainText('00:01.50 /')
    // 点段会把这一段播一遍：先暂停，再看方向键挪播放头（→ 0.1 秒、⇧→ 1 秒）。
    // 读数是播放器按帧报的时刻，与播放头可差一帧（30 帧约 34 毫秒）
    await dialog.getByRole('button', { name: '暂停' }).click()
    await expect(dialog.getByRole('button', { name: '播放' })).toBeVisible()
    const pausedAt = await settledClockMs(clock)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    await expect
      .poll(async () => Math.abs(clockMs(await clock.textContent()) - pausedAt - 1_100))
      .toBeLessThanOrEqual(FRAME_MS)

    // 修剪：拖结尾手柄，再用 ← 微调 0.1 秒
    const segment = film.getByRole('group', { name: /^第 2 段/ })
    const end = film.getByRole('slider', { name: '裁剪该段结尾' })
    const handle = await boxOf(end)
    await page.mouse.move(handle.cx, handle.cy)
    await page.mouse.down()
    await page.mouse.move(handle.cx - 20, handle.cy, { steps: 4 })
    await page.mouse.up()
    const trimmed = await segment.getAttribute('aria-label')
    expect(trimmed).not.toMatch(/，1\.7 秒$/)
    await end.focus()
    await page.keyboard.press('ArrowLeft')
    await expect(segment).not.toHaveAttribute('aria-label', trimmed ?? '')

    // ⌥→ 把选中的段往后挪一位
    await film.getByRole('button', { name: /^选中：第 1 段/ }).click()
    await page.keyboard.press('Alt+ArrowRight')
    await expect
      .poll(async () => (await readDraft(page))?.layer0.slice(0, 2).map((clip) => clip.id))
      .toEqual(['v2', 'v1'])

    // Delete 删除选中的段，⌘Z 撤销
    await film.getByRole('button', { name: /^选中：第 2 段/ }).click()
    await page.keyboard.press('Delete')
    await expect(film.getByRole('group')).toHaveCount(5)
    await page.keyboard.press('ControlOrMeta+z')
    await expect(film.getByRole('group')).toHaveCount(6)
  })

  test('特效轨：缩略图、拖中部改时间并吸附、←/→ 微调；上下拖换行，所有行之外只画横线，松手才开新行', async ({
    page,
  }) => {
    const { dialog } = await openWith(page, {
      layer0: BASE,
      overlays: [
        overlay('o1', 'hw-arrow', 1_000, 3_000, 0),
        overlay('o2', 'editorial-flash-overlay', 3_500, 4_000, 1),
      ],
    })
    const lane = dialog.getByRole('group', { name: '特效轨' })
    const arrow = lane.getByRole('button', { name: /^选中：特效 · 手绘箭头/ })
    await expect(arrow.locator('img')).toBeVisible()

    // 按住中部往右拖 1 秒多一点：开头吸到第 1 段结尾（2 秒处的切点），块上方写起止秒数
    const { pps } = await pixelsPerSecond(dialog)
    const block = await boxOf(arrow)
    await page.mouse.move(block.cx, block.cy)
    await page.mouse.down()
    await page.mouse.move(block.cx + pps * 1.03, block.cy, { steps: 6 })
    await expect(lane.locator('.wf-time-bubble')).toHaveText('2.0–5.0 秒')
    await expect(dialog.locator('.wf-snap-guide')).toBeVisible()
    await page.mouse.up()
    await expect(
      lane.getByRole('group', { name: '特效 · 手绘箭头，第 1 行，2.0–5.0 秒' }),
    ).toBeVisible()

    // 选中后 ←/→ 挪 0.1 秒，⇧ 1 秒
    await arrow.click()
    await page.keyboard.press('ArrowRight')
    await expect(
      lane.getByRole('group', { name: '特效 · 手绘箭头，第 1 行，2.1–5.1 秒' }),
    ).toBeVisible()
    await page.keyboard.press('Shift+ArrowLeft')
    await expect(
      lane.getByRole('group', { name: '特效 · 手绘箭头，第 1 行，1.1–4.1 秒' }),
    ).toBeVisible()

    // 拖到所有行下方：只画插入横线，行数不变；松手才多出一行（新开的行至少 8 像素高的感应区）
    const laneBox = await boxOf(lane)
    const rowsBottom = laneBox.y + 2 + 2 * 24
    const flash = await boxOf(lane.getByRole('button', { name: /^选中：特效 · 闪光叠加/ }))
    const arrowNow = await boxOf(arrow)
    await page.mouse.move(arrowNow.cx, arrowNow.cy)
    await page.mouse.down()
    await page.mouse.move(arrowNow.cx, flash.cy, { steps: 4 })
    await page.mouse.move(arrowNow.cx, rowsBottom + 8, { steps: 4 })
    await expect(lane.locator('.wf-overlay-insert')).toBeVisible()
    expect((await boxOf(lane)).height).toBe(laneBox.height)
    await page.mouse.up()
    await expect(lane.getByRole('group', { name: /^特效 · 闪光叠加，第 1 行/ })).toBeVisible()
    await expect(lane.getByRole('group', { name: /^特效 · 手绘箭头，第 2 行/ })).toBeVisible()

    // 所有行上方 7 像素处同样只画横线；松手开在最上面
    const top = (await boxOf(lane)).y + 2 - 7
    const arrowLow = await boxOf(arrow)
    await page.mouse.move(arrowLow.cx, arrowLow.cy)
    await page.mouse.down()
    await page.mouse.move(arrowLow.cx, top, { steps: 6 })
    await expect(lane.locator('.wf-overlay-insert')).toBeVisible()
    await page.mouse.up()
    await expect(lane.getByRole('group', { name: /^特效 · 手绘箭头，第 1 行/ })).toBeVisible()

    // 拖组件卡到特效轨（松手放下）
    await dialog.getByRole('tab', { name: '通用' }).click()
    await dialog
      .getByRole('radiogroup', { name: '分类', exact: true })
      .getByRole('radio', { name: /^社交/ })
      .click()
    const cardLocator = dialog.getByRole('button', { name: /^手绘圈注，/ })
    await cardLocator.scrollIntoViewIfNeeded()
    const cardButton = await boxOf(cardLocator)
    const film = await boxOf(dialog.getByRole('group', { name: '成片画面轨' }))
    await page.mouse.move(cardButton.cx, cardButton.cy)
    await page.mouse.down()
    await page.mouse.move(cardButton.cx + 20, cardButton.cy + 20, { steps: 4 })
    await page.mouse.move(film.x + film.width * 0.6, (await boxOf(lane)).y + 2 + 2 * 24 + 4, {
      steps: 8,
    })
    await page.mouse.up()
    await expect(lane.getByRole('group', { name: /^特效 · 手绘圈注，第 3 行/ })).toBeVisible()
    await expect(lane.getByRole('group', { name: /^特效 · / })).toHaveCount(3)
  })

  test('特效轨多行都在屏幕内、都能点选', async ({ page }) => {
    const { dialog } = await openWith(page, {
      layer0: BASE,
      overlays: [
        overlay('o1', 'hw-arrow', 500, 3_000, 0),
        overlay('o2', 'editorial-flash-overlay', 2_000, 4_000, 1),
        overlay('o3', 'grid-pixelate-wipe', 3_500, 1_200, 2),
        overlay('o4', 'hw-callout-circle', 1_000, 4_000, 3),
      ],
    })
    const lane = dialog.getByRole('group', { name: '特效轨' })
    for (const [name, row] of [
      ['手绘箭头', 1],
      ['闪光叠加', 2],
      ['方格消散', 3],
      ['手绘圈注', 4],
    ] as const) {
      const button = lane.getByRole('button', {
        name: new RegExp(`^选中：特效 · ${name}，第 ${row} 行`),
      })
      await expect(button).toBeInViewport()
      await button.click()
      await expect(button).toHaveAttribute('aria-pressed', 'true')
    }
  })

  test('标尺悬停同时显示时间和贯穿轨道的预览线，缩放滚动后仍对齐，离开或滚动时清理', async ({
    page,
  }) => {
    const { dialog, film } = await openWith(page, { layer0: BASE, music: true })
    const music = dialog.getByRole('group', { name: '音乐轨' })
    await expect(music.getByRole('button', { name: /^选中：音乐/ })).toBeVisible()
    await film.getByRole('button', { name: /^选中：第 3 段/ }).click()

    const ruler = dialog.getByRole('slider', { name: '时间线播放位置' })
    const guide = dialog.getByTestId('timeline-hover-guide')
    const preview = page.locator('.timeline-time-preview')
    // 点段会自动播放到段尾；停下之后再验证悬停不会改变实际播放时间。
    await expect.poll(async () => Number(await ruler.inputValue())).toBeGreaterThanOrEqual(5.2)
    await expect(dialog.getByRole('button', { name: '播放', exact: true })).toBeVisible()
    await settledClockMs(dialog.locator('.wf-clock'))
    const before = await ruler.inputValue()
    const rulerBox = await boxOf(ruler)
    const initial = await pixelsPerSecond(dialog)
    const hoverX = initial.left + initial.pps * 4
    await page.mouse.move(hoverX, rulerBox.cy)
    await expect(preview).toContainText('预览')
    await expect(preview).toContainText('00:04.00')
    await expect(guide).toBeVisible()
    const guideBox = await boxOf(guide)
    const filmBox = await boxOf(film)
    const musicBox = await boxOf(music)
    expect(Math.abs(guideBox.cx - hoverX)).toBeLessThan(1)
    expect(guideBox.y).toBeLessThanOrEqual(filmBox.y)
    expect(guideBox.y + guideBox.height).toBeGreaterThanOrEqual(musicBox.y + musicBox.height)
    await expect(ruler).toHaveValue(before)

    await page.mouse.move(filmBox.cx, filmBox.cy)
    await expect(guide).toHaveCount(0)
    await expect(preview).toHaveCount(0)

    for (let i = 0; i < 2; i += 1) await dialog.getByRole('button', { name: '放大时间线' }).click()
    await expect
      .poll(async () => (await pixelsPerSecond(dialog)).pps)
      .toBeGreaterThan(initial.pps * 3)
    const viewport = dialog.locator('.wf-track-scroll')
    const viewportBox = await boxOf(viewport)
    const zoomed = await pixelsPerSecond(dialog)
    // 原生滚动结束后把同一个 4 秒位置放在可见时间区中间，再核对预览位置。
    await viewport.evaluate(
      (element, delta) =>
        new Promise<void>((resolve) => {
          element.addEventListener('scroll', () => requestAnimationFrame(() => resolve()), {
            once: true,
          })
          element.scrollLeft += delta
        }),
      zoomed.left + zoomed.pps * 4 - viewportBox.cx,
    )
    await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
    const scrolled = await pixelsPerSecond(dialog)
    const scrolledX = scrolled.left + scrolled.pps * 4
    await page.mouse.move(scrolledX, (await boxOf(ruler)).cy)
    await expect(preview).toContainText('00:04.00')
    await expect(guide).toBeVisible()
    expect(Math.abs((await boxOf(guide)).cx - scrolledX)).toBeLessThan(1)
    await expect(ruler).toHaveValue(before)

    await viewport.evaluate(
      (element) =>
        new Promise<void>((resolve) => {
          element.addEventListener('scroll', () => requestAnimationFrame(() => resolve()), {
            once: true,
          })
          element.scrollLeft += 40
        }),
    )
    await expect(guide).toHaveCount(0)
    await expect(preview).toHaveCount(0)
    await expect(ruler).toHaveValue(before)
  })

  test('刻度至少 20 秒；工具栏没有总长读数，提示写明快捷键，自动卡点在吸附旁边；轨名叫特效', async ({
    page,
  }) => {
    const { dialog, film } = await openWith(page, { layer0: [video('v1', 0, 1_000)], music: true })
    const ruler = dialog.getByRole('slider', { name: '时间线播放位置' })
    expect(Number(await ruler.getAttribute('max'))).toBeCloseTo(20, 0)
    const rulerBox = await boxOf(ruler)
    const clip = await boxOf(film.getByRole('group', { name: /^第 1 段/ }))
    expect(clip.width / rulerBox.width).toBeCloseTo(1 / 20, 2)

    await expect(dialog.getByText(/上限/)).toHaveCount(0)
    await expect(dialog.locator('.wf-track-heads')).toContainText('特效')
    await expect(dialog.locator('.wf-tracks')).not.toContainText('包装')

    const tools = await dialog
      .getByRole('toolbar', { name: '剪辑工具' })
      .getByRole('button')
      .evaluateAll((items) =>
        items.map((item) => item.textContent?.trim() || item.getAttribute('aria-label')),
      )
    expect(tools.indexOf('自动卡点')).toBe(tools.indexOf('吸附') + 1)

    // 吸附可以关掉再打开
    const snap = dialog.getByRole('button', { name: '吸附' })
    await snap.click()
    await expect(snap).toHaveAttribute('aria-pressed', 'false')
    await snap.click()
    await expect(snap).toHaveAttribute('aria-pressed', 'true')
    // 焦点在按钮上时空格是播放、暂停，不点这个按钮
    await snap.focus()
    await page.keyboard.press(' ')
    await expect(snap).toHaveAttribute('aria-pressed', 'true')

    // 拍点刻度在刻度尺下方，透明度随强度在 0.3–1 之间
    await expect(dialog.getByRole('button', { name: '自动卡点' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
      { timeout: 15_000 },
    )
    const opacities = await dialog
      .locator('.wf-beat')
      .evaluateAll((items) => items.map((item) => Number(getComputedStyle(item).opacity)))
    expect(opacities.length).toBeGreaterThan(10)
    for (const opacity of opacities) {
      expect(opacity).toBeGreaterThanOrEqual(0.3)
      expect(opacity).toBeLessThanOrEqual(1)
    }
    const beat = await boxOf(dialog.locator('.wf-beat').first())
    expect(beat.y).toBeGreaterThan(rulerBox.y + rulerBox.height / 2)

    await film.getByRole('button', { name: /^选中：第 1 段/ }).click()
    await dialog.getByRole('button', { name: '删除' }).hover()
    await expect(page.getByRole('tooltip').filter({ hasText: '删除选中的片段' })).toHaveText(
      '删除选中的片段⌫',
    )
    // 指针离开按钮后要再动一下，提示才知道指针不在去往它的路上
    await page.mouse.move(WIDTH / 2, 30, { steps: 5 })
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    await dialog.getByRole('button', { name: '播放' }).hover()
    await expect(page.getByRole('tooltip').filter({ hasText: '播放' })).toHaveText('播放空格')
  })

  test('音量推子按 dB：0 dB 在正中，←/→ 0.5 dB、⇧ 3 dB，双击回 0 dB，可以静音', async ({
    page,
  }) => {
    const { dialog, film } = await openWith(page, { layer0: BASE, music: true })
    await film.getByRole('button', { name: /^选中：第 2 段/ }).click()
    const source = dialog.getByRole('slider', { name: '原声音量' })
    await expect(source).toHaveAttribute('aria-valuetext', '0 dB')
    const box = await boxOf(source)
    const unity = await boxOf(dialog.locator('.wf-fader-unity').first())
    expect(Math.abs(unity.cx - box.cx)).toBeLessThan(1)
    await source.focus()
    await page.keyboard.press('ArrowRight')
    await expect(source).toHaveAttribute('aria-valuetext', '+0.5 dB')
    await page.keyboard.press('Shift+ArrowLeft')
    await expect(source).toHaveAttribute('aria-valuetext', '−2.5 dB')
    await expect
      .poll(async () => (await readDraft(page))?.layer0[1])
      .toMatchObject({ volume: Number((10 ** (-2.5 / 20)).toFixed(6)) })
    await source.dblclick()
    await expect(source).toHaveAttribute('aria-valuetext', '0 dB')
    for (let i = 0; i < 7; i += 1) await page.keyboard.press('ArrowRight')
    await expect(dialog.getByRole('group', { name: '声音' })).toContainText('+3.5 dB')
    await dialog.getByRole('button', { name: '静音配乐' }).click()
    await expect(dialog.getByRole('slider', { name: '配乐音量' })).toHaveAttribute(
      'aria-valuetext',
      '静音',
    )
    await dialog.getByRole('button', { name: '取消静音配乐' }).click()
  })
})
