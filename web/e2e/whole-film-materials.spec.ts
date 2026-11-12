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
  return { dialog, materials, panel }
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

  await page.keyboard.press('Enter')
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
  // 有了块以后下面多出一条空行，这一行会往上挪：每次拖之前重新量它在哪
  const carryTo = async (x: number) => {
    const from = await centerOf(range)
    const { y } = await centerOf(row)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 10, from.y - 10, { steps: 3 })
    await page.mouse.move(x, y, { steps: 8 })
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

test('时间线上的块：拖着挪动、拖把手裁剪、按 Delete 删掉，都能撤销', async ({ page }) => {
  const { dialog, materials } = await openWith(page, [1])
  const row = dialog.getByRole('group', { name: '第 1 行' })
  for (const [at, shot] of [1, 3].entries()) {
    await shotOf(materials, 1, 'A', shot).click()
    await page.keyboard.press('Enter')
    await expect.poll(() => savedBlocks(page)).toHaveLength(at + 1)
  }
  await readyPlayer(dialog)
  const second = row.locator('[data-block-id]').nth(1)
  const timingOf = async (at: number) => {
    const saved = (await savedBlocks(page))[at] ?? ''
    const [, start, duration] = /，([\d.]+) 秒起，([\d.]+) 秒$/.exec(saved) ?? []
    return { start: Number(start), duration: Number(duration) }
  }
  const dragBy = async (locator: Locator, dx: number) => {
    const { x, y } = await centerOf(locator)
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + dx, y, { steps: 6 })
    await page.mouse.up()
  }

  await dragBy(second, 200)
  await expect.poll(async () => (await timingOf(1)).start).toBeGreaterThan(2)
  expect(await timingOf(1)).toMatchObject({ duration: 1 })
  expect(await timingOf(0)).toEqual({ start: 0, duration: 1 })
  const movedTo = (await timingOf(1)).start

  await second.getByRole('button').click()
  await dragBy(row.getByRole('slider', { name: '裁剪开头' }), 20)
  await expect.poll(async () => (await timingOf(1)).duration).toBeLessThan(1)
  const trimmed = await timingOf(1)
  expect(trimmed.start + trimmed.duration).toBeCloseTo(movedTo + 1, 2)

  // 选中着按 Esc 只取消选中，不关编辑器
  await expect(second.getByRole('button')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  await expect(second.getByRole('button')).toHaveAttribute('aria-pressed', 'false')
  await expect(dialog).toBeVisible()

  await second.getByRole('button').click()
  await page.keyboard.press('Delete')
  await expect.poll(() => savedBlocks(page)).toEqual(['A · 镜头 1，0 秒起，1 秒'])

  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => savedBlocks(page)).toHaveLength(2)
  expect(await timingOf(1)).toEqual(trimmed)
})

