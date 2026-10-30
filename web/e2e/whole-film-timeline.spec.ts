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
  card('c1', 'fixture-scene', 2_000),
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
    // 视频共 115.6 秒，最后一段用 6 秒的组件、只放 4 秒（共 119.6 秒，再加一个 1 秒的镜头就超了）：
    // 拉长时先碰到的是成片上限、不是组件自己的时长
    const videos = [
      ...Array.from({ length: 19 }, (_, k) => video(`v${k + 1}`, 0, 6_000)),
      video('v20', 0, 1_600),
    ]
    const { dialog, film } = await openWith(page, {
      layer0: [...videos, card('c1', 'fixture-scene', 4_000)],
      overlays: [overlay('o1', 'fixture-overlay', 116_000, 4_000, 0)],
    })
    const filmBox = await boxOf(film)
    await liftShot(page, dialog, 2)
    await page.mouse.move(filmBox.x + filmBox.width / 2, filmBox.y + 12, { steps: 8 })
    await expect(
      page.getByRole('status').filter({ hasText: '加入后成片超过 120 秒，无法加入' }),
    ).toBeVisible()
    await page.mouse.up()
    await expect(film.getByRole('group')).toHaveCount(21)
    await expect(
      page.getByText('加入后成片超过 120 秒，无法加入；请先缩短或删除其他片段'),
    ).toBeVisible()

    // 拉长最后一段：到 120 秒停住，写明原因
    await film.getByRole('button', { name: /^选中：第 21 段/ }).click()
    const handle = await boxOf(film.getByRole('slider', { name: '裁剪结尾' }))
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
    await overlays.getByRole('button', { name: /^选中：特效 · 测试叠加/ }).click()
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

  test('画面轨多选：Shift 扩选后画面上没有选中框；按住任一选中段整块拖动，松手仍选着这几段', async ({
    page,
  }) => {
    const { dialog, film } = await openWith(page, { layer0: BASE })
    const segment = (n: number) =>
      film.getByRole('button', { name: new RegExp(`^选中：第 ${n} 段`) })
    const preview = film.getByTestId('timeline-insertion-preview')

    // 单选视频段：画面上有选中框，两端各一个修剪手柄
    await segment(2).click()
    await expect(selectionFrame(dialog)).toBeVisible()
    await expect(film.getByRole('slider')).toHaveCount(2)
    // Shift 扩选：画面上不画选中框，修剪手柄仍只在选区两端
    await segment(3).click({ modifiers: ['Shift'] })
    await expect(segment(2)).toHaveAttribute('aria-pressed', 'true')
    await expect(segment(3)).toHaveAttribute('aria-pressed', 'true')
    await expect(selectionFrame(dialog)).toBeHidden()
    await expect(film.getByRole('slider')).toHaveCount(2)

    // 按住选区里的第 3 段拖到第 5 段后半：v1、v2 一起挪到 v4 之后，占位按两段一共的长度
    const { pps } = await pixelsPerSecond(dialog)
    const from = await boxOf(segment(3))
    const fifth = await boxOf(film.getByRole('group', { name: /^第 5 段/ }))
    await page.mouse.move(from.cx, from.cy)
    await page.mouse.down()
    await page.mouse.move(from.cx + 20, from.cy, { steps: 3 })
    await page.mouse.move(fifth.x + fifth.width - 4, from.cy, { steps: 8 })
    await expect(preview).toBeVisible()
    await expect
      .poll(async () => Math.abs((await boxOf(preview)).width - 3.2 * pps))
      .toBeLessThan(3)
    await page.mouse.up()
    await expect
      .poll(async () => (await readDraft(page))?.layer0.map((clip) => clip.id))
      .toEqual(['c1', 'v3', 'v4', 'v1', 'v2', 'v5'])
    await expect(segment(4)).toHaveAttribute('aria-pressed', 'true')
    await expect(segment(5)).toHaveAttribute('aria-pressed', 'true')
    await expect(segment(3)).toHaveAttribute('aria-pressed', 'false')
  })

  test('点段只选中、播放头到段首，播放中点段停在段首；Delete 删除、⌘Z 撤销、⌥→ 挪一位、修剪与 ←/→ 微调、方向键走播放头', async ({
    page,
  }) => {
    const { dialog, film } = await openWith(page, {
      layer0: [BASE[1], BASE[2], card('c2', 'fixture-scene', 1_500), BASE[3], BASE[4], BASE[5]],
    })
    const clock = dialog.getByRole('slider', { name: '时间线播放位置' })
    const play = dialog.getByRole('button', { name: '播放', exact: true })
    const expectPlayheadAt = (ms: number) =>
      expect
        .poll(async () => Math.abs(Number(await clock.inputValue()) * 1000 - ms))
        .toBeLessThanOrEqual(FRAME_MS)
    // 点段：只选中，不播放；点在段的后半截，播放头也到段首。组件可以放在画面轨任意位置：第 3 段是
    // 3.2–4.7 秒的组件段
    const component = film.getByRole('button', { name: /^选中：第 3 段 · 组件 · 测试画面/ })
    const componentBox = await boxOf(component)
    await component.click({
      position: { x: componentBox.width * 0.8, y: componentBox.height / 2 },
    })
    await expect(play).toBeVisible()
    await expectPlayheadAt(3_200)
    // 组件段没有原声：工具条里的原声推子置灰，悬停说明原因
    await expect(dialog.getByRole('slider', { name: '原声', exact: true })).toBeDisabled()
    await expect(dialog.getByTitle('组件段没有原声，无法调整原声音量')).toBeVisible()

    // 播放中点第 2 段（1.5–3.2 秒）：停下，播放头停在段首
    await play.click()
    await expect(dialog.getByRole('button', { name: '暂停', exact: true })).toBeVisible()
    await film.getByRole('button', { name: /^选中：第 2 段/ }).click()
    await expect(play).toBeVisible()
    // 方向键挪播放头：→ 0.1 秒、⇧→ 1 秒。读数是播放器按帧报的时刻，与播放头可差一帧
    const pausedAt = await settledClockMs(clock)
    expect(Math.abs(pausedAt - 1_500)).toBeLessThanOrEqual(FRAME_MS)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    await expect
      .poll(async () => Math.abs(Number(await clock.inputValue()) * 1000 - pausedAt - 1_100))
      .toBeLessThanOrEqual(FRAME_MS)

    // 修剪：拖结尾手柄，再用 ← 微调 0.1 秒
    const segment = film.getByRole('group', { name: /^第 2 段/ })
    const end = film.getByRole('slider', { name: '裁剪结尾' })
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

  test('拖画面轨一段的左把手往外拉长：被拖的段画成一整块、带着拉回来的原声，盖在前一段上；别的段不动；松手后首尾接上', async ({
    page,
  }) => {
    const { dialog, film } = await openWith(page, { layer0: BASE })
    // 第 3 段是 v2：素材 1.5–3.2 秒，开头还能往前拉
    await film.getByRole('button', { name: /^选中：第 3 段/ }).click()
    const segment = (n: number) => film.getByRole('group', { name: new RegExp(`^第 ${n} 段`) })
    const boxes = async () => ({
      second: await boxOf(segment(2)),
      third: await boxOf(segment(3)),
      fourth: await boxOf(segment(4)),
    })
    const wave = segment(3).getByTestId('timeline-wave')
    await expect(wave).toBeVisible()
    /** 原声行画了素材多长：波形每列是一个峰值，列数随素材时间段变。 */
    const waveColumns = async () =>
      Number((await wave.getAttribute('viewBox'))?.split(' ')[2] ?? Number.NaN)
    const columnsBefore = await waveColumns()
    const before = await boxes()
    const handle = await boxOf(film.getByRole('slider', { name: '裁剪开头' }))
    const { pps } = await pixelsPerSecond(dialog)
    const pull = Math.round(pps * 0.4)
    await page.mouse.move(handle.cx, handle.cy)
    await page.mouse.down()
    await page.mouse.move(handle.cx - pull, handle.cy, { steps: 6 })
    const during = await boxes()
    for (const key of ['second', 'fourth'] as const) {
      expect(Math.abs(during[key].x - before[key].x)).toBeLessThanOrEqual(1)
      expect(Math.abs(during[key].width - before[key].width)).toBeLessThanOrEqual(1)
    }
    // 被拖的段是一个元素：从把手处到原来的结尾，原声行画的是素材 1.1–3.2 秒
    expect(Math.abs(during.third.x - (before.third.x - pull))).toBeLessThanOrEqual(2)
    expect(
      Math.abs(during.third.x + during.third.width - (before.third.x + before.third.width)),
    ).toBeLessThanOrEqual(1)
    expect((await waveColumns()) / columnsBefore).toBeCloseTo(2.1 / 1.7, 1)
    // 盖在前一段上：拉回来的那截里（避开把手的命中区）最上面是被拖的段
    const onTop = await segment(3).evaluate(
      (element: HTMLElement, x: number) => {
        const box = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(x, box.bottom - 4))
      },
      before.third.x - pull * 0.4,
    )
    expect(onTop).toBe(true)
    // 把手停在拉长后的开头
    const moved = await boxOf(film.getByRole('slider', { name: '裁剪开头' }))
    expect(Math.abs(moved.cx - (handle.cx - pull))).toBeLessThanOrEqual(2)
    await expect(film.getByTestId('trim-cut')).toHaveCount(0)
    await page.mouse.up()

    // 松手：第 3 段接在第 2 段后面，第 4 段跟着往后
    await expect
      .poll(async () => {
        const after = await boxes()
        return [
          after.third.x - (after.second.x + after.second.width),
          after.fourth.x - before.fourth.x - pull,
        ].map((gap) => Math.abs(gap) <= 3)
      })
      .toEqual([true, true])
    await expect
      .poll(async () => (await readDraft(page))?.layer0[2]?.playbackStart)
      .toBeLessThan(1_500)
  })

  test('第一段左把手往回拉：左边停在 0，向右变长盖在第二段上，把手留在 0；松手后后面的段往右滑', async ({
    page,
  }) => {
    // 第一段是素材 1.0–2.5 秒，开头还能往前拉 1 秒
    const layer0 = [video('v1', 1_000, 2_500), ...BASE.slice(2)]
    const { dialog, film } = await openWith(page, { layer0 })
    await film.getByRole('button', { name: /^选中：第 1 段/ }).click()
    const segment = (n: number) => film.getByRole('group', { name: new RegExp(`^第 ${n} 段`) })
    const before = { first: await boxOf(segment(1)), second: await boxOf(segment(2)) }
    const handle = await boxOf(film.getByRole('slider', { name: '裁剪开头' }))
    const { pps } = await pixelsPerSecond(dialog)
    const pull = Math.round(pps * 0.4)
    await page.mouse.move(handle.cx, handle.cy)
    await page.mouse.down()
    await page.mouse.move(handle.cx - pull, handle.cy, { steps: 6 })
    const first = await boxOf(segment(1))
    const second = await boxOf(segment(2))
    expect(Math.abs(first.x - before.first.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(first.width - (before.first.width + pull))).toBeLessThanOrEqual(2)
    expect(Math.abs(second.x - before.second.x)).toBeLessThanOrEqual(1)
    // 盖在第二段开头那截上
    const onTop = await segment(1).evaluate(
      (element: HTMLElement, x: number) => {
        const box = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(x, box.bottom - 4))
      },
      before.second.x + pull / 2,
    )
    expect(onTop).toBe(true)
    // 把手留在 0（时间区开头）
    const moved = await boxOf(film.getByRole('slider', { name: '裁剪开头' }))
    expect(Math.abs(moved.cx - handle.cx)).toBeLessThanOrEqual(2)
    await page.mouse.up()

    // 入点早了拉过的那么多（像素按每秒像素换成毫秒，差几毫秒）
    const pulledMs = (pull / pps) * 1000
    await expect
      .poll(async () => {
        const clip = (await readDraft(page))?.layer0[0]
        return [
          Math.abs((clip?.playbackStart ?? 0) - (1_000 - pulledMs)) <= 5,
          Math.abs((clip?.duration ?? 0) - (1_500 + pulledMs)) <= 5,
        ]
      })
      .toEqual([true, true])
    await expect
      .poll(async () => Math.abs((await boxOf(segment(2))).x - (before.second.x + pull)) <= 3)
      .toBe(true)
  })

  test('拖画面轨一段的右把手往里裁：拖动中后面的段不动，剪掉的那段调暗；松手后后面的段接上', async ({
    page,
  }) => {
    const { dialog, film } = await openWith(page, { layer0: BASE })
    // 第 3 段是 v2，长 1.7 秒
    await film.getByRole('button', { name: /^选中：第 3 段/ }).click()
    const segment = (n: number) => film.getByRole('group', { name: new RegExp(`^第 ${n} 段`) })
    const boxes = async () => ({ third: await boxOf(segment(3)), fourth: await boxOf(segment(4)) })
    const before = await boxes()
    const handle = await boxOf(film.getByRole('slider', { name: '裁剪结尾' }))
    const { pps } = await pixelsPerSecond(dialog)
    const pull = Math.round(pps * 0.4)
    await page.mouse.move(handle.cx, handle.cy)
    await page.mouse.down()
    await page.mouse.move(handle.cx - pull, handle.cy, { steps: 6 })
    const during = await boxes()
    for (const key of ['third', 'fourth'] as const) {
      expect(Math.abs(during[key].x - before[key].x)).toBeLessThanOrEqual(1)
      expect(Math.abs(during[key].width - before[key].width)).toBeLessThanOrEqual(1)
    }
    // 调暗层从把手处到这段原来的结尾，画在这段里
    const cut = film.getByTestId('trim-cut')
    const dimmed = await boxOf(cut)
    expect(Math.abs(dimmed.x - (handle.cx - pull))).toBeLessThanOrEqual(3)
    expect(
      Math.abs(dimmed.x + dimmed.width - (before.third.x + before.third.width)),
    ).toBeLessThanOrEqual(1)
    const moved = await boxOf(film.getByRole('slider', { name: '裁剪结尾' }))
    expect(Math.abs(moved.cx - (handle.cx - pull))).toBeLessThanOrEqual(2)
    await expect(film.getByTestId('trim-extend')).toHaveCount(0)
    await page.mouse.up()
    await expect(cut).toHaveCount(0)

    // 松手：第 4 段接到第 3 段后面
    await expect
      .poll(async () => {
        const after = await boxes()
        return [
          after.fourth.x - (after.third.x + after.third.width),
          after.fourth.x - (before.fourth.x - pull),
        ].map((gap) => Math.abs(gap) <= 3)
      })
      .toEqual([true, true])
    await expect.poll(async () => (await readDraft(page))?.layer0[2]?.duration).toBeLessThan(1_700)
  })

  test('特效轨：拖动和微调；上下新增预演展开一行，松手才提交，取消恢复原排列', async ({ page }) => {
    const { dialog } = await openWith(page, {
      layer0: BASE,
      overlays: [
        overlay('o1', 'fixture-overlay', 1_000, 3_000, 0),
        overlay('o2', 'fixture-fields', 3_500, 4_000, 1),
      ],
    })
    const lane = dialog.getByRole('group', { name: '特效轨' })
    const arrow = lane.getByRole('button', { name: /^选中：特效 · 测试叠加/ })

    // 按住中部往右拖 1 秒多一点：开头吸到第 1 段结尾（2 秒处的切点），块上方写起止秒数
    const { pps } = await pixelsPerSecond(dialog)
    const block = await boxOf(arrow)
    await page.mouse.move(block.cx, block.cy)
    await page.mouse.down()
    await page.mouse.move(block.cx + pps * 1.03, block.cy, { steps: 6 })
    await expect(lane.getByRole('status')).toHaveText('2.0–5.0 秒')
    await page.mouse.up()
    await expect(
      lane.getByRole('group', { name: '特效 · 测试叠加，第 1 行，2.0–5.0 秒' }),
    ).toBeVisible()

    // 选中后 ←/→ 挪 0.1 秒，⇧ 1 秒
    await arrow.click()
    await page.keyboard.press('ArrowRight')
    await expect(
      lane.getByRole('group', { name: '特效 · 测试叠加，第 1 行，2.1–5.1 秒' }),
    ).toBeVisible()
    await page.keyboard.press('Shift+ArrowLeft')
    await expect(
      lane.getByRole('group', { name: '特效 · 测试叠加，第 1 行，1.1–4.1 秒' }),
    ).toBeVisible()

    // 拖到已有行只换行；越过最后一行后展开新增预演，尚未保存草稿。
    await expect.poll(async () => (await readDraft(page))?.overlays[0]?.start).toBe(1_100)
    const beforeMove = await readDraft(page)
    const laneBox = await boxOf(lane)
    const flash = await boxOf(lane.getByRole('button', { name: /^选中：特效 · 测试可填项/ }))
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
    await expect(lane.getByRole('group', { name: /^特效 · 测试可填项，第 1 行/ })).toBeVisible()
    await expect(lane.getByRole('group', { name: /^特效 · 测试叠加，第 2 行/ })).toBeVisible()

    // 移到所有行上方也会展开；Esc 收回，不修改草稿。
    await expect.poll(async () => (await boxOf(lane)).height).toBe(laneBox.height)
    await expect.poll(async () => (await readDraft(page))?.overlays[0]?.track).toBe(1)
    const beforeCancel = await readDraft(page)
    const firstRow = await boxOf(lane.getByRole('group', { name: /^特效 · 测试可填项，第 1 行/ }))
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
    await expect(lane.getByRole('group', { name: /^特效 · 测试叠加，第 1 行/ })).toBeVisible()
    await expect.poll(async () => (await boxOf(lane)).height).toBe(laneBox.height)

    // 拖组件卡到特效轨（松手放下）
    await dialog.getByRole('tab', { name: '通用' }).click()
    await dialog
      .getByRole('radiogroup', { name: '分类', exact: true })
      .getByRole('radio', { name: /^场景/ })
      .click()
    const cardLocator = dialog.getByRole('button', { name: /^测试画面，/ })
    await cardLocator.scrollIntoViewIfNeeded()
    const cardButton = await boxOf(cardLocator)
    const film = await boxOf(dialog.getByRole('group', { name: '画面轨', exact: true }))
    await page.mouse.move(cardButton.cx, cardButton.cy)
    await page.mouse.down()
    await page.mouse.move(cardButton.cx + 20, cardButton.cy + 20, { steps: 4 })
    const lastRow = await boxOf(lane.getByRole('group', { name: /^特效 · 测试可填项，第 2 行/ }))
    await page.mouse.move(film.x + film.width * 0.6, lastRow.y + lastRow.height * 1.5, {
      steps: 8,
    })
    await page.mouse.up()
    await expect(lane.getByRole('group', { name: /^特效 · 测试画面，第 3 行/ })).toBeVisible()
    await expect(lane.getByRole('group', { name: /^特效 · / })).toHaveCount(3)
  })

  test('特效轨多行都在屏幕内、都能点选', async ({ page }) => {
    const { dialog } = await openWith(page, {
      layer0: BASE,
      overlays: [
        overlay('o1', 'fixture-overlay', 500, 3_000, 0),
        overlay('o2', 'fixture-fields', 2_000, 4_000, 1),
        overlay('o3', 'fixture-scene', 3_500, 1_200, 2),
        overlay('o4', 'fixture-brand-card', 1_000, 3_000, 3),
      ],
    })
    const lane = dialog.getByRole('group', { name: '特效轨' })
    for (const [name, row] of [
      ['测试叠加', 1],
      ['测试可填项', 2],
      ['测试画面', 3],
      ['示例品牌 片尾', 4],
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
    // 点段不播放；播放头停稳之后再验证悬停不会改变实际播放时间。
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
    // 两个推子在剪辑工具条里
    const sound = dialog.getByRole('toolbar', { name: '剪辑工具' }).getByRole('group', {
      name: '声音',
    })
    const source = sound.getByRole('slider', { name: '原声', exact: true })
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
    await expect(sound).toContainText('+3.5 dB')
    await dialog.getByRole('button', { name: '静音配乐' }).click()
    await expect(sound.getByRole('slider', { name: '配乐', exact: true })).toHaveAttribute(
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

/** 预览画面（正在显示的播放器）在页面上的范围；点选层铺满整张预览卡片，比画面大 */
const pictureOf = (dialog: Locator) =>
  boxOf(
    dialog
      .getByRole('region', { name: '预览' })
      .locator('hyperframes-player:not(.is-pending)')
      .last(),
  )

/** 画面上的选中框与它转过的角度（计算后的 CSS rotate） */
const selectionFrame = (dialog: Locator) => dialog.locator('.wf-canvas-frame')
const frameRotate = (dialog: Locator) =>
  selectionFrame(dialog).evaluate((frame) => getComputedStyle(frame).rotate)

/** 点 p 绕 center 顺时针转 degrees（页面坐标 y 向下） */
const turnAround = (
  center: { x: number; y: number },
  point: { x: number; y: number },
  degrees: number,
) => {
  const r = (degrees * Math.PI) / 180
  const dx = point.x - center.x
  const dy = point.y - center.y
  return {
    x: center.x + dx * Math.cos(r) - dy * Math.sin(r),
    y: center.y + dx * Math.sin(r) + dy * Math.cos(r),
  }
}

/** 按住选中框上的把手，分几步拖到 to 再松手；shift 时全程按住 Shift */
const dragHandle = async (
  page: Page,
  handle: Locator,
  to: (from: { x: number; y: number }) => { x: number; y: number },
  { shift = false } = {},
) => {
  const from = await boxOf(handle)
  const target = to({ x: from.cx, y: from.cy })
  if (shift) await page.keyboard.down('Shift')
  await page.mouse.move(from.cx, from.cy)
  await page.mouse.down()
  await page.mouse.move(target.x, target.y, { steps: 8 })
  await page.mouse.up()
  if (shift) await page.keyboard.up('Shift')
}

/**
 * 测试可填项在 180×320 画布上不变换时画出来那块（左下角的色底文字条）的中心（画布像素）：1920×1080 的
 * 设计稿缩到 0.09375 倍、竖直居中，色底 x 120–1020、y 720–940 落在 x 11.3–95.6、y 176.9–197.5
 */
const PANEL_CENTER = { x: 53, y: 187 }

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
      overlays: [overlay('o1', 'fixture-fields', 0, 4_000, 0)],
    })
    const block = dialog
      .getByRole('group', { name: '特效轨' })
      .getByRole('button', { name: /^选中：特效 · 测试可填项/ })
    await seekTo(dialog, 2)

    const name = await shownInPreview(dialog, '[data-hf-id="o1"] [data-var-text="text"]')
    await page.mouse.click(name.x, name.y)
    await expect(block).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('dialog', { name: /测试可填项/ })).toBeHidden()

    // 点画面上没有特效的地方：选中底下的视频段
    const picture = await pictureOf(dialog)
    await page.mouse.click(picture.cx, picture.y + 12)
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
              '[data-hf-id="o1"] [data-var-text="text"]',
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
        text: '陈默',
      })
    await expect(block).toHaveAttribute('aria-pressed', 'true')
  })

  test('在画面上拖动文字条：松手记一步编辑，换页后停在拖到的地方；撤销回到原处', async ({
    page,
  }) => {
    const { dialog } = await openWith(page, {
      layer0: [video('v1', 0, 6_000)],
      overlays: [overlay('o1', 'fixture-fields', 0, 4_000, 0)],
    })
    await seekTo(dialog, 2)
    const name = await shownInPreview(dialog, '[data-hf-id="o1"] [data-var-text="text"]')
    const before = await placedInPreview(dialog, 'o1')
    if (before === null) throw new Error('预览里没有文字条')

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
      throw new Error('文字条不见了')
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
      overlays: [overlay('o1', 'fixture-fields', 0, 4_000, 0)],
    })
    await seekTo(dialog, 2)
    const saved = JSON.stringify(await readDraft(page))

    // 画面上没有特效的地方是底下的视频段
    const picture = await pictureOf(dialog)
    await dragBy(page, { x: picture.cx, y: picture.y + 12 }, 30, 40)
    await expect(dialog.locator('.wf-canvas')).not.toHaveClass(/is-dragging/)
    await page.mouse.up()
    await expect(film.getByRole('button', { name: /^选中：第 1 段/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(await placedInPreview(dialog, 'v1')).toMatchObject({ translate: '' })

    const name = await shownInPreview(dialog, '[data-hf-id="o1"] [data-var-text="text"]')
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

test.describe('成片编辑器 · 画面上缩放、旋转与拖出画面', () => {
  const panel = () => overlay('o1', 'fixture-fields', 0, 4_000, 0)
  const panelBlock = (dialog: Locator) =>
    dialog
      .getByRole('group', { name: '特效轨' })
      .getByRole('button', { name: /^选中：特效 · 测试可填项/ })

  /** 打开只有一段视频和一个文字条的成片，停在 2 秒，点画面上的文字条选中它 */
  const selectPanel = async (page: Page, placed: Partial<Overlay> = {}) => {
    const { dialog, film } = await openWith(page, {
      layer0: [video('v1', 0, 6_000)],
      overlays: [{ ...panel(), ...placed }],
    })
    await seekTo(dialog, 2)
    const name = await shownInPreview(dialog, '[data-hf-id="o1"] [data-var-text="text"]')
    await page.mouse.click(name.x, name.y)
    await expect(panelBlock(dialog)).toHaveAttribute('aria-pressed', 'true')
    await expect(selectionFrame(dialog)).toBeVisible()
    return { dialog, film, name }
  }

  test('拖右下角等比放大：拖的时候显示倍数，松手记下倍数与转轴，撤销回到原大', async ({ page }) => {
    const { dialog } = await selectPanel(page)
    const picture = await pictureOf(dialog)
    const frame = await boxOf(selectionFrame(dialog))
    const corner = await boxOf(selectionFrame(dialog).locator('[data-corner="se"]'))
    // 绕选中框的中心（画出来那块的中心）把角拉到 1.5 倍远
    await page.mouse.move(corner.cx, corner.cy)
    await page.mouse.down()
    await page.mouse.move(
      frame.cx + (corner.cx - frame.cx) * 1.5,
      frame.cy + (corner.cy - frame.cy) * 1.5,
      { steps: 8 },
    )
    const readout = dialog.locator('.wf-canvas-readout')
    await expect(readout).toBeVisible()
    await expect(readout).toHaveText(/^1[45]\d%$/)
    await page.mouse.up()
    await expect(readout).toBeHidden()

    await expect.poll(async () => (await readDraft(page))?.overlays[0]?.scale ?? 1).not.toBe(1)
    const scaled = (await readDraft(page))?.overlays[0]
    expect(scaled?.scale).toBeGreaterThan(1.45)
    expect(scaled?.scale).toBeLessThan(1.55)
    expect(scaled?.rotation ?? 0).toBe(0)
    // 转轴是画出来那块的中心（挪开之前的画布像素）
    const scale = picture.width / 180
    expect(Math.abs((scaled?.pivotX ?? 0) - (frame.cx - picture.x) / scale)).toBeLessThanOrEqual(
      1.5,
    )
    expect(Math.abs((scaled?.pivotY ?? 0) - (frame.cy - picture.y) / scale)).toBeLessThanOrEqual(
      1.5,
    )
    // 选中框跟着变大
    await expect
      .poll(async () => (await boxOf(selectionFrame(dialog))).width)
      .toBeGreaterThan(frame.width * 1.4)

    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await readDraft(page))?.overlays[0]?.scale ?? 1).toBe(1)
  })

  test('按住 Shift 拖旋转把手：角度按 15° 一档记下，选中框跟着转', async ({ page }) => {
    const { dialog } = await selectPanel(page)
    const frame = await boxOf(selectionFrame(dialog))
    await dragHandle(
      page,
      selectionFrame(dialog).locator('[data-handle="rotate"]'),
      (from) => turnAround({ x: frame.cx, y: frame.cy }, from, 40),
      { shift: true },
    )
    await expect.poll(async () => (await readDraft(page))?.overlays[0]?.rotation ?? 0).not.toBe(0)
    const rotation = (await readDraft(page))?.overlays[0]?.rotation ?? 0
    expect(rotation % 15).toBe(0)
    expect(rotation).toBe(45)
    await expect.poll(() => frameRotate(dialog)).toBe('45deg')
  })

  test('转过、缩放过的文字条照样跟着指针拖，换页后不多挪；再转时沿用原来的转轴', async ({
    page,
  }) => {
    const { dialog, name } = await selectPanel(page, {
      scale: 1.5,
      rotation: 30,
      pivotX: PANEL_CENTER.x,
      pivotY: PANEL_CENTER.y,
    })
    await expect.poll(() => frameRotate(dialog)).toBe('30deg')
    const before = await placedInPreview(dialog, 'o1')
    if (before === null) throw new Error('预览里没有文字条')

    await dragBy(page, name, 40, -30)
    await page.mouse.up()
    const released = await placedInPreview(dialog, 'o1')
    await expect.poll(async () => (await readDraft(page))?.overlays[0]?.x ?? 0).not.toBe(0)
    const moved = (await readDraft(page))?.overlays[0]
    if (moved?.x === undefined || moved.y === undefined) throw new Error('文字条不见了')
    // 转过的不吸附：画布位移就是指针位移按缩放换算后取整
    expect(Math.abs(moved.x * before.scale - 40)).toBeLessThanOrEqual(before.scale)
    expect(Math.abs(moved.y * before.scale + 30)).toBeLessThanOrEqual(before.scale)
    expect(moved).toMatchObject({
      scale: 1.5,
      rotation: 30,
      pivotX: PANEL_CENTER.x,
      pivotY: PANEL_CENTER.y,
    })
    // 换上的新页面停在拖到的地方；松手时画面上已经在那里，换页前后同一个位置
    await expect
      .poll(async () => (await placedInPreview(dialog, 'o1'))?.dataX)
      .toBe(String(moved.x))
    const after = await placedInPreview(dialog, 'o1')
    if (after === null || released === null) throw new Error('文字条不见了')
    expect(Math.abs(after.left - before.left - moved.x * after.scale)).toBeLessThanOrEqual(1)
    expect(Math.abs(after.top - before.top - moved.y * after.scale)).toBeLessThanOrEqual(1)
    expect(Math.abs(released.left - after.left)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(released.top - after.top)).toBeLessThanOrEqual(0.5)

    const frame = await boxOf(selectionFrame(dialog))
    await dragHandle(page, selectionFrame(dialog).locator('[data-handle="rotate"]'), (from) =>
      turnAround({ x: frame.cx, y: frame.cy }, from, 20),
    )
    await expect.poll(async () => (await readDraft(page))?.overlays[0]?.rotation).not.toBe(30)
    expect((await readDraft(page))?.overlays[0]).toMatchObject({
      x: moved.x,
      y: moved.y,
      pivotX: PANEL_CENTER.x,
      pivotY: PANEL_CENTER.y,
    })
  })

  test('拖出画面：选中框伸到画面外；取消选中后画面外画虚线轮廓，点它选中', async ({ page }) => {
    const { dialog, name } = await selectPanel(page)
    const picture = await pictureOf(dialog)
    await dragBy(page, name, picture.width * 0.6, 0)
    await page.mouse.up()
    await expect.poll(async () => (await readDraft(page))?.overlays[0]?.x ?? 0).toBeGreaterThan(0)
    // 文字条右边（不挪时在画布 96 像素处）挪到了 180 宽的画布外
    expect(((await readDraft(page))?.overlays[0]?.x ?? 0) + 96).toBeGreaterThan(180)
    await expect
      .poll(async () => {
        const frame = await boxOf(selectionFrame(dialog))
        return frame.x + frame.width > picture.x + picture.width
      })
      .toBe(true)

    // 点画面外的空处取消选中
    await page.mouse.click(picture.x - 30, picture.cy)
    await expect(panelBlock(dialog)).toHaveAttribute('aria-pressed', 'false')
    await expect(selectionFrame(dialog)).toBeHidden()
    const outline = dialog.getByRole('button', { name: /^选中画面外的特效 · 测试可填项/ })
    await expect(outline).toBeVisible()
    // 点轮廓伸在画面外的那一段
    const box = await boxOf(outline)
    await page.mouse.click((picture.x + picture.width + box.x + box.width) / 2, box.cy)
    await expect(panelBlock(dialog)).toHaveAttribute('aria-pressed', 'true')
    await expect(selectionFrame(dialog)).toBeVisible()
    await expect(outline).toBeHidden()
  })

  test('点选画面上的一块后，别的伸出画面的块照样画轮廓', async ({ page }) => {
    // 第二个文字条往右挪 120，右边到了画布 216 像素处，伸出 180 宽的画布
    const { dialog } = await openWith(page, {
      layer0: [video('v1', 0, 6_000)],
      overlays: [panel(), { ...overlay('o2', 'fixture-fields', 0, 4_000, 1), x: 120 }],
    })
    await seekTo(dialog, 2)
    const outline = dialog.getByRole('button', { name: /^选中画面外的特效 · 测试可填项/ })
    await expect(outline).toHaveCount(1)
    const name = await shownInPreview(dialog, '[data-hf-id="o1"] [data-var-text="text"]')
    // 像人点那样按住一会儿再松开
    await page.mouse.click(name.x, name.y, { delay: 200 })
    await expect(
      dialog
        .getByRole('group', { name: '特效轨' })
        .getByRole('button', { name: /^选中：特效 · 测试可填项，第 1 行/ }),
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(outline).toBeVisible()
  })

  test('拖字幕选中框的角：全部字幕一起缩放，记在草稿的字幕上', async ({ page }) => {
    const { dialog } = await openWith(page, { layer0: [video('v1', 0, 6_000)] })
    await seekTo(dialog, 1)
    const line = await shownInPreview(dialog, '[data-hf-id="caption:0"] .caption-line')
    await page.mouse.click(line.x, line.y)
    await expect(selectionFrame(dialog)).toBeVisible()
    await dragHandle(page, selectionFrame(dialog).locator('[data-corner="se"]'), (from) => ({
      x: from.x + 30,
      y: from.y + 10,
    }))
    await expect.poll(async () => (await readDraft(page))?.captions.scale ?? 1).toBeGreaterThan(1)
    expect((await readDraft(page))?.captions.pivotY ?? 0).toBeGreaterThan(0)
    expect((await readDraft(page))?.overlays).toEqual([])
  })

  test('点画面上的视频段：选中框铺满画面，没有缩放、旋转把手', async ({ page }) => {
    const { dialog, film } = await openWith(page, {
      layer0: [video('v1', 0, 6_000)],
      overlays: [panel()],
    })
    await seekTo(dialog, 2)
    const picture = await pictureOf(dialog)
    await page.mouse.click(picture.cx, picture.y + 12)
    await expect(film.getByRole('button', { name: /^选中：第 1 段/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(selectionFrame(dialog)).toBeVisible()
    await expect(selectionFrame(dialog).locator('[data-handle]')).toHaveCount(0)
    const frame = await boxOf(selectionFrame(dialog))
    expect(Math.abs(frame.x - picture.x - 2)).toBeLessThanOrEqual(1)
    expect(Math.abs(frame.width - picture.width + 4)).toBeLessThanOrEqual(1)
    expect(Math.abs(frame.height - picture.height + 4)).toBeLessThanOrEqual(1)
  })
})
