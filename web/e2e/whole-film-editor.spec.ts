/// <reference lib="dom" />

import { expect, test, type Locator, type Page } from '@playwright/test'
import type {
  GenerationsPageOut,
  VideoGenerationIn,
  VideoSubmitOut,
} from '../src/shared/api/generated/types.gen'
import { openConversation, screenshotBothThemes } from './helpers'

const SHOT_DIR = '../.artifacts/design-qa/whole-film-editor/impl-1'
/** mock 受理识别后 3 秒出结果。 */
const STEP_TIMEOUT = 15_000
const BRAND_SHOT_DIR = '../.artifacts/design-qa/brand-font-editor'
const INTERACTION_SHOT_DIR = '../.artifacts/design-qa/whole-film-preview-drag'

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

/** 从素材区末尾的加号选一版放进素材区。 */
const addMaterial = async (page: Page, dialog: Locator, name: string) => {
  await dialog.getByRole('button', { name: '添加镜头组', exact: true }).click()
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

  await dialog.getByRole('button', { name: '添加镜头组', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: /^镜头组 2 V1/ })).toBeVisible()
  await page.getByRole('menuitem', { name: /^镜头组 2 V1/ }).click()
  await addMaterial(page, dialog, '镜头组 3 V1')
  const shot2 = laneOf(dialog, '镜头组 2 · V1')
  const shot3 = laneOf(dialog, '镜头组 3 · V1')
  await expect(shot2).toBeVisible()
  await expect(shot3).toBeVisible()

  // 在第 2 组素材上框出 1–3 秒，拖到成片轨。
  await sweep(page, dialog, shot2, 1, 3)
  await expect(timelineOf(dialog).getByText(/^素材 1\.\d\d–3\.\d\d 秒/)).toBeVisible()
  const drop = await carryToFilm(page, dialog, shot2, 2, 0)
  await expect(timelineOf(dialog).getByText(/^插入到 0\.00 秒/)).toBeVisible()
  await drop()
  await expect(segments(dialog)).toHaveCount(1)
  // 时间线拖拽不能留下浏览器文字选区，后续拖动会被原生文字拖拽截走。
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')

  // 键盘：第 3 组整条选中后改成 0–2 秒，回车插到播放头处（第 1 段之后）。
  await shot3.focus()
  await page.keyboard.press('Enter')
  const end = dialog.getByRole('slider', { name: '选区结尾' })
  await end.focus()
  for (let step = 0; step < 4; step += 1) await page.keyboard.press('Shift+ArrowLeft')
  await expect(end).toHaveAttribute('aria-valuenow', '2')
  await page.keyboard.press('Enter')
  await expect(segments(dialog)).toHaveCount(2)

  // 再从第 2 组挑 4–5.6 秒放到最后。
  await sweep(page, dialog, shot2, 4, 5.6)
  await expect(timelineOf(dialog).getByText(/^素材 4\.\d\d–5\.\d\d 秒/)).toBeVisible()
  const last = await carryToFilm(page, dialog, shot2, 4.8, 20)
  await expect(timelineOf(dialog).getByText(/^插入到 4\.\d\d 秒/)).toBeVisible()
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

  await screenshotBothThemes(page, '../.artifacts/design-qa/editor-copy/subtitles')

  // 选中一段：卡只说来源与时长。
  await segments(dialog).nth(1).click()
  const segmentCard = dialog.getByRole('region', { name: '选中的段' })
  await expect(segmentCard).toBeVisible()

  // 换版本菜单向上展开。
  await timelineOf(dialog).getByRole('button', { name: '镜头组 2 当前用 V1，换版本' }).click()
  await expect(page.getByRole('menuitemradio', { name: /V1/ })).toBeVisible()
  await page.keyboard.press('Escape')

  // 改字：只能改字，存在草稿里。
  await subtitles.first().click()
  const subtitleCard = dialog.getByRole('region', { name: '选中的字幕' })
  await expect(subtitleCard.getByText('来自镜头组 2 · V1 的口播')).toBeVisible()
  const text = subtitleCard.getByRole('textbox', { name: '字幕文字' })
  await text.fill('今天第一次背这只包')
  await expect(subtitles.first()).toHaveAccessibleName('第 1 条字幕：今天第一次背这只包')
  await page.keyboard.press('Escape')

  // 重新识别：先「识别中」，结果回来后字幕出现。
  await retry.click()
  await expect(timelineOf(dialog).getByText('识别中')).toBeVisible()
  await page.mouse.move(0, 0)
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
  await expect(
    timelineOf(dialog).getByText(/^整片含片头片尾最长 120 秒，放不下这 \d\.\d 秒$/),
  ).toBeVisible()
  await screenshotBothThemes(page, `${SHOT_DIR}/pick-limit`)
  await drop()
  await expect(segments(dialog)).toHaveCount(30)
  await expect(
    dialog.getByText(/已有 117\.0 秒，放不下这 \d\.\d 秒；请先删减成片轨上的段$/),
  ).toBeVisible()
})