test('吸附：拖到别的块旁边会贴上去并画出吸附线，关掉就不贴；空档上点右键可以合拢', async ({
  page,
}) => {
  const { dialog, materials } = await openWith(page, [1])
  const row = dialog.getByRole('group', { name: '第 1 行' })
  const toolbar = dialog.getByRole('toolbar', { name: '剪辑工具' })
  for (const [at, shot] of [1, 3].entries()) {
    await shotOf(materials, 1, 'A', shot).click()
    await page.keyboard.press('Enter')
    await expect.poll(() => savedBlocks(page)).toHaveLength(at + 1)
  }
  await readyPlayer(dialog)
  const first = row.locator('[data-block-id]').nth(0)
  const second = row.locator('[data-block-id]').nth(1)
  const boxOf = async (locator: Locator) => {
    const box = await locator.boundingBox()
    if (box === null) throw new Error('块尚未布局')
    return box
  }
  const secondStart = async () => {
    const saved = (await savedBlocks(page))[1] ?? ''
    return Number(/，([\d.]+) 秒起，/.exec(saved)?.[1])
  }
  /** 拖着第二个块，让它的左边停在 `left` 这个横坐标上；`settle` 在松手前执行。 */
  const dragSecondTo = async (left: number, settle?: () => Promise<void>) => {
    const box = await boxOf(second)
    const y = box.y + box.height / 2
    await page.mouse.move(box.x + 10, y)
    await page.mouse.down()
    await page.mouse.move(left + 10, y, { steps: 8 })
    await settle?.()
    await page.mouse.up()
  }
  // 一秒长的块画出来比一秒的宽度少 2 像素，所以第一个块的结尾在它右边再加 2
  const firstEnd = async () => {
    const box = await boxOf(first)
    return box.x + box.width + 2
  }

  await dragSecondTo((await firstEnd()) + 300)
  await expect.poll(secondStart).toBeGreaterThan(2)

  await dragSecondTo((await firstEnd()) + 5, () =>
    expect(dialog.getByTestId('snap-guide')).toBeVisible(),
  )
  await expect.poll(secondStart).toBe(1)
  await expect(dialog.getByTestId('snap-guide')).toHaveCount(0)

  await toolbar.getByRole('button', { name: '吸附' }).click()
  await dragSecondTo((await firstEnd()) + 5)
  await expect.poll(secondStart).toBeGreaterThan(1)
  expect(await secondStart()).toBeLessThan(1.3)

  await dragSecondTo((await firstEnd()) + 300)
  await expect.poll(secondStart).toBeGreaterThan(2)
  const gapX = (await firstEnd()) + 150
  const rowBox = await boxOf(row)
  await page.mouse.click(gapX, rowBox.y + rowBox.height / 2, { button: 'right' })
  await page.getByRole('menuitem', { name: '合拢这个空档' }).click()
  await expect.poll(secondStart).toBe(1)

  // 没有空档了：再点右键不出菜单
  await page.mouse.click(gapX + 200, rowBox.y + rowBox.height / 2, { button: 'right' })
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('换行：把块拖到最下面的空行新开一行，再拖回去；镜头也能直接拖进新的一行', async ({ page }) => {
  const { dialog, materials } = await openWith(page, [1])
  const firstRow = dialog.getByRole('group', { name: '第 1 行' })
  const secondRow = dialog.getByRole('group', { name: '第 2 行' })
  const newRow = dialog.getByRole('group', { name: '新的一行' })
  for (const [at, shot] of [1, 3].entries()) {
    await shotOf(materials, 1, 'A', shot).click()
    await page.keyboard.press('Enter')
    await expect.poll(() => savedBlocks(page)).toHaveLength(at + 1)
  }
  await readyPlayer(dialog)
  /** 存下来的成片里每个块在第几行，按文件里的先后。 */
  const savedRows = () =>
    page.evaluate(async (conversationId) => {
      const response = await fetch(`/api/conversations/${conversationId}/whole-film/draft`)
      const { html } = (await response.json()) as { html: string | null }
      return [...(html ?? '').matchAll(/<video [^>]*data-track-index="(\d+)"/g)].map(([, track]) =>
        Number(track),
      )
    }, conversationIdOf(page))
  const middleY = async (locator: Locator) => (await centerOf(locator)).y
  const dragTo = async (from: Locator, y: number) => {
    const { x, y: fromY } = await centerOf(from)
    await page.mouse.move(x, fromY)
    await page.mouse.down()
    await page.mouse.move(x, y, { steps: 8 })
    await page.mouse.up()
  }

  await expect(secondRow).toHaveCount(0)
  await dragTo(firstRow.locator('[data-block-id]').nth(1), await middleY(newRow))
  // 下面一行的块在文件里写在前面，上面的行才盖得住它
  await expect.poll(savedRows).toEqual([1, 0])
  await expect(secondRow.locator('[data-block-id]')).toHaveCount(1)
  await expect(firstRow.locator('[data-block-id]')).toHaveCount(1)

  await dragTo(secondRow.locator('[data-block-id]'), await middleY(firstRow))
  await expect.poll(savedRows).toEqual([0, 0])
  await expect(secondRow).toHaveCount(0)

  await shotOf(materials, 1, 'A', 4).click()
  const range = groupOf(materials, 1).getByRole('group', { name: /^选中的范围/ })
  const from = await centerOf(range)
  const target = await centerOf(newRow)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 10, from.y - 10, { steps: 3 })
  await page.mouse.move(target.x, target.y, { steps: 8 })
  await expect(newRow.getByTestId('drop-ghost')).toBeVisible()
  await page.mouse.up()
  await expect.poll(savedRows).toEqual([1, 0, 0])
  await expect(secondRow.locator('[data-block-id]')).toHaveCount(1)
})

test('行头的眼睛：隐藏这一行以后预览里不出画面，存下来的成片带着隐藏标记；再点显示回来', async ({
  page,
}) => {
  const { dialog, materials } = await openWith(page, [1])
  await shotOf(materials, 1, 'A', 1).click()
  await page.keyboard.press('Enter')
  await expect.poll(() => savedBlocks(page)).toHaveLength(1)
  await readyPlayer(dialog)
  // 改动成片后预览会换一个播放器，换的那一下新旧两个都在：看后来的那个
  const picture = dialog
    .getByRole('region', { name: '预览' })
    .locator('hyperframes-player')
    .last()
    .frameLocator('iframe')
    .locator('video.picture')
  /** 存下来的成片里有几个隐藏的块。 */
  const savedHidden = () =>
    page.evaluate(async (conversationId) => {
      const response = await fetch(`/api/conversations/${conversationId}/whole-film/draft`)
      const { html } = (await response.json()) as { html: string | null }
      return (html ?? '').match(/<video data-hidden=""/g)?.length ?? 0
    }, conversationIdOf(page))
  await expect(picture).not.toHaveCSS('display', 'none')

  await dialog.getByRole('button', { name: '隐藏第 1 行' }).click()
  await expect.poll(savedHidden).toBe(1)
  await expect(picture).toHaveCSS('display', 'none')
  await expect(dialog.getByRole('group', { name: /，已隐藏$/ })).toHaveCount(1)

  const eye = dialog.getByRole('button', { name: '显示第 1 行' })
  await expect(eye).toHaveAttribute('aria-pressed', 'false')
  await eye.click()
  await expect.poll(savedHidden).toBe(0)
  await expect(picture).not.toHaveCSS('display', 'none')
})

test('行多了只有轨道区上下滚：素材区留在面板底部，行头跟着各行走，看不见的行落不上去', async ({
  page,
}) => {
  const ROWS = 10
  const { dialog, materials, panel } = await openWith(page, [1])
  await shotOf(materials, 1, 'A', 1).click()
  await page.keyboard.press('Enter')
  await expect.poll(() => savedBlocks(page)).toHaveLength(1)
  await dialog.getByRole('button', { name: '关闭成片编辑' }).click()
  await expect(dialog).toBeHidden()
  // 把这一块复制到每一行上，直接存成草稿
  await page.evaluate(
    async ({ conversationId, rows }) => {
      const path = `/api/conversations/${conversationId}/whole-film/draft`
      const { revision, html } = (await (await fetch(path)).json()) as {
        revision: number
        html: string
      }
      const video = /<video [^>]*><\/video>/.exec(html)?.[0] ?? ''
      const id = /\sid="([^"]+)"/.exec(video)?.[1] ?? ''
      const copies = Array.from({ length: rows }, (_, row) =>
        video
          .replaceAll(`"${id}"`, `"${id}-${row}"`)
          .replace('data-track-index="0"', `data-track-index="${row}"`),
      )
      const response = await fetch(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision, html: html.replace(video, copies.join('\n')) }),
      })
      if (!response.ok) throw new Error(`存草稿失败：${response.status}`)
    },
    { conversationId: conversationIdOf(page), rows: ROWS },
  )
  await page.setViewportSize({ width: 1440, height: 900 })
  await panel.getByRole('button', { name: '成片', exact: true }).click()
  await expect(dialog.getByRole('group', { name: `第 ${ROWS} 行` })).toHaveCount(1)
  await readyPlayer(dialog)

  const boxOf = async (locator: Locator) => {
    const box = await locator.boundingBox()
    if (box === null) throw new Error('元素尚未布局')
    return box
  }
  const tracks = dialog.locator('.wf-tracks')
  const workspace = dialog.getByRole('group', { name: '成片编辑器', exact: true })
  expect(await workspace.evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0)
  expect((await boxOf(dialog.getByRole('region', { name: '预览' }))).height).toBeGreaterThanOrEqual(
    220,
  )
  const materialsBox = await boxOf(materials)
  expect(materialsBox.y + materialsBox.height).toBeLessThanOrEqual(900)
  expect(await tracks.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)

  const tops = (locator: Locator) =>
    locator.evaluateAll((elements) =>
      elements.map((element) => Math.round(element.getBoundingClientRect().top)),
    )
  for (const share of [0.5, 1]) {
    await tracks.evaluate((element, share) => {
      element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) * share)
    }, share)
    // 时间尺留在顶上，每个行头和它那一行对齐
    const tracksBox = await boxOf(tracks)
    const rulerBox = await boxOf(tracks.locator('.timeline-ruler'))
    expect(Math.abs(rulerBox.y - tracksBox.y)).toBeLessThan(1)
    expect(await tops(tracks.locator('.wf-track-head'))).toEqual(
      await tops(tracks.locator('.wf-lane:not(.is-new)')),
    )
  }
  const newRow = dialog.getByRole('group', { name: '新的一行' })
  const newRowBox = await boxOf(newRow)
  const tracksBox = await boxOf(tracks)
  expect(newRowBox.y + newRowBox.height).toBeLessThanOrEqual(tracksBox.y + tracksBox.height)

  // 滚回顶上：最下面几行被裁在素材区那一截里，镜头在素材区里拖着不会落到看不见的行上
  await tracks.evaluate((element) => {
    element.scrollTop = 0
  })
  await shotOf(materials, 1, 'A', 3).click()
  const range = groupOf(materials, 1).getByRole('group', { name: /^选中的范围/ })
  const from = await centerOf(range)
  // 拖到的地方底下确实压着一条被裁掉的行
  const behind = await tracks.locator('[data-track]').evaluateAll(
    (lanes, y) =>
      lanes.some((lane) => {
        const { top, bottom } = lane.getBoundingClientRect()
        return y - 4 >= top && y - 4 <= bottom
      }),
    from.y,
  )
  expect(behind).toBe(true)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 40, from.y - 4, { steps: 4 })
  await expect(dialog.getByTestId('drop-ghost')).toHaveCount(0)
  // 滚到底再拖进最下面那条空行：新开第 ROWS + 1 行
  await tracks.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  const target = await centerOf(newRow)
  await page.mouse.move(target.x, target.y, { steps: 8 })
  await expect(newRow.getByTestId('drop-ghost')).toBeVisible()
  await page.mouse.up()
  await expect(dialog.getByRole('group', { name: `第 ${ROWS + 1} 行` })).toHaveCount(1)
})

