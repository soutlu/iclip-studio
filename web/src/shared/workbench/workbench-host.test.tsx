import { MOCK_STREAM_EPOCH } from '@/testing/mocks/transcript'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useCallback, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addMockConversation } from '@/testing/mocks/conversations'
import { loginAs, mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { ApiError } from '@/shared/api/client'
import { ShellChromeContext } from '@/shared/shell'
import { toast, Toaster } from '@/shared/ui/toast'
import type { ArtifactCreate, ArtifactEntry, ArtifactRendererProps } from './artifact'
import { useOpenArtifact } from './artifact-search'
import { ArtifactRegistry } from './registry'
import { useWorkbenchOpenRequest } from './use-workbench-open-request'
import { WorkbenchHeaderActions } from './workbench-header-actions'
import { WorkbenchHost } from './workbench-host'
import type { WorkbenchLayout } from './workbench-layout-context'
import { WorkbenchLayoutProvider } from './workbench-layout-provider'
import { WorkbenchRegistryProvider } from './workbench-registry-provider'

const CONVERSATION_ID = 'ff2c1c0e-6c4f-4f0e-9a2b-0f2f3a4b5c6d'
const OTHER_USER_ID = '7d3e2f1a-0b9c-4d8e-8f7a-6b5c4d3e2f1a'

const Painted = ({ artifact }: ArtifactRendererProps) => <p>画着{artifact.title}</p>

const WithHeaderAction = (props: ArtifactRendererProps) => (
  <>
    <Painted {...props} />
    <WorkbenchHeaderActions>
      <button type="button">页签自己的操作</button>
    </WorkbenchHeaderActions>
  </>
)

const shotsEntry: ArtifactEntry = {
  autoOpen: true,
  component: Painted,
  empty: '暂无',
  icon: 'grid',
  label: '分镜',
  match: { path: 'video_shot.json' },
  title: () => '分镜',
  type: 'storyboard',
}

const workspaceEntry: ArtifactEntry = {
  autoOpen: false,
  component: Painted,
  empty: '暂无',
  icon: 'folder',
  label: '文件',
  match: { workspace: true },
  title: () => '文件',
  type: 'workspace',
}

const EDIT_MAIN = 'edit/index.html'

/** 能新建的类型：主文件在时才有；`run` 缺省时照服务端那样把主文件加进工作区，答复它的路径。 */
const creatableEntry = (run?: ArtifactCreate['run']): ArtifactEntry => ({
  autoOpen: false,
  component: Painted,
  create: {
    agentCreatedNotice: 'agent 已创建剪辑目录',
    run:
      run ??
      (() => {
        addFile(EDIT_MAIN)
        return Promise.resolve(EDIT_MAIN)
      }),
  },
  hiddenWhenReadOnly: true,
  icon: 'film',
  label: '剪辑',
  match: { anyPath: [EDIT_MAIN] },
  title: () => '剪辑',
  type: 'editing',
})

const agentEntry: ArtifactEntry = {
  autoOpen: false,
  component: Painted,
  icon: 'agent',
  label: '委派任务',
  match: { displayKind: 'agent_call' },
  title: () => '委派任务 · 拆解',
  type: 'sub-agent',
}

const canvasEntry: ArtifactEntry = {
  autoOpen: false,
  component: Painted,
  empty: '还没有画布',
  icon: 'grid',
  label: '画布',
  match: { pattern: 'canvas/*.canvas.json' },
  title: (source) => `画布 ${source.kind === 'file' ? source.path : ''}`,
  type: 'canvas',
}

const scriptEntry: ArtifactEntry = {
  autoOpen: false,
  component: Painted,
  icon: 'video',
  label: '剧本',
  match: { path: 'script.md' },
  title: () => '剧本',
  type: 'script',
}

const registryWith = (...entries: ArtifactEntry[]) => {
  const registry = new ArtifactRegistry()
  for (const entry of entries) registry.register(entry)
  return registry
}

// 工作区里现在的文件：每个用例开头用 serveFiles 换一份
let served: string[] = []

const serveFiles = (paths: string[]) => {
  served = paths
  server.use(
    http.get('*/api/conversations/:conversationId/workspace/files', () =>
      HttpResponse.json({
        files: served.map((path) => ({
          path,
          sizeBytes: 10,
          updatedAt: '2026-09-01T10:00:00Z',
          version: 1,
        })),
      }),
    ),
  )
}

const addFile = (path: string) => {
  served = [...served, path]
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
  // 外框收起工作台时给的竖条插槽（应用里在 AppContentPane 的竖条里）
  const [railSlot, setRailSlot] = useState<HTMLElement | null>(null)
  const onOpen = useCallback<WorkbenchLayout['onOpen']>(
    (reason) => {
      onOpenRequest?.(reason)
      setCollapsed(false)
    },
    [onOpenRequest],
  )
  const { requestOpen } = useWorkbenchOpenRequest()
  const openArtifact = useOpenArtifact()
  return (
    <WorkbenchLayoutProvider
      layout={{
        ...layout,
        collapsed,
        onCollapsedChange: setCollapsed,
        onOpen,
        railSlot,
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
        <section aria-label="收起的工作台">
          <button onClick={() => onOpen('explicit')} type="button">
            展开工作台
          </button>
          {layout.compact ? null : <div ref={setRailSlot} />}
        </section>
      ) : layout.compact ? (
        <button onClick={() => setCollapsed(true)} type="button">
          回到对话
        </button>
      ) : null}
      <div hidden={collapsed}>
        <WorkbenchHost conversationId={CONVERSATION_ID} />
      </div>
      <Toaster />
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
  payload: { changes: [{ change, path }] },
  session_id: CONVERSATION_ID,
  timestamp: '2026-10-30T08:00:00+00:00',
  type: 'event.fs.changed',
})

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
    type: 'transcript.reset',
  },
  session_id: CONVERSATION_ID,
  stream_epoch: MOCK_STREAM_EPOCH,
  type: 'transcript.reset',
})