const MUSIC_SHOT_DIR = '../.artifacts/design-qa/whole-film-editor/impl-2'

/** 一段 `seconds` 秒的静音 WAV（单声道 8 kHz、16 位），上传「太短」的音乐用。 */
const silentWav = (seconds: number) => {
  const rate = 8000
  const bytes = Math.round(seconds * rate) * 2
  const wav = Buffer.alloc(44 + bytes)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + bytes, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24)
  wav.writeUInt32LE(rate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(bytes, 40)
  return wav
}

/** 演示对话里第 2 组那条 6 秒成片剪成三段：0–2、2.5–4、0.5–3，共 6 秒，切点在 2.0 与 3.5 秒。 */
const seedThreeSegments = async (page: Page) => {
  const conversationId = new URL(page.url()).pathname.split('/').at(-1) ?? ''
  await page.evaluate(
    ({ key }) => {
      const source = '5b2f3071-0b2f-4d30-8d9c-2e3f4a5b6c7d'
      const segment = (id: string, start: number, end: number) => ({
        id,
        sourceJobId: source,
        start,
        end,
        origin: [start, end],
      })
      window.localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          segments: [segment('s1', 0, 2), segment('s2', 2.5, 4), segment('s3', 0.5, 3)],
          texts: {},
          manual: [],
          lanes: [{ groupId: 'shot-2', jobId: source }],
        }),
      )
    },
    { key: `whole-film-draft:${conversationId}` },
  )
}

test('整片音乐：没有工程文件时写一句生成，完成后自动对齐；拖动换段；上传太短的音乐；删除', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openConversation(page, '夜景延时素材生成')
  await seedThreeSegments(page)
  const dialog = await openWholeFilm(page)
  const track = timelineOf(dialog)
  await expect(segments(dialog)).toHaveCount(3)

  // 生成：对话里没有工程文件，写一句。
  await track.getByRole('button', { name: '添加音乐' }).click()
  await page.getByRole('menuitem', { name: '生成音乐' }).click()
  const panel = page.getByRole('dialog', { name: '生成音乐' })
  const describe = panel.getByRole('textbox', { name: '音乐描述' })
  await expect(describe).toBeVisible()
  await describe.fill('夏天海边的轻快电子乐，鼓点清楚')
  await screenshotBothThemes(page, `${MUSIC_SHOT_DIR}/music-generate-input`)
  await panel.getByRole('button', { name: '生成' }).click()
  await expect(track.getByText('音乐生成中，完成后自动对齐')).toBeVisible()

  // 生成完成：读出拍子（每分钟 120 拍），自动选起点。
  const clip = track.getByRole('button', { name: /^音乐：生成的音乐，使用 [\d.]+–[\d.]+ 秒$/ })
  await expect(clip).toBeVisible({ timeout: STEP_TIMEOUT })
  await clip.click()
  const card = dialog.getByRole('region', { name: '选中的音乐' })
  await expect(card.getByText(/^使用 [\d.]+–[\d.]+ 秒 · 整首 30\.0 秒$/)).toBeVisible()
  await expect(card.getByText(/^每分钟 120 拍 · 2 个切点中 \d 个落在拍上$/)).toBeVisible()
  await expect(dialog.getByText('音乐已自动对齐；拖动音乐可换用别的范围')).toBeVisible()
  await page.mouse.move(0, 0)
  await screenshotBothThemes(page, `${MUSIC_SHOT_DIR}/music-aligned`)
  await page.keyboard.press('Escape')
  await expect(card).toBeHidden()

  // 拖动：整首在窗口下滑动，吸附到拍上，气泡说用哪一段、几个切点落在拍上。
  const before = await clip.getAttribute('aria-label')
  const box = await clip.boundingBox()
  if (box === null) throw new Error('音乐片段尚未布局')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2, { steps: 8 })
  await expect(track.getByText(/^使用 [\d.]+–[\d.]+ 秒 · 落在拍上的切点 \d\/2$/)).toBeVisible()
  await screenshotBothThemes(page, `${MUSIC_SHOT_DIR}/music-drag`)
  await page.mouse.up()
  await expect(clip).not.toHaveAttribute('aria-label', before ?? '')

  // 上传一首 2 秒的：比视频段短 4 秒，后面接空位，「合成成片」说明原因。
  await track.getByRole('button', { name: '添加音乐' }).click()
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('menuitem', { name: '上传音乐' }).click()
  await (
    await chooser
  ).setFiles({ name: '夏日节拍.wav', mimeType: 'audio/wav', buffer: silentWav(2) })
  await expect(track.getByText('音乐比成片短 4.0 秒')).toBeVisible({ timeout: STEP_TIMEOUT })
  const compose = dialog.getByRole('button', { name: '合成成片' })
  await expect(compose).toHaveAttribute('aria-disabled', 'true')
  await compose.hover()
  await expect(page.getByRole('tooltip')).toHaveText(
    '音乐比成片短 4.0 秒，无法合成；请重新生成或换一首',
  )
  await expect(
    dialog.getByText('上传的音乐只有 2.0 秒，铺不满第一段开头到最后一段结尾，不循环补齐'),
  ).toBeVisible()
  await page.mouse.move(0, 0)
  // 菜单收起后焦点回到「+」，截图前移开，免得焦点环盖在轨道头上。
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await screenshotBothThemes(page, `${MUSIC_SHOT_DIR}/music-short`)

  // 删除：键盘上按 Delete，撤销放回来。
  const uploaded = track.getByRole('button', { name: /^音乐：夏日节拍\.wav/ })
  await uploaded.focus()
  await page.keyboard.press('Delete')
  await expect(uploaded).toBeHidden()
  await dialog.getByRole('button', { name: '撤销' }).click()
  await expect(uploaded).toBeVisible()
})

