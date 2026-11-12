import { expect, test, type Locator, type Page } from '@playwright/test'
import { openConversation } from './helpers'

const CONVERSATION = '无图分镜草稿'

const conversationIdOf = (page: Page) => new URL(page.url()).pathname.split('/').at(-1) ?? ''

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
  await expect(materials.getByRole('button', { name: /镜头 1，/ }).first()).toBeVisible()
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

/** 存下来的成片里的画面块，写成「名字，从几秒起，多长」。 */
const savedBlocks = (page: Page) =>
  page.evaluate(async (conversationId) => {
    const response = await fetch(`/api/conversations/${conversationId}/whole-film/draft`)
    const { html } = (await response.json()) as { html: string | null }
    const blocks = (html ?? '').matchAll(
      /<video [^>]*data-label="([^"]*)"[^>]*data-start="([^"]*)" data-duration="([^"]*)"/g,
    )
    return [...blocks].map(
      ([, label, start, duration]) => `${label}，${start} 秒起，${duration} 秒`,
    )
  }, conversationIdOf(page))

const readyPlayer = async (dialog: Locator) => {
  const player = dialog.getByRole('region', { name: '预览' }).locator('hyperframes-player')
  await expect
    .poll(() =>
      player.evaluateAll(
        (elements) =>
          elements.length === 1 && (elements[0] as HTMLElement & { painted: boolean }).painted,
      ),
    )
    .toBe(true)
}

const previewVideo = (dialog: Locator) =>
  dialog.locator('video').evaluate((video: HTMLVideoElement) => ({
    paused: video.paused,
    time: Math.round(video.currentTime * 10) / 10,
  }))

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
  const end = groupOf(materials, 3).getByRole('slider', { name: '裁剪结尾' })
  await expect(end).toBeInViewport()
  await end.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(end).toHaveAttribute('aria-valuenow', '5.9')
})

test('点镜头只选中、预览停在开头不播放；素材暂停续播与段尾重播；加入成片后预览换成成片', async ({
  page,
}) => {
  const { dialog, materials } = await openWith(page, [1])
  const transport = dialog.getByRole('group', { name: '播放控制' })
  const video = dialog.locator('video')
  const mediaTime = () => video.evaluate((element: HTMLVideoElement) => element.currentTime)
  const mediaPaused = () => video.evaluate((element: HTMLVideoElement) => element.paused)
  const play = transport.getByRole('button', { name: '播放', exact: true })

  await shotOf(materials, 1, 'A', 2).click()
  await expect.poll(() => previewVideo(dialog)).toEqual({ paused: true, time: 1 })
  await expect(play).toBeVisible()
  await page.waitForTimeout(250)
  expect(await previewVideo(dialog)).toEqual({ paused: true, time: 1 })

  await play.click()
  expect(await mediaTime()).toBeGreaterThanOrEqual(1)
  await expect.poll(mediaTime).toBeGreaterThan(1.05)
  const pause = transport.getByRole('button', { name: '暂停', exact: true })
  await expect(pause).not.toHaveAttribute('aria-disabled', 'true')
  await pause.click()
  await expect(video).toBeVisible()
  await expect.poll(mediaPaused).toBe(true)
  const pausedAt = await mediaTime()
  await page.waitForTimeout(250)
  expect(await mediaTime()).toBeCloseTo(pausedAt, 2)
  await transport.getByRole('button', { name: '播放', exact: true }).click()
  expect(await mediaTime()).toBeGreaterThanOrEqual(pausedAt)
  await expect.poll(mediaTime).toBeGreaterThan(pausedAt + 0.05)
  await expect.poll(() => previewVideo(dialog)).toEqual({ paused: true, time: 2 })
  await transport.getByRole('button', { name: '播放', exact: true }).click()
  await expect.poll(mediaPaused).toBe(false)
  const restarted = await mediaTime()
  expect(restarted).toBeGreaterThanOrEqual(1)
  expect(restarted).toBeLessThan(2)

  const end = groupOf(materials, 1).getByRole('slider', { name: '裁剪结尾' })
  await end.focus()
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Enter')
  await expect(video).toHaveCount(0)
  await expect.poll(() => savedBlocks(page)).toEqual(['A · 镜头 2，0 秒起，3 秒'])
  await readyPlayer(dialog)

  await groupOf(materials, 1)
    .getByRole('group', { name: /^选中的范围 1.0–4.0 秒/ })
    .click()
  await expect(
    groupOf(materials, 1).getByRole('group', { name: /^选中的范围 2\.0–3\.0 秒，1 个镜头/ }),
  ).toBeVisible()
  await expect.poll(() => previewVideo(dialog)).toEqual({ paused: true, time: 2 })

  await dialog.evaluate((element: HTMLElement) => element.focus())
  await page.keyboard.press('Space')
  await expect(video).toBeVisible()
  await expect.poll(mediaTime).toBeGreaterThan(2.05)
  await page.keyboard.press('Space')
  await expect.poll(mediaPaused).toBe(true)
  const materialPausedAt = await mediaTime()
  await page.waitForTimeout(250)
  expect(await mediaTime()).toBeCloseTo(materialPausedAt, 2)
})

