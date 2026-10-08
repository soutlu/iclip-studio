import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { WorkspaceFilesPanel } from './workspace-files-panel'

const CONVERSATION_ID = '4d3a7f8e-1b2c-4d5e-8f90-a1b2c3d4e5f6'
const PATH = 'frames/doc.json'
const IMAGE = 'https://cdn.example/out/S2-1.png?x=1'

const artifact = {
  id: 'workspace',
  source: { fileCount: 1, kind: 'workspace' },
  title: '文件',
  type: 'workspace',
} as const

/** 在阅读页直接打开一份内容给定的 JSON 文件。 */
const openJson = async (content: string, path = PATH) => {
  server.use(
    http.get('*/api/conversations/:conversationId/workspace/file', () =>
      HttpResponse.json({ file: { content, path, version: 1 } }),
    ),
  )
  return renderWithProviders(
    <WorkspaceFilesPanel artifact={artifact} conversationId={CONVERSATION_ID} readOnly={false} />,
    { initialPath: `/c/${CONVERSATION_ID}?file=${encodeURIComponent(path)}` },
  )
}

const SHOTS = {
  aspect_ratio: '9:16',
  shots: [
    { image_urls: [IMAGE], index: 1, prompt: { timeline: [{ timestamps: [0, 6] }] } },
    { image_urls: [], index: 2, prompt: { timeline: [] } },
  ],
}

/** 格式化后超过 200 行：{ items: [{ v: 0 }, … 70 个] }。 */
const LARGE = { items: Array.from({ length: 70 }, (_, v) => ({ v })) }

describe('JSON 格式化视图', () => {
  it('解析后按 2 格缩进排出：键与字符串带引号，括号与逗号都在，没有行号', async () => {
    await openJson('{"a":"x","b":["y"],"c":{},"d":[]}')

    expect(await screen.findByText('"a"')).toBeVisible()
    expect(screen.getByText('"x"')).toBeVisible()
    expect(screen.getByText('{')).toBeVisible()
    expect(screen.getByText('{}')).toBeVisible()
    expect(screen.getByText('[]')).toBeVisible()
    expect(screen.getAllByText(',')).toHaveLength(3)
    for (const number of ['1', '2', '3', '8']) {
      expect(screen.queryByText(number)).not.toBeInTheDocument()
    }
  })

  it('数字与 true / false / null 各自成段，不并进键名或标点', async () => {
    await openJson('{"n":6,"t":true,"f":false,"z":null}')

    for (const literal of ['6', 'true', 'false', 'null']) {
      expect(await screen.findByText(literal)).toBeVisible()
    }
  })

  it('页头文件名截中间时，可访问名与悬停提示仍是完整路径', async () => {
    const path = 'frames/video_shot_storyboard_final.json'
    await openJson('{}', path)

    const heading = await screen.findByRole('heading', { name: path })
    expect(within(heading).getByTitle(path)).toBeVisible()
  })

  it('每个非空对象与数组都能收起成 {…} 加项数，再点展开恢复', async () => {
    const user = userEvent.setup()
    await openJson(JSON.stringify(SHOTS))

    const toggle = await screen.findByRole('button', { name: '收起 shots[0]' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('"timestamps"')).toBeVisible()

    await user.click(toggle)

    const reopen = screen.getByRole('button', { name: '展开 shots[0]' })
    expect(reopen).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('"timestamps"')).not.toBeInTheDocument()
    expect(screen.getByText('{…}')).toBeVisible()
    expect(screen.getByText('3 项')).toBeVisible()

    await user.click(reopen)

    expect(screen.getByText('"timestamps"')).toBeVisible()
    expect(screen.queryByText('{…}')).not.toBeInTheDocument()
  })

  it('不超过 200 行的文件默认全部展开', async () => {
    await openJson(JSON.stringify({ items: LARGE.items.slice(0, 60) }))

    expect(await screen.findByRole('button', { name: '收起 items[59]' })).toBeVisible()
    expect(screen.queryByRole('button', { name: /^展开/ })).not.toBeInTheDocument()
  })

  it('超过 200 行的文件默认只展开前两层', async () => {
    await openJson(JSON.stringify(LARGE))

    expect(await screen.findByRole('button', { name: '收起 根' })).toBeVisible()
    expect(screen.getByRole('button', { name: '收起 items' })).toBeVisible()
    expect(screen.getByRole('button', { name: '展开 items[0]' })).toBeVisible()
    expect(screen.queryByText('"v"')).not.toBeInTheDocument()
  })

  it('页头「全部收起」只留第一层，变成「全部展开」后一键展开所有层', async () => {
    const user = userEvent.setup()
    await openJson(JSON.stringify(SHOTS))

    await user.click(await screen.findByRole('button', { name: '全部收起' }))

    expect(screen.getByRole('button', { name: '收起 根' })).toBeVisible()
    expect(screen.getByRole('button', { name: '展开 shots' })).toBeVisible()
    expect(screen.getByText('2 项')).toBeVisible()
    expect(screen.queryByText('"index"')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '全部展开' }))

    expect(screen.getByRole('button', { name: '收起 shots[0].prompt.timeline[0]' })).toBeVisible()
    expect(screen.getByRole('button', { name: '全部收起' })).toBeVisible()
  })

  it('长字符串原样一段显示，转义照 JSON 写法', async () => {
    const long = `参考锁定：${'模特的服装与发型跟住 @Image1，'.repeat(12)}\n剪辑形式：硬切。`
    await openJson(JSON.stringify({ global_settings: long }))

    expect(await screen.findByText(JSON.stringify(long))).toBeVisible()
  })

  it('图片地址原文不改，行尾的缩略图点开走共享灯箱', async () => {
    const user = userEvent.setup()
    await openJson(JSON.stringify(SHOTS))

    expect(await screen.findByText(JSON.stringify(IMAGE))).toBeVisible()

    await user.click(screen.getByRole('button', { name: '查看图片：S2-1.png' }))

    const dialog = screen.getByRole('dialog', { name: 'S2-1.png' })
    expect(within(dialog).getByRole('img')).toHaveAttribute('src', IMAGE)
  })

  it('解析不了就标红 × 说一句，下面原样摆出原文，不给收起按钮', async () => {
    const broken = '{\n  "a": 1,\n}'
    await openJson(broken)

    expect(await screen.findByText('JSON 格式有误，已按原文显示')).toBeVisible()
    expect(
      screen.getByText(
        (_, element) => element?.tagName === 'PRE' && element.textContent === broken,
      ),
    ).toBeVisible()
    expect(screen.queryByRole('button', { name: '全部收起' })).not.toBeInTheDocument()
  })

  it('复制按钮复制文件原文，不是格式化后的文本', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const original = '{"ratio":1.0,   "list":[1,2]}'
    await openJson(original)

    await screen.findByText('"ratio"')
    await user.click(screen.getByRole('button', { name: '复制原文' }))

    expect(writeText).toHaveBeenCalledWith(original)
  })
})
