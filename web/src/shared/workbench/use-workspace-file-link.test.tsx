import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import { ArtifactRegistry } from './registry'
import { useWorkspaceFileLink } from './use-workspace-file-link'

const registry = () => {
  const value = new ArtifactRegistry()
  value.register({
    autoOpen: false,
    component: () => null,
    icon: 'grid',
    label: '画布',
    match: { pattern: 'canvas/*.canvas.json' },
    title: () => '画布',
    type: 'canvas',
  })
  return value
}

function FileLink({ path }: { path: string }) {
  const link = useWorkspaceFileLink()
  return (
    <button onClick={() => link.open(path)} type="button">
      {path}
    </button>
  )
}

describe('useWorkspaceFileLink', () => {
  it('按模式认领的文件进它自己的面板', async () => {
    const { router } = await renderWithProviders(<FileLink path="canvas/a.canvas.json" />, {
      registry: registry(),
    })

    await userEvent.click(screen.getByRole('button', { name: 'canvas/a.canvas.json' }))

    expect(router.state.location.search).toEqual({ artifact: 'file:canvas/a.canvas.json' })
  })

  it('模式认不得的文件进「文件」页阅读', async () => {
    const { router } = await renderWithProviders(<FileLink path="canvas/sub/b.canvas.json" />, {
      registry: registry(),
    })

    await userEvent.click(screen.getByRole('button', { name: 'canvas/sub/b.canvas.json' }))

    expect(router.state.location.search).toEqual({
      artifact: 'workspace',
      file: 'canvas/sub/b.canvas.json',
    })
  })
})