test('选区两端拖动、←/→ 微调 0.1 秒、⇧ 1 秒；调的时候预览停在那一端的画面', async ({ page }) => {
  const { dialog, materials } = await openWith(page, [1])
  const label = dialog.getByText(/^素材 · 镜头组/)
  await shotOf(materials, 1, 'A', 2).click()
  const start = groupOf(materials, 1).getByRole('slider', { name: '裁剪开头' })
  const end = groupOf(materials, 1).getByRole('slider', { name: '裁剪结尾' })
  await expect(start).toHaveAttribute('aria-valuenow', '1')

  await start.focus()
  await page.keyboard.press('ArrowRight')
  await expect(start).toHaveAttribute('aria-valuenow', '1.1')
  await expect(label).toContainText('1.1 秒 · 选区 1.1–2.0')
  await expect.poll(() => previewVideo(dialog)).toEqual({ paused: true, time: 1.1 })
  await page.keyboard.press('Shift+ArrowRight')
  await expect(start).toHaveAttribute('aria-valuenow', '1.9')
  await page.keyboard.press('Shift+ArrowLeft')
  await expect(start).toHaveAttribute('aria-valuenow', '0.9')

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

test('选区里的播放头只在素材播放时出现：点镜头、暂停、拖抓手松手后都没有', async ({ page }) => {
  const { dialog, materials } = await openWith(page, [1])
  const transport = dialog.getByRole('group', { name: '播放控制' })
  const playhead = groupOf(materials, 1).getByTestId('material-playhead')
  const end = groupOf(materials, 1).getByRole('slider', { name: '裁剪结尾' })

  await shotOf(materials, 1, 'A', 2).click()
  await expect(dialog.locator('video')).toBeVisible()
  await expect(playhead).toHaveCount(0)

  await end.focus()
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await expect(end).toHaveAttribute('aria-valuetext', '4.0 秒')
  await transport.getByRole('button', { name: '播放', exact: true }).click()
  await expect(playhead).toBeVisible()
  await transport.getByRole('button', { name: '暂停', exact: true }).click()
  await expect(playhead).toHaveCount(0)

  const third = await centerOf(shotOf(materials, 1, 'A', 3))
  const fourth = await centerOf(shotOf(materials, 1, 'A', 4))
  const from = await centerOf(end)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + (fourth.x - third.x), from.y, { steps: 6 })
  await expect(end).toHaveAttribute('aria-valuetext', '5.0 秒')
  await expect(playhead).toHaveCount(0)
  await page.mouse.up()
  await expect(end).toHaveAttribute('aria-valuetext', '5.0 秒')
  await expect(playhead).toHaveCount(0)
})

test('Shift 选连着的几个镜头：不播放；在选区上单击只选那个镜头、Shift 点去掉一端；两端抓手不越过镜头边界，加入成片时一个镜头一块', async ({
  page,
}) => {
  const { dialog, materials } = await openWith(page, [1])
  const group = groupOf(materials, 1)
  const range = group.getByRole('group', { name: /^选中的范围/ })
  const toolbar = dialog.getByRole('toolbar', { name: '剪辑工具' })
  const transport = dialog.getByRole('group', { name: '播放控制' })
  const clickAt = async (locator: Locator, shift = false) => {
    const { x, y } = await centerOf(locator)
    if (shift) await page.keyboard.down('Shift')
    await page.mouse.click(x, y)
    if (shift) await page.keyboard.up('Shift')
  }

  await shotOf(materials, 1, 'A', 2).click()
  await shotOf(materials, 1, 'A', 3).click({ modifiers: ['Shift'] })
  await shotOf(materials, 1, 'A', 4).click({ modifiers: ['Shift'] })
  await expect(range).toHaveAccessibleName(/^选中的范围 1\.0–4\.0 秒，3 个镜头/)
  await expect.poll(() => previewVideo(dialog)).toEqual({ paused: true, time: 1 })
  await expect(transport.getByRole('button', { name: '播放', exact: true })).toBeVisible()

  await clickAt(shotOf(materials, 1, 'A', 3))
  await expect(range).toHaveAccessibleName(/^选中的范围 2\.0–3\.0 秒，1 个镜头/)
  await expect.poll(() => previewVideo(dialog)).toEqual({ paused: true, time: 2 })
  await shotOf(materials, 1, 'A', 2).click({ modifiers: ['Shift'] })
  await shotOf(materials, 1, 'A', 4).click({ modifiers: ['Shift'] })
  await expect(range).toHaveAccessibleName(/^选中的范围 1\.0–4\.0 秒，3 个镜头/)

  await clickAt(shotOf(materials, 1, 'A', 4), true)
  await expect(range).toHaveAccessibleName(/^选中的范围 1\.0–3\.0 秒，2 个镜头/)
  await expect(shotOf(materials, 1, 'A', 4)).toHaveAttribute('aria-pressed', 'false')
  await shotOf(materials, 1, 'A', 4).click({ modifiers: ['Shift'] })
  await expect(range).toHaveAccessibleName(/^选中的范围 1\.0–4\.0 秒，3 个镜头/)

  const start = group.getByRole('slider', { name: '裁剪开头' })
  const end = group.getByRole('slider', { name: '裁剪结尾' })
  await start.focus()
  await page.keyboard.press('Shift+ArrowRight')
  await expect(start).toHaveAttribute('aria-valuenow', '1.9')
  await page.keyboard.press('Shift+ArrowLeft')
  await expect(start).toHaveAttribute('aria-valuenow', '0.9')
  await end.focus()
  await page.keyboard.press('Shift+ArrowLeft')
  await expect(end).toHaveAttribute('aria-valuenow', '3.1')
  for (let step = 0; step < 4; step += 1) await page.keyboard.press('ArrowRight')
  await expect(end).toHaveAttribute('aria-valuenow', '3.5')

  await toolbar.getByRole('button', { name: '加入成片' }).click()
  await expect
    .poll(() => savedBlocks(page))
    .toEqual([
      'A · 镜头 1，0 秒起，1.1 秒',
      'A · 镜头 3，1.1 秒起，1 秒',
      'A · 镜头 4，2.1 秒起，0.5 秒',
    ])
})

test('撤销、重做也是成片编辑：预览回到成片', async ({ page }) => {
  const { dialog, materials } = await openWith(page, [1, 1])
  const label = dialog.getByText(/^素材 · 镜头组/)
  await shotOf(materials, 1, 'A', 1).click()
  await page.keyboard.press('Enter')
  await expect.poll(() => savedBlocks(page)).toHaveLength(1)

  await shotOf(materials, 1, 'B', 2).click()
  await expect(label).toBeVisible()
  await dialog.getByRole('button', { name: '撤销' }).click()
  await expect(label).toHaveCount(0)
  await expect.poll(() => savedBlocks(page)).toHaveLength(0)

  await shotOf(materials, 1, 'B', 4).click()
  await expect(label).toBeVisible()
  await dialog.getByRole('button', { name: '重做' }).click()
  await expect(label).toHaveCount(0)
  await expect.poll(() => savedBlocks(page)).toHaveLength(1)

  await shotOf(materials, 1, 'B', 3).click()
  await expect(label).toBeVisible()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(label).toHaveCount(0)
  await expect.poll(() => savedBlocks(page)).toHaveLength(0)
})

test('Enter 把选区接在成片末尾：焦点在镜头、选区两端或不在任何控件上时', async ({ page }) => {
  const { dialog, materials } = await openWith(page, [1, 1])

  await shotOf(materials, 1, 'A', 1).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText('先在下方点一个镜头选中范围')).toBeVisible()
  expect(await savedBlocks(page)).toEqual([])

  await shotOf(materials, 1, 'A', 1).click()
  await page.keyboard.press('Enter')
  await expect.poll(() => savedBlocks(page)).toEqual(['A · 镜头 1，0 秒起，1 秒'])
  await expect(page.getByText(/画面尺寸/)).toHaveCount(0)

  await shotOf(materials, 1, 'B', 4).click()
  await groupOf(materials, 1).getByRole('slider', { name: '裁剪结尾' }).focus()
  await page.keyboard.press('Enter')
  await expect
    .poll(() => savedBlocks(page))
    .toEqual(['A · 镜头 1，0 秒起，1 秒', 'B · 镜头 4，1 秒起，1 秒'])

  await dialog.evaluate((element: HTMLElement) => element.focus())
  await page.keyboard.press('Enter')
  await expect.poll(() => savedBlocks(page)).toHaveLength(3)
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
  await expect(picker).toHaveAccessibleName('生成 A的版本：V2')
  await shotOf(materials, 1, 'A', 2).click()
  await expect(groupOf(materials, 1).getByRole('slider')).toHaveCount(2)
  await picker.click()
  await page.getByRole('menuitemradio', { name: 'V1 原片' }).click()
  await expect(picker).toHaveAccessibleName('生成 A的版本：V1 原片')
  await expect(groupOf(materials, 1).getByRole('slider')).toHaveCount(0)
})