test('在两行之间、最上面新开一行：块拖到两行中间的缝里，镜头拖到第一行上面，别的行跟着改行号', async ({
  page,
}) => {
  const { dialog, materials } = await openWith(page, [1])
  const row = (number: number) => dialog.getByRole('group', { name: `第 ${number} 行` })
  const newRow = dialog.getByRole('group', { name: '新的一行' })
  const opening = dialog.locator('.wf-lane.is-opening')
  for (const [at, shot] of [1, 3, 4].entries()) {
    await shotOf(materials, 1, 'A', shot).click()
    await page.keyboard.press('Enter')
    await expect.poll(() => savedBlocks(page)).toHaveLength(at + 1)
  }
  await readyPlayer(dialog)
  /** 存下来的成片里每个块在第几行，写成「名字@行号」，按名字排。 */
  const savedTracks = () =>
    page.evaluate(async (conversationId) => {
      const response = await fetch(`/api/conversations/${conversationId}/whole-film/draft`)
      const { html } = (await response.json()) as { html: string | null }
      return [
        ...(html ?? '').matchAll(/<video [^>]*data-label="([^"]*)"[^>]*data-track-index="(\d+)"/g),
      ]
        .map(([, label, track]) => `${label}@${track}`)
        .toSorted()
    }, conversationIdOf(page))
  const boxOf = async (locator: Locator) => {
    const box = await locator.boundingBox()
    if (box === null) throw new Error('元素尚未布局')
    return box
  }
  const dragTo = async (from: Locator, y: number) => {
    const start = await centerOf(from)
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x, y, { steps: 8 })
  }

  // 先把第三个块拖到最下面的空行，成两行
  await dragTo(row(1).locator('[data-block-id]').nth(2), (await centerOf(newRow)).y)
  await page.mouse.up()
  await expect.poll(savedTracks).toEqual(['A · 镜头 1@0', 'A · 镜头 3@0', 'A · 镜头 4@1'])

  // 第二个块拖到两行中间的缝里：那里先让出一行，松手后它自己占第 2 行，原来的第 2 行排到第 3 行
  const first = await boxOf(row(1))
  const second = await boxOf(row(2))
  await dragTo(row(1).locator('[data-block-id]').nth(1), (first.y + first.height + second.y) / 2)
  await expect(opening).toHaveCount(1)
  await page.mouse.up()
  await expect(opening).toHaveCount(0)
  await expect.poll(savedTracks).toEqual(['A · 镜头 1@0', 'A · 镜头 3@1', 'A · 镜头 4@2'])
  await expect(row(3).locator('[data-block-id]')).toHaveCount(1)

  // 独占一行的块在自己这一行上面的缝里横着挪：还是这一行，不让出空行，隐藏着的也照旧隐藏
  await dialog.getByRole('button', { name: '隐藏第 2 行' }).click()
  const lone = row(2).locator('[data-block-id]')
  await expect(lone).toHaveAccessibleName(/已隐藏$/)
  const before = (await savedBlocks(page)).find((saved) => saved.startsWith('A · 镜头 3'))
  const grab = await centerOf(lone)
  const upper = await boxOf(row(1))
  const seam = (upper.y + upper.height + (await boxOf(row(2))).y) / 2
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(grab.x + 160, seam, { steps: 8 })
  await expect(opening).toHaveCount(0)
  await page.mouse.up()
  await expect
    .poll(async () => (await savedBlocks(page)).find((saved) => saved.startsWith('A · 镜头 3')))
    .not.toBe(before)
  expect(await savedTracks()).toEqual(['A · 镜头 1@0', 'A · 镜头 3@1', 'A · 镜头 4@2'])
  await expect(row(2).locator('[data-block-id]')).toHaveAccessibleName(/已隐藏$/)

  // 镜头拖到第一行上面（指针停在时间尺上也算）：新开的一行排在最上面，别的行都往后排一号
  await shotOf(materials, 1, 'A', 2).click()
  const range = groupOf(materials, 1).getByRole('group', { name: /^选中的范围/ })
  const from = await centerOf(range)
  const top = await boxOf(row(1))
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 10, from.y - 10, { steps: 3 })
  await page.mouse.move(top.x + 200, top.y - 12, { steps: 8 })
  await expect(opening.getByTestId('drop-ghost')).toBeVisible()
  await page.mouse.up()
  await expect
    .poll(savedTracks)
    .toEqual(['A · 镜头 1@1', 'A · 镜头 2@0', 'A · 镜头 3@2', 'A · 镜头 4@3'])
  await expect(row(4).locator('[data-block-id]')).toHaveCount(1)
})

