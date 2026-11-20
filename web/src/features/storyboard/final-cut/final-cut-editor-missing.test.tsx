import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/testing/mocks/server'
import { putMockProjectMain } from '@/testing/mocks/whole-film'
import {
  CONVERSATION,
  WRITE_URL,
  keepRealSaveDelay,
  openEditor,
  setUpEditorCase,
  shot,
  tearDownEditorCase,
  twoVideos,
} from '@/testing/final-cut-editor'

vi.mock('mediabunny', async () => (await import('@/testing/final-cut-media')).mediabunnyMock())

// 一条用例要开整个编辑器、走完一串操作，上限放宽到 15 秒
vi.setConfig({ testTimeout: 15_000 })

beforeEach(setUpEditorCase)
afterEach(tearDownEditorCase)

const MAIN_PATH = 'final-cut/index.html'

describe('final-cut 编辑器 · 主文件被删', () => {
  it('编辑中主文件在别处被删掉：放下工程、说明已删除（页签由工作台去掉），没存的改动不再往删掉的主文件里写', async () => {
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
    act(() =>
      socket.deliver({
        payload: { changes: [{ change: 'deleted', path: MAIN_PATH }] },
        session_id: CONVERSATION,
        timestamp: '2026-11-19T08:00:00+00:00',
        type: 'event.fs.changed',
      }),
    )

    expect(await screen.findByText('final-cut 已删除')).toBeVisible()
    expect(screen.queryByRole('toolbar', { name: '剪辑工具' })).toBeNull()
    expect(screen.queryByRole('button', { name: /新建/ })).toBeNull()
    // 停手后的自动保存（800 毫秒）和卸载时的补存都不再发生
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    expect(writes).toBe(0)
  })
})