test('把镜头拖进时间线：落在指针的位置；压在别的块上时挪到它后面', async ({ page }) => {
  const { dialog, materials } = await openWith(page, [1])
  const row = dialog.getByRole('group', { name: '第 1 行' })
  const range = groupOf(materials, 1).getByRole('group', { name: /^选中的范围/ })
  const lane = await row.boundingBox()
  if (lane === null) throw new Error('时间线尚未布局')
  const laneY = lane.y + lane.height / 2
  const carryTo = async (x: number) => {
    const from = await centerOf(range)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 10, from.y - 10, { steps: 3 })
    await page.mouse.move(x, laneY, { steps: 8 })
  }
  const blockBox = async (at: number) => {
    const box = await row.locator('[data-block-id]').nth(at).boundingBox()
    if (box === null) throw new Error('块尚未布局')
    return box
  }

  await shotOf(materials, 1, 'A', 2).click()
  const dropX = lane.x + lane.width * 0.3
  await carryTo(dropX)
  await expect(row.getByTestId('drop-ghost')).toBeVisible()
  await page.mouse.up()
  await expect(row.getByTestId('drop-ghost')).toHaveCount(0)
  await expect.poll(() => savedBlocks(page)).toHaveLength(1)
  const first = await blockBox(0)
  expect(Math.abs(first.x - dropX)).toBeLessThan(3)

  await shotOf(materials, 1, 'A', 4).click()
  await carryTo(first.x + first.width / 2)
  await page.mouse.up()
  await expect.poll(() => savedBlocks(page)).toHaveLength(2)
  const second = await blockBox(1)
  expect(Math.abs(second.x - (first.x + first.width))).toBeLessThan(4)

  await shotOf(materials, 1, 'A', 5).click()
  const outside = await centerOf(dialog.getByRole('region', { name: '预览' }))
  const from = await centerOf(range)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(outside.x, outside.y, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  expect(await savedBlocks(page)).toHaveLength(2)
})
