import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import { mockProjectMain, putMockProjectMain } from '@/testing/mocks/whole-film'
import {
  CONVERSATION,
  CREATE_URL,
  WRITE_URL,
  keepRealSaveDelay,
  openEditor,
  renderEditor,
  setUpEditorCase,
  shot,
  tearDownEditorCase,
  transport,
  twoVideos,
} from '@/testing/final-cut-editor'
import type { FakeSocket } from '@/testing/ws'

vi.mock('mediabunny', async () => (await import('@/testing/final-cut-media')).mediabunnyMock())

// 一条用例要开整个编辑器、走完一串操作，上限放宽到 15 秒
vi.setConfig({ testTimeout: 15_000 })

beforeEach(setUpEditorCase)
afterEach(tearDownEditorCase)

const MAIN_PATH = 'final-cut/index.html'

const createButton = () => screen.findByRole('button', { name: '新建 final-cut' })
const editorToolbar = () => screen.queryByRole('toolbar', { name: '剪辑工具' })

/** 工作区照常发来的文件变化通知。 */
const fsChanged = (socket: FakeSocket, change: 'created' | 'deleted', path: string) =>
  act(() =>
    socket.deliver({
      payload: { changes: [{ change, path }] },
      session_id: CONVERSATION,
      timestamp: '2026-11-19T08:00:00+00:00',
      type: 'event.fs.changed',
    }),
  )

describe('final-cut 编辑器 · 新建', () => {
  it('还没有工程：只有说明和「新建 final-cut」；点了按 1080×1920 的空模版新建主文件，建好后打开编辑器', async () => {
    const created: { path: string; content: string }[] = []
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.post(CREATE_URL, async ({ request }) => {
        created.push((await request.clone().json()) as { path: string; content: string })
        await held
        return undefined
      }),
    )
    const user = userEvent.setup()
    await renderEditor()
    const button = await createButton()
    expect(screen.getByText('暂无 final-cut，请先新建')).toBeVisible()
    expect(editorToolbar()).toBeNull()
    expect(screen.queryByRole('region', { name: '预览' })).toBeNull()
    expect(screen.queryByRole('group', { name: '画面 1' })).toBeNull()

    await waitFor(() => expect(button).toBeEnabled())
    await user.click(button)
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent('正在新建…')
    release()

    expect(await screen.findByRole('toolbar', { name: '剪辑工具' })).toBeVisible()
    expect(screen.queryByRole('button', { name: /新建 final-cut|正在新建/ })).toBeNull()
    expect(created.map((file) => file.path)).toEqual(['index.html'])
    const [{ content } = { content: '' }] = created
    expect(content).toContain('data-width="1080" data-height="1920"')
    expect(content).toMatch(/id="film"[^>]*data-duration="0"/)
    expect(content).not.toMatch(/<(video|audio) |class="clip/)
    // 打开的就是刚建的那一份
    expect(mockProjectMain(CONVERSATION)).toEqual({ content, version: 1 })
    expect(screen.getByText('final-cut 暂无内容，加入内容后可在此预览')).toBeVisible()
  })

  it('新建失败：说明原因，按钮还能再点，再点建好后打开编辑器', async () => {
    server.use(http.post(CREATE_URL, () => new HttpResponse(null, { status: 503 }), { once: true }))
    const user = userEvent.setup()
    await renderEditor()
    const button = await createButton()
    await waitFor(() => expect(button).toBeEnabled())
    await user.click(button)
    expect(await screen.findByRole('alert')).toHaveTextContent('final-cut 新建失败')
    expect(button).toBeEnabled()
    expect(mockProjectMain(CONVERSATION)).toBeUndefined()

    await user.click(button)
    expect(await screen.findByRole('toolbar', { name: '剪辑工具' })).toBeVisible()
    expect(mockProjectMain(CONVERSATION)?.version).toBe(1)
  })

  it('等着新建时别处建好了主文件（工作区通知）：读到工程后自动打开编辑器', async () => {
    const { socket } = await renderEditor()
    await createButton()
    putMockProjectMain(CONVERSATION, twoVideos())
    fsChanged(socket, 'created', MAIN_PATH)

    expect(await screen.findByRole('toolbar', { name: '剪辑工具' })).toBeVisible()
    expect(within(transport()).getByText('/ 00:03.50')).toBeVisible()
  })

  it('点新建时别处已经建好了（409）：照样打开那一份，不报错', async () => {
    const user = userEvent.setup()
    await renderEditor()
    const button = await createButton()
    putMockProjectMain(CONVERSATION, twoVideos())
    await waitFor(() => expect(button).toBeEnabled())
    await user.click(button)

    expect(await screen.findByRole('toolbar', { name: '剪辑工具' })).toBeVisible()
    expect(within(transport()).getByText('/ 00:03.50')).toBeVisible()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(mockProjectMain(CONVERSATION)).toEqual({ content: twoVideos(), version: 1 })
  })

  it('编辑中主文件在别处被删掉：回到新建，没存的改动不再往删掉的主文件里写', async () => {
    keepRealSaveDelay()
    putMockProjectMain(CONVERSATION, twoVideos())
    let writes = 0
    server.use(
      http.put(WRITE_URL, () => {
        writes += 1
        return undefined
      }),
    )
    const user = userEvent.setup()
    const { socket } = await openEditor()
    await user.click(await shot(/^生成 A 镜头 1，/))
    await user.keyboard('{Enter}')
    await waitFor(() =>
      expect(
        within(screen.getByRole('group', { name: '画面 1' })).getAllByRole('group'),
      ).toHaveLength(3),
    )

    server.use(
      http.get(WRITE_URL, ({ request }) =>
        new URL(request.url).searchParams.get('path') === MAIN_PATH
          ? HttpResponse.json({ detail: '文件不存在' }, { status: 404 })
          : undefined,
      ),
    )
    fsChanged(socket, 'deleted', MAIN_PATH)

    expect(await createButton()).toBeVisible()
    expect(editorToolbar()).toBeNull()
    // 停手后的自动保存（800 毫秒）和卸载时的补存都不再发生
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(writes).toBe(0)
  })
})
