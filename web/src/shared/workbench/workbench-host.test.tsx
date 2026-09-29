/** 受控宿主夹具通过恢复入口与隐藏容器模拟应用壳，验证产物交互与布局请求。 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useCallback, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { ShellChromeContext } from '@/shared/shell'
import type { ArtifactEntry, ArtifactRendererProps } from './artifact'
import { useOpenArtifact } from './artifact-search'
import { ArtifactRegistry } from './registry'
import { useWorkbenchSelection } from './use-workbench-selection'
import { WorkbenchHost } from './workbench-host'
import type { WorkbenchLayout } from './workbench-layout-context'
import { WorkbenchLayoutProvider } from './workbench-layout-provider'
import { WorkbenchRegistryProvider } from './workbench-registry-provider'

const CONVERSATION_ID = 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d'

const Painted = ({ artifact }: ArtifactRendererProps) => <p>画着{artifact.title}</p>

const shotsEntry: ArtifactEntry = {
  autoOpen: true,
  component: Painted,
  empty: 'agent 交付分镜后出现',
  icon: 'grid',
  label: '分镜',
  match: { path: 'video_shot.json' },
  title: () => '分镜',
  type: 'storyboard',
}

const workspaceEntry: ArtifactEntry = {
  autoOpen: false,
  component: Painted,
  empty: '还没有文件',
  icon: 'folder',
  label: '文件',
  match: { workspace: true },
  title: () => '文件',
  type: 'workspace',
}

const agentEntry: ArtifactEntry = {
  autoOpen: false,
  component: Painted,
  icon: 'agent',
  label: '委派任务',
  match: { displayKind: 'agent_call' },
  title: () => '委派任务 · 拆解',
  type: 'sub-agent',
}

const registryWith = (...entries: ArtifactEntry[]) => {
  const registry = new ArtifactRegistry()
  for (const entry of entries) registry.register(entry)
  return registry
}

const serveFiles = (paths: string[]) => {
  server.use(
    http.get('*/api/conversations/:conversationId/workspace/files', () =>
      HttpResponse.json({
        files: paths.map((path) => ({
          path,
          sizeBytes: 10,
          updatedAt: '2026-09-01T10:00:00Z',
          version: 1,
        })),
      }),
    ),
  )
}

type LayoutSize = Pick<WorkbenchLayout, 'compact' | 'sideBySide'>

const ROOMY: LayoutSize = { compact: false, sideBySide: true }

function ControlledHost({
  layout,
  onOpenRequest,
}: {
  layout: LayoutSize
  onOpenRequest?: WorkbenchLayout['onOpen']
}) {
  const [collapsed, setCollapsed] = useState(true)
  const onOpen = useCallback<WorkbenchLayout['onOpen']>(
    (reason) => {
      onOpenRequest?.(reason)
      setCollapsed(false)
    },
    [onOpenRequest],
  )
  const { requestOpen } = useWorkbenchSelection()
  const openArtifact = useOpenArtifact()
  return (
    <WorkbenchLayoutProvider
      layout={{
        ...layout,
        collapsed,
        onCollapsedChange: setCollapsed,
        onOpen,
      }}
    >
      <button
        onClick={() => {
          requestOpen()
          void openArtifact('file:video_shot.json')
        }}
        type="button"
      >
        从对话查看分镜
      </button>
      {collapsed ? (
        <button onClick={() => onOpen('explicit')} type="button">
          展开工作台
        </button>
      ) : layout.compact ? (
        <button onClick={() => setCollapsed(true)} type="button">
          回到对话
        </button>
      ) : null}
      <div hidden={collapsed}>
        <WorkbenchHost conversationId={CONVERSATION_ID} />
      </div>
    </WorkbenchLayoutProvider>
  )
}

const renderHost = (
  layout: LayoutSize = ROOMY,
  registry = registryWith(shotsEntry, workspaceEntry),
  initialPath = '/',
) =>
  renderWithProviders(
    <WorkbenchRegistryProvider registry={registry}>
      <ControlledHost layout={layout} />
    </WorkbenchRegistryProvider>,
    { initialPath },
  )

const fsChanged = (path: string, change: 'created' | 'modified' | 'deleted') => ({
  payload: { changes: [{ change, kind: 'file', path }], coalesced_window_ms: 0 },
  session_id: CONVERSATION_ID,
  type: 'event.fs.changed',
})

