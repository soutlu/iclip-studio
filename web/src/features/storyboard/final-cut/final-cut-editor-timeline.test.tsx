import { parseAutomation } from '@hyperframes/core/audio-automation'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeGenerationJob } from '@/testing/generation-job'
import { server } from '@/testing/mocks/server'
import { mockProjectMain, putMockProjectMain } from '@/testing/mocks/whole-film'
import { mockWorkspaceFile, putMockWorkspaceFile } from '@/testing/mocks/workspace'
import { renderWithProviders } from '@/testing/render'
import { audio, host, mainFile, video } from '@/testing/final-cut'
import {
  CONVERSATION,
  CREATE_URL,
  URL_A,
  URL_B,
  URL_SILENT,
  URL_UNREADABLE,
  WRITE_URL,
  editorRoot,
  openEditor,
  previewPages,
  previewSettled,
  progress,
  quietTakes,
  savedClips,
  savedFilm,
  savedVersion,
  serveGenerations,
  setUpEditorCase,
  shot,
  takes,
  tearDownEditorCase,
  toolbar,
  transport,
  twoVideos,
  waitSaved,
} from '@/testing/final-cut-editor'
import { files } from '@/testing/final-cut-media'
import { beatFileContent, parseBeatFile } from './beat-file'
import { FinalCutEditor } from './final-cut-editor'
import type { BeatGrid } from './music-beats'

vi.mock('mediabunny', async () => (await import('@/testing/final-cut-media')).mediabunnyMock())

// 一条用例要开整个编辑器、走完一串操作，上限放宽到 15 秒
vi.setConfig({ testTimeout: 15_000 })

beforeEach(setUpEditorCase)
afterEach(tearDownEditorCase)