test('整片音乐：工程文件里写了配乐，生成音乐引用那段原文', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = await openConversation(page, '穿搭种草 · 12 秒')
  await panel.getByRole('button', { name: '整片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /^编辑视频\s*整片/ })
  await expect(dialog).toBeVisible()

  await timelineOf(dialog).getByRole('button', { name: '添加音乐' }).click()
  await page.getByRole('menuitem', { name: '生成音乐' }).click()
  const generate = page.getByRole('dialog', { name: '生成音乐' })
  await expect(generate.getByText('使用工程文件里的配乐：')).toBeVisible()
  await expect(
    generate.getByText('轻快的电子乐，鼓点渐入，副歌推到高潮，整体明亮有活力'),
  ).toBeVisible()
  await expect(generate.getByRole('textbox')).toHaveCount(0)
  await screenshotBothThemes(page, `${MUSIC_SHOT_DIR}/music-generate`)
})

test('整片移动布局：素材区可操作，页面不横向溢出', async ({ page }) => {
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

test('整片合成：剪辑后提交，完成版本可预览下载，关闭并清除草稿后恢复最新版本', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const dialog = await openWholeFilm(page)
  await addMaterial(page, dialog, '镜头组 2 V1')
  await laneOf(dialog, '镜头组 2 · V1').focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await expect(segments(dialog)).toHaveCount(1)

  const accepted = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/generations/whole-films') &&
      response.request().method() === 'POST',
  )
  await dialog.getByRole('button', { name: '合成成片' }).click()
  const response = await accepted
  expect(response.status()).toBe(202)
  const submitted = response.request().postDataJSON() as {
    segments: { sourceJobId: string; startMs: number; endMs: number }[]
    subtitles: { startMs: number; endMs: number; text: string }[]
  }
  expect(submitted.segments).toEqual([
    { sourceJobId: '5b2f3071-0b2f-4d30-8d9c-2e3f4a5b6c7d', startMs: 0, endMs: 6000 },
  ])
  expect(submitted.subtitles.length).toBeGreaterThan(0)
  const { generation } = (await response.json()) as { generation: { id: string } }
  await expect(dialog.getByRole('button', { name: '整片合成中' })).toBeVisible()
  await screenshotBothThemes(page, '../.artifacts/design-qa/whole-film-editor/impl-3/composing')
  await dialog.getByRole('button', { name: '整片 V1' }).click({ timeout: STEP_TIMEOUT })
  await expect(dialog.getByRole('button', { name: '下载视频' })).toBeEnabled()
  await screenshotBothThemes(page, '../.artifacts/design-qa/whole-film-editor/impl-3/completed')

  const downloaded = page.waitForEvent('download')
  const tracking = page.waitForRequest(
    (request) => request.url().endsWith('/api/tracking/events') && request.method() === 'POST',
  )
  await dialog.getByRole('button', { name: '下载视频' }).click()
  expect((await tracking).postDataJSON()).toEqual({
    name: 'video.downloaded',
    jobId: generation.id,
  })
  expect(await (await downloaded).failure()).toBeNull()

  await dialog.getByRole('button', { name: '关闭视频编辑' }).click()
  await page.evaluate(() => {
    const conversationId = window.location.pathname.split('/').at(-1)
    window.localStorage.removeItem(`whole-film-draft:${conversationId}`)
  })
  await page
    .getByRole('complementary', { name: '工作台' })
    .getByRole('button', { name: '整片', exact: true })
    .click()
  await expect(dialog.getByText('已按 V1 恢复剪辑')).toBeVisible()
  await expect(segments(dialog)).toHaveCount(1)
  await screenshotBothThemes(page, '../.artifacts/design-qa/whole-film-editor/impl-3/restored')
})

test('整片片头片尾：按正文画幅选择固定模板，字幕只在正文出现，合成请求使用正文时钟', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const dialog = await openWholeFilm(page)
  await addMaterial(page, dialog, '镜头组 2 V1')
  await laneOf(dialog, '镜头组 2 · V1').focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  const introSlot = dialog.getByRole('button', { name: '添加片头', exact: true })
  const outroSlot = dialog.getByRole('button', { name: '添加片尾', exact: true })
  expect((await introSlot.boundingBox())?.width).toBe(64)
  expect((await outroSlot.boundingBox())?.width).toBe(64)
  await expect(segments(dialog).first()).toHaveAccessibleName(/0–6 秒$/)
  await screenshotBothThemes(page, `${BRAND_SHOT_DIR}/placeholders`)
  await introSlot.click()
  await expect(page.getByRole('menuitem', { name: /^品牌片头 · 竖版/ })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /^品牌片头 · 横版/ })).toHaveCount(0)
  await page.getByRole('menuitem', { name: /^品牌片头 · 竖版/ }).click()
  await expect(introSlot).toHaveCount(0)
  await dialog.getByRole('button', { name: '添加片尾', exact: true }).click()
  await page.getByRole('menuitem', { name: /^品牌片尾 · 竖版/ }).click()
  await expect(outroSlot).toHaveCount(0)
  await expect(
    dialog.getByRole('button', { name: '片头：品牌片头 · 竖版，位置固定' }),
  ).toBeVisible()
  await expect(
    dialog.getByRole('button', { name: '片尾：品牌片尾 · 竖版，位置固定' }),
  ).toBeVisible()
  await expect(segments(dialog).first()).toHaveAccessibleName(/6–12 秒$/)
  const ruler = dialog.getByRole('slider', { name: '时间线播放位置' })
  await page.mouse.click(await xAt(dialog, 1), await middleY(ruler))
  await expect(dialog.getByLabel('视频预览').getByText('这只包今天第一次上身')).toHaveCount(0)
  await page.mouse.click(await xAt(dialog, 7), await middleY(ruler))
  await expect(dialog.getByLabel('视频预览').getByText('这只包今天第一次上身')).toBeVisible()
  await page.mouse.move(0, 0)
  await dialog.getByRole('button', { name: '字幕字体：系统默认' }).click()
  await page.getByRole('menuitemradio', { name: '示例字体 · 通用' }).click()
  await expect(dialog.getByRole('button', { name: '合成成片' })).not.toHaveAttribute(
    'aria-disabled',
  )
  await expect(dialog.getByLabel('视频预览').getByText('这只包今天第一次上身')).toBeVisible()
  await screenshotBothThemes(page, `${BRAND_SHOT_DIR}/custom-font`)
  const accepted = page.waitForResponse((response) =>
    response.url().endsWith('/api/generations/whole-films'),
  )
  await dialog.getByRole('button', { name: '合成成片' }).click()
  const response = await accepted
  expect(response.status()).toBe(202)
  const submitted = response.request().postDataJSON() as {
    intro: { templateId: string }
    fontId: string
    outro: { templateId: string }
    subtitles: { startMs: number }[]
  }
  expect(submitted.fontId).toBe('ba000001-0000-4000-8000-000000000005')
  expect(submitted.intro.templateId).toBe('ba000001-0000-4000-8000-000000000001')
  expect(submitted.outro.templateId).toBe('ba000001-0000-4000-8000-000000000002')
  expect(submitted.subtitles[0]?.startMs).toBe(300)
  await expect(dialog.getByRole('button', { name: '整片 V1' })).toBeVisible({
    timeout: STEP_TIMEOUT,
  })
  await dialog.getByRole('button', { name: '关闭视频编辑' }).click()
  await page.evaluate(() => {
    const conversationId = window.location.pathname.split('/').at(-1)
    window.localStorage.removeItem(`whole-film-draft:${conversationId}`)
  })
  await page
    .getByRole('complementary', { name: '工作台' })
    .getByRole('button', { name: '整片', exact: true })
    .click()
  await expect(dialog.getByText('已按 V1 恢复剪辑')).toBeVisible()
  await expect(dialog.getByRole('button', { name: /^片头：/ })).toBeVisible()
  await expect(dialog.getByRole('button', { name: /^片尾：/ })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '字幕字体：示例字体' })).toBeVisible()
  await expect(segments(dialog).first()).toHaveAccessibleName(/6–12 秒$/)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0)
  await screenshotBothThemes(page, '../.artifacts/design-qa/whole-film-editor/impl-3/brands-mobile')
  await dialog.getByRole('button', { name: /^片头：/ }).click()
  await dialog
    .getByRole('region', { name: '选中的片头' })
    .getByRole('button', { name: '删除片头' })
    .click()
  await expect(introSlot).toBeVisible()
  await expect(segments(dialog).first()).toHaveAccessibleName(/0–6 秒$/)
})

