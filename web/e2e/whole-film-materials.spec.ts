import { expect, test, type Locator, type Page } from '@playwright/test'
import { openConversation } from './helpers'

/** 有分镜、还没有出片的演示对话；各用例按需给镜头组出片（mock 的素材片 6 秒，每秒一个镜头） */
const CONVERSATION = '无图分镜草稿'

const conversationIdOf = (page: Page) => new URL(page.url()).pathname.split('/').at(-1) ?? ''

/** 按镜头组号各出一条片，等它们都完成；返回任务号 */
const addTakes = async (page: Page, shots: readonly number[]) => {
  const conversationId = conversationIdOf(page)
  const ids = await page.evaluate(
    async ({ conversationId, shots }) => {
      const created: string[] = []
      for (const shot of shots) {
        const response = await fetch('/api/generations/video', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            conversation_id: conversationId,
            shot_index: shot,
            prompt: `第 ${shot} 组`,
          }),
        })
        if (!response.ok) throw new Error(`出片失败：${response.status}`)
        created.push(((await response.json()) as { task_id: string }).task_id)
      }
      return created
    },
    { conversationId, shots },
  )
  await waitCompleted(page, ids)
  return ids
}

/** 给一条原作合成一版（素材区里这条原作多一个版本） */
const composeVersion = async (page: Page, baseJobId: string) => {
  const conversationId = conversationIdOf(page)
  const id = await page.evaluate(
    async ({ conversationId, baseJobId }) => {
      const response = await fetch('/api/generations/video-composites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          baseJobId,
          segments: [{ sourceJobId: baseJobId, start: 0, end: 3 }],
        }),
      })
      if (!response.ok) throw new Error(`合成失败：${response.status}`)
      return ((await response.json()) as { generation: { id: string } }).generation.id
    },
    { conversationId, baseJobId },
  )
  await waitCompleted(page, [id])
}

const waitCompleted = (page: Page, ids: readonly string[]) =>
  expect
    .poll(
      () =>
        page.evaluate(
          async ({ conversationId, ids }) => {
            const response = await fetch(
              `/api/generations?conversationId=${conversationId}&kind=video`,
            )
            const body = (await response.json()) as { items: { id: string; status: string }[] }
            return body.items.filter((item) => ids.includes(item.id) && item.status === 'completed')
              .length
          },
          { conversationId: conversationIdOf(page), ids },
        ),
      { timeout: 15_000 },
    )
    .toBe(ids.length)

/** 进对话、按镜头组出片、打开成片编辑器 */
const openWith = async (page: Page, shots: readonly number[]) => {
  await page.setViewportSize({ width: 1449, height: 982 })
  const panel = await openConversation(page, CONVERSATION)
  await addTakes(page, shots)
  await panel.getByRole('button', { name: '成片', exact: true }).click()
  const dialog = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('group', { name: '成片编辑器', exact: true }) })
  await expect(dialog).toBeVisible()
  const materials = dialog.getByRole('region', { name: '视频素材区' })
  // 镜头表读好了才有镜头按钮
  await expect(materials.getByRole('button', { name: /镜头 1，/ }).first()).toBeVisible()
  // 弹窗打开时从 95% 放大进场，量尺寸前等它放完
  await dialog.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  )
  return { dialog, materials }
}

const groupOf = (materials: Locator, index: number) =>
  materials.getByRole('group', { name: `镜头组 ${index}` })

const shotOf = (materials: Locator, group: number, take: string, shot: number) =>
  groupOf(materials, group).getByRole('button', {
    name: new RegExp(`^生成 ${take} 镜头 ${shot}，`),
  })

const filmLane = (dialog: Locator) => dialog.getByRole('group', { name: '画面轨', exact: true })

const previewVideo = (dialog: Locator) =>
  dialog.locator('video').evaluate((video: HTMLVideoElement) => ({
    paused: video.paused,
    time: Math.round(video.currentTime * 10) / 10,
  }))

/** 点刻度上某个时刻：播放位置滑块铺满整条时间区 */
const seek = async (page: Page, dialog: Locator, seconds: number) => {
  const ruler = dialog.getByRole('slider', { name: '时间线播放位置' })
  const box = await ruler.boundingBox()
  if (box === null) throw new Error('时间线尚未布局')
  const scale = Number(await ruler.getAttribute('max'))
  await page.mouse.click(box.x + (seconds / scale) * box.width + 1, box.y + box.height / 2)
}

