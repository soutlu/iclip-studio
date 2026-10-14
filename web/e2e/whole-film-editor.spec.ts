/// <reference lib="dom" />

import { expect, test, type Locator, type Page } from '@playwright/test'
import { openConversation, screenshotBothThemes } from './helpers'

const SHOT_DIR = '../.artifacts/design-qa/whole-film-editor/impl-1'
/** mock 受理识别后 3 秒出结果。 */
const STEP_TIMEOUT = 15_000

/** 演示对话里：第 2 组一条竖版 6 秒成片（识别出三句口播），第 3 组一条横版成片（识别失败）。 */
const openWholeFilm = async (page: Page, { mobile = false } = {}) => {
  const panel = await openConversation(page, '夜景延时素材生成', { mobile })
  await panel.getByRole('button', { name: '整片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /^编辑视频\s*整片/ })
  await expect(dialog).toBeVisible()
  await expect(page).toHaveURL(/[?&]wholeFilm=true/)
  return dialog
}

const timelineOf = (dialog: Locator) =>
  dialog.getByRole('region', { name: '整片时间线', exact: true })
const segments = (dialog: Locator) => timelineOf(dialog).getByRole('button', { name: /^第 \d+ 段/ })
const laneOf = (dialog: Locator, name: string) =>
  timelineOf(dialog).getByRole('button', { name: new RegExp(`^${name} 素材`) })

/** 时间线上某个时刻的横坐标：刻度上的播放位置滑块铺满整条轨道。 */
const xAt = async (dialog: Locator, clock: number) => {
  const ruler = dialog.getByRole('slider', { name: '时间线播放位置' })
  const box = await ruler.boundingBox()
  if (box === null) throw new Error('时间线尚未布局')
  const scale = Number(await ruler.getAttribute('max'))
  return box.x + (clock / scale) * box.width
}

const middleY = async (locator: Locator) => {
  const box = await locator.boundingBox()
  if (box === null) throw new Error('元素尚未布局')
  return box.y + box.height / 2
}

/** 在素材轨上从 `from` 秒拖到 `to` 秒，框出一截。 */
const sweep = async (page: Page, dialog: Locator, lane: Locator, from: number, to: number) => {
  const y = await middleY(lane)
  await page.mouse.move(await xAt(dialog, from), y)
  await page.mouse.down()
  await page.mouse.move(await xAt(dialog, to), y, { steps: 6 })
  await page.mouse.up()
}

/** 按住素材上 `at` 秒处（选区里）拖到成片轨的 `clock` 秒处，不松手；返回松手的函数。 */
const carryToFilm = async (
  page: Page,
  dialog: Locator,
  lane: Locator,
  at: number,
  clock: number,
) => {
  await page.mouse.move(await xAt(dialog, at), await middleY(lane))
  await page.mouse.down()
  await page.mouse.move(await xAt(dialog, clock), await middleY(dialog.getByTestId('film-lane')), {
    steps: 8,
  })
  return () => page.mouse.up()
}

/** 从「添加视频」或控制条的「添加」→「视频」选一版放进素材区。 */
const addMaterial = async (page: Page, dialog: Locator, name: string) => {
  const inline = dialog.getByRole('button', { name: '添加视频', exact: true })
  if (await inline.isVisible()) {
    await inline.click()
  } else {
    await dialog.getByRole('button', { name: '添加', exact: true }).click()
    await page.getByRole('menuitem', { name: '视频', exact: true }).click()
  }
  await page.getByRole('menuitem', { name: new RegExp(`^${name}`) }).click()
}

test('整片：空时间线起步，从两条素材挑段交叉剪辑，字幕跟着段走，改字、重新识别', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const dialog = await openWholeFilm(page)
  await expect(timelineOf(dialog).getByText('从下方素材轨拖选片段放到这里')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '合成成片' })).toBeDisabled()
  await page.mouse.move(0, 0)
  await screenshotBothThemes(page, `${SHOT_DIR}/new`)

  await dialog.getByRole('button', { name: '添加视频', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: /^镜头组 2 V1/ })).toBeVisible()
  await screenshotBothThemes(page, `${SHOT_DIR}/new-add-video`)
  await page.getByRole('menuitem', { name: /^镜头组 2 V1/ }).click()
  await addMaterial(page, dialog, '镜头组 3 V1')
  const shot2 = laneOf(dialog, '镜头组 2 · V1')
  const shot3 = laneOf(dialog, '镜头组 3 · V1')
  await expect(shot2).toBeVisible()
  await expect(shot3).toBeVisible()

  // 在第 2 组素材上框出 1–3 秒，拖到成片轨。
  await sweep(page, dialog, shot2, 1, 3)
  await expect(timelineOf(dialog).getByText(/^素材 1\.\d\d–3\.\d\d 秒/)).toBeVisible()
  await screenshotBothThemes(page, `${SHOT_DIR}/pick`)
  const drop = await carryToFilm(page, dialog, shot2, 2, 0)
  await expect(timelineOf(dialog).getByText(/^插入到 0\.00 秒/)).toBeVisible()
  await screenshotBothThemes(page, `${SHOT_DIR}/pick-drag`)
  await drop()
  await expect(segments(dialog)).toHaveCount(1)

  // 键盘：第 3 组整条选中后改成 0–2 秒，回车插到播放头处（第 1 段之后）。
  await shot3.focus()
  await page.keyboard.press('Enter')
  const end = dialog.getByRole('slider', { name: '选区结尾' })
  await end.focus()
  for (let step = 0; step < 20; step += 1) {
    if (Number(await end.getAttribute('aria-valuenow')) <= 2) break
    await page.keyboard.press('ArrowLeft')
  }
  await page.keyboard.press('Enter')
  await expect(segments(dialog)).toHaveCount(2)

  // 再从第 2 组挑 4–5.6 秒放到最后。
  await sweep(page, dialog, shot2, 4, 5.6)
  const last = await carryToFilm(page, dialog, shot2, 4.8, 20)
  await last()
  await expect(segments(dialog)).toHaveCount(3)
  await expect(segments(dialog).nth(1)).toHaveAccessibleName(/^第 2 段 · 镜头组 3 · V1/)

  // 字幕：第 2 组的段带着口播，第 3 组那段识别失败、可重试。
  const subtitles = timelineOf(dialog).getByRole('button', { name: /^第 \d+ 条字幕/ })
  await expect(subtitles.first()).toBeVisible()
  const retry = timelineOf(dialog).getByRole('button', { name: '镜头组 3 · V1 字幕识别失败，重试' })
  await expect(retry).toBeVisible()
  await page.keyboard.press('Escape')
  // 播放头拖到 0.5 秒：预览里按统一样式显示这一刻的字幕。
  const ruler = dialog.getByRole('slider', { name: '时间线播放位置' })
  await page.mouse.click(await xAt(dialog, 0.5), await middleY(ruler))
  await expect(
    dialog.getByLabel('视频预览').getByText('这只包今天第一次上身', { exact: true }),
  ).toBeVisible()
  await page.mouse.move(0, 0)
  await screenshotBothThemes(page, `${SHOT_DIR}/subtitle`)

  // 选中一段：卡只说来源与时长。
  await segments(dialog).nth(1).click()
  const segmentCard = dialog.getByRole('region', { name: '选中的段' })
  await expect(segmentCard.getByText('声音在合成时统一处理')).toBeVisible()
  await screenshotBothThemes(page, `${SHOT_DIR}/cross-selected`)

  // 换版本菜单向上展开。
  await timelineOf(dialog).getByRole('button', { name: '镜头组 2 当前用 V1，换版本' }).click()
  await expect(page.getByRole('menuitemradio', { name: /V1/ })).toBeVisible()
  await screenshotBothThemes(page, `${SHOT_DIR}/cross-version`)
  await page.keyboard.press('Escape')

  // 改字：只能改字，存在草稿里。
  await subtitles.first().click()
  const subtitleCard = dialog.getByRole('region', { name: '选中的字幕' })
  await expect(subtitleCard.getByText('来自镜头组 2 · V1 的口播')).toBeVisible()
  const text = subtitleCard.getByRole('textbox', { name: '字幕文字' })
  await text.fill('今天第一次背这只包')
  await expect(subtitles.first()).toHaveAccessibleName('第 1 条字幕：今天第一次背这只包')
  await screenshotBothThemes(page, `${SHOT_DIR}/subtitle-edit`)
  await page.keyboard.press('Escape')

  // 重新识别：先「识别中」，结果回来后字幕出现。
  await retry.click()
  await expect(timelineOf(dialog).getByText('识别中')).toBeVisible()
  await page.mouse.move(0, 0)
  await screenshotBothThemes(page, `${SHOT_DIR}/subtitle-pending`)
  await expect(timelineOf(dialog).getByText('识别中')).toBeHidden({ timeout: STEP_TIMEOUT })

  // 草稿只存在浏览器：刷新后（mock 的登录随页面清掉，重新登录）重开，还是这份。
  await page.reload()
  const reopened = await openWholeFilm(page)
  await expect(segments(reopened)).toHaveCount(3)
  await expect(
    timelineOf(reopened).getByRole('button', { name: '第 1 条字幕：今天第一次背这只包' }),
  ).toBeVisible()
})

