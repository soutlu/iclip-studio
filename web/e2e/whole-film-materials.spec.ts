import { expect, test, type Locator, type Page } from '@playwright/test'
import { openConversation, screenshotBothThemes } from './helpers'

const SHOT_DIR = '../.artifacts/design-qa/whole-film-pr19'

/** 有分镜、还没有出片的演示对话；各用例按需给镜头组出片（mock 的成片 6 秒，每秒一个镜头） */
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

/** 进对话、按镜头组出片、打开整片编辑器 */
/** 用户屏幕与常见笔记本屏幕 */
const VIEWPORTS: readonly { width: number; height: number }[] = [
  { width: 1449, height: 982 },
  { width: 1440, height: 900 },
]

const openWith = async (
  page: Page,
  shots: readonly number[],
  viewport = { width: 1449, height: 982 },
) => {
  await page.setViewportSize(viewport)
  const panel = await openConversation(page, CONVERSATION)
  await addTakes(page, shots)
  await panel.getByRole('button', { name: '整片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /^编辑视频\s*整片/ })
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

const filmLane = (dialog: Locator) => dialog.getByRole('group', { name: '成片画面轨' })

/** 素材区可视区、页面与弹窗工作区的滚动尺寸 */
const areaMetrics = (materials: Locator) =>
  materials.evaluate((section) => {
    const body = section.querySelector('.wf-materials-body')
    const workspace = section.closest('.wf-workspace')
    if (!(body instanceof HTMLElement) || !(workspace instanceof HTMLElement))
      throw new Error('素材区尚未渲染')
    const root = document.documentElement
    return {
      height: body.clientHeight,
      top: Math.round(body.getBoundingClientRect().top),
      scrolls: body.scrollHeight > body.clientHeight,
      // 横向能不能滚：裁掉的透明点按区不算
      scrollsSideways:
        getComputedStyle(body).overflowX !== 'hidden' && body.scrollWidth > body.clientWidth,
      pageScrolls: root.scrollHeight > root.clientHeight,
      workspaceScrolls: workspace.scrollHeight > workspace.clientHeight,
    }
  })

const previewVideo = (dialog: Locator) =>
  dialog.locator('video.wf-material-video').evaluate((video: HTMLVideoElement) => ({
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

test('镜头组区域固定高度，镜头组多时在区域里上下滚动；轨道只放画面', async ({ page }) => {
  const { dialog, materials } = await openWith(page, [1, 1, 2, 2, 3])

  // 放下第一组的两条原作并露出下一组的组名
  const before = await areaMetrics(materials)
  expect(before).toMatchObject({
    height: 118,
    scrolls: true,
    scrollsSideways: false,
    pageScrolls: false,
    workspaceScrolls: false,
  })
  await expect(groupOf(materials, 1).getByText('生成 B')).toBeInViewport()
  await expect(groupOf(materials, 2).getByText('镜头组 2')).toBeInViewport()
  await expect(groupOf(materials, 3)).not.toBeInViewport()

  // 没有按钮行，也没有切换镜头组的下拉
  await expect(materials.getByRole('button', { name: /加入成片|镜头组/ })).toHaveCount(0)

  // 轨道 32 像素，镜头上不写字；组名、原作名与成片区轨名同字号
  const look = await materials.evaluate((section) => ({
    strips: [...section.querySelectorAll('.wf-take-strip')].map(
      (strip) => strip.getBoundingClientRect().height,
    ),
    shotText: [...section.querySelectorAll('.wf-shot')].map((shot) => shot.textContent).join(''),
    fonts: [
      ...new Set(
        [
          ...section.querySelectorAll('.wf-group-label, .wf-take-label'),
          ...document.querySelectorAll('.wf-track-head'),
        ].map((element) => getComputedStyle(element).fontSize),
      ),
    ],
  }))
  expect(new Set(look.strips)).toEqual(new Set([32]))
  expect(look.shotText).toBe('')
  expect(look.fonts).toHaveLength(1)

  // 素材轨与成片轨左端对齐
  const stripLeft = await materials.locator('.wf-take-strip').first().boundingBox()
  const filmLeft = await filmLane(dialog).boundingBox()
  expect(Math.round(stripLeft?.x ?? 0)).toBe(Math.round(filmLeft?.x ?? -1))

  await screenshotBothThemes(page, `${SHOT_DIR}/${page.viewportSize()?.width}-many-groups-top`)

  // 在区域里滚到底：后面的镜头组可以挑，区域高度与位置不变、页面不滚
  await materials.hover()
  await page.mouse.wheel(0, 400)
  await expect(groupOf(materials, 3)).toBeInViewport()
  await expect(shotOf(materials, 3, 'A', 6)).toBeInViewport()
  expect(await areaMetrics(materials)).toEqual({ ...before })
  await shotOf(materials, 3, 'A', 2).click()
  await expect(dialog.getByText('素材 · 镜头组 3 · 生成 A · 镜头 2')).toBeVisible()
  await expect.poll(() => previewVideo(dialog)).toEqual({ paused: true, time: 2 })
  await screenshotBothThemes(page, `${SHOT_DIR}/${page.viewportSize()?.width}-many-groups-scrolled`)

  // 选中轨道最右的镜头：结尾手柄不撑出横向滚动
  await shotOf(materials, 3, 'A', 6).click()
  const endHandle = groupOf(materials, 3).getByRole('slider', { name: '裁剪该段结尾' })
  await expect(endHandle).toBeVisible()
  expect(await areaMetrics(materials)).toEqual({ ...before })
  // 手柄看得见的部分整个在区域里，没被裁掉
  const handleBox = await endHandle.boundingBox()
  const bodyRight = await materials
    .locator('.wf-materials-body')
    .evaluate((body) => body.getBoundingClientRect().left + body.clientWidth)
  expect((handleBox?.x ?? 0) + (handleBox?.width ?? 0)).toBeLessThanOrEqual(bodyRight)
})

for (const viewport of VIEWPORTS)
  test(`${viewport.width}×${viewport.height}：下半按内容定高，预览占其余；特效轨加行时预览让出高度`, async ({
    page,
  }) => {
    const { dialog, materials } = await openWith(page, [1, 1, 2], viewport)
    const layout = () =>
      dialog.evaluate((element) => {
        const box = (selector: string) => {
          const found = element.querySelector(selector)
          if (found === null) throw new Error(`没有 ${selector}`)
          return found.getBoundingClientRect()
        }
        const root = document.documentElement
        return {
          preview: Math.round(box('.wf-preview').height),
          materials: Math.round(box('.wf-materials-body').height),
          // 素材轨下面到下半面板底边：只剩面板的内边距
          below: Math.round(box('.wf-timeline').bottom - box('.wf-materials-body').bottom),
          pageScrolls: root.scrollHeight > root.clientHeight,
        }
      })
    const before = await layout()
    expect(before).toMatchObject({ materials: 118, pageScrolls: false })
    expect(before.below).toBeLessThanOrEqual(12)

    await dialog.getByRole('tab', { name: '组件' }).click()
    const components = dialog.getByRole('list', { name: '组件' })
    await components.getByRole('button', { name: /^字标定格，包装轨/ }).click()
    await components.getByRole('button', { name: /^手绘箭头，包装轨/ }).click()
    await expect(dialog.getByRole('group', { name: /^特效 · 手绘箭头/ })).toBeVisible()
    const after = await layout()
    expect(after).toMatchObject({ materials: 118, pageScrolls: false })
    expect(after.below).toBeLessThanOrEqual(12)
    expect(after.preview).toBeLessThan(before.preview)
    await expect(materials).toBeInViewport()
  })

test('1 个镜头组时区域高度不变、不滚动', async ({ page }) => {
  const { materials } = await openWith(page, [1, 1])
  expect(await areaMetrics(materials)).toMatchObject({
    height: 118,
    scrolls: false,
    pageScrolls: false,
    workspaceScrolls: false,
  })
})

test('素材轨按自身时长铺满一行，缩放成片时间线不跟着变', async ({ page }) => {
  const { dialog, materials } = await openWith(page, [1])
  const strip = materials.locator('.wf-take-strip').first()
  const before = await strip.boundingBox()
  await dialog.getByRole('button', { name: '放大时间线' }).click()
  await dialog.getByRole('button', { name: '放大时间线' }).click()
  expect(await strip.boundingBox()).toEqual(before)
  const last = await shotOf(materials, 1, 'A', 6).boundingBox()
  // 最后一个镜头到轨道右端（镜头之间留 2 像素缝）
  expect(Math.round((last?.x ?? 0) + (last?.width ?? 0) + 2)).toBe(
    Math.round((before?.x ?? 0) + (before?.width ?? 0)),
  )
})

test('点镜头：预览切到这条素材并播放这个镜头，播完停在出点；播放、点成片轨、拖播放头都回到成片', async ({
  page,
}) => {
  const { dialog, materials } = await openWith(page, [1, 1])
  const label = dialog.locator('.wf-stage-label')
  // 成片里先有一段，工具条的播放才能用；加入成片也是成片编辑，预览回到成片
  await shotOf(materials, 1, 'A', 1).click()
  await expect(label).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(filmLane(dialog).getByRole('group', { name: /^第 1 段/ })).toBeVisible()
  await expect(label).toHaveCount(0)

  await shotOf(materials, 1, 'B', 2).click()
  await expect(label).toContainText('素材 · 镜头组 1 · 生成 B · 镜头 2')
  await expect(label).toContainText('选区 1.0–2.0')
  await expect(dialog.getByRole('button', { name: '暂停' })).toBeVisible()
  await expect(materials.locator('.wf-material-playhead')).toHaveCount(1)
  // 播完停在出点
  await expect
    .poll(() => previewVideo(dialog), { timeout: 5_000 })
    .toEqual({
      paused: true,
      time: 2,
    })
  await expect(label).toContainText('2.0 秒 · 选区 1.0–2.0')

  // 点播放：回到成片
  await dialog.getByRole('button', { name: '播放' }).click()
  await expect(label).toHaveCount(0)
  await expect(materials.locator('.wf-material-playhead')).toHaveCount(0)

  // 点成片轨上的段：回到成片
  await shotOf(materials, 1, 'A', 3).click()
  await expect(label).toBeVisible()
  await filmLane(dialog)
    .getByRole('button', { name: /^选中：第 1 段/ })
    .click()
  await expect(label).toHaveCount(0)

  // 点选区（不拖）：预览再放一遍这段选区；拖播放头：回到成片
  await groupOf(materials, 1)
    .getByRole('group', { name: /^选中的范围 2\.0–3\.0 秒/ })
    .click()
  await expect(label).toContainText('生成 A · 镜头 3')
  await seek(page, dialog, 0.5)
  await expect(label).toHaveCount(0)
})

test('选区两端拖动、←/→ 微调 0.1 秒、⇧ 1 秒；调的时候预览停在那一端的画面', async ({ page }) => {
  const { dialog, materials } = await openWith(page, [1])
  const label = dialog.locator('.wf-stage-label')
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
  const strip = await materials.locator('.wf-take-strip').first().boundingBox()
  const from = await centerOf(end)
  const perSecond = (strip?.width ?? 0) / 6
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + perSecond * 1.5, from.y, { steps: 6 })
  await expect(label).toContainText('3.5 秒 · 选区 0.9–3.5')
  await expect.poll(() => previewVideo(dialog)).toEqual({ paused: true, time: 3.5 })
  await page.mouse.up()
  await expect(end).toHaveAttribute('aria-valuetext', '3.5 秒')
})

test('在选区里按下即拖整段选区，松手在成片轨上加入', async ({ page }) => {
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
  await expect(dialog.locator('.wf-stage-label')).toHaveCount(0)

  // 已经选中了 A 的镜头 2；在选区外的 B 镜头 3 上按下，拖走的是 B 镜头 3
  await shotOf(materials, 1, 'A', 2).click()
  await expect(dialog.locator('.wf-stage-label')).toBeVisible()
  await drop(shotOf(materials, 1, 'B', 3))
  await expect(film.getByRole('group', { name: /^第 \d 段 · B · 镜头 3，1\.0 秒/ })).toBeVisible()
  await expect(
    groupOf(materials, 1).getByRole('group', { name: /^选中的范围 2\.0–3\.0 秒/ }),
  ).toBeVisible()
  await expect(dialog.locator('.wf-stage-label')).toHaveCount(0)
})

test('成片轨上用了的段在素材轨底边画一道', async ({ page }) => {
  const { dialog, materials } = await openWith(page, [1, 1])
  const laneOf = (take: 'A' | 'B') =>
    groupOf(materials, 1)
      .locator('.wf-take')
      .filter({ hasText: `生成 ${take}` })
  await expect(materials.locator('.wf-used')).toHaveCount(0)

  await shotOf(materials, 1, 'A', 2).click()
  await page.keyboard.press('Enter')
  await expect(filmLane(dialog).getByRole('group', { name: /^第 1 段/ })).toBeVisible()
  await expect(laneOf('A').locator('.wf-used')).toHaveCount(1)
  await expect(laneOf('B').locator('.wf-used')).toHaveCount(0)

  // 画在用了的那一段下面（镜头 2 = 1–2 秒，轨道 6 秒），贴着轨道底边
  const strip = await laneOf('A').locator('.wf-take-strip').boundingBox()
  const bar = await laneOf('A').locator('.wf-used').boundingBox()
  if (strip === null || bar === null) throw new Error('素材轨尚未布局')
  expect(bar.height).toBe(3)
  // 轨道宽按窗口来，换算成像素允许 1px 取整误差
  expect(Math.abs(bar.x - strip.x - (strip.width / 6 + 2))).toBeLessThanOrEqual(1)
  expect(Math.abs(bar.width - (strip.width / 6 - 4))).toBeLessThanOrEqual(1)
  expect(Math.round(strip.y + strip.height - (bar.y + bar.height))).toBe(1)

  // 同一段再放一次就再画一道；撤销后跟着少一道
  await page.keyboard.press('Enter')
  await expect(laneOf('A').locator('.wf-used')).toHaveCount(2)
  await dialog.getByRole('button', { name: '撤销' }).click()
  await expect(laneOf('A').locator('.wf-used')).toHaveCount(1)
})

test('撤销、重做也是成片编辑：预览回到成片', async ({ page }) => {
  const { dialog, materials } = await openWith(page, [1, 1])
  const film = filmLane(dialog)
  const label = dialog.locator('.wf-stage-label')
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
  await panel.getByRole('button', { name: '整片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /^编辑视频\s*整片/ })
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

for (const viewport of VIEWPORTS) {
  test(`验收截图 ${viewport.width}×${viewport.height}`, async ({ page }) => {
    const prefix = `${SHOT_DIR}/${viewport.width}`
    const { dialog, materials } = await openWith(page, [1, 1, 2, 2, 3], viewport)
    for (const [take, shot] of [
      ['A', 1],
      ['B', 2],
      ['A', 3],
    ] as const) {
      await shotOf(materials, 1, take, shot).click()
      await page.keyboard.press('Enter')
    }
    await expect(filmLane(dialog).getByRole('group', { name: /^第 3 段/ })).toBeVisible()
    await seek(page, dialog, 0)
    await page.mouse.move(viewport.width / 2, 30)
    await screenshotBothThemes(page, `${prefix}-1-initial`)

    // 点镜头：预览放素材
    await shotOf(materials, 1, 'B', 2).click()
    await expect(dialog.locator('.wf-stage-label')).toContainText('生成 B · 镜头 2')
    await page.mouse.move(viewport.width / 2, 30)
    await screenshotBothThemes(page, `${prefix}-11-material-preview`)

    // 拖选区开头：预览停在开头那一帧
    const start = groupOf(materials, 1).getByRole('slider', { name: '裁剪该段开头' })
    const from = await centerOf(start)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x - 60, from.y, { steps: 4 })
    await screenshotBothThemes(page, `${prefix}-11b-handle-drag`)
    await page.mouse.up()
  })

  test(`验收截图 ${viewport.width}×${viewport.height}：1 个镜头组`, async ({ page }) => {
    await openWith(page, [1, 1], viewport)
    await page.mouse.move(viewport.width / 2, 30)
    await screenshotBothThemes(page, `${SHOT_DIR}/${viewport.width}-2-one-take`)
  })
}