const centerOf = async (locator: Locator) => {
  const box = await locator.boundingBox()
  if (box === null) throw new Error('元素尚未布局')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test('素材区滚动后能选择后面的镜头组与末尾镜头', async ({ page }) => {
  const { materials } = await openWith(page, [1, 1, 2, 2, 3])
  const last = shotOf(materials, 3, 'A', 6)
  await expect(last).not.toBeInViewport()
  await materials.hover()
  await page.mouse.wheel(0, 400)
  await expect(last).toBeInViewport()
  await last.click()
  const end = groupOf(materials, 3).getByRole('slider', { name: '裁剪该段结尾' })
  await expect(end).toBeInViewport()
  await end.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(end).toHaveAttribute('aria-valuenow', '5.9')
})

test('缩放成片时间线不会改变素材镜头的位置和大小', async ({ page }) => {
  const { dialog, materials } = await openWith(page, [1])
  const first = shotOf(materials, 1, 'A', 1)
  const last = shotOf(materials, 1, 'A', 6)
  const before = [await first.boundingBox(), await last.boundingBox()]
  await dialog.getByRole('button', { name: '放大时间线' }).click()
  await dialog.getByRole('button', { name: '放大时间线' }).click()
  expect([await first.boundingBox(), await last.boundingBox()]).toEqual(before)
})

test('素材暂停续播与段尾重播；点画面轨上的段播放，拖播放头返回成片', async ({ page }) => {
  const { dialog, materials } = await openWith(page, [1])
  const toolbar = dialog.getByRole('toolbar', { name: '剪辑工具' })
  const video = dialog.locator('video')
  const mediaTime = () => video.evaluate((element: HTMLVideoElement) => element.currentTime)
  const mediaPaused = () => video.evaluate((element: HTMLVideoElement) => element.paused)

  // 成片为空时也能暂停素材；选择非零入点，续播和重播都不能从文件开头播放。
  await shotOf(materials, 1, 'A', 2).click()
  expect(await mediaTime()).toBeGreaterThanOrEqual(1)
  await expect.poll(mediaTime).toBeGreaterThan(1.05)
  const pause = toolbar.getByRole('button', { name: '暂停', exact: true })
  await expect(pause).not.toHaveAttribute('aria-disabled', 'true')
  await pause.click()
  await expect(video).toBeVisible()
  await expect.poll(mediaPaused).toBe(true)
  const pausedAt = await mediaTime()
  await page.waitForTimeout(250)
  expect(await mediaTime()).toBeCloseTo(pausedAt, 2)
  await toolbar.getByRole('button', { name: '播放', exact: true }).click()
  expect(await mediaTime()).toBeGreaterThanOrEqual(pausedAt)
  await expect.poll(mediaTime).toBeGreaterThan(pausedAt + 0.05)
  await expect.poll(() => previewVideo(dialog)).toEqual({ paused: true, time: 2 })
  await toolbar.getByRole('button', { name: '播放', exact: true }).click()
  await expect.poll(mediaPaused).toBe(false)
  const restarted = await mediaTime()
  expect(restarted).toBeGreaterThanOrEqual(1)
  expect(restarted).toBeLessThan(2)

  // 扩成三秒选区再加入成片，给真实播放器留足观察播放和暂停的时间。
  const end = groupOf(materials, 1).getByRole('slider', { name: '裁剪该段结尾' })
  await end.focus()
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Enter')
  await expect(video).toHaveCount(0)
  const clip = filmLane(dialog).getByRole('button', { name: /^选中：第 1 段/ })
  await expect(clip).toBeVisible()
  const player = dialog.getByRole('region', { name: '预览' }).locator('hyperframes-player')
  await expect
    .poll(() =>
      player.evaluateAll(
        (elements) =>
          elements.length === 1 && (elements[0] as HTMLElement & { painted: boolean }).painted,
      ),
    )
    .toBe(true)

  // 成片已有内容时，暂停、继续仍然控制素材，不会偷偷切回成片。
  await groupOf(materials, 1)
    .getByRole('group', { name: /^选中的范围 1.0–4.0 秒/ })
    .click()
  await expect.poll(mediaTime).toBeGreaterThan(1.05)
  const snap = toolbar.getByRole('button', { name: '吸附', exact: true })
  const snapping = await snap.getAttribute('aria-pressed')
  await snap.focus()
  await page.keyboard.press('Space')
  await expect(video).toBeVisible()
  await expect.poll(mediaPaused).toBe(true)
  const materialPausedAt = await mediaTime()
  await page.keyboard.press('Space')
  await expect(snap).toHaveAttribute('aria-pressed', snapping ?? '')
  expect(await mediaTime()).toBeGreaterThanOrEqual(materialPausedAt)
  await expect.poll(mediaTime).toBeGreaterThan(materialPausedAt + 0.05)

  // 点画面轨上的段回到成片：只选中、不播放，播放头在段首；按播放从那里放
  await clip.click()
  await expect(video).toHaveCount(0)
  const playhead = dialog.getByRole('slider', { name: '时间线播放位置' })
  await expect(toolbar.getByRole('button', { name: '播放', exact: true })).toBeVisible()
  await expect(playhead).toHaveValue('0')
  await toolbar.getByRole('button', { name: '播放', exact: true }).click()
  await expect.poll(async () => Number(await playhead.inputValue())).toBeGreaterThan(0.2)
  await pause.click()
  await expect
    .poll(() => player.evaluate((element) => (element as HTMLElement & { paused: boolean }).paused))
    .toBe(true)
  // iframe 暂停后仍有末次报时；等它落地，再观察播放位置保持不变。
  await page.waitForTimeout(250)
  const filmPausedAt = Number(await playhead.inputValue())
  await page.waitForTimeout(250)
  expect(Number(await playhead.inputValue())).toBeCloseTo(filmPausedAt, 1)

  await shotOf(materials, 1, 'A', 5).click()
  await expect(video).toBeVisible()
  await seek(page, dialog, 0.5)
  await expect(video).toHaveCount(0)
  await expect.poll(async () => Number(await playhead.inputValue())).toBeCloseTo(0.5, 1)
})

test('选区两端拖动、←/→ 微调 0.1 秒、⇧ 1 秒；调的时候预览停在那一端的画面', async ({ page }) => {
  const { dialog, materials } = await openWith(page, [1])
  const label = dialog.getByText(/^素材 · 镜头组/)
  await shotOf(materials, 1, 'A', 2).click()
  const start = groupOf(materials, 1).getByRole('slider', { name: '裁剪该段开头' })
  const end = groupOf(materials, 1).getByRole('slider', { name: '裁剪该段结尾' })
  await expect(start).toHaveAttribute('aria-valuenow', '1')

  await start.focus()
  await page.keyboard.press('ArrowRight')
  await expect(start).toHaveAttribute('aria-valuenow', '1.1')
  await expect(label).toContainText('1.1 秒 · 选区 1.1–2.0')
  await expect.poll(() => previewVideo(dialog)).toEqual({ paused: true, time: 1.1 })
  // ⇧ 1 秒，但选区至少留 0.1 秒
  await page.keyboard.press('Shift+ArrowRight')
  await expect(start).toHaveAttribute('aria-valuenow', '1.9')
  await page.keyboard.press('Shift+ArrowLeft')
  await expect(start).toHaveAttribute('aria-valuenow', '0.9')

  // 拖结尾往右：预览停在结尾那一帧
  const third = await centerOf(shotOf(materials, 1, 'A', 3))
  const fourth = await centerOf(shotOf(materials, 1, 'A', 4))
  const from = await centerOf(end)
  const perSecond = fourth.x - third.x
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + perSecond * 1.5, from.y, { steps: 6 })
  await expect(label).toContainText('3.5 秒 · 选区 0.9–3.5')
  await expect.poll(() => previewVideo(dialog)).toEqual({ paused: true, time: 3.5 })
  await page.mouse.up()
  await expect(end).toHaveAttribute('aria-valuetext', '3.5 秒')
})