/** 主流快照：一轮里一张派出了子代理的工具卡。 */
const delegationReset = (state: 'running' | 'done') => ({
  payload: {
    agent_id: 'main',
    seq: 1,
    snapshot: {
      attachments: [],
      interactions: [],
      items: [
        {
          content: [],
          kind: 'turn',
          ordinal: 0,
          origin: { kind: 'user' },
          state: 'completed',
          steps: [
            {
              frames: [
                {
                  agentRefs: [{ agentId: 'run-1', role: 'child' }],
                  display: { agent_name: '拆解', kind: 'agent_call', prompt: '拆' },
                  frameId: 'f1',
                  kind: 'tool',
                  name: 'delegate',
                  state,
                  toolCallId: 'call_d1',
                },
              ],
              kind: 'step',
              ordinal: 0,
              state: 'completed',
              stepId: 's1',
              turnId: 't1',
            },
          ],
          turnId: 't1',
        },
      ],
      meta: {},
      prompts: [],
      tasks: [],
      todos: [],
    },
  },
  session_id: CONVERSATION_ID,
  type: 'transcript.reset',
})

describe('WorkbenchHost 收起态', () => {
  it('一份文件都没有时收着；点开是选择页，常驻的两行都灰着，各带一句为什么', async () => {
    serveFiles([])
    await renderHost()

    await userEvent.click(await screen.findByRole('button', { name: '展开工作台' }))

    const chooser = await screen.findByRole('navigation', { name: '能打开的产物' })
    const shots = within(chooser).getByRole('button', { name: /分镜/ })
    expect(shots).toHaveAttribute('aria-disabled', 'true')
    expect(shots).toHaveTextContent('agent 交付分镜后出现')
    const files = within(chooser).getByRole('button', { name: /文件/ })
    expect(files).toHaveAttribute('aria-disabled', 'true')
    expect(files).toHaveTextContent('还没有文件')
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  })

  it('只有普通文件时不自动展开；点开是选择页，选「文件」才画它，地址记下这件产物', async () => {
    serveFiles(['video/a.md'])
    const { router } = await renderHost()

    expect(await screen.findByRole('button', { name: '展开工作台' })).toBeVisible()
    expect(screen.queryByText('画着文件')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '展开工作台' }))
    const chooser = await screen.findByRole('navigation', { name: '能打开的产物' })
    expect(screen.queryByText('画着文件')).not.toBeInTheDocument()

    await userEvent.click(within(chooser).getByRole('button', { name: '文件' }))

    expect(await screen.findByText('画着文件')).toBeVisible()
    expect(screen.getByRole('tab', { name: '文件', selected: true })).toBeVisible()
    expect(router.state.location.search).toMatchObject({ artifact: 'workspace' })
  })

  it('派活卡在选择页里一件一行，点它打开子代理那条流', async () => {
    serveFiles([])
    const { socket } = await renderHost(ROOMY, registryWith(shotsEntry, workspaceEntry, agentEntry))
    await screen.findByRole('button', { name: '展开工作台' })
    socket.deliver(delegationReset('running'))

    await userEvent.click(screen.getByRole('button', { name: '展开工作台' }))
    const chooser = await screen.findByRole('navigation', { name: '能打开的产物' })
    await userEvent.click(within(chooser).getByRole('button', { name: '委派任务 · 拆解' }))

    expect(await screen.findByText('画着委派任务 · 拆解')).toBeVisible()
  })

  it('紧凑屏保持收起，哪怕分镜已经交付', async () => {
    serveFiles(['video_shot.json'])
    await renderHost({ compact: true, sideBySide: false })

    expect(await screen.findByRole('button', { name: '展开工作台' })).toBeVisible()
    expect(await screen.findByText('画着分镜')).not.toBeVisible()
  })
})