test('多选：Shift 点选两个块一起删掉再撤销回来；框选跨两行；点空白处取消；] 选中播放头右边的块；缩放到选中', async ({
  page,
}) => {
  const { dialog, materials } = await openWith(page, [1])
  const firstRow = dialog.getByRole('group', { name: '第 1 行' })
  const secondRow = dialog.getByRole('group', { name: '第 2 行' })
  const toolbar = dialog.getByRole('toolbar', { name: '剪辑工具' })
  for (const [at, shot] of [1, 3, 4].entries()) {
    await shotOf(materials, 1, 'A', shot).click()
    await page.keyboard.press('Enter')
    await expect.poll(() => savedBlocks(page)).toHaveLength(at + 1)
  }
  await readyPlayer(dialog)
  const blockOf = (shot: number) =>
    dialog.getByRole('button', { name: new RegExp(`^选中：A · 镜头 ${shot}，`) })
  /** 选中着的块是哪几个镜头，按行、再按时间先后。 */
  const selectedShots = () =>
    dialog
      .getByRole('button', { name: /^选中：/, pressed: true })
      .evaluateAll((buttons) =>
        buttons.map((button) => Number(/镜头 (\d+)，/.exec(button.ariaLabel ?? '')?.[1])),
      )
  const boxOf = async (locator: Locator) => {
    const box = await locator.boundingBox()
    if (box === null) throw new Error('元素尚未布局')
    return box
  }

  // Shift 点选两个块，按 Delete 一起删掉；撤销一步两个都回来
  const before = await savedBlocks(page)
  await blockOf(1).click()
  await blockOf(4).click({ modifiers: ['Shift'] })
  await expect.poll(selectedShots).toEqual([1, 4])
  await page.keyboard.press('Delete')
  await expect.poll(() => savedBlocks(page)).toEqual(['A · 镜头 3，0 秒起，1 秒'])
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => savedBlocks(page)).toEqual(before)

  // 镜头 4 挪到新的一行，时间不变
  const four = await centerOf(blockOf(4))
  await page.mouse.move(four.x, four.y)
  await page.mouse.down()
  await page.mouse.move(
    four.x,
    (await centerOf(dialog.getByRole('group', { name: '新的一行' }))).y,
    {
      steps: 8,
    },
  )
  await page.mouse.up()
  await expect(secondRow.getByRole('button', { name: /^选中：A · 镜头 4，/ })).toHaveCount(1)

  // 从第一行右边的空白处往左下拖到第二行：框住镜头 3 的后半段和第二行的镜头 4，拖着时就显示选中
  const rowBox = await boxOf(firstRow)
  const from = { x: rowBox.x + rowBox.width - 30, y: rowBox.y + rowBox.height / 2 }
  const to = { x: (await centerOf(blockOf(3))).x, y: (await centerOf(secondRow)).y }
  const frameFromTo = async () => {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 8 })
    await expect(dialog.getByTestId('marquee')).toBeVisible()
  }
  // 框选中途按 Esc：只取消这次框选，原来的选中不变，编辑器还开着
  await blockOf(1).click()
  await frameFromTo()
  await expect.poll(selectedShots).toEqual([3, 4])
  await page.keyboard.press('Escape')
  await expect(dialog.getByTestId('marquee')).toHaveCount(0)
  await page.mouse.up()
  await expect.poll(selectedShots).toEqual([1])
  await expect(dialog).toBeVisible()

  await frameFromTo()
  await expect.poll(selectedShots).toEqual([3, 4])
  await page.mouse.up()
  await expect(dialog.getByTestId('marquee')).toHaveCount(0)
  await expect.poll(selectedShots).toEqual([3, 4])

  // 点空白处：全部取消
  await page.mouse.click(from.x, from.y)
  await expect.poll(selectedShots).toEqual([])

  // 框选完焦点不在块上，Delete 照样删掉选中的块
  await frameFromTo()
  await page.mouse.up()
  await expect.poll(selectedShots).toEqual([3, 4])
  await page.keyboard.press('Delete')
  await expect.poll(() => savedBlocks(page)).toEqual(['A · 镜头 1，0 秒起，1 秒'])
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await savedBlocks(page)).sort()).toEqual([...before].sort())

  // 点时间尺只挪播放头、不动选中；] 选中播放头右边的块，跨着播放头的镜头 3 也算
  await blockOf(1).click()
  const ruler = dialog.getByRole('slider', { name: '时间线播放位置' })
  const rulerBox = await boxOf(ruler)
  await page.mouse.click(to.x, rulerBox.y + rulerBox.height / 2)
  await expect.poll(selectedShots).toEqual([1])
  await page.keyboard.press(']')
  await expect.poll(selectedShots).toEqual([3, 4])

  // 缩放到选中：读数变成百分比；镜头 3 到镜头 4 这一段完整露出，起点离时间区左边 24 像素
  await expect(toolbar.getByText('适应', { exact: true })).toBeVisible()
  const fitted = await boxOf(firstRow)
  await toolbar.getByRole('button', { name: '缩放到选中的块' }).click()
  await expect(toolbar.getByText(/^\d+%$/)).toBeVisible()
  const start = await boxOf(blockOf(3))
  const end = await boxOf(blockOf(4))
  expect(Math.abs(start.x - fitted.x - 24)).toBeLessThan(1.5)
  expect(end.x + end.width).toBeLessThan(fitted.x + fitted.width - 16)
  // 放大以后时间尺的刻度跟着变密：这一屏里至少看得见两个刻度数字
  const shownTicks = await dialog.locator('.wf-tracks').evaluate((tracks) => {
    const view = tracks.getBoundingClientRect()
    return [...tracks.querySelectorAll('.timeline-tick')].filter((tick) => {
      const { left, right } = tick.getBoundingClientRect()
      return left >= view.left && right <= view.right
    }).length
  })
  expect(shownTicks).toBeGreaterThanOrEqual(2)
})

