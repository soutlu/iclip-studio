import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
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
      <WorkspaceFilesPanel
        conversationTitle="夜景延时素材生成"
        artifact={artifact}
        conversationId={CONVERSATION_ID}
        readOnly={false}
      />
    </WorkbenchRegistryProvider>,
    { initialPath },
  )
}

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

  it('这份文件本身是别的产物时，给一个去那边打开的入口', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    const { router } = await renderPanel(`/c/${CONVERSATION_ID}?file=video_shot.json`)

    await userEvent.click(await screen.findByRole('button', { name: '在分镜里打开' }))

    expect(router.state.location.search).toMatchObject({ artifact: 'file:video_shot.json' })
  })

  it('文件已经没了就说明白，能回列表', async () => {
    seedMockWorkspace(CONVERSATION_ID)
    await renderPanel(`/c/${CONVERSATION_ID}?file=gone.md`)

    expect(await screen.findByText('该文件已不存在')).toBeVisible()
    expect(screen.getByRole('button', { name: '返回文件列表' })).toBeVisible()
  })
})