describe('final-cut 编辑器 · 加入素材', () => {
  it('还没有工程：播放、进度条、导出置灰并说明原因，没选镜头时按 Enter 提示先选，打开不保存', async () => {
    const user = userEvent.setup()
    await openEditor()
    expect(screen.getByText('final-cut 暂无内容，加入内容后可在此预览')).toBeVisible()
    expect(within(transport()).getByRole('button', { name: '播放' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(progress()).toHaveAttribute('data-disabled')
    expect(within(toolbar()).queryByRole('button', { name: '加入 final-cut' })).toBeNull()
    editorRoot().focus()
    await user.keyboard('{Enter}')
    expect(
      await screen.findByText('尚未选中镜头，无法加入 final-cut；请先在「镜头」页签中选中镜头范围'),
    ).toBeVisible()
    const exportButton = screen.getByRole('button', { name: '导出' })
    expect(exportButton).toHaveAttribute('aria-disabled', 'true')
    await user.click(exportButton)
    expect(
      (await screen.findAllByText('final-cut 暂无内容，无法导出；请先加入内容')).length,
    ).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(mockProjectMain(CONVERSATION)).toBeUndefined()
  })

  it('选一个镜头按 Enter：按素材的画幅新建工程主文件，片段的 src 直接写素材片的地址', async () => {
    const user = userEvent.setup()
    await openEditor()
    await user.click(await shot(/^生成 A 镜头 2，/))
    await user.keyboard('{Enter}')

    await waitSaved(() => expect(savedClips()).toHaveLength(1))
    expect(savedFilm()).toContain('data-width="720" data-height="1280"')
    const [clip] = savedClips()
    expect(clip).toContain(`src="${URL_A}"`)
    expect(clip).not.toContain('data-var-src')
    expect(clip).toMatch(/data-start="0" data-duration="2.5"[^>]* data-media-start="2"/)
    expect(savedVersion()).toBe(1)
    expect(clip).toContain('data-label="A · 镜头 2"')
    expect(within(transport()).getByText('/ 00:02.50')).toBeVisible()
  })

  it('再选别的镜头按 Enter：接在末尾；选几个镜头一次加入时一个镜头一个片段', async () => {
    const user = userEvent.setup()
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    await user.click(await shot(/^生成 A 镜头 1，/))
    await user.keyboard('{Shift>}')
    await user.click(await shot(/^生成 A 镜头 2，/))
    await user.keyboard('{/Shift}{Enter}')

    await waitSaved(() => expect(savedClips()).toHaveLength(4))
    // 新加的片段写在根下第一个：后加的在前面
    const [fourth, third] = savedClips()
    expect(third).toMatch(/data-start="3.5" data-duration="2"[^>]* data-media-start="0"/)
    expect(fourth).toMatch(/data-start="5.5" data-duration="2.5"[^>]* data-media-start="2"/)
  })

  it('素材确认有声音才写成有声音：没有音轨、读不出有没有音轨时都写成静音', async () => {
    const user = userEvent.setup()
    await openEditor([...takes, ...quietTakes])
    for (const [count, take] of [
      [1, 'A'],
      [2, 'C'],
      [3, 'D'],
    ] as const) {
      await user.click(await shot(new RegExp(`^生成 ${take} 镜头 1，`)))
      await user.keyboard('{Enter}')
      await waitSaved(() => expect(savedClips()).toHaveLength(count))
    }
    const clipOf = (url: string) => savedClips().find((clip) => clip.includes(`src="${url}"`))
    expect(clipOf(URL_A)).toContain(' data-has-audio="true"')
    expect(clipOf(URL_A)).not.toContain('muted')
    for (const url of [URL_SILENT, URL_UNREADABLE]) {
      expect(clipOf(url)).toContain(' muted="true"')
      expect(clipOf(url)).not.toContain('data-has-audio')
    }
  })

  it('撤销退回加之前，重做再加回来；⌘Z 也可以', async () => {
    const user = userEvent.setup()
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    await user.click(await shot(/^生成 B 镜头 1，/))
    await user.keyboard('{Enter}')
    await waitSaved(() => expect(savedClips()).toHaveLength(3))

    await user.click(within(toolbar()).getByRole('button', { name: '撤销' }))
    await waitSaved(() => expect(savedClips()).toHaveLength(2))
    await user.click(within(toolbar()).getByRole('button', { name: '重做' }))
    await waitSaved(() => expect(savedClips()).toHaveLength(3))
    await user.keyboard('{Meta>}z{/Meta}')
    await waitSaved(() => expect(savedClips()).toHaveLength(2))
  })

  it('保存被拒：说明原因，可以重新保存', async () => {
    const user = userEvent.setup()
    server.use(
      http.post(
        CREATE_URL,
        () => HttpResponse.json({ detail: '工作区暂时写不进去' }, { status: 503 }),
        { once: true },
      ),
    )
    await openEditor()
    await user.click(await shot(/^生成 A 镜头 1，/))
    await user.keyboard('{Enter}')
    expect(await screen.findByText(/工作区暂时写不进去$/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: '重新保存' }))
    await waitSaved(() => expect(savedClips()).toHaveLength(1))
  })

  it('工程主文件读取失败：说明原因，重试后打开', async () => {
    const user = userEvent.setup()
    server.use(
      http.get(WRITE_URL, () => HttpResponse.json({ detail: '服务暂时不可用' }, { status: 503 }), {
        once: true,
      }),
    )
    serveGenerations(takes)
    await renderWithProviders(<FinalCutEditor conversationId={CONVERSATION} />)
    expect(await screen.findByText(/服务暂时不可用$/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('toolbar', { name: '剪辑工具' })).toBeVisible()
  })
})

describe('final-cut 编辑器 · 时间线', () => {
  const timeline = () => screen.getByRole('group', { name: '画面 1' })

  it('工程里只有组件或块的片段、没有视频片段：照样能播放', async () => {
    putMockProjectMain(CONVERSATION, mainFile([host()], { width: 720, height: 1280 }))
    await openEditor()
    expect(screen.queryByText('final-cut 暂无内容，加入内容后可在此预览')).toBeNull()
    expect(within(transport()).getByRole('button', { name: '播放' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('还没有 final-cut：留一行空的，提示把镜头拖进来', async () => {
    await openEditor()
    expect(
      within(timeline()).getByText('将「镜头」页签里的镜头拖到此处可加入 final-cut'),
    ).toBeVisible()
    expect(screen.queryByRole('group', { name: '画面 2' })).toBeNull()
  })

  it('final-cut 里的片段排在一行里，行头只写行名和开关，不写片段的名字和片段数', async () => {
    putMockProjectMain(
      CONVERSATION,
      mainFile(
        [
          video({ label: 'A · 镜头 2', src: URL_A, duration: 2_000 }),
          video({
            id: 'clip-2',
            label: 'B · 镜头 1',
            src: URL_B,
            start: 2_000,
            duration: 1_500,
          }),
        ],
        { width: 720, height: 1280 },
      ),
    )
    await openEditor()
    const clips = within(timeline()).getAllByRole('group')
    expect(clips.map((clip) => clip.getAttribute('aria-label'))).toEqual([
      'A · 镜头 2，2.0 秒',
      'B · 镜头 1，1.5 秒',
    ])
    const head = screen.getByRole('button', { name: '隐藏画面 1' }).parentElement
    expect(head).toHaveTextContent(/^画面 1$/)
    expect(screen.getByRole('slider', { name: '时间线播放位置' })).toBeEnabled()
  })

  it('两行的 final-cut：行号小的在上面，画面区的行从上往下叫「画面 1」「画面 2」', async () => {
    putMockProjectMain(
      CONVERSATION,
      mainFile(
        [
          video({ label: 'A · 镜头 2', src: URL_A, duration: 2_000, track: 1 }),
          video({
            id: 'clip-2',
            label: 'B · 镜头 1',
            src: URL_B,
            duration: 1_500,
          }),
        ],
        { width: 720, height: 1280 },
      ),
    )
    await openEditor()
    expect(within(timeline()).getByRole('group')).toHaveAccessibleName('B · 镜头 1，1.5 秒')
    expect(
      within(screen.getByRole('group', { name: '画面 2' })).getByRole('group'),
    ).toHaveAccessibleName('A · 镜头 2，2.0 秒')
    expect(screen.getByRole('button', { name: '隐藏画面 2' })).toBeVisible()
  })

  it('声音区只有一行：行叫「配乐」，开关是「静音配乐」，点了换成「取消静音配乐」', async () => {
    putMockProjectMain(
      CONVERSATION,
      mainFile([video({ src: URL_A, duration: 2_000 }), audio({ duration: 2_000 })], {
        width: 720,
        height: 1280,
      }),
    )
    const user = userEvent.setup()
    await openEditor()
    expect(
      within(screen.getByRole('group', { name: '配乐' })).getByRole('group'),
    ).toHaveAccessibleName('配乐，2.0 秒')
    await user.click(screen.getByRole('button', { name: '静音配乐' }))
    expect(screen.getByRole('button', { name: '取消静音配乐' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    await waitSaved(() => expect(savedFilm()).toContain('data-hidden'))
  })

  it('声音区不止一行：从上往下叫「配乐 1」「配乐 2」', async () => {
    putMockProjectMain(
      CONVERSATION,
      mainFile(
        [
          audio({ duration: 2_000 }),
          audio({ id: 'audio-2', label: '音效', duration: 1_000, track: 1 }),
        ],
        { width: 720, height: 1280 },
      ),
    )
    await openEditor()
    expect(
      within(screen.getByRole('group', { name: '配乐 1' })).getByRole('group'),
    ).toHaveAccessibleName('配乐，2.0 秒')
    expect(
      within(screen.getByRole('group', { name: '配乐 2' })).getByRole('group'),
    ).toHaveAccessibleName('音效，1.0 秒')
    expect(screen.getByRole('button', { name: '静音配乐 2' })).toBeVisible()
  })

  it('点行头的眼睛：这一行的片段一起隐藏，存出的文件带着隐藏标记；再点显示回来', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await user.click(screen.getByRole('button', { name: '隐藏画面 1' }))
    expect(
      within(timeline())
        .getAllByRole('group')
        .map((clip) => clip.getAttribute('aria-label')),
    ).toEqual(['A · 镜头 1，2.0 秒，已隐藏', 'A · 镜头 1，1.5 秒，已隐藏'])
    await waitSaved(() => expect(savedFilm().match(/data-hidden=""/g)).toHaveLength(2))

    const eye = screen.getByRole('button', { name: '显示画面 1' })
    expect(eye).toHaveAttribute('aria-pressed', 'false')
    await user.click(eye)
    await waitSaved(() => expect(savedFilm()).not.toContain('data-hidden'))
    expect(screen.getByRole('button', { name: '隐藏画面 1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  const clip = (name: RegExp) => within(timeline()).getByRole('button', { name })

  it('点一个片段选中它，按 Delete 删掉：开着波纹编辑，后面的片段往前补上，final-cut 变短', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await user.click(clip(/2\.0 秒$/))
    expect(clip(/2\.0 秒$/)).toHaveAttribute('aria-pressed', 'true')
    expect(within(timeline()).getAllByRole('slider')).toHaveLength(2)

    await user.keyboard('{Delete}')
    await waitSaved(() => expect(savedClips()).toHaveLength(1))
    expect(savedClips()[0]).toContain('data-start="0" data-duration="1.5"')
    expect(within(transport()).getByText('/ 00:01.50')).toBeVisible()
    expect(within(timeline()).queryAllByRole('slider')).toHaveLength(0)
  })

  it('关掉波纹编辑再删：后面的片段留在原处', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await user.click(within(toolbar()).getByRole('button', { name: '波纹编辑' }))
    expect(within(toolbar()).getByRole('button', { name: '波纹编辑' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    await user.click(clip(/2\.0 秒$/))
    await user.keyboard('{Delete}')
    await waitSaved(() => expect(savedClips()).toHaveLength(1))
    expect(savedClips()[0]).toContain('data-start="2" data-duration="1.5"')
  })

  it('选中一个片段按 Esc：只取消选中', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await user.click(clip(/2\.0 秒$/))
    expect(clip(/2\.0 秒$/)).toHaveAttribute('aria-pressed', 'true')
    await user.keyboard('{Escape}')
    expect(clip(/2\.0 秒$/)).toHaveAttribute('aria-pressed', 'false')
  })

  it('选中以后在把手上按方向键裁剪：裁结尾只改长度，裁开头起点和入点一起动；不超出素材', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await user.click(clip(/1\.5 秒$/))
    const end = within(timeline()).getByRole('slider', { name: '裁剪结尾' })
    end.focus()
    await user.keyboard('{ArrowLeft}')
    /** 片段上的起点、时长、入点。 */
    const timed = (start: string, duration: string, mediaStart: string) =>
      new RegExp(
        `data-start="${start}" data-duration="${duration}"[^>]* data-media-start="${mediaStart}"`,
      )
    await waitSaved(() => expect(savedClips()[1]).toMatch(timed('2', '1.4', '0')))
    // 素材 B 一共 3 秒：再怎么往外拉也只到 3 秒
    await user.keyboard('{Shift>}{ArrowRight}{ArrowRight}{/Shift}')
    await waitSaved(() => expect(savedClips()[1]).toMatch(timed('2', '3', '0')))

    const start = within(timeline()).getByRole('slider', { name: '裁剪开头' })
    start.focus()
    await user.keyboard('{ArrowRight}')
    await waitSaved(() => expect(savedClips()[1]).toMatch(timed('2.1', '2.9', '0.1')))
    // 往前裁不能压到前一个片段
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    await waitSaved(() => expect(savedClips()[1]).toMatch(timed('2', '3', '0')))
    expect(within(transport()).getByText('/ 00:05.00')).toBeVisible()
  })

  /** 发给预览页的最后一次跳转（毫秒）。 */
  const lastSeekMs = () => {
    const seek = previewPages.latest().commands.findLast((command) => command.type === 'seek')
    return seek?.type === 'seek' ? seek.ms : undefined
  }
  /**
   * 播放头的竖线量出来在横坐标 `x` 处（默认 0，播放头在 0 秒；测试里一秒 100 像素）。测试里没有排版，竖线量不到
   * 高度时各行上不算按在竖线上。
   */
  const placeLine = (x = 0) =>
    vi.spyOn(screen.getByTestId('timeline-playhead'), 'getBoundingClientRect').mockReturnValue({
      x: x - 1,
      y: 0,
      left: x - 1,
      right: x + 1,
      top: 0,
      bottom: 400,
      width: 2,
      height: 400,
      toJSON: () => ({}),
    })
  /**
   * 在第一个片段的身体上按住穿过它的竖线（播放头在 0 秒），拖到第 `ms` 毫秒处（测试里一秒 100 像素），不松手；
   * 返回松手。
   */
  const dragPlayhead = (ms: number) => {
    placeLine()
    const body = clip(/2\.0 秒$/)
    fireEvent.pointerDown(body, { button: 0, pointerId: 1, clientX: 0, clientY: 60 })
    fireEvent.pointerMove(body, { pointerId: 1, clientX: ms / 10, clientY: 60 })
    return () => fireEvent.pointerUp(body, { pointerId: 1, clientX: ms / 10, clientY: 60 })
  }

  it('按住播放头拖到片段的边附近：吸到边上，画吸附线，松手后吸附线收起', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    const release = dragPlayhead(2_060)
    expect(screen.getByTestId('snap-guide')).toHaveStyle({ left: '200px' })
    await waitFor(() => expect(lastSeekMs()).toBe(2_000))
    release()
    expect(screen.queryByTestId('snap-guide')).toBeNull()
  })

  it('关掉吸附再拖播放头：停在拖到的地方，不画吸附线', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await user.click(within(toolbar()).getByRole('button', { name: '吸附' }))
    dragPlayhead(2_060)
    expect(screen.queryByTestId('snap-guide')).toBeNull()
    await waitFor(() => expect(lastSeekMs()).toBe(2_060))
  })

  it('播放头停在选中片段的开头：按开头的把手拖是裁剪，播放头不动', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await user.click(clip(/2\.0 秒$/))
    placeLine()
    const start = within(timeline()).getByRole('slider', { name: '裁剪开头' })
    fireEvent.pointerDown(start, { button: 0, pointerId: 1, clientX: 0, clientY: 60 })
    fireEvent.pointerMove(start, { pointerId: 1, clientX: 30, clientY: 60 })
    fireEvent.pointerUp(start, { pointerId: 1, clientX: 30, clientY: 60 })
    await waitSaved(() => expect(savedClips()[0]).toContain('data-start="0.3" data-duration="1.7"'))
    expect(progress()).toHaveAttribute('aria-valuetext', '00:00.00 / 00:03.50')
  })

  it('音量关键帧的点在播放头的竖线下面：按住拖的是这个点，播放头不动', async () => {
    const lane = JSON.stringify({
      version: 1,
      lanes: [
        {
          target: 'volume',
          points: [
            { t: 0, v: 2 },
            { t: 2, v: 2 },
          ],
        },
      ],
    })
    putMockProjectMain(
      CONVERSATION,
      mainFile([video({ src: URL_A, duration: 2_000, automation: lane })], {
        width: 720,
        height: 1280,
      }),
    )
    const user = userEvent.setup()
    await openEditor()
    await user.click(clip(/2\.0 秒$/))
    placeLine()
    const point = within(timeline()).getByRole('slider', { name: '音量关键帧 1' })
    fireEvent.pointerDown(point, { button: 0, pointerId: 1, clientX: 0, clientY: 10 })
    fireEvent.pointerMove(point, { pointerId: 1, clientX: 0, clientY: 40 })
    fireEvent.pointerUp(point, { pointerId: 1, clientX: 0, clientY: 40 })
    /** 存下的主文件里视频片段音量曲线开头那个点的音量。 */
    const firstGain = () =>
      parseAutomation(
        new DOMParser()
          .parseFromString(savedFilm(), 'text/html')
          .getElementById('clip-1')
          ?.getAttribute('data-automation') ?? '{"version":1,"lanes":[]}',
      ).lanes.find((each) => each.target === 'volume')?.points[0]?.v
    await waitSaved(() => expect(firstGain()).not.toBe(2))
    expect(progress()).toHaveAttribute('aria-valuetext', '00:00.00 / 00:02.00')
  })

  it('右键按在播放头的竖线上：出下面那个片段的菜单', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    placeLine()
    const body = clip(/2\.0 秒$/)
    fireEvent.pointerDown(body, { button: 2, pointerId: 1, pointerType: 'mouse', clientX: 0 })
    fireEvent.contextMenu(body, { clientX: 0 })
    expect(await screen.findByRole('menu', { name: 'A · 镜头 1' })).toBeVisible()
    // 右键没有按住竖线：播放头没有在拖
    expect(screen.getByTestId('timeline-playhead')).not.toHaveAttribute('data-dragging')
  })

  it('播放头在选中的片段里：按住片段身体上竖线的位置拖，挪的是片段', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    // 点选第二个片段（2–3.5 秒），播放头挪到它正中 2.75 秒
    await user.click(clip(/1\.5 秒$/))
    await waitFor(() => expect(lastSeekMs()).toBe(2_750))
    placeLine(275)
    // 测试里片段的左边量成 0：拖 300 像素就是想挪到第 3 秒
    const body = clip(/1\.5 秒$/)
    fireEvent.pointerDown(body, { button: 0, pointerId: 1, clientX: 275, clientY: 60 })
    fireEvent.pointerMove(body, { pointerId: 1, clientX: 575, clientY: 60 })
    fireEvent.pointerUp(body, { pointerId: 1, clientX: 575, clientY: 60 })
    await waitSaved(() => expect(savedClips()[1]).toContain('data-start="3"'))
    expect(lastSeekMs()).toBe(2_750)
  })

  it('在竖线上点一下没选中的片段：选中它，播放头不动', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    placeLine()
    const body = clip(/2\.0 秒$/)
    fireEvent.pointerDown(body, { button: 0, pointerId: 1, clientX: 0, clientY: 60 })
    fireEvent.pointerUp(body, { pointerId: 1, clientX: 0, clientY: 60 })
    expect(body).toHaveAttribute('aria-pressed', 'true')
    expect(playheadText()).toBe('00:00.00')
  })

  it('在竖线上点一下空白处：取消选中', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await user.click(clip(/2\.0 秒$/))
    expect(clip(/2\.0 秒$/)).toHaveAttribute('aria-pressed', 'true')
    placeLine()
    fireEvent.pointerDown(timeline(), { button: 0, pointerId: 1, clientX: 0, clientY: 60 })
    fireEvent.pointerUp(timeline(), { pointerId: 1, clientX: 0, clientY: 60 })
    expect(clip(/2\.0 秒$/)).toHaveAttribute('aria-pressed', 'false')
  })

  it('在竖线上按住：挪过一点点不动播放头，拖开了才拖播放头', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    placeLine()
    const body = clip(/2\.0 秒$/)
    const before = lastSeekMs()
    fireEvent.pointerDown(body, { button: 0, pointerId: 1, clientX: 0, clientY: 60 })
    fireEvent.pointerMove(body, { pointerId: 1, clientX: 3, clientY: 60 })
    expect(screen.getByTestId('timeline-playhead')).not.toHaveAttribute('data-dragging')
    expect(lastSeekMs()).toBe(before)
    fireEvent.pointerMove(body, { pointerId: 1, clientX: 50, clientY: 60 })
    expect(screen.getByTestId('timeline-playhead')).toHaveAttribute('data-dragging')
    await waitFor(() => expect(lastSeekMs()).toBe(500))
  })

  /** 时间线上播放位置的读数。 */
  const playheadText = () =>
    screen.getByRole('slider', { name: '时间线播放位置' }).getAttribute('aria-valuetext')

  it('点选播放头不在里面的片段：播放头挪进去（离开头 0.8 秒，短片段到正中）', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    // 第二个片段在 2–3.5 秒，不到 1.6 秒：挪到正中 2.75 秒
    await user.click(clip(/1\.5 秒$/))
    await waitFor(() => expect(lastSeekMs()).toBe(2_750))
  })

  it('正在播放时点选播放头不在里面的片段：跳过去以后接着播', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await previewSettled()
    await user.click(within(transport()).getByRole('button', { name: '播放' }))
    expect(await within(transport()).findByRole('button', { name: '暂停' })).toBeVisible()
    await user.click(clip(/1\.5 秒$/))
    await waitFor(() => {
      const commands = previewPages.latest().commands
      const seek = commands.findLastIndex((command) => command.type === 'seek')
      expect(commands[seek]).toMatchObject({ type: 'seek', ms: 2_750 })
      expect(commands.slice(seek + 1).map((command) => command.type)).toContain('play')
    })
  })

  it('拖动片段：松手后的那一下点击不算点选，播放头不动', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    // 第二个片段往后拖到 4 秒（测试里一秒 100 像素）
    const body = clip(/1\.5 秒$/)
    fireEvent.pointerDown(body, { button: 0, pointerId: 1, clientX: 10, clientY: 60 })
    fireEvent.pointerMove(body, { pointerId: 1, clientX: 410, clientY: 60 })
    fireEvent.pointerUp(body, { pointerId: 1, clientX: 410, clientY: 60 })
    fireEvent.click(body)
    await waitSaved(() => expect(savedClips()[1]).toContain('data-start="4"'))
    expect(playheadText()).toBe('00:00.00')
  })

  it('按住 Shift 加选播放头不在里面的片段：播放头不动', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await user.keyboard('{Shift>}')
    await user.click(clip(/1\.5 秒$/))
    await user.keyboard('{/Shift}')
    expect(clip(/1\.5 秒$/)).toHaveAttribute('aria-pressed', 'true')
    expect(playheadText()).toBe('00:00.00')
  })

  it('指针移到时间尺上：画一条虚线，不出写着时间的气泡', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    await openEditor()
    fireEvent.pointerMove(screen.getByRole('slider', { name: '时间线播放位置' }), {
      clientX: 120,
      pointerType: 'mouse',
    })
    expect(screen.getByTestId('timeline-hover-guide')).toBeInTheDocument()
    expect(screen.queryByText('预览')).toBeNull()
  })

  it('静音的配乐片段上有「已静音」小标', async () => {
    putMockProjectMain(
      CONVERSATION,
      mainFile([video({ src: URL_A, duration: 2_000 }), audio({ duration: 2_000, hidden: true })], {
        width: 720,
        height: 1280,
      }),
    )
    await openEditor()
    const music = within(screen.getByRole('group', { name: '配乐' })).getByRole('group')
    expect(music).toHaveAccessibleName('配乐，2.0 秒，已静音')
    expect(within(music).getByText('已静音')).toBeVisible()
  })

  it('双击时间线上的片段：选中它，停在「字幕·配音」时也切到「属性」', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    const side = screen.getByRole('complementary', { name: '镜头、贴片、场景、配乐、字幕和属性' })
    await user.click(within(side).getByRole('tab', { name: '字幕·配音' }))
    await user.dblClick(clip(/2\.0 秒$/))
    expect(clip(/2\.0 秒$/)).toHaveAttribute('aria-pressed', 'true')
    expect(within(side).getByRole('tab', { name: '属性' })).toHaveAttribute('aria-selected', 'true')
  })

  const materialPreview = () =>
    screen.queryByRole('region', { name: '素材 · 镜头组 1 · 生成 A · 镜头 2' })

  it('预览素材时在时间线上选中片段：回到 final-cut 的预览', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await user.click(await shot(/^生成 A 镜头 2，/))
    expect(materialPreview()).toBeInTheDocument()
    await user.click(clip(/1\.5 秒$/))
    expect(materialPreview()).toBeNull()
  })

  it('预览素材时按 Esc：退出素材预览', async () => {
    putMockProjectMain(CONVERSATION, twoVideos())
    const user = userEvent.setup()
    await openEditor()
    await user.click(await shot(/^生成 A 镜头 2，/))
    expect(materialPreview()).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(materialPreview()).toBeNull()
  })
})

