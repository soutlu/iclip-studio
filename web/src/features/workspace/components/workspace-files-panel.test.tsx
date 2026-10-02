import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '@/testing/mocks/server'
import { seedMockWorkspace } from '@/testing/mocks/workspace'
import { renderWithProviders } from '@/testing/render'
import { ArtifactRegistry, WorkbenchRegistryProvider } from '@/shared/workbench'
import { WorkspaceFilesPanel } from './workspace-files-panel'

const CONVERSATION_ID = '4d3a7f8e-1b2c-4d5e-8f90-a1b2c3d4e5f6'

const artifact = {
  id: 'workspace',
  source: { fileCount: 4, kind: 'workspace' },
  title: '文件',
  type: 'workspace',
} as const

const renderPanel = (initialPath = `/c/${CONVERSATION_ID}`) => {
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
  return renderWithProviders(
    <WorkbenchRegistryProvider registry={registry}>
      <WorkspaceFilesPanel artifact={artifact} conversationId={CONVERSATION_ID} readOnly={false} />
    </WorkbenchRegistryProvider>,
    { initialPath },
  )
}

describe('WorkspaceFilesPanel 列表', () => {
  it('按目录分组列出文件：根目录在前，目录名不带斜杠；大小与时间各占一列', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    await renderPanel()

    const root = await screen.findByRole('region', { name: '根目录' })
    expect(within(root).getByRole('button', { name: /storyboard\.md/ })).toBeVisible()
    const shots = within(root).getByRole('button', { name: /video_shot\.json/ })
    expect(within(shots).getByText(/^\d+(\.\d)? KB$/)).toBeVisible()
    expect(within(shots).getByText(/^\d{2}:\d{2}$/)).toBeVisible()

    expect(screen.getByRole('heading', { name: 'frames' })).toBeVisible()
    const frames = screen.getByRole('region', { name: 'frames' })
    expect(within(frames).getByRole('button', { name: /extraction\.json/ })).toBeVisible()
  })

  it('没有文件就是空态', async () => {
    server.use(
      http.get('*/api/conversations/:conversationId/workspace/files', () =>
        HttpResponse.json({ files: [] }),
      ),
    )
    await renderPanel()

    expect(await screen.findByText('还没有文件')).toBeVisible()
    expect(screen.getByText('agent 写下的每一份文件都会列在这里。')).toBeVisible()
  })
})

describe('WorkspaceFilesPanel 阅读', () => {
  it('点一行进阅读，地址记下 file；Markdown 排成文档；返回回到列表并清掉 file', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const { router } = await renderPanel()

    await userEvent.click(await screen.findByRole('button', { name: /storyboard\.md/ }))

    expect(await screen.findByRole('columnheader', { name: '结构层级' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'storyboard.md' })).toBeVisible()
    expect(screen.queryByText('MD')).not.toBeInTheDocument()
    expect(router.state.location.search).toMatchObject({ file: 'storyboard.md' })

    await userEvent.click(screen.getByRole('button', { name: '返回文件列表' }))

    expect(await screen.findByRole('region', { name: '根目录' })).toBeVisible()
    expect(router.state.location.search).not.toHaveProperty('file')
  })

  it('从阅读页返回，刚看过的那一行留下标记并接回焦点', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    await renderPanel()

    await userEvent.click(await screen.findByRole('button', { name: /extraction\.json/ }))
    await userEvent.click(await screen.findByRole('button', { name: '返回文件列表' }))

    const row = await screen.findByRole('button', { name: /extraction\.json/ })
    expect(row).toHaveAttribute('aria-current', 'true')
    expect(row).toHaveFocus()
    expect(screen.getByRole('button', { name: /storyboard\.md/ })).not.toHaveAttribute(
      'aria-current',
    )
  })

  it('JSON 直接是格式化视图：页头是目录加文件名，没有「看原文」与类型标签', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    await renderPanel(`/c/${CONVERSATION_ID}?file=frames%2Fextraction.json`)

    expect(await screen.findByRole('button', { name: '收起 boards' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'frames/extraction.json' })).toBeVisible()
    expect(screen.getByRole('button', { name: '查看图片：图片' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '看原文' })).not.toBeInTheDocument()
    expect(screen.queryByText('JSON')).not.toBeInTheDocument()
  })

  it('纯文本按原样换行整段显示，没有行号', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    await renderPanel(`/c/${CONVERSATION_ID}?file=${encodeURIComponent('口播文案.txt')}`)

    const body = await screen.findByText(/^开场：周末的早上/)
    expect(body.textContent).toContain('开场：周末的早上，不想背太重的包。\n\n它能装下')
    for (const number of ['1', '2', '9']) {
      expect(screen.queryByText(number)).not.toBeInTheDocument()
    }
  })

  it('空文件说一句「这份文件还是空的」', async () => {
    server.use(
      http.get('*/api/conversations/:conversationId/workspace/file', () =>
        HttpResponse.json({ file: { content: '', path: 'notes.json', version: 1 } }),
      ),
    )
    await renderPanel(`/c/${CONVERSATION_ID}?file=notes.json`)

    expect(await screen.findByText('这份文件还是空的')).toBeVisible()
    expect(screen.queryByText('JSON 格式有误，按原文显示')).not.toBeInTheDocument()
  })

  it('这份文件本身是别的产物时，给一个去那边打开的入口', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const { router } = await renderPanel(`/c/${CONVERSATION_ID}?file=video_shot.json`)

    await userEvent.click(await screen.findByRole('button', { name: '在分镜里打开' }))

    expect(router.state.location.search).toMatchObject({ artifact: 'file:video_shot.json' })
  })

  it('文件已经没了就说明白，能回列表', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    await renderPanel(`/c/${CONVERSATION_ID}?file=gone.md`)

    expect(await screen.findByText('这个文件已经不在了')).toBeVisible()
    expect(screen.getByRole('button', { name: '返回文件列表' })).toBeVisible()
  })
})
