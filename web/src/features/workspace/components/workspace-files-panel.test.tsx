import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { putMockWorkspaceFile, seedMockWorkspace } from '@/testing/mocks/workspace'
import { renderWithProviders } from '@/testing/render'
import { ArtifactRegistry, WorkbenchRegistryProvider, workspaceQueryKeys } from '@/shared/workbench'
import { WorkspaceFilesPanel } from './workspace-files-panel'

const CONVERSATION_ID = '4d3a7f8e-1b2c-4d5e-8f90-a1b2c3d4e5f6'

const artifact = {
  id: 'workspace',
  source: { fileCount: 5, kind: 'workspace' },
  title: '文件',
  type: 'workspace',
} as const

// jsdom 里元素都没有尺寸：宽屏的用例只让文件页的外层（直接装着浮起面板）量出来有 900 宽，
// 别的元素（编辑器的行之类）照旧
const widePanel = () => {
  const measure = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.querySelector(':scope > section') === null) return measure.call(this)
    return {
      bottom: 700,
      height: 700,
      left: 0,
      right: 900,
      top: 0,
      width: 900,
      x: 0,
      y: 0,
    } as DOMRect
  })
}

afterEach(() => vi.restoreAllMocks())

const renderPanel = (initialPath = `/c/${CONVERSATION_ID}`, { readOnly = false } = {}) => {
  const registry = new ArtifactRegistry()
  registry.register({
    autoOpen: true,
    component: () => null,
    icon: 'grid',
    label: '分镜',
    match: { path: 'video_shot.json' },
    title: () => '分镜',
    type: 'storyboard',
  })
  registry.register({
    autoOpen: false,
    component: () => null,
    hiddenWhenReadOnly: true,
    icon: 'film',
    label: 'final-cut',
    match: { anyPath: ['final-cut/index.html'] },
    title: () => 'final-cut',
    type: 'final-cut',
  })
  return renderWithProviders(
    <WorkbenchRegistryProvider registry={registry}>
      <WorkspaceFilesPanel
        artifact={artifact}
        conversationId={CONVERSATION_ID}
        readOnly={readOnly}
      />
    </WorkbenchRegistryProvider>,
    { initialPath },
  )
}

const directory = () => screen.findByRole('tree', { name: '文件目录' })
const row = (name: string) => screen.findByRole('treeitem', { name })

describe('WorkspaceFilesPanel 目录树', () => {
  it('目录在前、文件在后，子级在目录下一层；目录可以收起再展开', async () => {
    const user = userEvent.setup()
    seedMockWorkspace(CONVERSATION_ID)
    await renderPanel()

    const tree = await directory()
    await waitFor(() =>
      expect(
        within(tree)
          .getAllByRole('treeitem')
          .map((item) => item.getAttribute('aria-label')),
      ).toEqual([
        'frames',
        'extraction.json',
        'video',
        'night-city-timelapse-9a3f2c1d.md',
        'storyboard.md',
        'video_shot.json',
        '口播文案.txt',
      ]),
    )
    const frames = await row('frames')
    expect(frames).toHaveAttribute('aria-expanded', 'true')
    expect(frames).toHaveAttribute('aria-level', '1')
    expect(await row('extraction.json')).toHaveAttribute('aria-level', '2')

    await user.click(frames)

    expect(await row('frames')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('treeitem', { name: 'extraction.json' })).not.toBeInTheDocument()

    await user.click(await row('frames'))
    expect(await row('extraction.json')).toBeVisible()
  })

  it('键盘：上下键在行间移动，左键收起目录，回车打开文件', async () => {
    const user = userEvent.setup()
    seedMockWorkspace(CONVERSATION_ID)
    const { router } = await renderPanel()

    const frames = await row('frames')
    frames.focus()
    await user.keyboard('{ArrowLeft}')
    expect(await row('frames')).toHaveAttribute('aria-expanded', 'false')
    await user.keyboard('{ArrowRight}')
    expect(await row('frames')).toHaveAttribute('aria-expanded', 'true')

    await user.keyboard('{ArrowDown}')
    await waitFor(async () => expect(await row('extraction.json')).toHaveFocus())
    await user.keyboard('{Enter}')

    expect(await screen.findByRole('heading', { name: 'frames/extraction.json' })).toBeVisible()
    expect(router.state.location.search).toMatchObject({ file: 'frames/extraction.json' })
  })

  it('筛选只留路径里含筛选词的文件和它们的目录，右边写匹配的文件数', async () => {
    const user = userEvent.setup()
    seedMockWorkspace(CONVERSATION_ID)
    await renderPanel()
    await row('storyboard.md')

    const filter = screen.getByRole('textbox', { name: '筛选文件' })
    await user.type(filter, 'JSON')

    const tree = await directory()
    await waitFor(() =>
      expect(
        within(tree)
          .getAllByRole('treeitem')
          .map((item) => item.getAttribute('aria-label')),
      ).toEqual(['frames', 'extraction.json', 'video_shot.json']),
    )
    expect(screen.getByText('2')).toBeVisible()

    await user.clear(filter)
    await user.type(filter, '没有这个')
    expect(await screen.findByText('没有匹配的文件')).toBeVisible()
  })
})