test('在选区里按下即拖整段选区，松手在画面轨上加入', async ({ page }) => {
  const { dialog, materials } = await openWith(page, [1])
  await shotOf(materials, 1, 'A', 2).click()
  const range = groupOf(materials, 1).getByRole('group', { name: /^选中的范围 1\.0–2\.0 秒/ })
  const from = await centerOf(range)
  const to = await centerOf(filmLane(dialog))
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
  await expect(
    filmLane(dialog).getByRole('group', { name: '第 1 段 · A · 镜头 2，1.0 秒' }),
  ).toBeVisible()
})

test('在选区外按下镜头即拖：先选中这个镜头再拖，松手加入，不放预览', async ({ page }) => {
  const { dialog, materials } = await openWith(page, [1, 1])
  const film = filmLane(dialog)
  const drop = async (shot: Locator) => {
    const from = await centerOf(shot)
    const to = await centerOf(film)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 8 })
    await page.mouse.up()
  }

  // 还没有选区：按下镜头 A5 直接拖
  await drop(shotOf(materials, 1, 'A', 5))
  await expect(film.getByRole('group', { name: '第 1 段 · A · 镜头 5，1.0 秒' })).toBeVisible()
  // 松手后补的那一下点按不算点镜头：预览留在成片
  await expect(dialog.getByText(/^素材 · 镜头组/)).toHaveCount(0)

  // 已经选中了 A 的镜头 2；在选区外的 B 镜头 3 上按下，拖走的是 B 镜头 3
  await shotOf(materials, 1, 'A', 2).click()
  await expect(dialog.getByText(/^素材 · 镜头组/)).toBeVisible()
  await drop(shotOf(materials, 1, 'B', 3))
  await expect(film.getByRole('group', { name: /^第 \d 段 · B · 镜头 3，1\.0 秒/ })).toBeVisible()
  await expect(
    groupOf(materials, 1).getByRole('group', { name: /^选中的范围 2\.0–3\.0 秒/ }),
  ).toBeVisible()
  await expect(dialog.getByText(/^素材 · 镜头组/)).toHaveCount(0)
})