describe('WorkbenchHost 展开态', () => {
  it('区分产物自动选择与用户显式查看的展开请求', async () => {
    serveFiles(['video_shot.json'])
    const onOpenRequest = vi.fn<WorkbenchLayout['onOpen']>()
    await renderWithProviders(
      <WorkbenchRegistryProvider registry={registryWith(shotsEntry, workspaceEntry)}>
        <ControlledHost layout={ROOMY} onOpenRequest={onOpenRequest} />
      </WorkbenchRegistryProvider>,
    )
    await screen.findByText('画着分镜')
    expect(onOpenRequest).toHaveBeenLastCalledWith('automatic')

    await userEvent.click(screen.getByRole('button', { name: '从对话查看分镜' }))

    expect(onOpenRequest).toHaveBeenLastCalledWith('explicit')
  })

  it('换位请求交给应用壳，当前产物仍保留', async () => {
    serveFiles(['video_shot.json'])
    const onSwapPanes = vi.fn()
    await renderWithProviders(
      <ShellChromeContext value={{ onSwapPanes, sidebarOverlay: false }}>
        <WorkbenchRegistryProvider registry={registryWith(shotsEntry, workspaceEntry)}>
          <ControlledHost layout={ROOMY} />
        </WorkbenchRegistryProvider>
      </ShellChromeContext>,
    )
    const painted = await screen.findByText('画着分镜')
    await waitFor(() => expect(painted).toBeVisible())

    await userEvent.click(screen.getByRole('button', { name: '交换对话与工作台' }))

    expect(onSwapPanes).toHaveBeenCalledTimes(1)
    expect(screen.getByText('画着分镜')).toBe(painted)
  })

  it('分镜交付即自动展开，标签栏里分镜与文件并排，分镜是当前', async () => {
    serveFiles(['video_shot.json', 'video/a.md'])
    await renderHost()

    expect(await screen.findByText('画着分镜')).toBeVisible()
    expect(screen.getByRole('tab', { name: '分镜', selected: true })).toBeVisible()
    expect(screen.getByRole('tab', { name: '文件', selected: false })).toBeVisible()
  })

  it('点「文件」标签切过去，再点回分镜', async () => {
    serveFiles(['video_shot.json'])
    await renderHost()
    await screen.findByText('画着分镜')

    await userEvent.click(screen.getByRole('tab', { name: '文件' }))
    expect(await screen.findByText('画着文件')).toBeVisible()

    await userEvent.click(screen.getByRole('tab', { name: '分镜' }))
    expect(await screen.findByText('画着分镜')).toBeVisible()
  })

  it('派活卡只有被地址点名时才占标签位，切到别的标签它就退回菜单', async () => {
    serveFiles(['video_shot.json'])
    const registry = registryWith(shotsEntry, workspaceEntry, agentEntry)
    // mock 主流的冷读里本来就有一张派活卡 call_t2_delegate。
    await renderHost(ROOMY, registry, `/c/${CONVERSATION_ID}?artifact=frame:call_t2_delegate`)

    expect(await screen.findByText('画着委派任务 · 拆解')).toBeVisible()
    expect(screen.getByRole('tab', { name: '委派任务 · 拆解', selected: true })).toBeVisible()

    await userEvent.click(screen.getByRole('tab', { name: '分镜' }))

    expect(await screen.findByText('画着分镜')).toBeVisible()
    expect(screen.queryByRole('tab', { name: '委派任务 · 拆解' })).not.toBeInTheDocument()
  })

  it('订着整个工作区：video_shot.json 一落地，面板自己展开、分镜标签出现', async () => {
    serveFiles(['video/a.md'])
    const { socket } = await renderHost()
    await screen.findByRole('button', { name: '展开工作台' })
    const asked = socket
      .frames()
      .find((frame) => frame.type === 'watch_fs_add' && frame.payload?.['recursive'] === true)
    expect(asked?.payload).toMatchObject({ paths: [''], session_id: CONVERSATION_ID })

    serveFiles(['video/a.md', 'video_shot.json'])
    socket.deliver(fsChanged('video_shot.json', 'created'))

    expect(await screen.findByText('画着分镜')).toBeVisible()
    expect(screen.getByRole('tab', { name: '分镜', selected: true })).toBeVisible()
  })

  it('放不下并排时是二选一形态：只给「回到对话」，点了退回菜单钮', async () => {
    serveFiles(['video_shot.json'])
    await renderHost({ compact: false, sideBySide: false })

    expect(await screen.findByText('画着分镜')).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: '回到对话' }))

    expect(screen.getByRole('button', { name: '展开工作台' })).toBeVisible()
    expect(await screen.findByText('画着分镜')).not.toBeVisible()
  })

  it('用户折叠后保留产物渲染器，恢复入口可以再展开', async () => {
    serveFiles(['video_shot.json'])
    await renderHost()
    const painted = await screen.findByText('画着分镜')
    await waitFor(() => expect(painted).toBeVisible())

    await userEvent.click(screen.getByRole('button', { name: '折叠工作台' }))
    expect(painted).not.toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: '展开工作台' }))

    expect(screen.getByText('画着分镜')).toBe(painted)
    expect(painted).toBeVisible()
  })

  it('紧凑屏显式查看可以展开，折叠后查看同一产物也重新展开', async () => {
    serveFiles(['video_shot.json'])
    await renderHost({ compact: true, sideBySide: false })
    const painted = await screen.findByText('画着分镜')
    expect(painted).not.toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: '从对话查看分镜' }))
    await waitFor(() => expect(painted).toBeVisible())
    await userEvent.click(screen.getByRole('button', { name: '回到对话' }))
    expect(painted).not.toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: '从对话查看分镜' }))
    await waitFor(() => expect(painted).toBeVisible())
  })
})