describe('WorkspaceFilesPanel 宽屏：左树右预览', () => {
  it('没选文件时右边先显示排第一的顶层文件；点一行右边换成它，地址记下 file', async () => {
    const user = userEvent.setup()
    widePanel()
    seedMockWorkspace(CONVERSATION_ID)
    const { router } = await renderPanel()

    const preview = await screen.findByRole('region', { name: '文件预览' })
    expect(await within(preview).findByRole('heading', { name: 'storyboard.md' })).toBeVisible()
    expect(await within(preview).findByRole('columnheader', { name: '结构层级' })).toBeVisible()
    expect(await row('storyboard.md')).toHaveAttribute('aria-selected', 'true')
    expect(router.state.location.search).not.toHaveProperty('file')

    await user.click(await row('口播文案.txt'))

    expect(await within(preview).findByRole('heading', { name: '口播文案.txt' })).toBeVisible()
    // 纯文本照正文排，不进原文查看器
    expect(await within(preview).findByText(/开场：周末的早上，不想背太重的包。/)).toBeVisible()
    expect(within(preview).queryByRole('textbox', { name: '文件内容' })).not.toBeInTheDocument()
    expect(router.state.location.search).toMatchObject({ file: '口播文案.txt' })
    expect(await row('口播文案.txt')).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('button', { name: '返回文件列表' })).not.toBeInTheDocument()
  })

  it('有 final-cut 主文件时默认显示它', async () => {
    widePanel()
    seedMockWorkspace(CONVERSATION_ID)
    putMockWorkspaceFile(CONVERSATION_ID, 'final-cut/index.html', '<html><body></body></html>')
    await renderPanel()
    const preview = await screen.findByRole('region', { name: '文件预览' })
    expect(
      await within(preview).findByRole('heading', { name: 'final-cut/index.html' }),
    ).toBeVisible()
  })

  it('地址带着文件时直接显示那一份，它所在的目录展开、那一行选中', async () => {
    widePanel()
    seedMockWorkspace(CONVERSATION_ID)
    await renderPanel(`/c/${CONVERSATION_ID}?file=frames/extraction.json`)

    const preview = await screen.findByRole('region', { name: '文件预览' })
    expect(
      await within(preview).findByRole('heading', { name: 'frames/extraction.json' }),
    ).toBeVisible()
    expect(await row('extraction.json')).toHaveAttribute('aria-selected', 'true')
  })

  it('这份文件本身是某个页签的文档时，给一个直达那个页签的按钮', async () => {
    const user = userEvent.setup()
    widePanel()
    seedMockWorkspace(CONVERSATION_ID)
    const { router } = await renderPanel(`/c/${CONVERSATION_ID}?file=video_shot.json`)

    await user.click(await screen.findByRole('button', { name: '打开分镜' }))

    expect(router.state.location.search).toMatchObject({ artifact: 'file:video_shot.json' })
  })

  it('final-cut 主文件给「打开 final-cut」；只读对话里 final-cut 页签不出现，也就没有这个按钮', async () => {
    const user = userEvent.setup()
    widePanel()
    seedMockWorkspace(CONVERSATION_ID)
    putMockWorkspaceFile(CONVERSATION_ID, 'final-cut/index.html', '<!doctype html>')
    const { router, unmount } = await renderPanel(`/c/${CONVERSATION_ID}?file=final-cut/index.html`)

    await user.click(await screen.findByRole('button', { name: '打开 final-cut' }))
    expect(router.state.location.search).toMatchObject({ artifact: 'final-cut' })
    unmount()

    await renderPanel(`/c/${CONVERSATION_ID}?file=final-cut/index.html`, { readOnly: true })
    expect(await screen.findByRole('heading', { name: 'final-cut/index.html' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '打开 final-cut' })).not.toBeInTheDocument()
  })

  it('agent 增删文件后目录树跟着变；正看着的文件被删就说明白', async () => {
    const user = userEvent.setup()
    widePanel()
    seedMockWorkspace(CONVERSATION_ID)
    putMockWorkspaceFile(CONVERSATION_ID, 'notes/draft.md', '## 草稿')
    const { queryClient } = await renderPanel()
    await user.click(await row('draft.md'))
    expect(await screen.findByRole('heading', { name: 'notes/draft.md' })).toBeVisible()

    seedMockWorkspace(CONVERSATION_ID)
    putMockWorkspaceFile(CONVERSATION_ID, 'notes/final.md', '## 定稿')
    await queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all(CONVERSATION_ID) })

    expect(await row('final.md')).toBeVisible()
    expect(screen.queryByRole('treeitem', { name: 'draft.md' })).not.toBeInTheDocument()
    expect(await screen.findByText('该文件已不存在')).toBeVisible()
  })

  it('「复制原文」复制的是文件原文', async () => {
    const user = userEvent.setup()
    widePanel()
    seedMockWorkspace(CONVERSATION_ID)
    await renderPanel(`/c/${CONVERSATION_ID}?file=口播文案.txt`)
    await screen.findByText(/开场：周末的早上/)

    await user.click(screen.getByRole('button', { name: '复制原文' }))

    await expect(navigator.clipboard.readText()).resolves.toMatch(/^开场：周末的早上/)
  })

  it('JSON 排成两格缩进再显示；「全部收起」收起根下面的每一段、根留着，按钮换成「全部展开」', async () => {
    const user = userEvent.setup()
    widePanel()
    seedMockWorkspace(CONVERSATION_ID)
    putMockWorkspaceFile(CONVERSATION_ID, 'notes/compact.json', '{"shots":[{"id":"s1"}],"fps":5}')
    await renderPanel(`/c/${CONVERSATION_ID}?file=notes/compact.json`)

    const source = await screen.findByRole('textbox', { name: '文件内容' })
    expect(source).toHaveAttribute('aria-readonly', 'true')
    // 每行一个块，textContent 里没有换行：和排好的原文去掉换行一致
    const formatted = JSON.stringify({ fps: 5, shots: [{ id: 's1' }] }, ['shots', 'id', 'fps'], 2)
    expect(source.textContent).toBe(formatted.replaceAll('\n', ''))

    await user.click(screen.getByRole('button', { name: '全部收起' }))

    expect(source).not.toHaveTextContent('"id": "s1"')
    // 根对象不收：它的直接字段还看得见
    expect(source).toHaveTextContent('"fps": 5')
    expect(await screen.findByRole('button', { name: '全部展开' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: '全部展开' }))
    expect(source).toHaveTextContent('"id": "s1"')
  })

  it('JSON 解析不了时照原文显示并说明', async () => {
    widePanel()
    seedMockWorkspace(CONVERSATION_ID)
    putMockWorkspaceFile(CONVERSATION_ID, 'broken.json', '{"shots": [')
    await renderPanel(`/c/${CONVERSATION_ID}?file=broken.json`)

    expect(await screen.findByText('JSON 格式有误，已按原文显示')).toBeVisible()
    expect(screen.getByRole('textbox', { name: '文件内容' })).toHaveTextContent('{"shots": [')
  })

  it('文件已经没了就说明白', async () => {
    widePanel()
    seedMockWorkspace(CONVERSATION_ID)
    await renderPanel(`/c/${CONVERSATION_ID}?file=gone.md`)

    expect(await screen.findByText('该文件已不存在')).toBeVisible()
  })
})

describe('WorkspaceFilesPanel 窄屏：列表 → 阅读', () => {
  it('点一行进阅读页，地址记下 file；返回回到目录树，刚看过的那一行选中并接回焦点', async () => {
    const user = userEvent.setup()
    seedMockWorkspace(CONVERSATION_ID)
    const { router } = await renderPanel()

    await user.click(await row('extraction.json'))

    expect(await screen.findByRole('heading', { name: 'frames/extraction.json' })).toBeVisible()
    expect(screen.queryByRole('tree')).not.toBeInTheDocument()
    expect(router.state.location.search).toMatchObject({ file: 'frames/extraction.json' })

    await user.click(screen.getByRole('button', { name: '返回文件列表' }))

    const last = await row('extraction.json')
    expect(last).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(last).toHaveFocus())
    expect(router.state.location.search).not.toHaveProperty('file')
  })

  it('文件已经没了就说明白，能回列表', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    await renderPanel(`/c/${CONVERSATION_ID}?file=gone.md`)

    expect(await screen.findByText('该文件已不存在')).toBeVisible()
    expect(screen.getByRole('button', { name: '返回文件列表' })).toBeVisible()
  })
})