describe('WorkbenchHost 收起态', () => {
  it('一份文件都没有时收着；点开是选择页，顶栏写「工作台」，常驻的两行都灰着、写「暂无」', async () => {
    serveFiles([])
    await renderHost()

    await userEvent.click(await screen.findByRole('button', { name: '展开工作台' }))

    const chooser = await screen.findByRole('navigation', { name: '能打开的产物' })
    const shots = within(chooser).getByRole('button', { name: /分镜/ })
    expect(shots).toHaveAttribute('aria-disabled', 'true')
    expect(shots).toHaveTextContent('分镜暂无')
    const files = within(chooser).getByRole('button', { name: /文件/ })
    expect(files).toHaveAttribute('aria-disabled', 'true')
    expect(files).toHaveTextContent('文件暂无')
    expect(screen.getByText('工作台')).toBeVisible()
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

  it.each([
    { files: ['video/a.md'], rows: ['分镜暂无', '文件'] },
    {
      files: ['video/a.md', 'script.md'],
      rows: ['分镜暂无', '剧本', '文件'],
    },
  ])('没登记灰着原因的常驻类型等有了文件才列出：$files', async ({ files, rows }) => {
    serveFiles(files)
    await renderHost(ROOMY, registryWith(shotsEntry, scriptEntry, workspaceEntry))

    await userEvent.click(await screen.findByRole('button', { name: '展开工作台' }))

    const chooser = await screen.findByRole('navigation', { name: '能打开的产物' })
    await waitFor(() =>
      expect(
        within(chooser)
          .getAllByRole('button')
          .map((row) => row.textContent),
      ).toEqual(rows),
    )
  })

  it('按模式认领的类型也常驻：还没有那类文件时选择页照样列一行灰的', async () => {
    serveFiles(['video/a.md'])
    await renderHost(ROOMY, registryWith(shotsEntry, canvasEntry, workspaceEntry))

    await userEvent.click(await screen.findByRole('button', { name: '展开工作台' }))

    const chooser = await screen.findByRole('navigation', { name: '能打开的产物' })
    const canvas = within(chooser).getByRole('button', { name: /画布/ })
    expect(canvas).toHaveAttribute('aria-disabled', 'true')
    expect(canvas).toHaveTextContent('还没有画布')
  })

  it('同一常驻类型有几件产物就列几行，按登记顺序排在各自类型下，点哪行开哪件', async () => {
    serveFiles(['canvas/a.canvas.json', 'video/a.md', 'canvas/b.canvas.json'])
    const { router } = await renderHost(
      ROOMY,
      registryWith(shotsEntry, canvasEntry, workspaceEntry),
    )

    await userEvent.click(await screen.findByRole('button', { name: '展开工作台' }))

    const chooser = await screen.findByRole('navigation', { name: '能打开的产物' })
    await waitFor(() =>
      expect(
        within(chooser)
          .getAllByRole('button')
          .map((row) => row.textContent),
      ).toEqual(['分镜暂无', '画布 canvas/a.canvas.json', '画布 canvas/b.canvas.json', '文件']),
    )

    await userEvent.click(
      within(chooser).getByRole('button', { name: '画布 canvas/b.canvas.json' }),
    )

    expect(await screen.findByText('画着画布 canvas/b.canvas.json')).toBeVisible()
    expect(router.state.location.search).toMatchObject({ artifact: 'file:canvas/b.canvas.json' })
    expect(
      screen.getByRole('tab', { name: '画布 canvas/a.canvas.json', selected: false }),
    ).toBeVisible()
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

  it.each([
    ['并排', ROOMY, '折叠工作台'],
    ['二选一', { compact: false, sideBySide: false }, '回到对话'],
  ])(
    '%s布局：页签放进顶栏右侧的控件在页签内容外面，和顶栏自己的按钮一起显示',
    async (_, layout, ownButton) => {
      serveFiles(['video_shot.json'])
      await renderHost(layout, registryWith({ ...shotsEntry, component: WithHeaderAction }))

      const action = await screen.findByRole('button', { name: '页签自己的操作' })
      expect(action).toBeVisible()
      expect(screen.getByRole('tabpanel')).not.toContainElement(action)
      expect(screen.getByRole('button', { name: ownButton })).toBeVisible()
    },
  )

  it('紧凑布局：顶栏没有交换、折叠按钮，页签放进顶栏右侧的控件照样显示', async () => {
    serveFiles(['video_shot.json'])
    await renderHost(
      { compact: true, sideBySide: false },
      registryWith({ ...shotsEntry, component: WithHeaderAction }),
    )
    await userEvent.click(screen.getByRole('button', { name: '从对话查看分镜' }))

    expect(await screen.findByRole('button', { name: '页签自己的操作' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '折叠工作台' })).toBeNull()
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

describe('WorkbenchHost · 只读时不显示的页签', () => {
  beforeEach(() => {
    loginAs(mockAuthUser)
  })

  /** 画出来时带上是不是只读：对话读到以后才算得出来。 */
  const PaintedWithAccess = ({ artifact, readOnly }: ArtifactRendererProps) => (
    <p>
      画着{artifact.title}
      {readOnly ? '（只读）' : '（可编辑）'}
    </p>
  )

  const withAccess = (entry: ArtifactEntry): ArtifactEntry => ({
    ...entry,
    component: PaintedWithAccess,
  })

  const filmEntry: ArtifactEntry = {
    autoOpen: true,
    component: PaintedWithAccess,
    icon: 'video',
    label: '制作',
    match: { path: 'film.icml' },
    title: () => '制作',
    type: 'film',
  }

  const editingEntry: ArtifactEntry = {
    autoOpen: false,
    component: PaintedWithAccess,
    hiddenWhenReadOnly: true,
    icon: 'video-type',
    label: '剪辑',
    match: { anyPath: ['video_shot.json', 'film.icml'] },
    title: () => '剪辑',
    type: 'editing',
  }

  const registry = () =>
    registryWith(withAccess(shotsEntry), filmEntry, editingEntry, withAccess(workspaceEntry))

  const tabNames = () => screen.getAllByRole('tab').map((tab) => tab.textContent)

  it.each([
    { files: ['video_shot.json'], first: '分镜', tabs: ['分镜', '剪辑', '文件'] },
    { files: ['film.icml', 'notes.md'], first: '制作', tabs: ['制作', '剪辑', '文件'] },
    {
      files: ['video_shot.json', 'film.icml'],
      first: '分镜',
      tabs: ['分镜', '制作', '剪辑', '文件'],
    },
  ])('有 $files 时多一个页签，排在「文件」前面，不自动打开', async ({ files, first, tabs }) => {
    serveFiles(files)
    await renderHost(ROOMY, registry(), `/c/${CONVERSATION_ID}`)

    expect(await screen.findByText(`画着${first}（可编辑）`)).toBeVisible()
    await waitFor(() => expect(tabNames()).toEqual(tabs))
    expect(screen.getByRole('tab', { name: '剪辑' })).toHaveAttribute('aria-selected', 'false')
  })

  it('分镜和工程文件都没有时没有这个页签，选择页里也不列', async () => {
    serveFiles(['notes.md'])
    await renderHost(ROOMY, registry(), `/c/${CONVERSATION_ID}`)

    await userEvent.click(await screen.findByRole('button', { name: '展开工作台' }))
    const chooser = await screen.findByRole('navigation', { name: '能打开的产物' })
    await waitFor(() =>
      expect(
        within(chooser)
          .getAllByRole('button')
          .map((row) => row.textContent),
      ).toEqual(['分镜暂无', '文件']),
    )
  })

  it('带着地址直接打开它', async () => {
    serveFiles(['video_shot.json'])
    const { router } = await renderHost(ROOMY, registry(), `/c/${CONVERSATION_ID}?artifact=editing`)

    expect(await screen.findByText('画着剪辑（可编辑）')).toBeVisible()
    expect(screen.getByRole('tab', { name: '剪辑', selected: true })).toBeVisible()
    expect(router.state.location.search).toMatchObject({ artifact: 'editing' })
  })

  it('只读查看别人的对话：没有这个页签，带着地址也打开不了，换成自动打开的那一个', async () => {
    addMockConversation('别人的对话', undefined, OTHER_USER_ID, CONVERSATION_ID)
    serveFiles(['video_shot.json', 'film.icml'])
    await renderHost(ROOMY, registry(), `/c/${CONVERSATION_ID}?artifact=editing`)

    expect(await screen.findByText('画着分镜（只读）')).toBeVisible()
    expect(tabNames()).toEqual(['分镜', '制作', '文件'])
    expect(screen.queryByText(/^画着剪辑/)).not.toBeInTheDocument()
  })
})

describe('WorkbenchHost · 新建', () => {
  beforeEach(() => {
    loginAs(mockAuthUser)
  })

  // 提示挂在全局：上一条用例的提示别留到下一条
  afterEach(() => {
    act(() => {
      toast.dismiss()
    })
  })

  const withCreatable = (run?: ArtifactCreate['run']) =>
    registryWith(shotsEntry, creatableEntry(run), workspaceEntry)

  const openCreateMenu = async () => {
    await userEvent.click(await screen.findByRole('button', { name: '新建' }))
    return screen.findByRole('menuitem', { name: '新建 剪辑' })
  }

  it('主文件不在时没有它的页签；「+」里点「新建 剪辑」：建好后直接切过去，不提示，「+」不再出现', async () => {
    serveFiles(['video_shot.json'])
    const { router } = await renderHost(ROOMY, withCreatable(), `/c/${CONVERSATION_ID}`)
    expect(await screen.findByText('画着分镜')).toBeVisible()
    expect(screen.queryByRole('tab', { name: '剪辑' })).not.toBeInTheDocument()

    await userEvent.click(await openCreateMenu())

    expect(await screen.findByText('画着剪辑')).toBeVisible()
    expect(screen.getByRole('tab', { name: '剪辑', selected: true })).toBeVisible()
    expect(router.state.location.search).toMatchObject({ artifact: 'editing' })
    expect(screen.queryByText('agent 已创建剪辑目录')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新建' })).not.toBeInTheDocument()
  })

  it('正在建时「+」换成转圈、不能再点', async () => {
    serveFiles(['video_shot.json'])
    let finish = () => {}
    const run = () =>
      new Promise<string>((resolve) => {
        finish = () => {
          addFile(EDIT_MAIN)
          resolve(EDIT_MAIN)
        }
      })
    await renderHost(ROOMY, withCreatable(run), `/c/${CONVERSATION_ID}`)

    await userEvent.click(await openCreateMenu())

    expect(await screen.findByRole('status', { name: '正在新建 剪辑' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '新建' })).not.toBeInTheDocument()
    finish()
    expect(await screen.findByRole('tab', { name: '剪辑', selected: true })).toBeVisible()
  })

  it.each([
    [
      '服务端给了原因',
      new ApiError(503, '剪辑 新建失败：服务暂不可用'),
      '剪辑 新建失败：服务暂不可用',
    ],
    ['没给原因', new Error('boom'), '剪辑 新建失败'],
  ])('新建失败（%s）：提示失败，还在原来的页签，「+」能再点', async (_, error, text) => {
    serveFiles(['video_shot.json'])
    await renderHost(
      ROOMY,
      withCreatable(() => Promise.reject(error)),
      `/c/${CONVERSATION_ID}`,
    )

    await userEvent.click(await openCreateMenu())

    expect(await screen.findByText(text)).toBeVisible()
    expect(screen.getByRole('tab', { name: '分镜', selected: true })).toBeVisible()
    expect(await screen.findByRole('button', { name: '新建' })).toBeVisible()
  })

  it('只读查看别人的对话：没有「+」', async () => {
    addMockConversation('别人的对话', undefined, OTHER_USER_ID, CONVERSATION_ID)
    serveFiles(['video_shot.json'])
    await renderHost(ROOMY, withCreatable(), `/c/${CONVERSATION_ID}`)

    expect(await screen.findByText('画着分镜')).toBeVisible()
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: '新建' })).not.toBeInTheDocument(),
    )
  })

  it('对话开着时 agent 写了主文件：切到它的页签，提示 agent 建好了', async () => {
    serveFiles(['video_shot.json'])
    const { router, socket } = await renderHost(ROOMY, withCreatable(), `/c/${CONVERSATION_ID}`)
    expect(await screen.findByText('画着分镜')).toBeVisible()

    addFile(EDIT_MAIN)
    socket.deliver(fsChanged(EDIT_MAIN, 'created'))

    expect(await screen.findByText('画着剪辑')).toBeVisible()
    expect(screen.getByRole('tab', { name: '剪辑', selected: true })).toBeVisible()
    expect(router.state.location.search).toMatchObject({ artifact: 'editing' })
    expect(await screen.findByText('agent 已创建剪辑目录')).toBeVisible()
  })

  it('打开对话时主文件已经在：页签照常排着，不切过去也不提示', async () => {
    serveFiles(['video_shot.json', EDIT_MAIN])
    await renderHost(ROOMY, withCreatable(), `/c/${CONVERSATION_ID}`)

    expect(await screen.findByText('画着分镜')).toBeVisible()
    expect(await screen.findByRole('tab', { name: '剪辑', selected: false })).toBeVisible()
    expect(screen.queryByText('agent 已创建剪辑目录')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新建' })).not.toBeInTheDocument()
  })

  it('开着它时主文件被删：页签消失，回到默认页签，「+」又能新建', async () => {
    serveFiles(['video_shot.json', EDIT_MAIN])
    const { socket } = await renderHost(
      ROOMY,
      withCreatable(),
      `/c/${CONVERSATION_ID}?artifact=editing`,
    )
    expect(await screen.findByText('画着剪辑')).toBeVisible()

    serveFiles(['video_shot.json'])
    socket.deliver(fsChanged(EDIT_MAIN, 'deleted'))

    expect(await screen.findByText('画着分镜')).toBeVisible()
    expect(screen.getByRole('tab', { name: '分镜', selected: true })).toBeVisible()
    expect(screen.queryByRole('tab', { name: '剪辑' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建' })).toBeVisible()
  })

  it('选择页：分隔线下是能新建的类型，点了建好并打开它', async () => {
    serveFiles([])
    await renderHost(ROOMY, withCreatable(), `/c/${CONVERSATION_ID}`)

    await userEvent.click(await screen.findByRole('button', { name: '展开工作台' }))
    const chooser = await screen.findByRole('navigation', { name: '能打开的产物' })
    await userEvent.click(within(chooser).getByRole('button', { name: '新建 剪辑' }))

    expect(await screen.findByText('画着剪辑')).toBeVisible()
    expect(screen.getByRole('tab', { name: '剪辑', selected: true })).toBeVisible()
  })

  it('收起成竖条：竖条里是常驻页签的图标和「+」；点图标展开并打开它，点「+」建好后展开并打开', async () => {
    serveFiles(['video_shot.json', 'video/a.md'])
    await renderHost(ROOMY, withCreatable(), `/c/${CONVERSATION_ID}`)
    await screen.findByText('画着分镜')
    await userEvent.click(screen.getByRole('button', { name: '折叠工作台' }))

    const rail = screen.getByRole('region', { name: '收起的工作台' })
    expect(
      within(rail)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label') ?? button.textContent),
    ).toEqual(['展开工作台', '分镜', '文件', '新建 剪辑'])

    await userEvent.click(within(rail).getByRole('button', { name: '文件' }))
    expect(await screen.findByText('画着文件')).toBeVisible()
    expect(screen.getByRole('tab', { name: '文件', selected: true })).toBeVisible()

    await userEvent.click(screen.getByRole('button', { name: '折叠工作台' }))
    await userEvent.click(
      within(screen.getByRole('region', { name: '收起的工作台' })).getByRole('button', {
        name: '新建 剪辑',
      }),
    )
    expect(await screen.findByText('画着剪辑')).toBeVisible()
    expect(screen.getByRole('tab', { name: '剪辑', selected: true })).toBeVisible()
  })
})

describe('WorkbenchHost · 委派任务页签', () => {
  const DELEGATE = `/c/${CONVERSATION_ID}?artifact=frame:call_t2_delegate`

  it('按 Delete 关掉，回到默认页签，焦点落在它上面', async () => {
    serveFiles(['video_shot.json'])
    const { router } = await renderHost(
      ROOMY,
      registryWith(shotsEntry, workspaceEntry, agentEntry),
      DELEGATE,
    )
    const tab = await screen.findByRole('tab', { name: '委派任务 · 拆解', selected: true })

    tab.focus()
    await userEvent.keyboard('{Delete}')

    expect(await screen.findByText('画着分镜')).toBeVisible()
    expect(screen.queryByRole('tab', { name: '委派任务 · 拆解' })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '分镜', selected: true })).toHaveFocus()
    expect(router.state.location.search).not.toHaveProperty('artifact', 'frame:call_t2_delegate')
  })

  it('点名字后面的 × 关掉；常驻页签没有 ×、按 Delete 不关', async () => {
    serveFiles(['video_shot.json'])
    await renderHost(ROOMY, registryWith(shotsEntry, workspaceEntry, agentEntry), DELEGATE)
    const tab = await screen.findByRole('tab', { name: '委派任务 · 拆解', selected: true })

    // × 只给鼠标点，不在无障碍树里
    const close = tab.querySelector('[aria-hidden="true"]:has(svg)')
    if (!(close instanceof HTMLElement)) throw new Error('页签上没有 ×')
    await userEvent.click(close)

    expect(await screen.findByText('画着分镜')).toBeVisible()
    const shots = screen.getByRole('tab', { name: '分镜', selected: true })
    expect(shots.querySelector('svg')).toBeNull()
    shots.focus()
    await userEvent.keyboard('{Delete}')
    expect(screen.getByRole('tab', { name: '分镜', selected: true })).toBeVisible()
  })

  it('没有自动打开的产物时关掉回到选择页', async () => {
    serveFiles(['video/a.md'])
    await renderHost(ROOMY, registryWith(shotsEntry, workspaceEntry, agentEntry), DELEGATE)
    const tab = await screen.findByRole('tab', { name: '委派任务 · 拆解', selected: true })

    tab.focus()
    await userEvent.keyboard('{Delete}')

    expect(await screen.findByRole('navigation', { name: '能打开的产物' })).toBeVisible()
  })
})