describe('final-cut 编辑器 · 多选', () => {
  // 一行三个片段：A 镜头 1 在 0–2 秒，B 镜头 1 在 2–3.5 秒，A 镜头 2 在 3.5–5 秒
  const threeVideos = () =>
    mainFile(
      [
        video({ label: 'A · 镜头 1', src: URL_A, duration: 2_000 }),
        video({
          id: 'clip-2',
          label: 'B · 镜头 1',
          src: URL_B,
          start: 2_000,
          duration: 1_500,
        }),
        video({
          id: 'clip-3',
          label: 'A · 镜头 2',
          src: URL_A,
          start: 3_500,
          duration: 1_500,
          mediaStart: 2_000,
        }),
      ],
      { width: 720, height: 1280 },
    )
  const row = () => screen.getByRole('group', { name: '画面 1' })
  const NAMES = ['A · 镜头 1', 'B · 镜头 1', 'A · 镜头 2'] as const
  const clip = (label: (typeof NAMES)[number]) =>
    within(row()).getByRole('button', { name: new RegExp(`^选中：${label}，`) })
  /** 选中着的片段，按时间线上的先后。 */
  const pressed = () => NAMES.filter((label) => clip(label).getAttribute('aria-pressed') === 'true')

  const openThree = async () => {
    putMockProjectMain(CONVERSATION, threeVideos())
    const user = userEvent.setup()
    await openEditor()
    return user
  }

  it('Shift、⌘ 点片段逐个加减选中，每个选中的片段都有两端的把手；直接点收成只选这一个', async () => {
    const user = await openThree()
    await user.click(clip('A · 镜头 1'))
    await user.keyboard('{Shift>}')
    await user.click(clip('A · 镜头 2'))
    await user.keyboard('{/Shift}')
    expect(pressed()).toEqual(['A · 镜头 1', 'A · 镜头 2'])
    expect(within(row()).getAllByRole('slider', { name: /^裁剪/ })).toHaveLength(4)

    await user.keyboard('{Meta>}')
    await user.click(clip('A · 镜头 1'))
    await user.click(clip('B · 镜头 1'))
    await user.keyboard('{/Meta}')
    expect(pressed()).toEqual(['B · 镜头 1', 'A · 镜头 2'])

    await user.click(clip('A · 镜头 1'))
    expect(pressed()).toEqual(['A · 镜头 1'])
  })

  it('点行里的空白处取消全部选中；按 Esc 也全部取消', async () => {
    const user = await openThree()
    await user.click(clip('A · 镜头 1'))
    await user.keyboard('{Shift>}')
    await user.click(clip('B · 镜头 1'))
    await user.keyboard('{/Shift}')
    await user.click(row())
    expect(pressed()).toEqual([])

    await user.click(clip('B · 镜头 1'))
    await user.keyboard('{Shift>}')
    await user.click(clip('A · 镜头 2'))
    await user.keyboard('{/Shift}{Escape}')
    expect(pressed()).toEqual([])
  })

  it('[ 选中播放头左边的片段、] 选中右边的片段，替换原有选中；正好从播放头开始或结束的只算一边', async () => {
    const user = await openThree()
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)))
    await user.click(clip('A · 镜头 2'))
    // 点选把播放头挪进了 A 镜头 2，先放回 0 秒，再挪到 2 秒：A 镜头 1 正好在这里结束，B 镜头 1 正好从这里开始
    progress().focus()
    await user.keyboard('{Home}')
    editorRoot().focus()
    await user.keyboard('{Shift>}{ArrowRight}{ArrowRight}{/Shift}')
    expect(within(transport()).getByText('00:02.00')).toBeVisible()

    await user.keyboard('[[')
    expect(pressed()).toEqual(['A · 镜头 1'])
    await user.keyboard(']')
    expect(pressed()).toEqual(['B · 镜头 1', 'A · 镜头 2'])
  })

  it('选两个片段按 Delete 一起删掉，开着波纹编辑剩下的往前补；撤销一步两个都回来', async () => {
    const user = await openThree()
    await user.click(clip('A · 镜头 1'))
    await user.keyboard('{Shift>}')
    await user.click(clip('A · 镜头 2'))
    await user.keyboard('{/Shift}{Delete}')
    await waitSaved(() => expect(savedClips()).toHaveLength(1))
    expect(savedClips()[0]).toContain('data-label="B · 镜头 1"')
    expect(savedClips()[0]).toContain('data-start="0" data-duration="1.5"')
    expect(within(row()).queryAllByRole('slider', { name: /^裁剪/ })).toHaveLength(0)

    await user.keyboard('{Meta>}z{/Meta}')
    await waitSaved(() => expect(savedClips()).toHaveLength(3))
    expect(savedClips().map((saved) => /data-start="([\d.]+)"/.exec(saved)?.[1])).toEqual([
      '0',
      '2',
      '3.5',
    ])
    // 删掉的片段撤销回来以后不再是选中的
    expect(pressed()).toEqual([])
  })

  it('选中相邻的两个片段，在一个的结尾把手上按方向键：两个一起裁，往外拉按被挡住的那个收住', async () => {
    const user = await openThree()
    await user.click(clip('B · 镜头 1'))
    await user.keyboard('{Shift>}')
    await user.click(clip('A · 镜头 2'))
    await user.keyboard('{/Shift}')
    const end = within(row()).getAllByRole('slider', { name: '裁剪结尾' }).at(-1)
    if (end === undefined) throw new Error('没有结尾把手')
    end.focus()
    await user.keyboard('{ArrowLeft}')
    await waitSaved(() => {
      expect(savedClips()[1]).toContain('data-start="2" data-duration="1.4"')
      expect(savedClips()[2]).toContain('data-start="3.5" data-duration="1.4"')
    })
    // B · 镜头 1 再拉长 0.1 秒就碰到 A · 镜头 2：一起裁时把手最多到 5 秒（A · 镜头 2 自己能到 7.5 秒）
    await waitFor(() => expect(end).toHaveAttribute('aria-valuemax', '5'))
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}')
    await waitSaved(() => {
      expect(savedClips()[1]).toContain('data-start="2" data-duration="1.5"')
      expect(savedClips()[2]).toContain('data-start="3.5" data-duration="1.5"')
    })
  })

  it('工具条：选择工具的菜单有两个工具和三条命令，点「选中播放头右边的片段」选中；没选中时「缩放到选中的片段」置灰并说明原因', async () => {
    const user = await openThree()
    const zoomTo = within(toolbar()).getByRole('button', { name: '缩放到选中的片段' })
    expect(zoomTo).toHaveAttribute('aria-disabled', 'true')
    await user.click(zoomTo)
    expect(
      (await screen.findAllByText('尚未选中片段，无法缩放；请先选中一个片段')).length,
    ).toBeGreaterThan(0)

    await user.click(within(toolbar()).getByRole('button', { name: '选择工具：选择' }))
    const menu = await screen.findByRole('menu', { name: '选择工具：选择' })
    expect(menu).toHaveAttribute('data-side', 'top')
    expect(within(menu).getByRole('menuitemradio', { name: '选择' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(within(menu).getByRole('menuitem', { name: /^选中播放头左边的片段/ })).toHaveTextContent(
      '[',
    )
    const right = within(menu).getByRole('menuitem', { name: /^选中播放头右边的片段/ })
    expect(right).toHaveTextContent(']')
    expect(
      within(menu)
        .getAllByRole('menuitemradio')
        .map((item) => item.textContent),
    ).toEqual(['选择', '切开'])
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['在播放头处切开S', '选中播放头左边的片段[', '选中播放头右边的片段]'])

    await user.click(right)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(pressed()).toEqual(['A · 镜头 1', 'B · 镜头 1', 'A · 镜头 2'])
    expect(zoomTo).not.toHaveAttribute('aria-disabled')
  })

  it('工具条的「删除」：没选中时置灰并说明原因，点了什么都不删；选中几个片段后点它一起删掉，和按 Delete 一样', async () => {
    const user = await openThree()
    const remove = within(toolbar()).getByRole('button', { name: '删除' })
    expect(remove).toHaveAttribute('aria-disabled', 'true')
    expect(remove).toHaveAttribute('aria-keyshortcuts', 'Delete')
    await user.click(remove)
    expect(
      (await screen.findAllByText('尚未选中片段，无法删除；请先选中片段')).length,
    ).toBeGreaterThan(0)
    expect(within(row()).getAllByRole('button', { name: /^选中：/ })).toHaveLength(3)

    await user.click(clip('A · 镜头 1'))
    await user.keyboard('{Shift>}')
    await user.click(clip('B · 镜头 1'))
    await user.keyboard('{/Shift}')
    expect(remove).not.toHaveAttribute('aria-disabled')
    await user.click(remove)
    // 开着波纹编辑：剩下的片段往前补到开头
    await waitSaved(() => expect(savedClips()).toEqual([expect.stringContaining('data-start="0"')]))
    expect(within(row()).getAllByRole('button', { name: /^选中：/ })).toHaveLength(1)
    expect(remove).toHaveAttribute('aria-disabled', 'true')
  })

  it('工具条上没有缩略图开关', async () => {
    await openThree()
    expect(within(toolbar()).queryByRole('button', { name: /缩略图/ })).toBeNull()
  })

  it('开着菜单又有选中的片段：第一下 Esc 只关菜单、选中不变，第二下才取消选中，编辑器一直开着', async () => {
    const user = await openThree()
    await user.click(clip('A · 镜头 1'))
    await user.click(within(toolbar()).getByRole('button', { name: '选择工具：选择' }))
    await screen.findByRole('menu', { name: '选择工具：选择' })

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(pressed()).toEqual(['A · 镜头 1'])

    await user.keyboard('{Escape}')
    expect(pressed()).toEqual([])
  })
})