test('字幕字体排版：长英文、中文和显式换行按原画幅排版，放大和窗口缩放保持比例', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const dialog = await openWholeFilm(page)
  await addMaterial(page, dialog, '镜头组 2 V1')
  await laneOf(dialog, '镜头组 2 · V1').focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  const text =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZ\n这只包今天第一次上身这只包今天第一次上身'
  await dialog.getByRole('button', { name: '第 1 条字幕：这只包今天第一次上身' }).click()
  await dialog.getByRole('textbox', { name: '字幕文字' }).fill(text)
  await page.mouse.click(
    await xAt(dialog, 1),
    await middleY(dialog.getByRole('slider', { name: '时间线播放位置' })),
  )
  await dialog.getByRole('button', { name: '字幕字体：系统默认' }).click()
  await page.getByRole('menuitemradio', { name: '示例字体 · 通用' }).click()
  const caption = page.getByTestId('preview-caption')
  await expect(caption).toBeVisible()
  const wrapped = await caption.textContent()
  // 同一 sample-font.otf 经服务端 HarfBuzz 在 180×320 画布上的真实分行。
  expect(wrapped?.split('\n')).toEqual([
    'ABCDEFGHIJKLMNOPQ',
    'RSTUVWXYZABCDEFGHI',
    'JKLMNOPQRSTUVWXYZ',
    '这只包今天第一次上身这',
    '只包今天第一次上身',
  ])
  expect(wrapped?.replaceAll('\n', '')).toBe(text.replaceAll('\n', ''))
  const geometry = () =>
    caption.evaluate((element) => {
      const frame = element.parentElement?.getBoundingClientRect()
      if (frame === undefined) throw new Error('字幕画面尚未布局')
      const box = element.getBoundingClientRect()
      return {
        fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
        height: frame.height,
        bottom: frame.bottom - box.bottom,
        left: box.left - frame.left,
        width: frame.width,
      }
    })
  const desktop = await geometry()
  expect(desktop.fontSize / desktop.height).toBeCloseTo(14 / 320, 3)
  expect(desktop.bottom / desktop.height).toBeCloseTo(38 / 320, 3)
  expect(desktop.left / desktop.width).toBeCloseTo(11 / 180, 3)
  await page.mouse.move(0, 0)
  await screenshotBothThemes(page, `${BRAND_SHOT_DIR}/multiline-font`)
  await dialog.getByRole('button', { name: '放大', exact: true }).click()
  await expect(caption).toBeVisible()
  await expect.poll(async () => (await geometry()).height).toBeGreaterThan(desktop.height)
  await expect
    .poll(async () => {
      const box = await geometry()
      return box.fontSize / box.height
    })
    .toBeCloseTo(14 / 320, 3)
  const enlarged = await geometry()
  expect(await caption.textContent()).toBe(wrapped)
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect
    .poll(async () => {
      const box = await geometry()
      return box.fontSize / box.height
    })
    .toBeCloseTo(14 / 320, 3)
  const mobile = await geometry()
  await test.info().attach('caption-layout-geometry', {
    body: JSON.stringify({ desktop, enlarged, mobile, wrapped }, null, 2),
    contentType: 'application/json',
  })
  expect(await caption.textContent()).toBe(wrapped)
  await screenshotBothThemes(page, `${BRAND_SHOT_DIR}/multiline-font-mobile`)
  await dialog.getByRole('button', { name: '字幕字体：示例字体' }).click()
  await page.getByRole('menuitemradio', { name: '系统默认' }).click()
  await expect(caption).toHaveText(text)
  await dialog.getByRole('button', { name: '字幕字体：系统默认' }).click()
  await page.getByRole('menuitemradio', { name: '示例字体 · 通用' }).click()
  await expect(caption).toHaveText(wrapped ?? '')
})