test('撤销、重做也是成片编辑：预览回到成片', async ({ page }) => {
  const { dialog, materials } = await openWith(page, [1, 1])
  const film = filmLane(dialog)
  const label = dialog.getByText(/^素材 · 镜头组/)
  await shotOf(materials, 1, 'A', 1).click()
  await page.keyboard.press('Enter')
  await expect(film.getByRole('group', { name: /^第 1 段/ })).toBeVisible()

  await shotOf(materials, 1, 'B', 2).click()
  await expect(label).toBeVisible()
  await dialog.getByRole('button', { name: '撤销' }).click()
  await expect(label).toHaveCount(0)
  await expect(film.getByRole('group', { name: /^第 1 段/ })).toHaveCount(0)

  await shotOf(materials, 1, 'B', 4).click()
  await expect(label).toBeVisible()
  await dialog.getByRole('button', { name: '重做' }).click()
  await expect(label).toHaveCount(0)
  await expect(film.getByRole('group', { name: /^第 1 段/ })).toBeVisible()

  // 快捷键同样
  await shotOf(materials, 1, 'B', 3).click()
  await expect(label).toBeVisible()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(label).toHaveCount(0)
  await expect(film.getByRole('group', { name: /^第 1 段/ })).toHaveCount(0)
})

test('Enter 把选区插到播放头处：焦点在镜头、选区两端或不在任何控件上时', async ({ page }) => {
  const { dialog, materials } = await openWith(page, [1, 1])
  const film = filmLane(dialog)

  // 没选范围时说明原因
  await shotOf(materials, 1, 'A', 1).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText('先在下方点一个镜头选中范围')).toBeVisible()
  await expect(film.getByRole('group', { name: /^第 1 段/ })).toHaveCount(0)

  // 焦点在镜头上；点完立刻按：第一段要等画面尺寸读到（定画布），读到就插，不让人重按
  await shotOf(materials, 1, 'A', 1).click()
  await page.keyboard.press('Enter')
  await expect(film.getByRole('group', { name: '第 1 段 · A · 镜头 1，1.0 秒' })).toBeVisible()
  await expect(page.getByText(/画面尺寸/)).toHaveCount(0)

  // 焦点在选区一端上；播放头在 0 秒，插到最前面
  await seek(page, dialog, 0)
  await shotOf(materials, 1, 'B', 4).click()
  await groupOf(materials, 1).getByRole('slider', { name: '裁剪该段结尾' }).focus()
  await page.keyboard.press('Enter')
  await expect(film.getByRole('group', { name: '第 1 段 · B · 镜头 4，1.0 秒' })).toBeVisible()
  await expect(film.getByRole('group', { name: '第 2 段 · A · 镜头 1，1.0 秒' })).toBeVisible()

  // 焦点不在任何控件上（落在弹窗本身）
  await dialog.evaluate((element: HTMLElement) => element.focus())
  await page.keyboard.press('Enter')
  await expect(film.getByRole('group', { name: '第 1 段 · B · 镜头 4，1.0 秒' })).toBeVisible()
  await expect(film.getByRole('group', { name: /^第 3 段/ })).toBeVisible()
})

test('每条原作可以换版本；换了之后这条轨上的选区收起', async ({ page }) => {
  await page.setViewportSize({ width: 1449, height: 982 })
  const panel = await openConversation(page, CONVERSATION)
  const [take] = await addTakes(page, [1])
  if (take === undefined) throw new Error('没有出片')
  await composeVersion(page, take)
  await panel.getByRole('button', { name: '成片', exact: true }).click()
  const dialog = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('group', { name: '成片编辑器', exact: true }) })
  const materials = dialog.getByRole('region', { name: '视频素材区' })

  const picker = materials.getByRole('button', { name: /^生成 A的版本：/ })
  await expect(picker).toHaveAccessibleName('生成 A的版本：V1')
  await shotOf(materials, 1, 'A', 2).click()
  await expect(groupOf(materials, 1).getByRole('slider')).toHaveCount(2)
  await picker.click()
  await page.getByRole('menuitemradio', { name: '原片' }).click()
  await expect(picker).toHaveAccessibleName('生成 A的版本：原片')
  await expect(groupOf(materials, 1).getByRole('slider')).toHaveCount(0)
})