describe('final-cut 编辑器 · 吸到配乐的节拍', () => {
  const MUSIC = 'https://media.test/audio/music.mp3'

  // 配乐：8 秒鼓点，每 0.5 秒一下、每 2 秒重一下。文件内容直接是解好的采样（48 kHz），离线音频上下文原样读出来，
  // 节拍由引擎真的算
  const RATE = 48_000
  const drums = Float32Array.from({ length: 8 * RATE }, (_, i) => {
    const t = i / RATE
    const sinceHit = t % 0.5
    const level = t % 2 < 0.5 ? 0.9 : 0.6
    return (
      level * Math.exp(-25 * sinceHit) * Math.sin(2 * Math.PI * 60 * sinceHit) +
      0.05 * Math.sin(2 * Math.PI * 440 * t)
    )
  })

  // 读配乐声音的次数：算节拍要先读声音
  let musicReads = 0
  beforeEach(() => {
    musicReads = 0
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        decodeAudioData(data: ArrayBuffer) {
          return Promise.resolve({ getChannelData: () => new Float32Array(data) })
        }
      },
    )
    server.use(
      http.get(MUSIC, () => {
        musicReads += 1
        return HttpResponse.arrayBuffer(drums.slice().buffer)
      }),
    )
  })

  afterEach(() => vi.unstubAllGlobals())

  // 视频片段在 0–1.2 秒（挪动时结尾离节拍远，只有开头吸），配乐在声音区 0–8 秒
  const seed = () =>
    putMockProjectMain(
      CONVERSATION,
      mainFile(
        [
          video({ label: 'A · 镜头 1', src: URL_A, duration: 1_200 }),
          audio({ src: MUSIC, duration: 8_000 }),
        ],
        { width: 720, height: 1280 },
      ),
    )
  const open = async () => {
    seed()
    const user = userEvent.setup()
    await openEditor()
    return user
  }
  const clipOf = (label: string) => screen.getByRole('group', { name: new RegExp(`^${label}，`) })
  const marks = () => within(clipOf('配乐')).findByTestId('beat-marks', {}, { timeout: 4000 })
  /** 画出来的节拍在 final-cut 的第几毫秒：配乐从 0 秒放起，测试里一秒 100 像素。 */
  const beatsDrawn = async () =>
    [...(await marks()).children].map((mark) =>
      Math.round(Number.parseFloat((mark as HTMLElement).style.left) * 10),
    )
  const savedStart = () => Number(/data-start="([\d.]+)"/.exec(savedClips()[0] ?? '')?.[1])
  /** 把视频片段往右拖到第 `ms` 毫秒处（测试里片段的左边量成 0、一秒 100 像素），不松手；返回松手。 */
  const press = (ms: number) => {
    const body = within(clipOf('A · 镜头 1')).getByRole('button', { name: /^选中：/ })
    const x = 10 + ms / 10
    fireEvent.pointerDown(body, { button: 0, pointerId: 1, clientX: 10, clientY: 50 })
    fireEvent.pointerMove(body, { pointerId: 1, clientX: x, clientY: 50 })
    return () => fireEvent.pointerUp(body, { pointerId: 1, clientX: x, clientY: 50 })
  }
  /** 2 秒以后的第一拍：够不着视频片段原来的边、配乐的两端和播放头。 */
  const beatAfter2s = async () => {
    const beat = (await beatsDrawn()).find((ms) => ms > 2_000)
    if (beat === undefined) throw new Error('没有画出节拍')
    return beat
  }

  it('配乐片段上画出算出来的节拍，每 0.5 秒一拍，其中有强拍', async () => {
    await open()
    const beats = await beatsDrawn()
    expect(new Set(beats.slice(1).map((ms, i) => ms - (beats[i] ?? 0)))).toEqual(new Set([500]))
    const strong = (await marks()).querySelectorAll('.is-strong').length
    expect(strong).toBeGreaterThan(0)
    expect(strong).toBeLessThan(beats.length)
  })

  it('拖一个片段到节拍附近：吸附线画在节拍上，松手后开头正好落在节拍上', async () => {
    await open()
    const beat = await beatAfter2s()
    const release = press(beat - 20)
    expect(screen.getByTestId('snap-guide')).toHaveStyle({ left: `${beat / 10}px` })
    release()
    await waitSaved(() => expect(savedStart()).toBe(beat / 1000))
  })

  it('关掉吸附：不吸节拍，片段停在拖到的位置', async () => {
    const user = await open()
    const beat = await beatAfter2s()
    await user.click(within(toolbar()).getByRole('button', { name: '吸附' }))
    const release = press(beat - 20)
    expect(screen.queryByTestId('snap-guide')).toBeNull()
    release()
    await waitSaved(() => expect(savedStart()).toBe((beat - 20) / 1000))
  })

  // 配乐的节拍文件（工作区里的路径）：按地址的路径起名
  const BEAT_FILE = 'final-cut/beats/audio/music.mp3.json'

  it('工程里有这首配乐的节拍文件：不读声音、不算，画出文件里的节拍', async () => {
    // 文件里是每 0.4 秒一拍（和鼓点不一样），画出来的是文件里的
    const stored: BeatGrid = {
      beats: Array.from({ length: 20 }, (_, index) => index * 0.4),
      downbeats: Array.from({ length: 5 }, (_, index) => index * 1.6),
      seconds: 8,
    }
    putMockWorkspaceFile(CONVERSATION, BEAT_FILE, beatFileContent(MUSIC, stored))
    await open()
    const beats = await beatsDrawn()
    expect(new Set(beats.slice(1).map((ms, i) => ms - (beats[i] ?? 0)))).toEqual(new Set([400]))
    expect(musicReads).toBe(0)
  })

  it('工程里还没有节拍文件：算出来以后新建一份，存的就是画出来的节拍', async () => {
    await open()
    const beats = await beatsDrawn()
    await waitFor(() => expect(mockWorkspaceFile(CONVERSATION, BEAT_FILE)).toBeDefined())
    const stored = parseBeatFile(mockWorkspaceFile(CONVERSATION, BEAT_FILE)?.content ?? '')
    expect(stored?.beats.map((seconds) => Math.round(seconds * 1000))).toEqual(beats)
    expect(musicReads).toBe(1)
  })

  it('新建节拍文件不算一步撤销、不存主文件，预览不因为它重新加载', async () => {
    seed()
    const { socket } = await openEditor()
    await previewSettled()
    await waitFor(() => expect(mockWorkspaceFile(CONVERSATION, BEAT_FILE)).toBeDefined())
    const loads = () =>
      previewPages.latest().commands.filter((command) => command.type === 'load').length
    const before = loads()
    // 工作区照常通知节拍文件新建了
    act(() =>
      socket.deliver({
        payload: { changes: [{ change: 'created', path: BEAT_FILE }] },
        session_id: CONVERSATION,
        timestamp: '2026-11-17T08:00:00+00:00',
        type: 'event.fs.changed',
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(loads()).toBe(before)
    expect(within(toolbar()).getByRole('button', { name: '撤销' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(savedVersion()).toBe(1)
  })
})

describe('final-cut 编辑器 · 从素材栏拖进来吸节拍', () => {
  const MUSIC = 'https://media.test/audio/music.mp3'
  // 素材片的第一个镜头 1.2 秒：落在节拍上时结尾离别的节拍远，只有开头吸
  const URL_SHORT = 'https://media.test/take-short.mp4'
  const TAKE_SHORT = 'dddddddd-eeee-4fff-8000-111111111111'
  files.set(URL_SHORT, { keyframes: [0, 1.2], duration: 3 })
  const shortTake = makeGenerationJob({
    id: TAKE_SHORT,
    createdAt: '2026-09-01T10:00:00Z',
    outputUrl: URL_SHORT,
    shotIndex: 1,
    durationMs: 3000,
  })
  // 存好的节拍：每 0.5 秒一拍，不用算
  const grid: BeatGrid = {
    beats: Array.from({ length: 16 }, (_, index) => index * 0.5),
    downbeats: Array.from({ length: 4 }, (_, index) => index * 2),
    seconds: 8,
  }

  // 视频片段 0–1.2 秒，配乐在声音区 0–8 秒；测试里一秒 100 像素
  const open = async () => {
    putMockProjectMain(
      CONVERSATION,
      mainFile([video({ src: URL_A, duration: 1_200 }), audio({ src: MUSIC, duration: 8_000 })], {
        width: 720,
        height: 1280,
      }),
    )
    putMockWorkspaceFile(
      CONVERSATION,
      'final-cut/beats/audio/music.mp3.json',
      beatFileContent(MUSIC, grid),
    )
    const user = userEvent.setup()
    await openEditor([shortTake])
    await within(screen.getByRole('group', { name: /^配乐，/ })).findByTestId(
      'beat-marks',
      {},
      { timeout: 4000 },
    )
    return user
  }

  /**
   * jsdom 不排版：给时间线量出来的位置（时间区从 0 起，各行 40 像素高、从 100 往下排），返回视频片段那一行正中的
   * 高度。
   */
  const layOutTimeline = () => {
    const tracks = document.querySelector<HTMLElement>('.wf-tracks')
    if (tracks === null) throw new Error('时间线还没画出来')
    Object.defineProperty(tracks, 'clientWidth', { configurable: true, value: 5_000 })
    Object.defineProperty(tracks, 'clientHeight', { configurable: true, value: 1_000 })
    for (const [index, lane] of [...document.querySelectorAll('.wf-lane')].entries()) {
      const top = 100 + index * 50
      const box = { top, bottom: top + 40, left: 0, right: 5_000, width: 5_000, height: 40 }
      Object.defineProperty(lane, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ ...box, x: 0, y: top }),
      })
    }
    const lane = document.querySelector('[data-clip-id="clip-1"]')?.closest('.wf-lane')
    if (lane === null || lane === undefined) throw new Error('视频片段不在时间线上')
    return lane.getBoundingClientRect().top + 20
  }

  /** 把素材片的第一个镜头拖到时间线视频那一行的第 `ms` 毫秒处松手。 */
  const dropShotAt = async (ms: number) => {
    const button = await shot(/^生成 A 镜头 1，/)
    const y = layOutTimeline()
    const x = ms / 10
    fireEvent.pointerDown(button, { button: 0, pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(button, { pointerId: 1, clientX: x, clientY: y })
    fireEvent.pointerUp(button, { pointerId: 1, clientX: x, clientY: y })
  }
  const droppedStart = () =>
    Number(
      new RegExp(`<video [^>]*src="${URL_SHORT}"[^>]*>`)
        .exec(savedFilm())?.[0]
        .match(/data-start="([\d.]+)"/)?.[1],
    )

  it('拖一个镜头到节拍附近松手：开头正好落在节拍上', async () => {
    await open()
    await dropShotAt(2_480)
    await waitSaved(() => expect(droppedStart()).toBe(2.5))
  })

  it('关掉吸附：不吸节拍，落在松手的位置', async () => {
    const user = await open()
    await user.click(within(toolbar()).getByRole('button', { name: '吸附' }))
    await dropShotAt(2_480)
    await waitSaved(() => expect(droppedStart()).toBe(2.48))
  })
})

describe('final-cut 编辑器 · 片段右键菜单', () => {
  const user = () => userEvent.setup()
  const openWith = async (clips: Parameters<typeof mainFile>[0], extra = '') => {
    putMockProjectMain(CONVERSATION, mainFile(clips, { width: 720, height: 1280 }, extra))
    await openEditor()
  }
  /** 时间线上名字是 `label` 的片段。 */
  const clipOf = (label: string) => screen.getByRole('group', { name: new RegExp(`^${label}，`) })
  const pressedOf = (label: string) =>
    within(clipOf(label))
      .getByRole('button', { name: /^选中：/ })
      .getAttribute('aria-pressed')
  /** 用鼠标在片段上点右键，等它的菜单出来。 */
  const openMenu = async (label: string) => {
    // 先按下右键：菜单按鼠标打开，不把焦点放到第一项上
    fireEvent.pointerDown(clipOf(label), { button: 2, pointerType: 'mouse' })
    fireEvent.contextMenu(clipOf(label))
    return screen.findByRole('menu', { name: label })
  }
  const itemsOf = (menu: HTMLElement) =>
    within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent)
  const choose = async (label: string, item: string) => {
    const menu = await openMenu(label)
    await user().click(within(menu).getByRole('menuitem', { name: new RegExp(`^${item}`) }))
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  }
  const closeMenu = async () => {
    await user().keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
  }
  const inspector = () => screen.getByRole('tabpanel', { name: '属性' })
  const undoButton = () => within(toolbar()).getByRole('button', { name: '撤销' })
  const savedTag = (id: string) =>
    new RegExp(`<[a-z]+ [^>]*\\bid="${id}"[^>]*>`).exec(savedFilm())?.[0] ?? ''

  it('各种片段的菜单项：最上面是「在播放头处切开」，视频、音频片段能静音，画面区的片段能隐藏，最后是分隔线和「删除片段」；文字随状态变', async () => {
    await openWith(
      [
        video({ src: URL_A, duration: 2_000 }),
        video({ id: 'clip-2', label: '已关', src: URL_B, start: 2_000, muted: true, hidden: true }),
        host({ start: 0, track: 1 }),
        audio({ duration: 4_000 }),
        audio({ id: 'music-2', label: '已静音', start: 4_000, hidden: true }),
      ],
      '<p id="note" data-start="0" data-duration="2" data-track-index="2">手写文字</p>',
    )
    const detach = '分离音频至独立音轨⇧⌘B'
    const expected: Record<string, string[]> = {
      'A · 镜头 1': [detach, '静音此片段', '隐藏片段画面', '删除片段Delete'],
      已关: [detach, '取消静音', '恢复显示画面', '删除片段Delete'],
      测试可填项: ['隐藏片段画面', '删除片段Delete'],
      手写文字: ['隐藏片段画面', '删除片段Delete'],
      配乐: ['静音此片段', '删除片段Delete'],
      已静音: ['取消静音', '删除片段Delete'],
    }
    for (const [label, items] of Object.entries(expected)) {
      const menu = await openMenu(label)
      expect(itemsOf(menu)).toEqual(['在播放头处切开S', ...items])
      // 「在播放头处切开」后面和「删除片段」前面各有一条分隔线，视频片段的「分离音频」自成一组
      const separators = within(menu).getAllByRole('separator')
      expect(separators).toHaveLength(items[0] === detach ? 3 : 2)
      expect(separators[0]?.previousElementSibling).toHaveTextContent(/^在播放头处切开/)
      expect(separators.at(-1)?.nextElementSibling).toHaveTextContent(/^删除片段/)
      // 切开另有用例；关着原声的视频片段不能分离音频，别的项都能选
      for (const item of within(menu).getAllByRole('menuitem').slice(1))
        if (label === '已关' && item.textContent === detach)
          expect(item).toHaveAttribute('aria-disabled', 'true')
        else expect(item).not.toHaveAttribute('aria-disabled')
      await closeMenu()
    }
  })

  it('视频片段的素材没有声音：「取消静音」置灰，悬停说明原因，选它什么都不改、菜单不关；读不出有没有声音时照常能选', async () => {
    await openWith([
      video({ src: URL_SILENT, label: '无声', muted: true }),
      video({ id: 'clip-2', src: URL_UNREADABLE, label: '读不出', start: 2_000, muted: true }),
    ])
    const menu = await openMenu('无声')
    const unmute = () => within(menu).getByRole('menuitem', { name: '取消静音' })
    await waitFor(() => expect(unmute()).toHaveAttribute('aria-disabled', 'true'))
    await user().hover(unmute())
    expect(await screen.findByRole('tooltip')).toHaveTextContent('该素材没有声音，无法打开原声')
    await user().click(unmute())
    expect(screen.getByRole('menu', { name: '无声' })).toBeVisible()
    await closeMenu()
    // 用键盘也能走到置灰的那一项（前两项是「在播放头处切开」「分离音频至独立音轨」），聚焦时说明原因
    await openMenu('无声')
    await user().keyboard('{End}{Home}{ArrowDown}{ArrowDown}')
    await waitFor(() => expect(screen.getByRole('menuitem', { name: '取消静音' })).toHaveFocus())
    expect(await screen.findByRole('tooltip')).toHaveTextContent('该素材没有声音，无法打开原声')
    // 第一下 Esc 先收起说明，第二下关菜单
    await user().keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    expect(screen.getByRole('menu', { name: '无声' })).toBeVisible()
    await closeMenu()
    expect(undoButton()).toHaveAttribute('aria-disabled', 'true')

    await choose('读不出', '取消静音')
    await waitSaved(() => expect(savedTag('clip-2')).toContain('data-has-audio="true"'))
  })

  it('右键没选中的片段先只选中它、侧栏切到「属性」；多选时右键其中一个选中不变，静音、隐藏只改它，删除删掉全部选中的', async () => {
    await openWith([
      video({ label: 'A · 镜头 1', src: URL_A, duration: 2_000 }),
      video({ id: 'clip-2', label: 'B · 镜头 1', src: URL_B, start: 2_000, duration: 1_500 }),
      video({ id: 'clip-3', label: 'A · 镜头 2', src: URL_A, start: 3_500, duration: 1_500 }),
    ])
    // 菜单开着时页面别处对读屏藏起来，关了再看
    await openMenu('B · 镜头 1')
    await closeMenu()
    expect(pressedOf('B · 镜头 1')).toBe('true')
    expect(pressedOf('A · 镜头 1')).toBe('false')
    expect(within(inspector()).getByRole('heading', { name: 'B · 镜头 1' })).toBeVisible()

    const clicks = user()
    await clicks.keyboard('{Shift>}')
    await clicks.click(within(clipOf('A · 镜头 1')).getByRole('button', { name: /^选中：/ }))
    await clicks.keyboard('{/Shift}')
    await choose('B · 镜头 1', '隐藏片段画面')
    await waitSaved(() => expect(savedTag('clip-2')).toContain('data-hidden'))
    expect(savedTag('clip-1')).not.toContain('data-hidden')
    await choose('A · 镜头 1', '静音此片段')
    await waitSaved(() => expect(savedTag('clip-1')).toContain('muted="true"'))
    expect(savedTag('clip-2')).not.toContain('muted')
    expect(['A · 镜头 1', 'B · 镜头 1', 'A · 镜头 2'].map(pressedOf)).toEqual([
      'true',
      'true',
      'false',
    ])

    // 开着波纹编辑：剩下的那个补到开头
    await choose('A · 镜头 1', '删除片段')
    await waitSaved(() => expect(savedClips()).toHaveLength(1))
    expect(savedTag('clip-3')).toContain('data-start="0"')
  })

  it('菜单里的静音、隐藏写进文件的和「属性」里同样的操作一样，各算一步撤销', async () => {
    await openWith([video({ src: URL_A, duration: 2_000 }), audio({ duration: 4_000 })])
    /** 先用菜单做一次、撤销一步，再用「属性」做一次：两次存下来的一样，撤销一步就回到做之前。 */
    const sameAsInspector = async (
      label: string,
      item: string,
      viaInspector: () => Promise<void>,
    ) => {
      const before = savedFilm()
      await choose(label, item)
      await waitSaved(() => expect(savedFilm()).not.toBe(before))
      const viaMenu = savedFilm()
      await user().click(undoButton())
      await waitSaved(() => expect(savedFilm()).not.toBe(viaMenu))
      expect(undoButton()).toHaveAttribute('aria-disabled', 'true')
      const undone = savedFilm()
      await viaInspector()
      await waitSaved(() => expect(savedFilm()).not.toBe(undone))
      expect(savedFilm()).toBe(viaMenu)
      await user().click(undoButton())
      await waitSaved(() => expect(savedFilm()).toBe(undone))
    }
    await sameAsInspector('A · 镜头 1', '静音此片段', () =>
      user().click(within(inspector()).getByRole('switch', { name: '关闭原声' })),
    )
    await sameAsInspector('A · 镜头 1', '隐藏片段画面', () =>
      user().click(within(inspector()).getByRole('button', { name: '隐藏' })),
    )
    await sameAsInspector('配乐', '静音此片段', () =>
      user().click(within(inspector()).getByRole('button', { name: '静音' })),
    )
  })

  it('片段上右键只出片段的菜单，空档上右键只出空档的菜单；在打开的菜单上再点右键不换成空档的菜单', async () => {
    // 片段从 2 秒开始，开头是一段空档
    await openWith([video({ src: URL_A, start: 2_000, duration: 2_000 })])
    const row = screen.getByRole('group', { name: '画面 1' })
    fireEvent.contextMenu(row, { clientX: 0 })
    const gap = await screen.findByRole('menu', { name: '空档' })
    expect(itemsOf(gap)).toEqual(['合拢此空档', '合拢该行的所有空档'])
    await closeMenu()

    const menu = await openMenu('A · 镜头 1')
    expect(screen.getAllByRole('menu')).toEqual([menu])
    fireEvent.contextMenu(within(menu).getByRole('menuitem', { name: '静音此片段' }), {
      clientX: 0,
    })
    expect(screen.queryByRole('menu', { name: '空档' })).toBeNull()
    expect(screen.getAllByRole('menu')).toEqual([menu])
  })

  it('菜单开着时按 Esc 只关菜单、选中不变；菜单里按的键不当快捷键', async () => {
    await openWith([video({ src: URL_A, duration: 2_000 })])
    await openMenu('A · 镜头 1')
    await user().keyboard('{Delete}{Backspace}m')
    await closeMenu()
    expect(within(transport()).getByRole('button', { name: '静音' })).toBeVisible()
    expect(pressedOf('A · 镜头 1')).toBe('true')
    await act(() => new Promise((resolve) => setTimeout(resolve, 900)))
    expect(savedClips()).toHaveLength(1)
  })

  it('拖片段、框选进行中点右键：不出菜单，也不打断拖动', async () => {
    await openWith([video({ src: URL_A, start: 1_000, duration: 2_000 })])
    const body = within(clipOf('A · 镜头 1')).getByRole('button', { name: /^选中：/ })
    fireEvent.pointerDown(body, { button: 0, pointerId: 1, clientX: 10, clientY: 50 })
    fireEvent.pointerMove(body, { pointerId: 1, clientX: 200, clientY: 50 })
    fireEvent.contextMenu(clipOf('A · 镜头 1'))
    fireEvent.contextMenu(screen.getByRole('group', { name: '画面 1' }), { clientX: 0 })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.pointerUp(body, { pointerId: 1, clientX: 200, clientY: 50 })
    await waitSaved(() => expect(savedTag('clip-1')).not.toContain('data-start="1"'))

    const row = screen.getByRole('group', { name: '画面 1' })
    fireEvent.pointerDown(row, { button: 0, pointerId: 2, clientX: 0, clientY: 50 })
    fireEvent.pointerMove(row, { pointerId: 2, clientX: 300, clientY: 80 })
    expect(screen.getByTestId('marquee')).toBeInTheDocument()
    fireEvent.contextMenu(row, { clientX: 0 })
    fireEvent.contextMenu(clipOf('A · 镜头 1'))
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.pointerUp(row, { pointerId: 2, clientX: 300, clientY: 80 })
    expect(screen.queryByTestId('marquee')).toBeNull()
  })
})

describe('final-cut 编辑器 · 切开', () => {
  // 画面 1：A 镜头 1 在 0–2 秒、B 镜头 1 在 2–3.5 秒；画面 2：贴片在 0–3 秒
  const film = () =>
    mainFile(
      [
        video({ label: 'A · 镜头 1', src: URL_A, duration: 2_000, mediaStart: 500 }),
        video({ id: 'clip-2', label: 'B · 镜头 1', src: URL_B, start: 2_000, duration: 1_500 }),
        host({ start: 0, duration: 3_000, track: 1 }),
      ],
      { width: 720, height: 1280 },
    )
  const open = async () => {
    putMockProjectMain(CONVERSATION, film())
    const user = userEvent.setup()
    await openEditor()
    return user
  }
  const lanes = () => screen.getByRole('group', { name: '画面 1' })
  /** 选中片段的按钮：`label` 是名字，名字重了时连时长一起写（「A · 镜头 1，0.8 秒」）。 */
  const body = (label: string) =>
    screen.getByRole('button', { name: new RegExp(`^选中：${label}(，|$)`) })
  const pressedOf = (label: string) => body(label).getAttribute('aria-pressed')
  /** 时间线上的片段，按名字和时长，按时间线上的先后。 */
  const shownClips = () =>
    screen
      .getAllByRole('button', { name: /^选中：/ })
      .map((each) => each.getAttribute('aria-label'))
  /** 存出的文件里的视频片段：起点、时长、入点（秒）。 */
  const savedVideos = () =>
    savedClips().map((tag) =>
      ['data-start', 'data-duration', 'data-media-start'].map(
        (name) => new RegExp(`${name}="([\\d.]+)"`).exec(tag)?.[1],
      ),
    )
  /** 把播放头挪到第 `tenths` 个 0.1 秒（从 0 起）。 */
  const playheadTo = async (user: ReturnType<typeof userEvent.setup>, tenths: number) => {
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)))
    editorRoot().focus()
    await user.keyboard('{ArrowRight}'.repeat(tenths))
  }
  /** 点选片段会把播放头挪进片段里：用进度条把它放回 0.8 秒（在 A 镜头 1 里、不在 B 镜头 1 里）。 */
  const playheadBack = async (user: ReturnType<typeof userEvent.setup>) => {
    progress().focus()
    await user.keyboard(`{Home}${'{ArrowRight}'.repeat(8)}`)
  }
  const picker = (name: string) =>
    within(toolbar()).getByRole('button', { name: `选择工具：${name}` })
  // 测试里时间线没有宽度，按一秒 100 像素排：横坐标 x 就是第 x × 10 毫秒
  const razorAt = (target: HTMLElement, x: number, shiftKey = false) =>
    fireEvent.pointerDown(target, {
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
      clientX: x,
      clientY: 10,
      shiftKey,
    })

  it('按 S 在播放头处切开选中的片段：后半段紧跟着、入点接上，选着的还是前半段，一步撤销', async () => {
    const user = await open()
    await playheadTo(user, 8)
    await user.click(body('A · 镜头 1'))
    editorRoot().focus()
    // 键被用掉了：不往别处传
    expect(fireEvent.keyDown(editorRoot(), { key: 's' })).toBe(false)
    await waitSaved(() => expect(savedClips()).toHaveLength(3))
    expect(savedVideos()).toEqual([
      ['0', '0.8', '0.5'],
      ['0.8', '1.2', '1.3'],
      ['2', '1.5', '0'],
    ])
    expect(shownClips()).toEqual([
      '选中：A · 镜头 1，0.8 秒',
      '选中：A · 镜头 1，1.2 秒',
      '选中：B · 镜头 1，1.5 秒',
      '选中：测试可填项，3.0 秒',
    ])
    expect(body('A · 镜头 1，0.8 秒')).toHaveAttribute('aria-pressed', 'true')
    expect(body('A · 镜头 1，1.2 秒')).toHaveAttribute('aria-pressed', 'false')

    await user.click(within(toolbar()).getByRole('button', { name: '撤销' }))
    await waitSaved(() => expect(savedClips()).toHaveLength(2))
  })

  it('S 切不开时什么都不做：没选中、播放头不在选中的片段里；选中了多个时提示只选一个', async () => {
    const user = await open()
    await playheadTo(user, 8)
    expect(fireEvent.keyDown(editorRoot(), { key: 's' })).toBe(false)
    await user.click(body('B · 镜头 1'))
    await playheadBack(user)
    editorRoot().focus()
    expect(fireEvent.keyDown(editorRoot(), { key: 's' })).toBe(false)
    await user.keyboard('{Shift>}')
    await user.click(body('A · 镜头 1'))
    await user.keyboard('{/Shift}')
    editorRoot().focus()
    await user.keyboard('s')
    expect(await screen.findByText('选中了多个片段，无法切开；请只选中一个片段')).toBeVisible()
    await act(() => new Promise((resolve) => setTimeout(resolve, 900)))
    expect(savedClips()).toHaveLength(2)
    expect(within(toolbar()).getByRole('button', { name: '撤销' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
  })

  it('选择工具的下拉里「在播放头处切开」：切不开时置灰、悬停说明原因；能切时点了就切', async () => {
    const user = await open()
    await playheadTo(user, 8)
    await user.click(picker('选择'))
    const item = () =>
      within(screen.getByRole('menu', { name: '选择工具：选择' })).getByRole('menuitem', {
        name: /^在播放头处切开/,
      })
    expect(item()).toHaveAttribute('aria-disabled', 'true')
    expect(item()).toHaveTextContent('S')
    await user.hover(item())
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      '尚未选中片段，无法切开；请先选中一个片段',
    )
    await user.click(item())
    expect(screen.getByRole('menu', { name: '选择工具：选择' })).toBeVisible()
    await user.keyboard('{Escape}{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    await user.click(body('B · 镜头 1'))
    await playheadBack(user)
    await user.click(picker('选择'))
    await user.hover(item())
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      '播放头不在片段里，无法切开；请把播放头移到片段里面',
    )
    await user.keyboard('{Escape}{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    await user.click(body('A · 镜头 1'))
    await user.click(picker('选择'))
    expect(item()).not.toHaveAttribute('aria-disabled')
    await user.click(item())
    await waitSaved(() => expect(savedClips()).toHaveLength(3))
  })

  it('B 换成切开工具：下拉按钮跟着变；点片段在点的地方切开、选中不变，点得太靠边夹进 0.1 秒', async () => {
    const user = await open()
    await user.click(body('B · 镜头 1'))
    editorRoot().focus()
    await user.keyboard('b')
    expect(picker('切开')).toBeVisible()
    await user.click(picker('切开'))
    const menu = await screen.findByRole('menu', { name: '选择工具：切开' })
    expect(within(menu).getByRole('menuitemradio', { name: '切开' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    // 指针在各行上时有一条竖线跟着它
    fireEvent.pointerMove(lanes(), { clientX: 50, clientY: 10 })
    expect(screen.getByTestId('razor-line')).toHaveStyle({ left: '50px' })
    fireEvent.pointerLeave(lanes())
    expect(screen.queryByTestId('razor-line')).toBeNull()

    razorAt(body('A · 镜头 1'), 50)
    await waitSaved(() => expect(savedClips()).toHaveLength(3))
    expect(savedVideos().slice(0, 2)).toEqual([
      ['0', '0.5', '0.5'],
      ['0.5', '1.5', '1'],
    ])
    expect(pressedOf('B · 镜头 1')).toBe('true')
    expect(pressedOf('A · 镜头 1，0.5 秒')).toBe('false')

    // 点在离开头 0.01 秒处：切在离开头 0.1 秒（最短片段长度）处
    razorAt(body('B · 镜头 1'), 201)
    await waitSaved(() => expect(savedClips()).toHaveLength(4))
    expect(savedVideos().slice(2)).toEqual([
      ['2', '0.1', '0'],
      ['2.1', '1.4', '0.1'],
    ])
  })

  it('切开工具切的是指针所在那一行、那个时间上的片段，不看按下的是哪个元素', async () => {
    const user = await open()
    editorRoot().focus()
    await user.keyboard('b')
    // 按在 A 上、指针的时间已经在 B 上（2.5 秒）：切的是 B
    razorAt(body('A · 镜头 1'), 250)
    await waitSaved(() => expect(savedClips()).toHaveLength(3))
    expect(savedVideos()).toEqual([
      ['0', '2', '0.5'],
      ['2', '0.5', '0'],
      ['2.5', '1', '0.5'],
    ])
  })

  it('切开工具下按着 Shift 点：在那个时间把所有能切的片段一起切开，点在空白处也一样', async () => {
    const user = await open()
    editorRoot().focus()
    await user.keyboard('b')
    razorAt(lanes(), 100, true)
    await waitSaved(() => expect(savedClips()).toHaveLength(3))
    expect(shownClips()).toEqual([
      '选中：A · 镜头 1，1.0 秒',
      '选中：A · 镜头 1，1.0 秒',
      '选中：B · 镜头 1，1.5 秒',
      '选中：测试可填项，1.0 秒',
      '选中：测试可填项，2.0 秒',
    ])
    expect(within(toolbar()).getByRole('button', { name: '撤销' })).not.toHaveAttribute(
      'aria-disabled',
    )
    // 一步撤销：两个片段都回去
    await user.click(within(toolbar()).getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(shownClips()).toHaveLength(3))
  })

  it('切开工具下选中的片段没有裁剪把手：原来聚焦在把手上时焦点交还编辑器，按方向键不改文件；回到选择后把手回来', async () => {
    const user = await open()
    await user.click(body('B · 镜头 1'))
    within(lanes()).getByRole('slider', { name: '裁剪结尾' }).focus()
    await user.keyboard('b')
    expect(picker('切开')).toBeVisible()
    expect(within(lanes()).queryAllByRole('slider', { name: /^裁剪/ })).toEqual([])
    expect(editorRoot()).toHaveFocus()
    await user.keyboard('{ArrowLeft}{Shift>}{ArrowRight}{/Shift}')
    await act(() => new Promise((resolve) => setTimeout(resolve, 900)))
    expect(savedVideos()).toEqual([
      ['0', '2', '0.5'],
      ['2', '1.5', '0'],
    ])
    expect(pressedOf('B · 镜头 1')).toBe('true')

    await user.keyboard('v')
    expect(within(lanes()).getAllByRole('slider', { name: /^裁剪/ })).toHaveLength(2)
  })

  it('切开工具下不能拖片段、不能框选、点片段（含按 Enter）不选中；Esc 先取消选中再回到选择，V 也回到选择', async () => {
    const user = await open()
    await user.click(body('B · 镜头 1'))
    editorRoot().focus()
    await user.keyboard('b')
    // 在片段上按下又拖：只是在按下的地方切一刀，片段不跟着走
    const host = body('测试可填项')
    razorAt(host, 290)
    fireEvent.pointerMove(host, { pointerId: 1, clientX: 100, clientY: 40 })
    fireEvent.pointerUp(host, { pointerId: 1, clientX: 100, clientY: 40 })
    await waitSaved(() => expect(savedFilm()).toContain('data-start="0" data-duration="2.9"'))
    expect(savedFilm()).toMatch(/data-start="2.9" data-duration="0.1"/)
    // 在空白处按下又拖：不出框
    razorAt(lanes(), 380)
    fireEvent.pointerMove(lanes(), { pointerId: 1, clientX: 100, clientY: 40 })
    expect(screen.queryByTestId('marquee')).toBeNull()
    fireEvent.pointerUp(lanes(), { pointerId: 1, clientX: 100, clientY: 40 })
    expect(savedVideos()).toEqual([
      ['0', '2', '0.5'],
      ['2', '1.5', '0'],
    ])
    body('A · 镜头 1').focus()
    await user.keyboard('{Enter}')
    expect(pressedOf('A · 镜头 1')).toBe('false')
    expect(pressedOf('B · 镜头 1')).toBe('true')

    editorRoot().focus()
    await user.keyboard('{Escape}')
    expect(pressedOf('B · 镜头 1')).toBe('false')
    expect(picker('切开')).toBeVisible()
    await user.keyboard('{Escape}')
    expect(picker('选择')).toBeVisible()
    await user.keyboard('b')
    expect(picker('切开')).toBeVisible()
    await user.keyboard('v')
    expect(picker('选择')).toBeVisible()
    await user.keyboard('b')
    await user.keyboard('a')
    expect(picker('选择')).toBeVisible()
    // 回到选择以后点片段又是选中
    await user.click(body('A · 镜头 1'))
    expect(pressedOf('A · 镜头 1')).toBe('true')
  })

  it('切开工具下片段的右键菜单照常能用：选里面的项不当成在时间线上点了一下', async () => {
    const user = await open()
    editorRoot().focus()
    await user.keyboard('b')
    const clip = screen.getByRole('group', { name: /^B · 镜头 1，/ })
    fireEvent.pointerDown(clip, { button: 2, pointerType: 'mouse' })
    fireEvent.contextMenu(clip)
    const menu = await screen.findByRole('menu', { name: 'B · 镜头 1' })
    const mute = within(menu).getByRole('menuitem', { name: '静音此片段' })
    // 按着 Shift 在菜单项上按下：不在那个位置切开所有片段
    razorAt(mute, 100, true)
    await user.click(mute)
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await waitSaved(() => expect(savedClips()[1]).toContain('muted="true"'))
    expect(savedClips()).toHaveLength(2)
    expect(shownClips()).toHaveLength(3)
  })

  it('片段右键菜单最上面是「在播放头处切开」：播放头在片段里时能切，不在时置灰、悬停说明原因', async () => {
    const user = await open()
    await playheadTo(user, 8)
    const openMenu = async (label: string) => {
      const clip = screen.getByRole('group', { name: new RegExp(`^${label}，`) })
      fireEvent.pointerDown(clip, { button: 2, pointerType: 'mouse' })
      fireEvent.contextMenu(clip)
      return screen.findByRole('menu', { name: label })
    }
    const splitItem = (menu: HTMLElement) =>
      within(menu).getByRole('menuitem', { name: /^在播放头处切开/ })

    const outside = await openMenu('B · 镜头 1')
    expect(splitItem(outside)).toHaveAttribute('aria-disabled', 'true')
    await user.hover(splitItem(outside))
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      '播放头不在片段里，无法切开；请把播放头移到片段里面',
    )
    await user.click(splitItem(outside))
    expect(screen.getByRole('menu', { name: 'B · 镜头 1' })).toBeVisible()
    await user.keyboard('{Escape}{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())

    const inside = await openMenu('A · 镜头 1')
    expect(splitItem(inside)).not.toHaveAttribute('aria-disabled')
    expect(splitItem(inside)).toHaveTextContent('S')
    await user.click(splitItem(inside))
    await waitSaved(() => expect(savedClips()).toHaveLength(3))
    expect(savedVideos()[1]).toEqual(['0.8', '1.2', '1.3'])
  })
})

describe('final-cut 编辑器 · 分离音频', () => {
  const openWith = async (clips: Parameters<typeof mainFile>[0]) => {
    putMockProjectMain(CONVERSATION, mainFile(clips, { width: 720, height: 1280 }))
    await openEditor()
    return userEvent.setup()
  }
  const clipOf = (label: string) => screen.getByRole('group', { name: new RegExp(`^${label}，`) })
  const select = (user: ReturnType<typeof userEvent.setup>, label: string) =>
    user.click(within(clipOf(label)).getByRole('button', { name: /^选中：/ }))
  const inspector = () => screen.getByRole('tabpanel', { name: '属性' })
  const savedTags = () => savedFilm().match(/<(video|audio) [^>]*>/g) ?? []
  const pair = (offset = 0) => [
    audio({
      id: 'voice',
      label: 'A · 镜头 1 · 原声',
      src: URL_A,
      start: 1_000 + offset,
      duration: 2_000,
      link: offset === 0 ? 'lk-1' : null,
      syncOrigin: 'lk-1',
    }),
    video({
      src: URL_A,
      start: 1_000,
      duration: 2_000,
      muted: true,
      link: offset === 0 ? 'lk-1' : null,
      syncOrigin: 'lk-1',
    }),
  ]

  it('选中有声音的视频片段点「分离音频」：声音区最上面多一条「原声」行、选中原声，同步卡写口型同步、小标写联动；⇧⌘B 合并回视频', async () => {
    const user = await openWith([
      video({ src: URL_A, duration: 2_000 }),
      audio({ start: 0, duration: 4_000 }),
    ])
    const button = () => within(toolbar()).getByRole('button', { name: /^(分离音频|合并回视频)$/ })
    expect(button()).toHaveAccessibleName('分离音频')
    expect(button()).toHaveAttribute('aria-disabled', 'true')
    await select(user, 'A · 镜头 1')
    await waitFor(() => expect(button()).not.toHaveAttribute('aria-disabled'))
    await user.click(button())

    expect(screen.getByRole('group', { name: '原声' })).toBeVisible()
    expect(screen.getByRole('group', { name: '配乐' })).toBeVisible()
    expect(clipOf('A · 镜头 1 · 原声')).toHaveAccessibleName(/，联动$/)
    expect(within(inspector()).getByRole('heading', { name: 'A · 镜头 1 · 原声' })).toBeVisible()
    expect(within(inspector()).getByTestId('sync-status')).toHaveTextContent('与画面口型同步')
    expect(within(inspector()).getByRole('switch', { name: '联动' })).toBeChecked()
    expect(button()).toHaveAccessibleName('合并回视频')
    await waitSaved(() => expect(savedTags()).toHaveLength(3))
    // 原声写在视频片段前面
    expect(savedTags()[0]).toMatch(/^<audio [^>]*data-sync-origin="lk-1"/)
    expect(savedTags()[1]).toMatch(/^<video [^>]*data-sync-origin="lk-1"/)

    editorRoot().focus()
    await user.keyboard('{Shift>}{Meta>}b{/Meta}{/Shift}')
    expect(screen.queryByRole('group', { name: '原声' })).toBeNull()
    expect(within(inspector()).getByRole('heading', { name: 'A · 镜头 1' })).toBeVisible()
    await waitSaved(() => expect(savedTags()).toHaveLength(2))
    expect(savedTags()[0]).toContain('data-has-audio="true"')
  })

  it('不能分离：素材没有声音、已关闭原声时按钮置灰并说明原因', async () => {
    const user = await openWith([video({ src: URL_A, duration: 2_000, muted: true })])
    await select(user, 'A · 镜头 1')
    const detach = within(inspector()).getByRole('button', { name: '分离音频' })
    expect(detach).toHaveAttribute('aria-disabled', 'true')
    await user.click(detach)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      '已关闭原声，无法分离音频；请先打开原声',
    )
    expect(savedTags()).toHaveLength(1)
  })

  it('原声单独挪开了：时间线小标和同步卡写错开多少，视频片段那边合并置灰；「对齐画面」挪回去，联动仍关着', async () => {
    const user = await openWith(pair(400))
    expect(clipOf('A · 镜头 1 · 原声')).toHaveAccessibleName(/，错开 \+0\.40s$/)

    await select(user, 'A · 镜头 1')
    expect(within(inspector()).getByText('原声已分离至「原声」行')).toBeVisible()
    expect(within(inspector()).getByTestId('sync-status')).toHaveTextContent('错开 +0.40s')
    expect(within(inspector()).getByRole('switch', { name: '与分离原声联动' })).not.toBeChecked()
    expect(within(inspector()).queryByRole('switch', { name: '关闭原声' })).toBeNull()
    const merge = within(inspector()).getByRole('button', { name: '合并' })
    expect(merge).toHaveAttribute('aria-disabled', 'true')
    await user.hover(merge)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('原声和画面没对齐，请先对齐口型')

    await user.click(within(inspector()).getByRole('button', { name: '定位分离原声' }))
    expect(within(inspector()).getByTestId('sync-status')).toHaveTextContent('与画面错开 +0.40 秒')
    await user.click(within(inspector()).getByRole('button', { name: '对齐画面' }))
    expect(within(inspector()).getByTestId('sync-status')).toHaveTextContent('与画面口型同步')
    expect(clipOf('A · 镜头 1 · 原声')).toHaveAccessibleName(/秒$/)
    await waitSaved(() => expect(savedTags()[0]).toContain('data-start="1"'))
    expect(savedTags()[0]).not.toContain('data-link')
  })

  it('联动开着：改原声的倍速两段一起改；删掉其中一段时两段都删', async () => {
    const user = await openWith(pair())
    await select(user, 'A · 镜头 1 · 原声')
    await user.click(within(inspector()).getByRole('button', { name: '倍速：1x' }))
    await user.click(within(inspector()).getByRole('button', { name: /^倍速 1x，/ }))
    await user.keyboard('2{Enter}')
    await waitSaved(() =>
      expect(savedTags().map((tag) => tag.includes('data-playback-rate="2"'))).toEqual([
        true,
        true,
      ]),
    )
    await select(user, 'A · 镜头 1')
    await user.keyboard('{Delete}')
    await waitSaved(() => expect(savedTags()).toHaveLength(0))
  })

  it('一对里的片段的右键菜单：选中另一段、联动开关、合并回视频；视频片段没有静音', async () => {
    await openWith(pair())
    fireEvent.pointerDown(clipOf('A · 镜头 1'), { button: 2, pointerType: 'mouse' })
    fireEvent.contextMenu(clipOf('A · 镜头 1'))
    const menu = await screen.findByRole('menu', { name: 'A · 镜头 1' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual([
      '在播放头处切开S',
      '选中分离的原声片段',
      '解除与画面的联动',
      '合并回视频⇧⌘B',
      '隐藏片段画面',
      '删除片段Delete',
    ])
    await userEvent.setup().click(within(menu).getByRole('menuitem', { name: '解除与画面的联动' }))
    await waitSaved(() => expect(savedTags().join('')).not.toContain('data-link'))
  })
})