test('素材预览：拖选中显示边界画面，播放仅限选区，返回整片保留播放头', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const dialog = await openWholeFilm(page)
  await addMaterial(page, dialog, '镜头组 2 V1')
  await addMaterial(page, dialog, '镜头组 3 V1')
  const lane = laneOf(dialog, '镜头组 2 · V1')
  const ruler = dialog.getByRole('slider', { name: '时间线播放位置' })
  const video = dialog.getByLabel('视频播放器', { exact: true })
  const videoTime = () => video.evaluate((element) => (element as HTMLVideoElement).currentTime)

  // 拖动尚未结束时就能看见指针所在的画面，不能等插入成片轨后才预览。
  await page.mouse.move(await xAt(dialog, 1), await middleY(lane))
  await page.mouse.down()
  await page.mouse.move(await xAt(dialog, 3), await middleY(lane), { steps: 6 })
  await expect(video).toHaveAttribute('src', /sample-video/)
  await expect
    .poll(() => video.evaluate((element) => (element as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(2)
  await expect.poll(videoTime).toBeCloseTo(3, 1)
  await page.mouse.up()
  await expect(segments(dialog)).toHaveCount(0)
  await expect(ruler).toHaveValue('0')

  const end = dialog.getByRole('slider', { name: '选区结尾' })
  await end.focus()
  await page.keyboard.press('Shift+ArrowLeft')
  await expect.poll(videoTime).toBeCloseTo(2, 1)
  await dialog.getByRole('button', { name: '播放', exact: true }).click()
  await expect.poll(videoTime).toBeGreaterThan(1.1)
  await expect(dialog.getByRole('button', { name: '播放', exact: true })).toBeVisible()
  await expect.poll(videoTime).toBeCloseTo(2, 1)
  expect(await video.evaluate((element) => (element as HTMLVideoElement).paused)).toBe(true)
  await expect(ruler).toHaveValue('0')
  await screenshotBothThemes(page, `${INTERACTION_SHOT_DIR}/material-preview`)

  // 插入后回到整片；随后预览另一条横版素材，不污染整片第 0.5 秒的播放头。
  await end.focus()
  await page.keyboard.press('Enter')
  await expect(segments(dialog)).toHaveCount(1)
  await ruler.fill('0.5')
  await laneOf(dialog, '镜头组 3 · V1').focus()
  await page.keyboard.press('Enter')
  await expect(video).toHaveAttribute('src', /sample-video-wide/)
  await expect(ruler).toHaveValue('0.5')
  await expect(
    dialog.getByLabel('视频预览').getByText('这只包今天第一次上身', { exact: true }),
  ).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(video).toHaveAttribute('src', /sample-video/)
  await expect.poll(videoTime).toBeCloseTo(1.5, 1)
  await expect(ruler).toHaveValue('0.5')
})

test('添加镜头组：底部加号持续可用，片头片尾直接从轨道空位选择', async ({ page }) => {
  const dialog = await openWholeFilm(page)
  const add = dialog.getByRole('button', { name: '添加镜头组', exact: true })
  await expect(add).toHaveCount(1)
  await addMaterial(page, dialog, '镜头组 2 V1')
  await expect(add).toHaveCount(1)
  await addMaterial(page, dialog, '镜头组 3 V1')
  await expect(laneOf(dialog, '镜头组 2 · V1')).toBeVisible()
  await expect(laneOf(dialog, '镜头组 3 · V1')).toBeVisible()

  await expect(dialog.getByRole('button', { name: '添加', exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: '添加片头', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '添加片尾', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '视频', exact: true })).toHaveCount(0)

  await add.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu', { name: '添加镜头组', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(add).toBeFocused()
})

/** 通过已有 mock 生成接口准备素材，镜号可重复以生成同组多版；等待记录完成再编辑。 */
const createMaterials = async (page: Page, shotIndices: number[]) => {
  const ids = await page.evaluate(async (indices) => {
    const conversationId = window.location.pathname.split('/').at(-1)
    if (conversationId === undefined) throw new Error('尚未打开对话')
    return Promise.all(
      indices.map(async (shotIndex) => {
        const body: VideoGenerationIn = {
          conversation_id: conversationId,
          shot_index: shotIndex,
          model: 'vendor-a-seedance-2-5',
          prompt: '滚动验收素材',
          seconds: 6,
          aspect_ratio: '9:16',
          resolution: '720p',
        }
        const response = await fetch('/api/generations/video', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!response.ok) throw new Error('准备验收素材失败')
        return ((await response.json()) as VideoSubmitOut).task_id
      }),
    )
  }, shotIndices)
  await expect
    .poll(
      () =>
        page.evaluate(async (ids) => {
          const conversationId = window.location.pathname.split('/').at(-1) ?? ''
          const query = new URLSearchParams({ conversationId, kind: 'video' })
          const response = await fetch(`/api/generations?${query}`)
          const result = (await response.json()) as GenerationsPageOut
          return ids.every((id) =>
            result.items.some((item) => item.id === id && item.status === 'completed'),
          )
        }, ids),
      { timeout: STEP_TIMEOUT },
    )
    .toBe(true)
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1280, height: 720 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'landscape', width: 844, height: 390 },
]) {
  test(`多素材布局 ${viewport.name}：轨道高度固定、独立滚动，预览保持可见`, async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    const panel = await openConversation(page, '夜景延时素材生成', {
      mobile: viewport.width < 600,
    })
    await createMaterials(
      page,
      Array.from({ length: 10 }, (_, index) => index + 10),
    )
    await panel.getByRole('button', { name: '整片', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: /^编辑视频\s*整片/ })
    await addMaterial(page, dialog, '镜头组 10 V1')
    const stage = dialog.getByRole('region', { name: '预览舞台', exact: true })
    const tracks = dialog.getByRole('region', { name: '轨道列表', exact: true })
    const candidates = dialog.getByRole('region', { name: '候选素材', exact: true })
    const filmLane = dialog.getByTestId('film-lane')
    const filmBefore = await filmLane.boundingBox()
    const stageBefore = await stage.boundingBox()
    const tracksBefore = await tracks.boundingBox()
    if (stageBefore === null || tracksBefore === null) throw new Error('编辑器尚未布局')

    for (let group = 11; group <= 19; group += 1)
      await addMaterial(page, dialog, `镜头组 ${group} V1`)
    const stageAfter = await stage.boundingBox()
    const tracksAfter = await tracks.boundingBox()
    if (stageAfter === null || tracksAfter === null) throw new Error('编辑器尚未布局')
    expect(Math.abs(stageAfter.height - stageBefore.height)).toBeLessThan(1)
    expect(Math.abs(tracksAfter.height - tracksBefore.height)).toBeLessThan(1)
    expect(stageAfter.height).toBeGreaterThan(viewport.height * 0.25)
    expect(stageAfter.y).toBeGreaterThanOrEqual(0)
    expect(tracksAfter.y + tracksAfter.height).toBeLessThan(viewport.height)

    // 候选独立滚动，成片轨保持可见；左侧组名和右侧素材轨保持在同一行。
    await candidates.evaluate((element) => element.scrollTo({ top: 0 }))
    await candidates.hover()
    await page.mouse.wheel(0, 900)
    await expect.poll(() => candidates.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await expect(filmLane).toBeInViewport()
    const filmAfter = await filmLane.boundingBox()
    if (filmBefore === null || filmAfter === null) throw new Error('成片轨尚未布局')
    expect(Math.abs(filmAfter.y - filmBefore.y)).toBeLessThan(1)
    expect(Math.abs(filmAfter.height - filmBefore.height)).toBeLessThan(1)
    await expect(dialog.getByRole('button', { name: '添加镜头组', exact: true })).toBeInViewport()
    const last = laneOf(dialog, '镜头组 19 · V1')
    await last.scrollIntoViewIfNeeded()
    await expect(last).toBeInViewport()
    const label = timelineOf(dialog).getByText('镜头组 19', { exact: true })
    const labelBox = await label.boundingBox()
    const laneBox = await last.boundingBox()
    const candidateBox = await candidates.boundingBox()
    if (labelBox === null || laneBox === null || candidateBox === null)
      throw new Error('最后一组素材尚未布局')
    expect(laneBox.y).toBeGreaterThanOrEqual(candidateBox.y)
    expect(laneBox.y + laneBox.height).toBeLessThanOrEqual(candidateBox.y + candidateBox.height)
    expect(
      Math.abs(labelBox.y + labelBox.height / 2 - laneBox.y - laneBox.height / 2),
    ).toBeLessThan(1)
    expect(
      await dialog.getByLabel('整片编辑器', { exact: true }).evaluate((el) => el.scrollTop),
    ).toBe(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width,
    )

    await last.focus()
    await page.keyboard.press('Enter')
    const video = dialog.getByLabel('视频播放器', { exact: true })
    await expect
      .poll(() => video.evaluate((element) => (element as HTMLVideoElement).readyState))
      .toBeGreaterThanOrEqual(2)
    await page.mouse.move(0, 0)
    await screenshotBothThemes(page, `${INTERACTION_SHOT_DIR}/many-materials-${viewport.name}`)

    if (viewport.name === 'desktop') {
      // 系统取消拖动时，即使指针已经进入成片轨也不能提交片段。
      const cancelled = await carryToFilm(page, dialog, last, 3, 0)
      await expect(dialog.getByTestId('film-insert')).toBeVisible()
      await last.dispatchEvent('pointercancel', { pointerId: 1 })
      await cancelled()
      await expect(segments(dialog)).toHaveCount(0)
      await expect(dialog.getByTestId('film-carry')).toHaveCount(0)

      // 末行素材直接拖入常驻成片轨，不必先滚回顶部。
      const drop = await carryToFilm(page, dialog, last, 3, 0)
      await expect(dialog.getByTestId('film-insert')).toBeVisible()
      expect(await candidates.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
      await expect(last).toBeInViewport()
      const floating = await dialog.getByTestId('film-carry').boundingBox()
      const target = await filmLane.boundingBox()
      if (floating === null || target === null) throw new Error('拖动浮影尚未显示')
      expect(
        Math.abs(floating.y + floating.height / 2 - target.y - target.height / 2),
      ).toBeLessThan(1)
      await drop()
      await expect(segments(dialog)).toHaveCount(1)
      await expect(segments(dialog).first()).toHaveAccessibleName(/镜头组 19 · V1 · 0–6 秒$/)

      // 已有 A、B 两段时，候选 C 仍能直接落到切点，插入线与最终顺序一致。
      await dialog.getByRole('slider', { name: '时间线播放位置' }).fill('6')
      const second = laneOf(dialog, '镜头组 18 · V1')
      await second.focus()
      await page.keyboard.press('Enter')
      await page.keyboard.press('Enter')
      await expect(segments(dialog)).toHaveCount(2)
      const third = laneOf(dialog, '镜头组 17 · V1')
      await third.focus()
      await page.keyboard.press('Enter')
      const insert = await carryToFilm(page, dialog, third, 3, 6)
      await expect(timelineOf(dialog).getByText('插入到 6.00 秒', { exact: true })).toBeVisible()
      const marker = await dialog.getByTestId('film-insert').boundingBox()
      const first = await segments(dialog).first().boundingBox()
      if (marker === null || first === null) throw new Error('成片插入位置尚未布局')
      expect(Math.abs(marker.x + marker.width / 2 - first.x - first.width)).toBeLessThan(3)
      await insert()
      await expect(segments(dialog)).toHaveCount(3)
      await expect(segments(dialog).nth(0)).toHaveAccessibleName(/镜头组 19 · V1 · 0–6 秒$/)
      await expect(segments(dialog).nth(1)).toHaveAccessibleName(/镜头组 17 · V1 · 6–12 秒$/)
      await expect(segments(dialog).nth(2)).toHaveAccessibleName(/镜头组 18 · V1 · 12–18 秒$/)
    }
  })
}

test('同组多版本：菜单在窗口内滚动，换版只影响之后加入成片的片段', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const panel = await openConversation(page, '夜景延时素材生成', { mobile: true })
  await createMaterials(
    page,
    Array.from({ length: 21 }, () => 10),
  )
  await panel.getByRole('button', { name: '整片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /^编辑视频\s*整片/ })
  await addMaterial(page, dialog, '镜头组 10 V21')
  await laneOf(dialog, '镜头组 10 · V21').focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await expect(segments(dialog)).toHaveCount(1)
  await dialog.getByRole('slider', { name: '时间线播放位置' }).fill('6')

  await dialog.getByRole('button', { name: '镜头组 10 当前用 V21，换版本' }).click()
  const menu = page.getByRole('menu', { name: '镜头组 10 当前用 V21，换版本' })
  const bounds = await menu.boundingBox()
  if (bounds === null) throw new Error('版本菜单尚未布局')
  expect(bounds.y).toBeGreaterThanOrEqual(0)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(844)
  const earliest = menu.getByRole('menuitemradio', { name: /^V1\s/ })
  await earliest.scrollIntoViewIfNeeded()
  await expect(earliest).toBeInViewport()
  await earliest.click()
  await expect(dialog.getByRole('button', { name: '镜头组 10 当前用 V1，换版本' })).toBeVisible()
  await expect(
    timelineOf(dialog).getByRole('button', { name: /^镜头组 10 · V\d+ 素材/ }),
  ).toHaveCount(1)
  await laneOf(dialog, '镜头组 10 · V1').focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await expect(segments(dialog)).toHaveCount(2)
  await expect(segments(dialog).nth(0)).toHaveAccessibleName(/镜头组 10 · V21 · 0–6 秒$/)
  await expect(segments(dialog).nth(1)).toHaveAccessibleName(/镜头组 10 · V1 · 6–12 秒$/)
})