test('成组挪动、成组裁剪：选中的块挪同一个时间差，挡住时整组停下，一起裁同一端；没选中的块只挪它自己；Esc 取消拖动', async ({
  page,
}) => {
  const { dialog, materials } = await openWith(page, [1])
  const secondRow = dialog.getByRole('group', { name: '第 2 行' })
  for (const [at, shot] of [1, 3, 4].entries()) {
    await shotOf(materials, 1, 'A', shot).click()
    await page.keyboard.press('Enter')
    await expect.poll(() => savedBlocks(page)).toHaveLength(at + 1)
  }
  await readyPlayer(dialog)
  const blockName = (shot: number) => new RegExp(`^选中：A · 镜头 ${shot}，`)
  const blockOf = (shot: number) => dialog.getByRole('button', { name: blockName(shot) })
  // 块的外框（含两端的把手），里面是选中它的按钮
  const clipOf = (shot: number) =>
    dialog
      .locator('[data-block-id]')
      .filter({ has: page.getByRole('button', { name: blockName(shot) }) })
  const selectedShots = () =>
    dialog
      .getByRole('button', { name: /^选中：/, pressed: true })
      .evaluateAll((buttons) =>
        buttons.map((button) => Number(/镜头 (\d+)，/.exec(button.ariaLabel ?? '')?.[1])),
      )
  const boxOf = async (locator: Locator) => {
    const box = await locator.boundingBox()
    if (box === null) throw new Error('元素尚未布局')
    return box
  }
  type Placed = { start: number; duration: number; track: number }
  /** 存下来的成片里每个镜头在哪：键是镜头号，时间按秒。 */
  const savedLayout = () =>
    page.evaluate(async (conversationId) => {
      const response = await fetch(`/api/conversations/${conversationId}/whole-film/draft`)
      const { html } = (await response.json()) as { html: string | null }
      const read = (tag: string, name: string) =>
        new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? ''
      return Object.fromEntries(
        [...(html ?? '').matchAll(/<video [^>]*>/g)].map(([tag]) => [
          Number(/镜头 (\d+)/.exec(read(tag, 'data-label'))?.[1]),
          {
            start: Number(read(tag, 'data-start')),
            duration: Number(read(tag, 'data-duration')),
            track: Number(read(tag, 'data-track-index')),
          },
        ]),
      )
    }, conversationIdOf(page))
  const placedOf = (layout: Record<number, Placed>, shot: number) => {
    const placed = layout[shot]
    if (placed === undefined) throw new Error(`成片里没有镜头 ${shot}`)
    return placed
  }
  /** 存下来的成片里同一行的块没有在时间上重叠的。 */
  const expectNoOverlap = async () => {
    const blocks = Object.values(await savedLayout())
    for (const block of blocks)
      for (const other of blocks) {
        if (other === block || other.track !== block.track) continue
        const overlapping =
          block.start < other.start + other.duration && other.start < block.start + block.duration
        expect(overlapping).toBe(false)
      }
  }
  const dragBy = async (locator: Locator, dx: number, dy = 0) => {
    const { x, y } = await centerOf(locator)
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + dx, y + dy, { steps: 6 })
    await page.mouse.up()
  }

  // 镜头 4 挪到新的一行，时间不变：第一行是 1、3，第二行是 4
  await dragBy(
    blockOf(4),
    0,
    (await centerOf(dialog.getByRole('group', { name: '新的一行' }))).y -
      (await centerOf(blockOf(4))).y,
  )
  await expect(secondRow.getByRole('button', { name: /^选中：A · 镜头 4，/ })).toHaveCount(1)
  await expect.poll(async () => placedOf(await savedLayout(), 4).track).toBe(1)
  // 一秒长的块画出来比一秒的宽度少 2 像素
  const pps = (await boxOf(clipOf(1))).width + 2

  // 选中不同行的 3 和 4，拖 4 往后一秒：两个挪一样的量，各自留在原来的行；撤销一步都回来
  const before = await savedLayout()
  await blockOf(3).click()
  await blockOf(4).click({ modifiers: ['Shift'] })
  await dragBy(blockOf(4), pps)
  await expect
    .poll(async () => placedOf(await savedLayout(), 4).start)
    .toBeGreaterThan(placedOf(before, 4).start + 0.5)
  const moved = await savedLayout()
  const delta = placedOf(moved, 4).start - placedOf(before, 4).start
  expect(placedOf(moved, 3).start - placedOf(before, 3).start).toBeCloseTo(delta, 3)
  expect(placedOf(moved, 3).track).toBe(placedOf(before, 3).track)
  expect(placedOf(moved, 4).track).toBe(placedOf(before, 4).track)
  expect(placedOf(moved, 1)).toEqual(placedOf(before, 1))
  expect(await selectedShots()).toEqual([3, 4])
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(savedLayout).toEqual(before)

  // 拖 4 到第一行上面、往后半秒：4 新开最上面一行，3 留在原来那一行（行号跟着往后排）挪一样的量；撤销一步都回来
  const topRow = await boxOf(dialog.getByRole('group', { name: '第 1 行' }))
  const lifted = await centerOf(blockOf(4))
  await page.mouse.move(lifted.x, lifted.y)
  await page.mouse.down()
  await page.mouse.move(lifted.x + pps / 2, topRow.y - 12, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => placedOf(await savedLayout(), 4).track).toBe(0)
  const opened = await savedLayout()
  const raised = placedOf(opened, 4).start - placedOf(before, 4).start
  expect(raised).toBeGreaterThan(0.3)
  expect(placedOf(opened, 3).start - placedOf(before, 3).start).toBeCloseTo(raised, 3)
  expect(placedOf(opened, 3).track).toBe(1)
  expect(placedOf(opened, 1)).toEqual({ ...placedOf(before, 1), track: 1 })
  await expectNoOverlap()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(savedLayout).toEqual(before)

  // 拖动中按 Esc：块回到原处，什么都不写，选中不变，编辑器还开着
  const resting = await boxOf(clipOf(3))
  const grab = await centerOf(blockOf(4))
  const count = await dialog.locator('[data-block-id]').count()
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(grab.x + pps, grab.y, { steps: 6 })
  await expect.poll(async () => (await boxOf(clipOf(3))).x).toBeGreaterThan(resting.x + pps / 2)
  // 拖动中按 Delete、撤销都不生效：成片这时被改，松手会按改之前算好的位置写回去
  await page.keyboard.press('Delete')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(dialog.locator('[data-block-id]')).toHaveCount(count)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  expect((await boxOf(clipOf(3))).x).toBeCloseTo(resting.x, 0)
  await expect.poll(selectedShots).toEqual([3, 4])
  await expect(dialog).toBeVisible()
  expect(await savedLayout()).toEqual(before)

  // 选中 1 和 4，拖没选中的 3 往后半秒：只挪它自己，选中不变
  await blockOf(1).click()
  await blockOf(4).click({ modifiers: ['Shift'] })
  await dragBy(blockOf(3), pps / 2)
  await expect
    .poll(async () => placedOf(await savedLayout(), 3).start)
    .toBeGreaterThan(placedOf(before, 3).start + 0.3)
  const lone = await savedLayout()
  expect(placedOf(lone, 1)).toEqual(placedOf(before, 1))
  expect(placedOf(lone, 4)).toEqual(placedOf(before, 4))
  expect(await selectedShots()).toEqual([1, 4])

  // 再拖 4 往后 0.9 秒：1 会压到 3，整组停在 1 贴着 3 的地方
  await dragBy(blockOf(4), pps * 0.9)
  await expect
    .poll(async () => placedOf(await savedLayout(), 4).start)
    .not.toBe(placedOf(lone, 4).start)
  const stopped = await savedLayout()
  const shift = placedOf(stopped, 1).start - placedOf(lone, 1).start
  expect(placedOf(stopped, 4).start - placedOf(lone, 4).start).toBeCloseTo(shift, 3)
  expect(shift).toBeLessThan(0.8)
  expect(placedOf(stopped, 1).start + placedOf(stopped, 1).duration).toBeCloseTo(
    placedOf(stopped, 3).start,
    1,
  )
  await expectNoOverlap()

  // 选中同一行相邻的 1 和 3，拖 3 的结尾把手往前 0.3 秒：两个一起收短一样的量
  await blockOf(1).click()
  await blockOf(3).click({ modifiers: ['Shift'] })
  await dragBy(clipOf(3).getByRole('slider', { name: '裁剪结尾' }), -pps * 0.3)
  await expect
    .poll(async () => placedOf(await savedLayout(), 3).duration)
    .toBeLessThan(placedOf(stopped, 3).duration - 0.1)
  const shortened = await savedLayout()
  const cut = placedOf(stopped, 3).duration - placedOf(shortened, 3).duration
  expect(placedOf(stopped, 1).duration - placedOf(shortened, 1).duration).toBeCloseTo(cut, 3)
  expect(placedOf(shortened, 1).start).toBe(placedOf(stopped, 1).start)
  expect(placedOf(shortened, 3).start).toBe(placedOf(stopped, 3).start)

  // 再往后拉一秒：1 的结尾被 3 挡住，两个只一起拉长到 1 贴着 3
  await dragBy(clipOf(3).getByRole('slider', { name: '裁剪结尾' }), pps)
  await expect
    .poll(async () => placedOf(await savedLayout(), 3).duration)
    .toBeGreaterThan(placedOf(shortened, 3).duration)
  const stretched = await savedLayout()
  const grown = placedOf(stretched, 3).duration - placedOf(shortened, 3).duration
  expect(placedOf(stretched, 1).duration - placedOf(shortened, 1).duration).toBeCloseTo(grown, 3)
  expect(placedOf(stretched, 1).start + placedOf(stretched, 1).duration).toBeCloseTo(
    placedOf(stretched, 3).start,
    1,
  )
  await expectNoOverlap()
})
