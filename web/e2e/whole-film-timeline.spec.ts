import { expect, test, type ElementHandle, type Locator, type Page } from '@playwright/test'
import type { WholeFilmDocument } from '../src/shared/api/generated/types.gen'
import { openConversation } from './helpers'

// 成片编辑器的时间线：拖放、排序、特效轨、刻度、工具栏与声音行。草稿直接存进 mock 再打开编辑器。

const WIDTH = 1440
const HEIGHT = 900

const CONVERSATION = '0d3e5a10-7c4b-4e2f-9a61-000000000001'
/** 演示对话第 2 组那条 6 秒的竖版素材片，每秒一个镜头 */
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

/** 登录后把草稿直接存进 mock（片段按顺序首尾相接），再打开成片编辑器 */
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
  await panel.getByRole('button', { name: '成片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '夜景延时素材生成' })
  const film = dialog.getByRole('group', { name: '画面轨', exact: true })
  await expect(
    film.getByRole('group', { name: new RegExp(`^第 ${layer0.length} 段`) }),
  ).toBeVisible()
  // 预览播放器换上来时会报一次它的时刻：等它换上来（画好之后还要等几帧才换），之后点段、走播放头
  // 才不会被它拨回去
  await expect
    .poll(() =>
      dialog
        .getByRole('region', { name: '预览' })
        .locator('hyperframes-player')
        .evaluateAll(
          (players) =>
            players.length === 1 &&
            (players[0] as HTMLElement & { painted: boolean }).painted &&
            !players[0].classList.contains('is-pending'),
        ),
    )
    .toBe(true)
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

const boxOf = async (locator: Locator | ElementHandle<HTMLElement>) => {
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

/** 合成页按 30 帧走（与素材自己的帧率无关），读数落在帧上，与要去的时刻最多差一帧 */
const FRAME_MS = 34

/** 从时间线的语义控件找到真实的横向滚动宿主，避免依赖样式类或固定 DOM 层级。 */
const scrollViewport = async (ruler: Locator) => {
  const handle = await ruler.evaluateHandle((element) => {
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
      if (
        parent.scrollWidth > parent.clientWidth &&
        /auto|scroll/.test(getComputedStyle(parent).overflowX)
      )
        return parent
    }
    throw new Error('时间线尚不能横向滚动')
  })
  const viewport = handle.asElement()
  if (viewport === null) throw new Error('时间线滚动区域不存在')
  return viewport
}

/** 播放器暂停后还会补报时刻：等读数两次一样再读 */
const settledClockMs = async (clock: Locator) => {
  let last = ''
  await expect
    .poll(
      async () => {
        const now = await clock.inputValue()
        const settled = now === last
        last = now
        return settled
      },
      { intervals: [250] },
    )
    .toBe(true)
  return Number(last) * 1000
}

/** 点段播到段尾自己停下：读数两次一样，且停在段尾之前的最后一帧，不露出下一段 */
const expectStoppedAt = async (clock: Locator, endMs: number) => {
  let last = Number.NaN
  await expect
    .poll(
      async () => {
        const now = Number(await clock.inputValue()) * 1000
        const stopped = now === last && now >= endMs - FRAME_MS && now < endMs
        last = now
        return stopped
      },
      { intervals: [250], timeout: 10_000 },
    )
    .toBe(true)
}

/** 画面轨上各段左边缘的位置，用于核对预演让位与取消恢复。 */
const clipLefts = (film: Locator) =>
  film
    .getByRole('group', { name: /^第 \d+ 段/ })
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
  await page.mouse.move(range.cx, range.cy - 30, { steps: 4 })
}

test.describe('成片编辑器 · 时间线', () => {
  test('从素材竖直拖起镜头：按完整时长预演让位，松手才插入一次；拖到别的轨取消', async ({
    page,
  }) => {
    const { dialog, film } = await openWith(page, { layer0: BASE, music: true })
    const before = await clipLefts(film)
    const beforeDraft = await readDraft(page)
    const { pps } = await pixelsPerSecond(dialog)
    const filmBox = await boxOf(film)
    const third = await boxOf(film.getByRole('group', { name: /^第 3 段/ }))

    await liftShot(page, dialog, 4)
    // 指针在第 3 段前半：插在它前面的切点
    const x = third.x + 6
    const y = filmBox.y + 12
    await page.mouse.move(x, y, { steps: 8 })
    const preview = film.getByTestId('timeline-insertion-preview')
    await expect(preview).toBeVisible()
    await expect.poll(async () => Math.abs((await boxOf(preview)).width - pps)).toBeLessThan(3)
    await expect.poll(async () => Math.abs((await boxOf(preview)).x - third.x)).toBeLessThan(1)
    await expect(
      page.getByRole('status').filter({ hasText: /插入.*3\.5\s*秒.*1(?:\.0)?\s*秒/ }),
    ).toBeVisible()
    await expect.poll(async () => (await clipLefts(film))[2] - before[2]).toBeGreaterThan(pps * 0.9)
    await expect(film.getByRole('group', { name: /^第 \d+ 段/ })).toHaveCount(6)
    expect(await readDraft(page)).toEqual(beforeDraft)

    // 字幕轨不收镜头：撤回预演，原排列和草稿都不改变。
    const captions = await boxOf(dialog.getByRole('group', { name: '字幕轨' }))
    await page.mouse.move(x, captions.cy, { steps: 4 })
    await expect(preview).toBeHidden()
    await expect
      .poll(async () =>
        Math.max(...(await clipLefts(film)).map((left, at) => Math.abs(left - before[at]))),
      )
      .toBeLessThan(1)
    expect(await readDraft(page)).toEqual(beforeDraft)
    await page.mouse.move(x, y, { steps: 4 })
    await expect(preview).toBeVisible()
    await page.mouse.up()
    await expect(film.getByRole('group', { name: /^第 \d+ 段/ })).toHaveCount(7)
    await expect(film.getByRole('group', { name: /^第 3 段 · A · 镜头 4，1\.0 秒/ })).toBeVisible()
    await expect(preview).toBeHidden()
    await expect.poll(async () => (await readDraft(page))?.layer0.length).toBe(7)
    const inserted = await readDraft(page)
    expect(inserted?.layer0[2]).toMatchObject({ duration: 1_000, playbackStart: 3_000 })

    // 在字幕轨上松手：不再插入，已完成的编辑保留。
    await liftShot(page, dialog, 5)
    await page.mouse.move(x, captions.cy, { steps: 8 })
    await page.mouse.up()
    await expect(preview).toBeHidden()
    await expect(film.getByRole('group', { name: /^第 \d+ 段/ })).toHaveCount(7)
    expect(await readDraft(page)).toEqual(inserted)
  })

  test('放大时间线后，带着镜头到时间区边缘时自动横向滚动', async ({ page }) => {
    const { dialog } = await openWith(page, { layer0: BASE })
    for (let i = 0; i < 4; i += 1) await dialog.getByRole('button', { name: '放大时间线' }).click()
    const viewport = await scrollViewport(dialog.getByRole('slider', { name: '时间线播放位置' }))
    await expect
      .poll(() => viewport.evaluate((element) => element.scrollWidth > element.clientWidth))
      .toBe(true)
    const box = await boxOf(viewport)
    const film = await boxOf(dialog.getByRole('group', { name: '画面轨', exact: true }))
    await liftShot(page, dialog, 2)
    await page.mouse.move(box.x + box.width - 10, film.cy, { steps: 8 })
    await expect.poll(() => viewport.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
    await page.mouse.up()
  })

  test('成片最长 120 秒：放不下时说明原因，松手不加入；拉长与挪动到上限停住', async ({ page }) => {
    const nineteen = Array.from({ length: 19 }, (_, k) => video(`v${k + 1}`, 0, 6_000))
    const { dialog, film } = await openWith(page, {
      layer0: [...nineteen, card('c1', 'hw-title', 5_500)],
      overlays: [overlay('o1', 'hw-arrow', 116_000, 4_000, 0)],
    })
    const filmBox = await boxOf(film)
    await liftShot(page, dialog, 2)
    await page.mouse.move(filmBox.x + filmBox.width / 2, filmBox.y + 12, { steps: 8 })
    await expect(
      page.getByRole('status').filter({ hasText: '加入后成片超过 120 秒，无法加入' }),
    ).toBeVisible()
    await page.mouse.up()
    await expect(film.getByRole('group')).toHaveCount(20)
    await expect(
      page.getByText('加入后成片超过 120 秒，无法加入；请先缩短或删除其他片段'),
    ).toBeVisible()

    // 拉长最后一段：到 120 秒停住，写明原因
    await film.getByRole('button', { name: /^选中：第 20 段/ }).click()
    const handle = await boxOf(film.getByRole('slider', { name: '裁剪该段结尾' }))
    await page.mouse.move(handle.cx, handle.cy)
    await page.mouse.down()
    await page.mouse.move(handle.cx + 200, handle.cy, { steps: 6 })
    await expect(
      dialog.getByRole('status').filter({ hasText: '成片最长 120 秒，不能再拉长' }),
    ).toBeVisible()
    await page.mouse.up()
    await expect
      .poll(async () =>
        (await readDraft(page))?.layer0.reduce((total, clip) => total + clip.duration, 0),
      )
      .toBe(120_000)

    // 特效块挪不过 120 秒
    const overlays = dialog.getByRole('group', { name: '特效轨' })
    await overlays.getByRole('button', { name: /^选中：特效 · 手绘箭头/ }).click()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByText('成片最长 120 秒，不能再拉长')).toBeVisible()
    await expect(overlays.getByRole('group', { name: /116\.0–120\.0 秒$/ })).toBeVisible()
  })

  test('画面轨内拖动排序：完整占位与邻段预演，松手才保存；Esc 或拖出轨道取消', async ({ page }) => {
    const { dialog, film } = await openWith(page, { layer0: BASE })
    const before = await clipLefts(film)
    const beforeDraft = await readDraft(page)
    const { pps } = await pixelsPerSecond(dialog)
    const preview = film.getByTestId('timeline-insertion-preview')
    const second = await boxOf(film.getByRole('button', { name: /^选中：第 2 段/ }))
    const fifth = await boxOf(film.getByRole('group', { name: /^第 5 段/ }))
    await page.mouse.move(second.cx, second.cy)
    await page.mouse.down()
    await page.mouse.move(second.cx + 20, second.cy, { steps: 3 })
    await page.mouse.move(fifth.x + fifth.width - 4, second.cy, { steps: 8 })
    await expect(preview).toBeVisible()
    await expect
      .poll(async () => Math.abs((await boxOf(preview)).width - 1.5 * pps))
      .toBeLessThan(3)
    await expect(page.getByRole('status').filter({ hasText: /移到第\s*5\s*段/ })).toBeVisible()
    await expect.poll(async () => before[2] - (await clipLefts(film))[2]).toBeGreaterThan(pps)
    await expect(film.getByRole('group', { name: /^第 \d+ 段/ })).toHaveCount(6)
    expect(await readDraft(page)).toEqual(beforeDraft)
    await page.mouse.up()
    await expect
      .poll(async () => (await readDraft(page))?.layer0.map((clip) => clip.id))
      .toEqual(['c1', 'v2', 'v3', 'v4', 'v1', 'v5'])
    await expect(preview).toBeHidden()
    const movedDraft = await readDraft(page)
    const movedLefts = await clipLefts(film)

    // 在有效落点按 Esc：撤回预演，随后 pointerup 不得提交。
    const first = await boxOf(film.getByRole('group', { name: /^第 1 段/ }))
    const moved = await boxOf(film.getByRole('button', { name: /^选中：第 5 段/ }))
    await page.mouse.move(moved.cx, moved.cy)
    await page.mouse.down()
    await page.mouse.move(first.x + 2, moved.cy, { steps: 8 })
    await expect(preview).toBeVisible()
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await expect(preview).toBeHidden()
    await expect
      .poll(async () =>
        Math.max(...(await clipLefts(film)).map((left, at) => Math.abs(left - movedLefts[at]))),
      )
      .toBeLessThan(1)
    expect(await readDraft(page)).toEqual(movedDraft)

    // 拖出画面轨（到素材区）松手：不挪，缩影退回
    const third = await boxOf(film.getByRole('button', { name: /^选中：第 3 段/ }))
    const materials = await boxOf(dialog.getByRole('region', { name: '视频素材区' }))
    await page.mouse.move(third.cx, third.cy)
    await page.mouse.down()
    await page.mouse.move(third.cx, materials.cy, { steps: 8 })
    await expect(preview).toBeHidden()
    await page.mouse.up()
    expect(await readDraft(page)).toEqual(movedDraft)
  })

  test('点段移到段首、Delete 删除、⌘Z 撤销、⌥→ 挪一位、修剪与 ←/→ 微调、方向键走播放头', async ({
    page,
  }) => {
    const { dialog, film } = await openWith(page, {
      layer0: [BASE[1], BASE[2], card('c2', 'hw-title', 1_500), BASE[3], BASE[4], BASE[5]],
    })
    const clock = dialog.getByRole('slider', { name: '时间线播放位置' })
    // 点段：播放头到段首，把这一段播一遍，播到段尾停下。组件可以放在画面轨任意位置：第 3 段是组件段
    await film.getByRole('button', { name: /^选中：第 3 段 · 组件 · 手写标题/ }).click()
    await expect(dialog.getByText('当前片段 · 第 3 段 · 没有原声')).toBeVisible()
    await expectStoppedAt(clock, 4_700)

    await film.getByRole('button', { name: /^选中：第 2 段/ }).click()
    await expectStoppedAt(clock, 3_200)
    // 方向键挪播放头：→ 0.1 秒、⇧→ 1 秒。读数是播放器按帧报的时刻，与播放头可差一帧
    const pausedAt = await settledClockMs(clock)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    await expect
      .poll(async () => Math.abs(Number(await clock.inputValue()) * 1000 - pausedAt - 1_100))
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

  test('特效轨：拖动和微调；上下新增预演展开一行，松手才提交，取消恢复原排列', async ({ page }) => {
    const { dialog } = await openWith(page, {
      layer0: BASE,
      overlays: [
        overlay('o1', 'hw-arrow', 1_000, 3_000, 0),
        overlay('o2', 'editorial-flash-overlay', 3_500, 4_000, 1),
      ],
    })
    const lane = dialog.getByRole('group', { name: '特效轨' })
    const arrow = lane.getByRole('button', { name: /^选中：特效 · 手绘箭头/ })

    // 按住中部往右拖 1 秒多一点：开头吸到第 1 段结尾（2 秒处的切点），块上方写起止秒数
    const { pps } = await pixelsPerSecond(dialog)
    const block = await boxOf(arrow)
    await page.mouse.move(block.cx, block.cy)
    await page.mouse.down()
    await page.mouse.move(block.cx + pps * 1.03, block.cy, { steps: 6 })
    await expect(lane.getByRole('status')).toHaveText('2.0–5.0 秒')
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

    // 拖到已有行只换行；越过最后一行后展开新增预演，尚未保存草稿。
    await expect.poll(async () => (await readDraft(page))?.overlays[0]?.start).toBe(1_100)
    const beforeMove = await readDraft(page)
    const laneBox = await boxOf(lane)
    const flash = await boxOf(lane.getByRole('button', { name: /^选中：特效 · 闪光叠加/ }))
    const arrowNow = await boxOf(arrow)
    await page.mouse.move(arrowNow.cx, arrowNow.cy)
    await page.mouse.down()
    await page.mouse.move(arrowNow.cx, flash.cy, { steps: 4 })
    await expect(lane.getByRole('status').filter({ hasText: '新增特效轨' })).toHaveCount(0)
    await page.mouse.move(arrowNow.cx, flash.y + flash.height * 1.5, { steps: 4 })
    await expect(lane.getByRole('status').filter({ hasText: '新增特效轨' })).toContainText(
      '松开添加',
    )
    await expect.poll(async () => (await boxOf(lane)).height).toBeGreaterThan(laneBox.height)
    expect(await readDraft(page)).toEqual(beforeMove)
    await expect(lane.getByRole('group', { name: /^特效 · / })).toHaveCount(2)
    await page.mouse.up()
    await expect(lane.getByRole('group', { name: /^特效 · 闪光叠加，第 1 行/ })).toBeVisible()
    await expect(lane.getByRole('group', { name: /^特效 · 手绘箭头，第 2 行/ })).toBeVisible()

    // 移到所有行上方也会展开；Esc 收回，不修改草稿。
    await expect.poll(async () => (await boxOf(lane)).height).toBe(laneBox.height)
    await expect.poll(async () => (await readDraft(page))?.overlays[0]?.track).toBe(1)
    const beforeCancel = await readDraft(page)
    const firstRow = await boxOf(lane.getByRole('group', { name: /^特效 · 闪光叠加，第 1 行/ }))
    const top = firstRow.y - firstRow.height / 4
    const arrowLow = await boxOf(arrow)
    await page.mouse.move(arrowLow.cx, arrowLow.cy)
    await page.mouse.down()
    await page.mouse.move(arrowLow.cx, top, { steps: 6 })
    await expect(lane.getByRole('status').filter({ hasText: '新增特效轨' })).toBeVisible()
    await expect.poll(async () => (await boxOf(lane)).height).toBeGreaterThan(laneBox.height)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await expect(dialog).toBeVisible()
    await expect.poll(async () => (await boxOf(lane)).height).toBe(laneBox.height)
    expect(await readDraft(page)).toEqual(beforeCancel)

    // 再拖到最上面松手，预演结果提交成第一行。
    const retry = await boxOf(arrow)
    await page.mouse.move(retry.cx, retry.cy)
    await page.mouse.down()
    await page.mouse.move(retry.cx, top, { steps: 6 })
    await expect(lane.getByRole('status').filter({ hasText: '新增特效轨' })).toBeVisible()
    await page.mouse.up()
    await expect(lane.getByRole('group', { name: /^特效 · 手绘箭头，第 1 行/ })).toBeVisible()
    await expect.poll(async () => (await boxOf(lane)).height).toBe(laneBox.height)

    // 拖组件卡到特效轨（松手放下）
    await dialog.getByRole('tab', { name: '通用' }).click()
    await dialog
      .getByRole('radiogroup', { name: '分类', exact: true })
      .getByRole('radio', { name: /^社交/ })
      .click()
    const cardLocator = dialog.getByRole('button', { name: /^手绘圈注，/ })
    await cardLocator.scrollIntoViewIfNeeded()
    const cardButton = await boxOf(cardLocator)
    const film = await boxOf(dialog.getByRole('group', { name: '画面轨', exact: true }))
    await page.mouse.move(cardButton.cx, cardButton.cy)
    await page.mouse.down()
    await page.mouse.move(cardButton.cx + 20, cardButton.cy + 20, { steps: 4 })
    const lastRow = await boxOf(lane.getByRole('group', { name: /^特效 · 闪光叠加，第 2 行/ }))
    await page.mouse.move(film.x + film.width * 0.6, lastRow.y + lastRow.height * 1.5, {
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
    const preview = page.getByText('00:04.00', { exact: true })
    // 点段会自动播放到段尾；停下之后再验证悬停不会改变实际播放时间。
    await expectStoppedAt(ruler, 5_200)
    await expect(dialog.getByRole('button', { name: '播放', exact: true })).toBeVisible()
    await settledClockMs(dialog.getByRole('slider', { name: '时间线播放位置' }))
    const before = await ruler.inputValue()
    const rulerBox = await boxOf(ruler)
    const initial = await pixelsPerSecond(dialog)
    const hoverX = initial.left + initial.pps * 4
    await page.mouse.move(hoverX, rulerBox.cy)
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
    await expect.poll(async () => (await pixelsPerSecond(dialog)).pps).toBeGreaterThan(initial.pps)
    const viewport = await scrollViewport(dialog.getByRole('slider', { name: '时间线播放位置' }))
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

  test('吸附可切换，焦点在工具按钮时空格仍控制播放，自动卡点读取音乐后可用', async ({ page }) => {
    const { dialog } = await openWith(page, { layer0: BASE, music: true })
    const snap = dialog.getByRole('button', { name: '吸附' })
    await snap.click()
    await expect(snap).toHaveAttribute('aria-pressed', 'false')
    await snap.click()
    await expect(snap).toHaveAttribute('aria-pressed', 'true')
    await snap.focus()
    await page.keyboard.press(' ')
    await expect(dialog.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
    await expect(snap).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press(' ')
    await expect(dialog.getByRole('button', { name: '播放', exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '自动卡点' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
      { timeout: 15_000 },
    )
  })

  test('音量按 dB 调整并保存，双击恢复，配乐可静音', async ({ page }) => {
    const { dialog, film } = await openWith(page, { layer0: BASE, music: true })
    await film.getByRole('button', { name: /^选中：第 2 段/ }).click()
    const source = dialog.getByRole('slider', { name: '原声音量' })
    await expect(source).toHaveAttribute('aria-valuetext', '0 dB')
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

/**
 * 合成页里第一个看得见的匹配元素，中心在页面上的位置；还没有时为 null。
 * 合成页在播放器的 iframe 里按缩放画出来，位置要乘上缩放再加上 iframe 的位置。
 */
const pointInPreview = (dialog: Locator, selector: string) =>
  dialog
    .getByRole('region', { name: '预览' })
    .locator('hyperframes-player')
    .evaluate((player, selector) => {
      const iframe = (player as HTMLElement & { iframeElement: HTMLIFrameElement }).iframeElement
      const doc = iframe.contentDocument
      const win = iframe.contentWindow
      if (doc === null || win === null) return null
      const shown = (element: Element) => {
        for (let node: Element | null = element; node !== null; node = node.parentElement) {
          const style = win.getComputedStyle(node)
          if (style.visibility === 'hidden' || style.display === 'none') return false
          if (Number(style.opacity) === 0) return false
        }
        return element.getBoundingClientRect().width > 0
      }
      const element = [...doc.querySelectorAll(selector)].find(shown)
      if (element === undefined) return null
      const frame = iframe.getBoundingClientRect()
      const scale = frame.width / iframe.offsetWidth
      const box = element.getBoundingClientRect()
      return {
        x: frame.left + (box.left + box.width / 2) * scale,
        y: frame.top + (box.top + box.height / 2) * scale,
      }
    }, selector)

/** 等合成页里这个元素画出来（动画入场后），返回它在页面上的中心 */
const shownInPreview = async (dialog: Locator, selector: string) => {
  await expect.poll(() => pointInPreview(dialog, selector)).not.toBeNull()
  const point = await pointInPreview(dialog, selector)
  if (point === null) throw new Error(`预览里没有 ${selector}`)
  return point
}

/**
 * 正在显示的合成页里，写着这个 data-hf-id 的最外层元素：它的位置属性、行内 translate，与它画在
 * 页面上的范围（已按画面缩放换到页面坐标）
 */
const placedInPreview = (dialog: Locator, hfId: string) =>
  dialog
    .getByRole('region', { name: '预览' })
    // 换页那一刻新旧两个播放器可能同时显示，取后放上来的那个
    .locator('hyperframes-player:not(.is-pending)')
    .last()
    .evaluate((player, hfId) => {
      const iframe = (player as HTMLElement & { iframeElement: HTMLIFrameElement }).iframeElement
      const element = iframe.contentDocument?.querySelector<HTMLElement>(`[data-hf-id="${hfId}"]`)
      if (element == null) return null
      const frame = iframe.getBoundingClientRect()
      const scale = frame.width / iframe.offsetWidth
      const box = element.getBoundingClientRect()
      return {
        dataX: element.getAttribute('data-x'),
        dataY: element.getAttribute('data-y'),
        translate: element.style.getPropertyValue('translate'),
        left: frame.left + box.left * scale,
        top: frame.top + box.top * scale,
        /** 画布 1 像素在页面上多宽 */
        scale,
      }
    }, hfId)

/** 按住 from，分几步拖到 (dx, dy) 之外 */
const dragBy = async (page: Page, from: { x: number; y: number }, dx: number, dy: number) => {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 })
}

/** 播放头跳到这一刻（秒），等播放器停稳 */
const seekTo = async (dialog: Locator, secondsAt: number) => {
  const clock = dialog.getByRole('slider', { name: '时间线播放位置' })
  await clock.fill(String(secondsAt))
  await settledClockMs(clock)
}

test.describe('成片编辑器 · 画面点选、原位改字与拖动', () => {
  test('点画面上的字幕选中时间线上那一句；双击在画面上改字，回车后时间线跟着变', async ({
    page,
  }) => {
    const { dialog } = await openWith(page, { layer0: [video('v1', 0, 6_000)] })
    const captions = dialog.getByRole('group', { name: '字幕轨' })
    const first = captions.getByRole('button', { name: /^字幕：夜色里，城市慢慢亮起来/ })
    const second = captions.getByRole('button', { name: /^字幕：车流划出一道道光/ })
    await expect(first).toBeVisible()
    await seekTo(dialog, 1)

    const line = await shownInPreview(dialog, '[data-hf-id="caption:0"] .caption-line')
    await page.mouse.click(line.x, line.y)
    await expect(first).toHaveClass(/is-selected/)
    await expect(second).not.toHaveClass(/is-selected/)
    await expect(dialog.locator('.wf-canvas-frame')).toBeVisible()
    // 字幕不能删：Delete 什么也不删
    await page.keyboard.press('Delete')
    await expect(captions.getByRole('button', { name: /^字幕：/ })).toHaveCount(2)
    expect((await readDraft(page))?.layer0).toHaveLength(1)

    // 双击原位改字：整句全选，打字替换，回车提交
    await page.mouse.dblclick(line.x, line.y)
    await expect(dialog.locator('.wf-canvas-frame')).toBeHidden()
    await page.keyboard.type('夜色里，灯火通明')
    await page.keyboard.press('Enter')
    await expect(captions.getByRole('button', { name: /^字幕：夜色里，灯火通明/ })).toBeVisible()
    await expect
      .poll(async () => (await readDraft(page))?.captions.edits.map((edit) => edit.text))
      .toEqual(['夜色里，灯火通明'])
    // 编辑器还开着；焦点回到编辑器，← → 照常走播放头
    await expect(dialog).toBeVisible()
    const clock = dialog.getByRole('slider', { name: '时间线播放位置' })
    const before = await settledClockMs(clock)
    await page.keyboard.press('ArrowRight')
    await expect
      .poll(async () => Math.abs(Number(await clock.inputValue()) * 1000 - before - 100))
      .toBeLessThanOrEqual(FRAME_MS)
  })

  test('点画面上的特效选中时间线上那一块，不弹浮层；双击带标记的名字原位改字', async ({ page }) => {
    const { dialog, film } = await openWith(page, {
      layer0: [video('v1', 0, 6_000)],
      overlays: [overlay('o1', 'lt-neon-border', 0, 4_000, 0)],
    })
    const block = dialog
      .getByRole('group', { name: '特效轨' })
      .getByRole('button', { name: /^选中：特效 · 霓虹边框姓名条/ })
    await seekTo(dialog, 2)

    const name = await shownInPreview(dialog, '[data-hf-id="o1"] [data-var-text="name"]')
    await page.mouse.click(name.x, name.y)
    await expect(block).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('dialog', { name: /霓虹边框姓名条/ })).toBeHidden()

    // 点画面上没有特效的地方：选中底下的视频段
    const panel = await boxOf(dialog.locator('.wf-canvas'))
    await page.mouse.click(panel.x + panel.width / 2, panel.y + 12)
    await expect(film.getByRole('button', { name: /^选中：第 1 段/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(block).toHaveAttribute('aria-pressed', 'false')

    // 双击名字：改这一项，其余可填项不动；Esc 放弃不关编辑器
    const nameText = () =>
      dialog
        .getByRole('region', { name: '预览' })
        .locator('hyperframes-player')
        .evaluate(
          (player) =>
            (
              player as HTMLElement & { iframeElement: HTMLIFrameElement }
            ).iframeElement.contentDocument?.querySelector(
              '[data-hf-id="o1"] [data-var-text="name"]',
            )?.textContent,
        )
    const shownName = await nameText()
    await page.mouse.dblclick(name.x, name.y)
    await page.keyboard.type('陈默')
    await page.keyboard.press('Escape')
    expect(await nameText()).toBe(shownName)
    await expect(dialog).toBeVisible()
    // 焦点回到编辑器：选中特效块时 → 把它挪 0.1 秒
    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => (await readDraft(page))?.overlays[0]?.start).toBe(100)
    // 等预览换上挪过之后的页面再改字（换页会放弃进行中的改字）
    await expect
      .poll(() =>
        dialog
          .getByRole('region', { name: '预览' })
          .locator('hyperframes-player')
          .evaluateAll((players) =>
            players.map((player) =>
              (
                player as HTMLElement & { iframeElement: HTMLIFrameElement }
              ).iframeElement.contentDocument
                ?.querySelector('[data-hf-id="o1"] [data-start]')
                ?.getAttribute('data-start'),
            ),
          ),
      )
      .toEqual(['0.1'])
    await page.mouse.dblclick(name.x, name.y)
    await page.keyboard.type('陈默')
    await page.keyboard.press('Enter')
    await expect
      .poll(async () => (await readDraft(page))?.overlays[0]?.variables)
      .toEqual({
        name: '陈默',
      })
    await expect(block).toHaveAttribute('aria-pressed', 'true')
  })

  test('在画面上拖动名牌：松手记一步编辑，换页后停在拖到的地方；撤销回到原处', async ({ page }) => {
    const { dialog } = await openWith(page, {
      layer0: [video('v1', 0, 6_000)],
      overlays: [overlay('o1', 'lt-neon-border', 0, 4_000, 0)],
    })
    await seekTo(dialog, 2)
    const name = await shownInPreview(dialog, '[data-hf-id="o1"] [data-var-text="name"]')
    const before = await placedInPreview(dialog, 'o1')
    if (before === null) throw new Error('预览里没有名牌')

    await dragBy(page, name, 40, -30)
    await expect(dialog.locator('.wf-canvas')).toHaveClass(/is-dragging/)
    await page.mouse.up()
    // 松手后、换页之前（换页至少等 250 毫秒）元素停在松手的地方
    const released = await placedInPreview(dialog, 'o1')
    await expect(dialog.locator('.wf-canvas')).not.toHaveClass(/is-dragging/)
    await expect
      .poll(async () => {
        const moved = (await readDraft(page))?.overlays[0]
        return [Math.sign(moved?.x ?? 0), Math.sign(moved?.y ?? 0)]
      })
      .toEqual([1, -1])
    const moved = (await readDraft(page))?.overlays[0]
    // 换上的新页面带着位置属性，运行时按它挪开；画面上停在拖到的地方
    await expect
      .poll(() => placedInPreview(dialog, 'o1'))
      .toMatchObject({
        dataX: String(moved?.x),
        dataY: String(moved?.y),
        translate: `${moved?.x}px ${moved?.y}px`,
      })
    // 挪开的画布像素乘上缩放就是页面上挪开的距离；与指针的位移只差吸附（6 像素以内）
    const after = await placedInPreview(dialog, 'o1')
    if (after === null || moved?.x === undefined || moved.y === undefined)
      throw new Error('名牌不见了')
    expect(Math.abs(after.left - before.left - moved.x * after.scale)).toBeLessThanOrEqual(1)
    expect(Math.abs(after.top - before.top - moved.y * after.scale)).toBeLessThanOrEqual(1)
    expect(Math.abs(after.left - before.left - 40)).toBeLessThanOrEqual(7)
    expect(Math.abs(after.top - before.top + 30)).toBeLessThanOrEqual(7)
    // 换页前后是同一个位置：没有闪回，也没有多挪
    expect(Math.abs((released?.left ?? 0) - after.left)).toBeLessThanOrEqual(0.5)
    expect(Math.abs((released?.top ?? 0) - after.top)).toBeLessThanOrEqual(0.5)
    await expect(dialog.getByRole('button', { name: '撤销' })).not.toHaveAttribute('aria-disabled')

    await page.keyboard.press('ControlOrMeta+z')
    await expect
      .poll(async () => {
        const undone = (await readDraft(page))?.overlays[0]
        return [undone?.x, undone?.y]
      })
      .toEqual([0, 0])
    await expect.poll(() => placedInPreview(dialog, 'o1')).toMatchObject({ dataX: null })
  })

  test('拖动画面上的字幕：全部字幕一起挪，位置记在草稿的字幕上', async ({ page }) => {
    const { dialog } = await openWith(page, { layer0: [video('v1', 0, 6_000)] })
    await seekTo(dialog, 1)
    const line = await shownInPreview(dialog, '[data-hf-id="caption:0"] .caption-line')

    await dragBy(page, line, 0, -50)
    await page.mouse.up()
    await expect
      .poll(async () => {
        const captions = (await readDraft(page))?.captions
        return [captions?.x, Math.sign(captions?.y ?? 0)]
      })
      .toEqual([0, -1])
    await expect
      .poll(async () => (await placedInPreview(dialog, 'captions'))?.dataY)
      .toBe(String((await readDraft(page))?.captions.y))
  })

  test('画面轨上的视频段只能选中，拖不动；拖动中按 Esc 放弃，元素回到原处，编辑器不关', async ({
    page,
  }) => {
    const { dialog, film } = await openWith(page, {
      layer0: [video('v1', 0, 6_000)],
      overlays: [overlay('o1', 'lt-neon-border', 0, 4_000, 0)],
    })
    await seekTo(dialog, 2)
    const saved = JSON.stringify(await readDraft(page))

    // 画面上没有特效的地方是底下的视频段
    const panel = await boxOf(dialog.locator('.wf-canvas'))
    await dragBy(page, { x: panel.x + panel.width / 2, y: panel.y + 12 }, 30, 40)
    await expect(dialog.locator('.wf-canvas')).not.toHaveClass(/is-dragging/)
    await page.mouse.up()
    await expect(film.getByRole('button', { name: /^选中：第 1 段/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(await placedInPreview(dialog, 'v1')).toMatchObject({ translate: '' })

    const name = await shownInPreview(dialog, '[data-hf-id="o1"] [data-var-text="name"]')
    const before = await placedInPreview(dialog, 'o1')
    await dragBy(page, name, 60, -40)
    await expect.poll(async () => (await placedInPreview(dialog, 'o1'))?.translate).not.toBe('')
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('.wf-canvas')).not.toHaveClass(/is-dragging/)
    expect(await placedInPreview(dialog, 'o1')).toEqual(before)
    // 两次都没记编辑，草稿没变
    await expect(dialog.getByRole('button', { name: '撤销' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(JSON.stringify(await readDraft(page))).toBe(saved)
  })
})