test('整片放不下时不插入：插入线变虚、说明还差多少', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openConversation(page, '夜景延时素材生成')
  const conversationId = new URL(page.url()).pathname.split('/').at(-1) ?? ''
  // 预先放满 117 秒：第 2 组那条成片的 0–3.9 秒放 30 次。
  await page.evaluate(
    ({ key }) => {
      const source = '5b2f3071-0b2f-4d30-8d9c-2e3f4a5b6c7d'
      window.localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          segments: Array.from({ length: 30 }, (_, at) => ({
            id: `s${at}`,
            sourceJobId: source,
            start: 0,
            end: 3.9,
            origin: [0, 3.9],
          })),
          texts: {},
          manual: [],
          lanes: [{ groupId: 'shot-2', jobId: source }],
        }),
      )
    },
    { key: `whole-film-draft:${conversationId}` },
  )
  const dialog = await openWholeFilm(page)
  await expect(segments(dialog)).toHaveCount(30)
  const shot2 = laneOf(dialog, '镜头组 2 · V1')
  await sweep(page, dialog, shot2, 0, 5)
  const drop = await carryToFilm(page, dialog, shot2, 2.5, 30)
  await expect(timelineOf(dialog).getByText(/^整片最长 120 秒，放不下这 \d\.\d 秒$/)).toBeVisible()
  await screenshotBothThemes(page, `${SHOT_DIR}/pick-limit`)
  await drop()
  await expect(segments(dialog)).toHaveCount(30)
  await expect(
    dialog.getByText(/^整片已有 117\.0 秒，放不下这 \d\.\d 秒；请先删减成片轨上的段$/),
  ).toBeVisible()
})

test('整片移动布局：对话框内部自己滚，页面不横向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const dialog = await openWholeFilm(page, { mobile: true })
  await addMaterial(page, dialog, '镜头组 2 V1')
  await laneOf(dialog, '镜头组 2 · V1').focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await expect(segments(dialog)).toHaveCount(1)
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
  await page.mouse.move(0, 0)
  await screenshotBothThemes(page, `${SHOT_DIR}/mobile`)
})
