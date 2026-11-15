import { act, renderHook, waitFor } from '@testing-library/react'
import { delay, http, HttpResponse } from 'msw'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { FsChange, SessionUpdate, TranscriptConnection } from '@/shared/transcript/connection'
import { TranscriptConnectionContext } from '@/shared/transcript/transcript-context'
import { audio, fixtureCatalog, host, mainFile, video } from '@/testing/final-cut'
import { itemFileContent, server } from '@/testing/mocks/server'
import { mockProjectMain, putMockProjectMain } from '@/testing/mocks/whole-film'
import { mockWorkspaceFile, putMockWorkspaceFile } from '@/testing/mocks/workspace'
import { FONT_BLOCK_END, FONT_BLOCK_START, type FilmClip, type VideoClip } from './composition/film'
import type { ProjectMain } from './final-cut.api'
import { useFilmSession, type NewAudio, type NewVideo } from './use-film-session'

const CONVERSATION = '6b0f3a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'
const OTHER_SRC = 'https://media.test/videos/b.mp4'
const MAIN_PATH = 'final-cut/index.html'
const WRITE = '*/api/conversations/:conversationId/workspace/file'
const CREATE = '*/api/conversations/:conversationId/final-cut/files'
const READ = '*/api/conversations/:conversationId/workspace/file'
const CANVAS = { width: 720, height: 1280 }

/** 一次保存：第一次走新建（`expectedVersion` 是 null），之后按版本号写主文件。 */
type Save = { html: string; expectedVersion: number | null }

const recordSaves = (slow = 0) => {
  const saves: Save[] = []
  server.use(
    http.put(WRITE, async ({ request }) => {
      const body = (await request.clone().json()) as {
        path: string
        content: string
        expectedVersion: number
      }
      if (body.path === MAIN_PATH)
        saves.push({ html: body.content, expectedVersion: body.expectedVersion })
      if (slow > 0) await delay(slow)
      return undefined
    }),
    http.post(CREATE, async ({ request }) => {
      const body = (await request.clone().json()) as { path: string; content: string }
      if (body.path === 'index.html') saves.push({ html: body.content, expectedVersion: null })
      if (slow > 0) await delay(slow)
      return undefined
    }),
  )
  return saves
}

/** 编辑器订阅文件变化用的连接：测试里自己发通知。 */
const fakeConnection = () => {
  const files = new Set<{ paths: readonly string[]; handler: (changes: FsChange[]) => void }>()
  const sessions = new Set<(update: SessionUpdate) => void>()
  const connection = {
    watchFs: (
      _conversationId: string,
      paths: readonly string[],
      handler: (changes: FsChange[]) => void,
    ) => {
      const watch = { paths, handler }
      files.add(watch)
      return () => void files.delete(watch)
    },
    watchSessions: (watcher: (update: SessionUpdate) => void) => {
      sessions.add(watcher)
      return () => void sessions.delete(watcher)
    },
  } as unknown as TranscriptConnection
  const notify = (...paths: string[]) =>
    act(() => {
      for (const watch of files)
        watch.handler(paths.map((path) => ({ path, change: 'modified' as const })))
    })
  return { connection, notify }
}

const open = async (
  initial: ProjectMain | null = null,
  debounceMs = 10,
  conversation = CONVERSATION,
) => {
  const onNotice = vi.fn<(message: string) => void>()
  const { connection, notify } = fakeConnection()
  const hook = renderHook(
    () => useFilmSession(conversation, initial, fixtureCatalog, { debounceMs, onNotice }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <TranscriptConnectionContext value={connection}>{children}</TranscriptConnectionContext>
      ),
    },
  )
  await waitFor(() => expect(hook.result.current.opening).toBe(false))
  return { ...hook, onNotice, notify }
}

type Session = Awaited<ReturnType<typeof open>>['result']

const piece = (overrides: Partial<NewVideo> = {}): NewVideo => ({
  label: 'A · 镜头 1',
  src: video().src,
  mediaStart: 0,
  duration: 2_000,
  muted: false,
  ...overrides,
})

const add = (result: Session, ...videos: NewVideo[]) =>
  act(() => result.current.addVideos(CANVAS, videos))

/** 工程里的视频片段，按它们在文件里的先后。 */
const videosOf = (result: Session): VideoClip[] =>
  (result.current.film?.clips ?? []).filter((clip) => clip.kind === 'video')

/** 工程里的视频片段按起点排，写成「地址、起点、时长」。 */
const spans = (result: Session) =>
  videosOf(result)
    .toSorted((left, right) => left.start - right.start)
    .map((clip) => [clip.src, clip.start, clip.duration])

const fixtureItem = (name: string) => {
  const item = fixtureCatalog.items.find((candidate) => candidate.name === name)
  if (item === undefined) throw new Error(`测试组件库里没有 ${name}`)
  return item
}

const settled = (result: Session) => waitFor(() => expect(result.current.save.kind).toBe('idle'))

// 每次用一段新的对话：上一个用例收尾时的保存晚到，也改不到这一个用例存着的工程
const openWith = (clips: FilmClip[], extra = '') => {
  const conversation = crypto.randomUUID()
  return open(putMockProjectMain(conversation, mainFile(clips, CANVAS, extra)), 10, conversation)
}

describe('useFilmSession · 读存', () => {
  it('还没有工程时没有文件，打开不保存', async () => {
    const saves = recordSaves()
    const { result } = await open()
    expect(result.current.film).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(saves).toEqual([])
  })

  it('打开工程主文件：读出视频片段和画幅，不改就不保存', async () => {
    const saves = recordSaves()
    const second = video({ id: 'clip-2', src: OTHER_SRC, start: 2_000, mediaStart: 500 })
    const { result } = await open(
      putMockProjectMain(CONVERSATION, mainFile([video(), second], CANVAS)),
    )
    expect(result.current.film).toMatchObject({
      canvas: CANVAS,
      clips: [video(), second],
      durationMs: 4_000,
      canUndo: false,
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(saves).toEqual([])
  })

  it('第一次加素材时用模板建主文件，素材接在末尾；停下后第一次保存走新建，之后带版本号写', async () => {
    const saves = recordSaves()
    const { result } = await open()
    await add(result, piece(), piece({ mediaStart: 3_000, duration: 1_500 }))
    expect(spans(result)).toEqual([
      [video().src, 0, 2_000],
      [video().src, 2_000, 1_500],
    ])
    expect(result.current.film).toMatchObject({ canvas: CANVAS, durationMs: 3_500 })
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.expectedVersion).toBeNull()
    expect(saves[0]?.html).toMatch(/id="film"[^>]*data-duration="3.5"/)
    expect(saves[0]?.html).toContain('<script src="vendor/npm/gsap@3.14.2/dist/gsap.min.js">')
    expect(saves[0]?.html).toContain(FONT_BLOCK_START)
    await settled(result)
    expect(mockProjectMain(CONVERSATION)).toEqual({ content: saves[0]?.html, version: 1 })

    await add(result, piece({ src: OTHER_SRC }))
    expect(spans(result).at(-1)).toEqual([OTHER_SRC, 3_500, 2_000])
    await waitFor(() => expect(saves).toHaveLength(2))
    expect(saves[1]?.expectedVersion).toBe(1)
    await settled(result)
    expect(mockProjectMain(CONVERSATION)?.version).toBe(2)
  })

  it('静音的素材写 muted、不写有声音的标记，有声音的反过来；地址只写在 src 上', async () => {
    const saves = recordSaves()
    const { result } = await open()
    await add(result, piece({ muted: true }), piece({ mediaStart: 3_000, duration: 1_000 }))
    await waitFor(() => expect(saves).toHaveLength(1))
    const tagAt = (start: number) =>
      new RegExp(`<video [^>]*data-start="${start}"[^>]*>`).exec(saves[0]?.html ?? '')?.[0]
    expect(tagAt(0)).toContain(' muted="true"')
    expect(tagAt(0)).not.toContain('data-has-audio')
    expect(tagAt(2)).toContain(' data-has-audio="true"')
    expect(tagAt(2)).not.toContain('muted')
    expect(saves[0]?.html).not.toContain('data-var-src')
    expect(saves[0]?.html).not.toContain('data-composition-variables')
  })

  it('同一时刻只有一次保存在途，回来后再按新的版本号存最新的一版', async () => {
    const saves = recordSaves(80)
    const { result } = await open()
    await add(result, piece())
    await waitFor(() => expect(saves).toHaveLength(1))
    await add(result, piece({ mediaStart: 2_000 }))
    await add(result, piece({ mediaStart: 4_000 }))
    await waitFor(() => expect(saves).toHaveLength(2))
    expect(saves[1]?.expectedVersion).toBe(1)
    expect(saves[1]?.html.match(/<video /g)).toHaveLength(3)
    await settled(result)
    expect(saves).toHaveLength(2)
  })

  it('别处已存过更新的一版（写的时候 409）：换成那一版、清空历史，并提示', async () => {
    const stored = putMockProjectMain(CONVERSATION, mainFile([video()], CANVAS))
    const newer = video({ mediaStart: 500, duration: 3_000 })
    putMockProjectMain(CONVERSATION, mainFile([newer], CANVAS))
    const { result, onNotice } = await open(stored)
    await add(result, piece({ mediaStart: 6_000 }))
    await waitFor(() => expect(videosOf(result)).toEqual([newer]))
    expect(result.current.film?.canUndo).toBe(false)
    expect(onNotice).toHaveBeenCalledWith(
      '成片草稿已在别处修改，已切换到最新版本；未保存的改动已放弃',
    )
    await settled(result)
    expect(mockProjectMain(CONVERSATION)?.version).toBe(2)
  })

  it('第一次保存时工程已经被别处建好了（新建 409）：同样换成那一份并提示', async () => {
    const { result, onNotice } = await open()
    putMockProjectMain(CONVERSATION, mainFile([video({ id: 'theirs' })], CANVAS))
    await add(result, piece({ mediaStart: 6_000 }))
    await waitFor(() => expect(videosOf(result).map((clip) => clip.id)).toEqual(['theirs']))
    expect(onNotice).toHaveBeenCalledWith(
      '成片草稿已在别处修改，已切换到最新版本；未保存的改动已放弃',
    )
    await settled(result)
    expect(mockProjectMain(CONVERSATION)?.version).toBe(1)
  })

  it('保存失败时说明原因，重新保存后恢复', async () => {
    server.use(
      http.post(CREATE, () => HttpResponse.json({ detail: '工作区写不进去' }, { status: 503 }), {
        once: true,
      }),
    )
    const { result } = await open()
    await add(result, piece())
    await waitFor(() =>
      expect(result.current.save).toEqual({
        kind: 'failed',
        message: '成片草稿保存失败：工作区写不进去',
      }),
    )
    act(() => result.current.flush())
    await settled(result)
    expect(mockProjectMain(CONVERSATION)?.version).toBe(1)
  })

  it('<head> 里手写的注释、样式、脚本：编辑、保存以后原样还在，只有字体块按片段重算', async () => {
    const handHead =
      '<head>\n<meta charset="utf-8">\n<!-- 手写的注释 -->\n<style>.mine{color:red}</style>\n' +
      `<script>window.hand = 1</script>\n${FONT_BLOCK_START}\n${FONT_BLOCK_END}\n` +
      '<script src="vendor/npm/extra.js"></script>\n</head>'
    const html =
      `<!doctype html>\n<html>\n${handHead}\n<body>\n` +
      '<main id="stage" data-composition-id="mine" data-start="0" data-duration="2" data-width="720" data-height="1280">\n' +
      `${'<video id="v" src="https://media.test/videos/a.mp4" data-start="0" data-duration="2" data-track-index="0"></video>'}\n` +
      '</main>\n</body>\n</html>\n'
    const saves = recordSaves()
    const conversation = crypto.randomUUID()
    const { result } = await open(putMockProjectMain(conversation, html), 10, conversation)
    expect(result.current.film?.canvas).toEqual(CANVAS)
    await act(() =>
      result.current.addItem(
        CANVAS,
        fixtureItem('fixture-fields'),
        { text: '新品' },
        { track: 1, start: 0 },
      ),
    )
    await waitFor(() => expect(saves).toHaveLength(1))
    const saved = saves[0]?.html ?? ''
    const outside = (text: string) =>
      text.slice(0, text.indexOf(FONT_BLOCK_START)) +
      text.slice(text.indexOf(FONT_BLOCK_END) + FONT_BLOCK_END.length)
    const headOf = (text: string) => /<head>[\s\S]*<\/head>/.exec(text)?.[0] ?? ''
    expect(outside(headOf(saved))).toBe(outside(handHead))
    expect(saved).toMatch(/<main [^>]*id="stage"/)
    expect(result.current.film?.clips.map((clip) => clip.kind)).toEqual(['host', 'video'])
  })
})

describe('useFilmSession · 文件变化的通知', () => {
  it('自己保存的那一版也会通知：不重读、不提示，撤销还管用', async () => {
    const saves = recordSaves(80)
    let reads = 0
    server.use(
      http.get(READ, () => {
        reads += 1
        return undefined
      }),
    )
    const { result, onNotice, notify } = await open(
      putMockProjectMain(CONVERSATION, mainFile([video()], CANVAS)),
    )
    await add(result, piece({ mediaStart: 3_000 }))
    await waitFor(() => expect(saves).toHaveLength(1))
    // 通知不带版本号，在保存还没回来的时候就到了
    notify(MAIN_PATH)
    await settled(result)
    await waitFor(() => expect(reads).toBe(1))
    notify(MAIN_PATH)
    await waitFor(() => expect(reads).toBe(2))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(onNotice).not.toHaveBeenCalled()
    expect(result.current.film?.canUndo).toBe(true)
    act(() => result.current.undo())
    expect(spans(result)).toEqual([[video().src, 0, 2_000]])
    await waitFor(() => expect(saves).toHaveLength(2))
    expect(saves[1]?.expectedVersion).toBe(2)
  })

  it('主文件在别处改了：换成那一版、放弃本地没存的改动并提示', async () => {
    const { result, onNotice, notify } = await open(
      putMockProjectMain(CONVERSATION, mainFile([video()], CANVAS)),
      60_000,
    )
    await add(result, piece({ mediaStart: 3_000 }))
    const theirs = video({ id: 'theirs', duration: 4_000 })
    putMockProjectMain(CONVERSATION, mainFile([theirs], CANVAS))
    notify(MAIN_PATH)
    await waitFor(() => expect(videosOf(result)).toEqual([theirs]))
    expect(result.current.film?.canUndo).toBe(false)
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(
      '成片草稿已在别处修改，已切换到最新版本；未保存的改动已放弃',
    )
  })

  it('工程主文件被删掉：回到还没有工程的样子', async () => {
    const conversation = crypto.randomUUID()
    const { result, notify } = await open(
      putMockProjectMain(conversation, mainFile([video()], CANVAS)),
      10,
      conversation,
    )
    server.use(
      http.get(READ, () => HttpResponse.json({ detail: '文件不存在' }, { status: 404 }), {
        once: true,
      }),
    )
    notify(MAIN_PATH)
    await waitFor(() => expect(result.current.film).toBeNull())
  })

  it('工程里别的文件变了：预览要重新加载，主文件不重读', async () => {
    let reads = 0
    server.use(
      http.get(READ, () => {
        reads += 1
        return undefined
      }),
    )
    const { result, notify } = await open(
      putMockProjectMain(CONVERSATION, mainFile([video()], CANVAS)),
    )
    expect(result.current.filesRevision).toBe(0)
    notify('final-cut/compositions/fixtures/fixture-fields.html')
    expect(result.current.filesRevision).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(reads).toBe(0)
    expect(result.current.film?.clips).toEqual([video()])
  })
})

describe('useFilmSession · 编辑', () => {
  it('撤销退回加之前的样子，重做再加回来，两次都会保存', async () => {
    const saves = recordSaves()
    const { result } = await open(putMockProjectMain(CONVERSATION, mainFile([video()], CANVAS)))
    await add(result, piece({ mediaStart: 3_000 }))
    await waitFor(() => expect(saves).toHaveLength(1))
    await settled(result)
    expect(result.current.film?.canUndo).toBe(true)

    act(() => result.current.undo())
    expect(spans(result)).toEqual([[video().src, 0, 2_000]])
    expect(result.current.film).toMatchObject({ durationMs: 2_000, canRedo: true })
    await waitFor(() => expect(saves).toHaveLength(2))
    await settled(result)

    act(() => result.current.redo())
    expect(spans(result)).toHaveLength(2)
    await waitFor(() => expect(saves).toHaveLength(3))
    await settled(result)
  })

  it('指定了落点：从那一行的那个时间放起，几段一段接一段；工程总长跟着变', async () => {
    const saves = recordSaves()
    const { result } = await openWith([video({ duration: 2_000 })])
    await act(() =>
      result.current.addVideos(
        CANVAS,
        [piece({ src: OTHER_SRC, duration: 1_000 }), piece({ src: OTHER_SRC, duration: 500 })],
        { track: 0, start: 4_000 },
      ),
    )
    expect(spans(result)).toEqual([
      [video().src, 0, 2_000],
      [OTHER_SRC, 4_000, 1_000],
      [OTHER_SRC, 5_000, 500],
    ])
    expect(result.current.film?.durationMs).toBe(5_500)
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.html).toMatch(/id="film"[^>]*data-duration="5.5"/)
  })

  const openThree = () =>
    openWith([
      video({ id: 'a', duration: 2_000 }),
      video({ id: 'b', src: OTHER_SRC, start: 2_000, duration: 1_000 }),
      video({ id: 'c', start: 3_000, duration: 1_500 }),
    ])

  it('改几个片段的起止和入点：算一步撤销，工程总长跟着变，存出的文件写着新的时间', async () => {
    const saves = recordSaves()
    const { result } = await openThree()
    act(() =>
      result.current.retime(
        new Map([
          ['b', { start: 2_000, duration: 600, mediaStart: 0 }],
          ['c', { start: 3_400, duration: 2_000, mediaStart: 400 }],
        ]),
      ),
    )
    expect(spans(result).slice(1)).toEqual([
      [OTHER_SRC, 2_000, 600],
      [video().src, 3_400, 2_000],
    ])
    expect(videosOf(result).at(-1)).toMatchObject({ mediaStart: 400 })
    expect(result.current.film?.durationMs).toBe(5_400)
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.html).toMatch(
      /id="c"[^>]*data-start="3.4" data-duration="2"[^>]*data-media-start="0.4"/,
    )
    expect(saves[0]?.html).toMatch(/id="film"[^>]*data-duration="5.4"/)

    act(() => result.current.undo())
    expect(spans(result).slice(1)).toEqual([
      [OTHER_SRC, 2_000, 1_000],
      [video().src, 3_000, 1_500],
    ])
    expect(result.current.film?.durationMs).toBe(4_500)
    expect(result.current.film?.canUndo).toBe(false)
  })

  it('删掉一个片段、开着波纹编辑：后面的片段往前补上；撤销回来', async () => {
    const saves = recordSaves()
    const { result } = await openThree()
    act(() => result.current.removeClips(['b'], true))
    expect(spans(result)).toEqual([
      [video().src, 0, 2_000],
      [video().src, 2_000, 1_500],
    ])
    expect(result.current.film?.durationMs).toBe(3_500)
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.html).not.toContain(OTHER_SRC)

    act(() => result.current.undo())
    expect(spans(result)).toHaveLength(3)
    expect(result.current.film?.html).toContain(OTHER_SRC)
  })

  it('删掉一个片段、关着波纹编辑：留下空档', async () => {
    const { result } = await openThree()
    act(() => result.current.removeClips(['b'], false))
    expect(spans(result)).toEqual([
      [video().src, 0, 2_000],
      [video().src, 3_000, 1_500],
    ])
  })

  it('把几个片段一起挪到新的起点（合拢空档）：算一步撤销，工程总长跟着变', async () => {
    const { result } = await openThree()
    act(() => result.current.removeClips(['b'], false))
    act(() => result.current.restart(new Map([['c', 2_000]])))
    expect(spans(result)).toEqual([
      [video().src, 0, 2_000],
      [video().src, 2_000, 1_500],
    ])
    expect(result.current.film?.durationMs).toBe(3_500)

    act(() => result.current.undo())
    expect(spans(result).at(-1)).toEqual([video().src, 3_000, 1_500])
    expect(result.current.film?.durationMs).toBe(4_500)
  })

  const layout = (result: Session) =>
    videosOf(result).map((clip) => [clip.id, clip.track, clip.start, clip.z])

  /** 存出的文件里根下的片段，按文件里的先后。 */
  const savedOrder = (html: string | undefined) =>
    [...new DOMParser().parseFromString(html ?? '', 'text/html').querySelectorAll('#film > *')].map(
      (clip) => clip.id,
    )

  it('加进去的片段写在根下第一个、叠在最上面：叠放顺序按文件里所有的片段数算，组件或块的片段和音频片段也算', async () => {
    const saves = recordSaves()
    const { result } = await openWith([
      video({ id: 'a', duration: 2_000 }),
      host({ track: 1 }),
      audio(),
    ])
    await act(() =>
      result.current.addVideos(CANVAS, [piece({ duration: 1_000 }), piece({ duration: 500 })], {
        track: 2,
        start: 500,
      }),
    )
    const [second, first] = videosOf(result)
    expect(layout(result)).toEqual([
      [second?.id, 2, 1_500, 5],
      [first?.id, 2, 500, 4],
      ['a', 0, 0, 0],
    ])
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(savedOrder(saves[0]?.html)).toEqual([second?.id, first?.id, 'a', 'title-1', 'music-1'])
    expect(saves[0]?.html).toContain(`<video style="z-index: 5" id="${second?.id}"`)
  })

  it('同一行里横着挪不改叠放顺序和文件里的先后', async () => {
    const { result } = await openThree()
    await act(() =>
      result.current.addVideos(CANVAS, [piece({ duration: 1_000 })], { track: 1, start: 6_000 }),
    )
    const added = videosOf(result).find((clip) => clip.track === 1)
    if (added === undefined) throw new Error('镜头没有加进去')
    act(() =>
      result.current.retime(new Map([[added.id, { start: 500, duration: 1_000, mediaStart: 0 }]])),
    )
    expect(layout(result)).toEqual([
      [added.id, 1, 500, 4],
      ['a', 0, 0, 0],
      ['b', 0, 2_000, 0],
      ['c', 0, 3_000, 0],
    ])
  })

  it('把片段换到上面一行：抬到它压着的、时间上重叠的片段之上，别的片段和文件里的先后不动；一步撤销', async () => {
    const saves = recordSaves()
    const { result } = await openWith([
      video({ id: 'x', duration: 2_000 }),
      video({ id: 'm', duration: 1_000, track: 1 }),
      video({ id: 'y', start: 2_500, duration: 3_500, track: 1, z: 2 }),
    ])
    act(() => result.current.moveClip('m', { track: 0, start: 3_000 }, 'up'))
    expect(layout(result)).toEqual([
      ['x', 0, 0, 0],
      ['m', 0, 3_000, 3],
      ['y', 1, 2_500, 2],
    ])
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(savedOrder(saves[0]?.html)).toEqual(['x', 'm', 'y'])
    expect(saves[0]?.html).toMatch(
      /<video style="z-index: 3" id="m"[^>]*data-start="3"[^>]*data-track-index="0"/,
    )

    act(() => result.current.undo())
    expect(layout(result)).toEqual([
      ['x', 0, 0, 0],
      ['m', 1, 0, 0],
      ['y', 1, 2_500, 2],
    ])
    expect(result.current.film?.canUndo).toBe(false)
  })

  it('把片段换到下面一行：降到盖着它的、时间上重叠的片段之下，降到 0 时去掉叠放顺序；一步撤销', async () => {
    const saves = recordSaves()
    const { result } = await openWith([
      video({ id: 'a', duration: 2_000, z: 1 }),
      video({ id: 'b', start: 2_000, duration: 1_000 }),
      video({ id: 'c', start: 3_000, duration: 1_500, z: 3 }),
    ])
    act(() => result.current.moveClip('c', { track: 1, start: 500 }, 'down'))
    expect(layout(result)).toEqual([
      ['a', 0, 0, 1],
      ['b', 0, 2_000, 0],
      ['c', 1, 500, 0],
    ])
    expect(result.current.film?.durationMs).toBe(3_000)
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(savedOrder(saves[0]?.html)).toEqual(['a', 'b', 'c'])
    expect(saves[0]?.html).not.toMatch(/<video [^>]*z-index[^>]*id="c"/)

    act(() => result.current.undo())
    expect(layout(result)).toEqual([
      ['a', 0, 0, 1],
      ['b', 0, 2_000, 0],
      ['c', 0, 3_000, 3],
    ])
    expect(result.current.film?.canUndo).toBe(false)
  })

  it('不调方向时只改行号和起点', async () => {
    const { result } = await openWith([
      video({ id: 'x', duration: 2_000 }),
      video({ id: 'm', duration: 1_000, track: 1 }),
      video({ id: 'y', start: 2_500, duration: 3_500, track: 1, z: 2 }),
    ])
    act(() => result.current.moveClip('m', { track: 0, start: 3_000 }, null))
    expect(layout(result)).toEqual([
      ['x', 0, 0, 0],
      ['m', 0, 3_000, 0],
      ['y', 1, 2_500, 2],
    ])
  })

  it('第 0 行没有片段时，最上面那一行就是第一行：没给落点的镜头接在它末尾，波纹编辑补的也是它', async () => {
    const { result } = await openWith([
      video({ id: 'low', track: 2, duration: 5_000 }),
      video({ id: 'a', track: 1, duration: 2_000 }),
      video({ id: 'b', track: 1, start: 2_000, duration: 1_000 }),
    ])
    await add(result, piece({ duration: 1_500 }))
    const added = videosOf(result).find((clip) => !['low', 'a', 'b'].includes(clip.id))
    expect(added).toMatchObject({ track: 1, start: 3_000 })

    act(() => result.current.removeClips(['a'], true))
    expect(layout(result)).toEqual([
      [added?.id, 1, 1_000, 4],
      ['low', 2, 0, 0],
      ['b', 1, 0, 0],
    ])
  })

  const hiddenIds = (result: Session) =>
    videosOf(result)
      .filter((clip) => clip.hidden)
      .map((clip) => clip.id)

  it('把几个片段一起隐藏：算一步撤销，存出的文件带着隐藏标记，工程总长不变；再显示回来标记去掉', async () => {
    const saves = recordSaves()
    const { result } = await openThree()
    act(() => result.current.setHidden(['a', 'b'], true))
    expect(hiddenIds(result)).toEqual(['a', 'b'])
    expect(result.current.film?.durationMs).toBe(4_500)
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.html.match(/<video data-hidden=""/g)).toHaveLength(2)
    await settled(result)

    act(() => result.current.undo())
    expect(hiddenIds(result)).toEqual([])
    expect(result.current.film?.canUndo).toBe(false)
    act(() => result.current.redo())
    expect(hiddenIds(result)).toEqual(['a', 'b'])

    act(() => result.current.setHidden(['a', 'b'], false))
    expect(hiddenIds(result)).toEqual([])
    expect(result.current.film?.html).not.toContain('data-hidden')
  })

  it('隐藏标记跟着片段走，不跟着行：放进隐藏着的行的镜头照常显示，隐藏的片段换到别的行仍然隐藏', async () => {
    const { result } = await openThree()
    act(() => result.current.moveClip('c', { track: 1, start: 0 }, 'down'))
    act(() => result.current.setHidden(['c'], true))
    await act(() =>
      result.current.addVideos(CANVAS, [piece({ duration: 1_000 })], { track: 1, start: 5_000 }),
    )
    const added = videosOf(result).find((clip) => clip.start === 5_000)
    expect(added?.hidden).toBe(false)

    act(() => result.current.moveClip('a', { track: 1, start: 2_000 }, 'down'))
    expect(hiddenIds(result)).toEqual(['c'])
    act(() => result.current.moveClip('c', { track: 0, start: 3_000 }, 'up'))
    expect(hiddenIds(result)).toEqual(['c'])
  })

  it('把片段搬进最上面新开的一行：别的片段换成新的行号，按换完的行算叠放顺序；一步撤销', async () => {
    const saves = recordSaves()
    const { result } = await openWith([
      video({ id: 'a', duration: 2_000, z: 2 }),
      video({ id: 'b', start: 2_000, duration: 1_000 }),
      video({ id: 'c', start: 3_000, duration: 1_500 }),
    ])
    act(() =>
      result.current.moveClip(
        'c',
        { track: 0, start: 500 },
        'up',
        new Map([
          ['a', 1],
          ['b', 1],
        ]),
      ),
    )
    expect(layout(result)).toEqual([
      ['a', 1, 0, 2],
      ['b', 1, 2_000, 0],
      ['c', 0, 500, 3],
    ])
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.html).toMatch(/id="a"[^>]*data-track-index="1"/)
    expect(saves[0]?.html).toMatch(/id="c"[^>]*data-start="0.5"[^>]*data-track-index="0"/)

    act(() => result.current.undo())
    expect(layout(result)).toEqual([
      ['a', 0, 0, 2],
      ['b', 0, 2_000, 0],
      ['c', 0, 3_000, 0],
    ])
    expect(result.current.film?.canUndo).toBe(false)
  })

  it('成组挪动、被抓的片段搬进最上面新开的一行：跟着的片段留在原来那一行（行号跟着改）只挪时间；一步撤销', async () => {
    const saves = recordSaves()
    const { result } = await openThree()
    act(() =>
      result.current.moveClip(
        'b',
        { track: 0, start: 2_500 },
        'up',
        new Map([
          ['a', 1],
          ['c', 1],
        ]),
        new Map([['a', 500]]),
      ),
    )
    // b 和 c 重叠、一样是 0 而 c 写在后面：b 抬到 1 才盖得住它
    expect(layout(result)).toEqual([
      ['a', 1, 500, 0],
      ['b', 0, 2_500, 1],
      ['c', 1, 3_000, 0],
    ])
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.html).toMatch(/id="a"[^>]*data-start="0.5"[^>]*data-track-index="1"/)
    expect(saves[0]?.html).toMatch(/id="b"[^>]*data-start="2.5"[^>]*data-track-index="0"/)

    act(() => result.current.undo())
    expect(layout(result)).toEqual([
      ['a', 0, 0, 0],
      ['b', 0, 2_000, 0],
      ['c', 0, 3_000, 0],
    ])
    expect(result.current.film?.canUndo).toBe(false)
  })

  it('成组挪动、被抓的片段换到已有的另一行：跟着的片段只挪时间，叠放顺序按它们挪完的时间算；一步撤销', async () => {
    const { result } = await openWith([
      video({ id: 'x', duration: 2_000 }),
      video({ id: 'm', duration: 1_000, track: 1 }),
      video({ id: 'f', start: 500, duration: 1_000, track: 2, z: 3 }),
    ])
    // m 往后挪 3 秒换到第一行，选中的 f 跟着挪 3 秒、留在原来那一行，挪完和 m 重叠
    act(() =>
      result.current.moveClip(
        'm',
        { track: 0, start: 3_000 },
        'up',
        undefined,
        new Map([['f', 3_500]]),
      ),
    )
    expect(layout(result)).toEqual([
      ['x', 0, 0, 0],
      ['m', 0, 3_000, 4],
      ['f', 2, 3_500, 3],
    ])

    act(() => result.current.undo())
    expect(layout(result)).toEqual([
      ['x', 0, 0, 0],
      ['m', 1, 0, 0],
      ['f', 2, 500, 3],
    ])
    expect(result.current.film?.canUndo).toBe(false)
  })

  it('把镜头加进两行之间新开的一行：下面的行往后排一号，新片段写在根下第一个、叠在最上面', async () => {
    const { result } = await openWith([
      video({ id: 'low', track: 1, duration: 5_000 }),
      video({ id: 'a', duration: 2_000 }),
    ])
    await act(() =>
      result.current.addVideos(
        CANVAS,
        [piece({ duration: 1_000 })],
        { track: 1, start: 500 },
        new Map([['low', 2]]),
      ),
    )
    const added = videosOf(result).find((clip) => clip.track === 1)
    expect(layout(result)).toEqual([
      [added?.id, 1, 500, 3],
      ['low', 2, 0, 0],
      ['a', 0, 0, 0],
    ])

    act(() => result.current.undo())
    expect(layout(result)).toEqual([
      ['low', 1, 0, 0],
      ['a', 0, 0, 0],
    ])
  })

  it('把片段全删掉：工程还在，只是没有画面', async () => {
    const { result } = await openThree()
    act(() => result.current.removeClips(['a', 'b', 'c'], true))
    expect(spans(result)).toEqual([])
    expect(result.current.film?.durationMs).toBe(0)
    expect(result.current.film?.html).toMatch(/id="film"[^>]*data-duration="0"/)
  })

  it('工程没有时长上限：两分钟以后还能接着加', async () => {
    const saves = recordSaves()
    const { result, onNotice } = await open()
    await add(result, piece({ duration: 119_000 }))
    await waitFor(() => expect(saves).toHaveLength(1))
    await settled(result)
    await add(result, piece({ duration: 5_000 }))
    expect(spans(result)).toHaveLength(2)
    expect(result.current.film?.durationMs).toBe(124_000)
    expect(onNotice).not.toHaveBeenCalled()
    await waitFor(() => expect(saves).toHaveLength(2))
    await settled(result)
  })

  it('还没有工程时连着加两次：只建一份主文件，两次加的都在', async () => {
    const saves = recordSaves()
    const { result } = await open()
    await act(async () => {
      await Promise.all([
        result.current.addVideos(CANVAS, [piece()]),
        result.current.addVideos(CANVAS, [piece({ mediaStart: 3_000 })]),
      ])
    })
    expect(spans(result)).toEqual([
      [video().src, 0, 2_000],
      [video().src, 2_000, 2_000],
    ])
    await waitFor(() => expect(saves.at(-1)?.html.match(/<video /g)).toHaveLength(2))
    expect(saves.filter((save) => save.expectedVersion === null)).toHaveLength(1)
    await settled(result)
  })
})

describe('useFilmSession · 组件或块的片段、音频片段和「其他」片段', () => {
  const catalogItem = (name: string) => {
    const item = fixtureCatalog.items.find((candidate) => candidate.name === name)
    if (item === undefined) throw new Error(`测试组件库里没有 ${name}`)
    return item
  }
  const sound = (overrides: Partial<NewAudio> = {}): NewAudio => ({
    label: '新配乐',
    src: 'https://media.test/audio/new.mp3',
    mediaStart: 0,
    duration: 3_000,
    ...overrides,
  })
  /** 文件里的片段，按文件里的先后，写成「id、种类、行号、起点、时长」。 */
  const kinds = (result: Session) =>
    result.current.film?.clips.map((clip) => [
      clip.id,
      clip.kind,
      clip.track,
      clip.start,
      clip.duration,
    ])
  /** 存出的文件里某个片段的开始标签。 */
  const tagOf = (html: string | undefined, id: string) =>
    new RegExp(`<[a-z]+ [^>]*\\bid="${id}"[^>]*>`).exec(html ?? '')?.[0]
  /** 存出的文件里根下的片段，按文件里的先后。 */
  const savedOrder = (html: string | undefined) =>
    [...new DOMParser().parseFromString(html ?? '', 'text/html').querySelectorAll('#film > *')].map(
      (clip) => clip.id,
    )

  // 画面区第 0 行是组件或块的片段，第 1 行是视频片段；声音区第 0 行的音频片段最长
  const stacked = () => [
    host({ id: 'k', duration: 3_000, z: 1 }),
    video({ id: 'p', track: 1, duration: 2_000 }),
    audio({ id: 'm', duration: 8_000 }),
  ]

  it('打开带三种片段的工程：三种片段都读出来，工程总长算到音频片段的结尾', async () => {
    const { result } = await openWith(stacked())
    expect(result.current.film?.clips).toEqual(stacked())
    expect(result.current.film?.durationMs).toBe(8_000)
  })

  it('加一个组件或块的片段：先按目录里的 files 把条目文件拷进工程，再写在根下第一个、叠在最上面', async () => {
    const saves = recordSaves()
    const created: string[] = []
    server.use(
      http.post(CREATE, async ({ request }) => {
        created.push(((await request.clone().json()) as { path: string }).path)
        return undefined
      }),
    )
    const conversation = crypto.randomUUID()
    const { result } = await open(
      putMockProjectMain(conversation, mainFile(stacked(), CANVAS)),
      10,
      conversation,
    )
    await act(() =>
      result.current.addItem(
        CANVAS,
        catalogItem('fixture-fields'),
        { text: '新品上市' },
        { track: 2, start: 7_000 },
      ),
    )
    expect(created).toEqual(['compositions/fixtures/fixture-fields.html'])
    expect(
      mockWorkspaceFile(conversation, 'final-cut/compositions/fixtures/fixture-fields.html'),
    ).toEqual({ content: itemFileContent('compositions/fixtures/fixture-fields.html'), version: 1 })
    const [added] = result.current.film?.clips ?? []
    expect(added).toMatchObject({
      kind: 'host',
      label: '测试可填项',
      item: 'fixture-fields',
      src: 'compositions/fixtures/fixture-fields.html',
      track: 2,
      start: 7_000,
      duration: 5_000,
      playbackStart: 0,
      values: { text: '新品上市' },
      z: 4,
    })
    expect(result.current.film?.durationMs).toBe(12_000)
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(savedOrder(saves[0]?.html)).toEqual([added?.id, 'k', 'p', 'm'])
    expect(tagOf(saves[0]?.html, added?.id ?? '')).toContain(
      'data-composition-id="fixture-fields" data-composition-src="compositions/fixtures/fixture-fields.html"',
    )
    // 条目 1920×1080，放进 720×1280：缩放居中写在行内样式上
    expect(tagOf(saves[0]?.html, added?.id ?? '')).toContain(
      'style="z-index: 4; left: 50%; top: 50%; width: 1920px; height: 1080px; translate: -50% -50%; scale: 0.375"',
    )
    expect(saves[0]?.html).toMatch(/id="film"[^>]*data-duration="12"/)

    act(() => result.current.undo())
    expect(result.current.film?.clips).toEqual(stacked())
  })

  it('条目文件工程里已经有了（新建 409）：跳过它接着拷，片段照常加进去；带旁挂文件的条目整个目录都拷', async () => {
    const conversation = crypto.randomUUID()
    putMockWorkspaceFile(
      conversation,
      'final-cut/compositions/fixture-sidecar/fixture-sidecar.html',
      '我改过的',
    )
    const { result } = await open(
      putMockProjectMain(conversation, mainFile([video()], CANVAS)),
      10,
      conversation,
    )
    const sidecar = catalogItem('fixture-sidecar')
    await act(() => result.current.addItem(CANVAS, sidecar, {}, { track: 1, start: 0 }))
    expect(
      mockWorkspaceFile(conversation, 'final-cut/compositions/fixture-sidecar/fixture-sidecar.html')
        ?.content,
    ).toBe('我改过的')
    expect(
      mockWorkspaceFile(
        conversation,
        'final-cut/compositions/fixture-sidecar/assets/fixture-sidecar.json',
      )?.content,
    ).toBe(itemFileContent('compositions/fixture-sidecar/assets/fixture-sidecar.json'))
    expect(result.current.film?.clips.map((clip) => clip.kind)).toEqual(['host', 'video'])
  })

  it('条目文件拷不进来：提示原因，不加片段', async () => {
    server.use(
      http.post(CREATE, () => HttpResponse.json({ detail: '工作区写不进去' }, { status: 503 }), {
        once: true,
      }),
    )
    const { result, onNotice } = await openWith([video()])
    let added: boolean | undefined
    await act(async () => {
      const at = { track: 1, start: 0 }
      added = await result.current.addItem(CANVAS, catalogItem('fixture-fields'), {}, at)
    })
    expect(added).toBe(false)
    expect(onNotice).toHaveBeenCalledWith('成片草稿保存失败：工作区写不进去')
    expect(result.current.film?.clips).toEqual([video()])
  })

  it('组件库的条目没写时长：取 10 秒和工程现有总长里大的那个', async () => {
    const { result } = await openWith(stacked())
    const caption = catalogItem('default-caption')
    await act(() => result.current.addItem(CANVAS, caption, {}, { track: 2, start: 0 }))
    expect(result.current.film?.clips[0]?.duration).toBe(10_000)
    act(() =>
      result.current.retime(new Map([['m', { start: 0, duration: 15_000, mediaStart: 0 }]])),
    )
    await act(() => result.current.addItem(CANVAS, caption, {}, { track: 3, start: 0 }))
    expect(result.current.film?.clips[0]?.duration).toBe(15_000)
  })

  it('加一段音频：写在根下第一个、不带叠放顺序，工程总长跟着变', async () => {
    const saves = recordSaves()
    const { result } = await openWith(stacked())
    await act(() =>
      result.current.addAudio(CANVAS, sound({ mediaStart: 1_000 }), { track: 1, start: 7_000 }),
    )
    const [added] = result.current.film?.clips ?? []
    expect(added).toEqual({
      kind: 'audio',
      id: added?.id,
      label: '新配乐',
      src: 'https://media.test/audio/new.mp3',
      start: 7_000,
      duration: 3_000,
      mediaStart: 1_000,
      track: 1,
      volume: 1,
      playbackRate: 1,
      fadeIn: 0,
      fadeOut: 0,
      loop: false,
      hidden: false,
    })
    expect(result.current.film?.durationMs).toBe(10_000)
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(savedOrder(saves[0]?.html)).toEqual([added?.id, 'k', 'p', 'm'])
    expect(tagOf(saves[0]?.html, added?.id ?? '')).not.toContain('style=')
  })

  it('在行里挪组件或块的片段和音频片段：组件或块的片段不写入点，音频片段写；一步撤销', async () => {
    const saves = recordSaves()
    const { result } = await openWith(stacked())
    act(() =>
      result.current.retime(
        new Map([
          ['k', { start: 500, duration: 2_000, mediaStart: 0 }],
          ['m', { start: 1_000, duration: 6_000, mediaStart: 2_000 }],
        ]),
      ),
    )
    expect(kinds(result)).toEqual([
      ['k', 'host', 0, 500, 2_000],
      ['p', 'video', 1, 0, 2_000],
      ['m', 'audio', 0, 1_000, 6_000],
    ])
    expect(result.current.film?.durationMs).toBe(7_000)
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(tagOf(saves[0]?.html, 'k')).not.toContain('data-media-start')
    expect(tagOf(saves[0]?.html, 'k')).not.toContain('data-playback-start')
    expect(tagOf(saves[0]?.html, 'm')).toContain('data-media-start="2"')

    act(() => result.current.undo())
    expect(result.current.film?.clips).toEqual(stacked())
  })

  it('组件或块的片段裁开头：文件里写上从第几秒开始播，和起止算一步撤销；拉回 0 时去掉这个属性', async () => {
    const saves = recordSaves()
    const { result } = await openWith(stacked())
    const original = result.current.film?.html
    act(() =>
      result.current.retime(new Map([['k', { start: 1_500, duration: 1_500, mediaStart: 1_500 }]])),
    )
    expect(result.current.film?.clips[0]).toMatchObject({
      id: 'k',
      start: 1_500,
      duration: 1_500,
      playbackStart: 1_500,
    })
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(tagOf(saves[0]?.html, 'k')).toContain('data-start="1.5" data-duration="1.5"')
    expect(tagOf(saves[0]?.html, 'k')).toContain('data-playback-start="1.5"')

    act(() => result.current.undo())
    expect(result.current.film?.html).toBe(original)

    act(() => result.current.redo())
    act(() => result.current.retime(new Map([['k', { start: 0, duration: 3_000, mediaStart: 0 }]])))
    expect(result.current.film?.clips[0]).toMatchObject({ start: 0, playbackStart: 0 })
    await waitFor(() => expect(saves).toHaveLength(2))
    expect(tagOf(saves[1]?.html, 'k')).not.toContain('data-playback-start')
  })

  /** 文件里的片段，按文件里的先后，写成「id、行号、起点、叠放顺序」（音频片段没有叠放顺序）。 */
  const stacking = (result: Session) =>
    result.current.film?.clips.map((clip) => [
      clip.id,
      clip.track,
      clip.start,
      clip.kind === 'audio' ? null : clip.z,
    ])

  it('把音频片段换到声音区的另一行：只改行号和起点，不带叠放顺序；一步撤销', async () => {
    const saves = recordSaves()
    const clips = [...stacked(), audio({ id: 'n', track: 1, start: 9_000 })]
    const { result } = await openWith(clips)
    act(() => result.current.moveClip('m', { track: 1, start: 0 }, 'down'))
    expect(stacking(result)).toEqual([
      ['k', 0, 0, 1],
      ['p', 1, 0, 0],
      ['m', 1, 0, null],
      ['n', 1, 9_000, null],
    ])
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(tagOf(saves[0]?.html, 'm')).toMatch(/^<audio id="m"[^>]* data-track-index="1"/)
    expect(tagOf(saves[0]?.html, 'm')).not.toContain('style=')

    act(() => result.current.undo())
    expect(result.current.film?.clips).toEqual(clips)
  })

  it('把组件或块的片段换到下面新开的一行：按叠放规则降到盖着它的片段之下；一步撤销', async () => {
    const saves = recordSaves()
    const { result } = await openWith(stacked())
    // 组件或块的片段搬到视频片段那一行下面：视频片段排到 0 号，组件或块的片段是 1 号，降到时间上压着它的视频片段之下
    act(() => result.current.moveClip('k', { track: 1, start: 0 }, 'down', new Map([['p', 0]])))
    expect(stacking(result)).toEqual([
      ['k', 1, 0, 0],
      ['p', 0, 0, 0],
      ['m', 0, 0, null],
    ])
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(tagOf(saves[0]?.html, 'k')).toMatch(/^<div [^>]*id="k"[^>]* data-track-index="1"/)

    act(() => result.current.undo())
    expect(result.current.film?.clips).toEqual(stacked())
  })

  it('把视频片段搬进组件那一行上面新开的一行：组件或块的片段排到 1 号，视频片段抬到它压着的组件或块的片段之上；一步撤销', async () => {
    const { result } = await openWith(stacked())
    act(() => result.current.moveClip('p', { track: 0, start: 500 }, 'up', new Map([['k', 1]])))
    expect(stacking(result)).toEqual([
      ['k', 1, 0, 1],
      ['p', 0, 500, 2],
      ['m', 0, 0, null],
    ])
    act(() => result.current.undo())
    expect(result.current.film?.clips).toEqual(stacked())
  })

  it('删掉组件或块的片段：从文件里去掉；撤销回来', async () => {
    const saves = recordSaves()
    const { result } = await openWith(stacked())
    act(() => result.current.removeClips(['k'], false))
    expect(kinds(result)).toEqual([
      ['p', 'video', 1, 0, 2_000],
      ['m', 'audio', 0, 0, 8_000],
    ])
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.html).not.toContain('data-composition-id="fixture-fields"')

    act(() => result.current.undo())
    expect(result.current.film?.clips).toEqual(stacked())
  })

  it('隐藏组件或块的片段和音频片段：存出的文件带着隐藏标记（音频片段就是静音），工程总长不变；撤销去掉', async () => {
    const saves = recordSaves()
    const { result } = await openWith(stacked())
    act(() => result.current.setHidden(['k', 'm'], true))
    expect(result.current.film?.clips.filter((clip) => clip.hidden).map((clip) => clip.id)).toEqual(
      ['k', 'm'],
    )
    expect(result.current.film?.durationMs).toBe(8_000)
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(tagOf(saves[0]?.html, 'm')).toMatch(/^<audio data-hidden=""/)
    expect(tagOf(saves[0]?.html, 'k')).toMatch(/^<div data-hidden=""/)

    act(() => result.current.undo())
    expect(result.current.film?.html).not.toContain('data-hidden')
  })

  it('改组件或块的片段的可填项：文件里的取值整串换成新的，算一步撤销；片段已经删掉时不动工程', async () => {
    const saves = recordSaves()
    const { result } = await openWith(stacked())
    act(() => result.current.setValues('k', { text: '新的标题', size: 120, shadow: true }))
    expect(result.current.film?.clips[0]).toMatchObject({
      id: 'k',
      values: { text: '新的标题', size: 120, shadow: true },
    })
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(tagOf(saves[0]?.html, 'k')).toContain(
      'data-variable-values="{&quot;text&quot;:&quot;新的标题&quot;,&quot;size&quot;:120,&quot;shadow&quot;:true}"',
    )

    act(() => result.current.undo())
    expect(result.current.film?.clips).toEqual(stacked())
    expect(result.current.film?.canUndo).toBe(false)

    act(() => result.current.removeClips(['k'], false))
    const removed = result.current.film?.html
    act(() => result.current.setValues('k', { text: '晚到的改动' }))
    expect(result.current.film?.html).toBe(removed)
    // 也不留一步空的撤销：撤销一次就是撤销删除
    act(() => result.current.undo())
    expect(result.current.film?.clips).toEqual(stacked())
  })

  it('改字体类可填项：宿主上的字体变量跟着换，和取值算一步撤销；字体块链上那个字体', async () => {
    const brand = host({
      id: 'brand',
      item: 'fixture-brand-card',
      src: 'compositions/fixtures/fixture-brand-card.html',
      duration: 3_000,
    })
    const { result } = await openWith([brand])
    const original = result.current.film?.html ?? ''
    expect(tagOf(original, 'brand')).toContain("--font-display: 'Playfair Display'")
    act(() => result.current.setValues('brand', { font: 'Comic Sans' }))
    expect(tagOf(result.current.film?.html, 'brand')).not.toContain('--font-display')
    expect(tagOf(result.current.film?.html, 'brand')).toContain('scale: 0.375')
    act(() => result.current.setValues('brand', { font: 'Playfair Display' }))
    expect(tagOf(result.current.film?.html, 'brand')).toContain(
      "--font-display: 'Playfair Display', 'Noto Sans SC', sans-serif",
    )
    act(() => result.current.undo())
    act(() => result.current.undo())
    expect(result.current.film?.html).toBe(original)
  })

  it('改视频片段、音频片段上的属性：几项一起写进文件、读回来是新的值，算一步撤销；值没变、片段已经删掉时不动工程', async () => {
    const saves = recordSaves()
    const { result } = await openWith(stacked())
    act(() =>
      result.current.setAttributes('p', {
        'data-playback-rate': '2',
        'data-fade-in': '0.5',
        muted: 'true',
        'data-has-audio': null,
      }),
    )
    expect(result.current.film?.clips[1]).toEqual(
      video({ id: 'p', track: 1, duration: 2_000, playbackRate: 2, fadeIn: 500, muted: true }),
    )
    await waitFor(() => expect(saves).toHaveLength(1))
    const tag = tagOf(saves[0]?.html, 'p')
    expect(tag).toContain(' data-playback-rate="2"')
    expect(tag).toContain(' muted="true"')
    expect(tag).not.toContain('data-has-audio')

    act(() => result.current.setAttributes('m', { loop: 'true', 'data-volume': '1.995262' }))
    expect(result.current.film?.clips[2]).toMatchObject({ loop: true, volume: 1.995262 })
    act(() => result.current.undo())
    expect(result.current.film?.clips[2]).toEqual(audio({ id: 'm', duration: 8_000 }))
    act(() => result.current.undo())
    expect(result.current.film?.clips).toEqual(stacked())
    expect(result.current.film?.canUndo).toBe(false)

    const before = result.current.film?.html
    act(() => result.current.setAttributes('m', { 'data-volume': '1', loop: null }))
    act(() => result.current.setAttributes('gone', { 'data-volume': '0.5' }))
    expect(result.current.film?.html).toBe(before)
    expect(result.current.film?.canUndo).toBe(false)
  })

  it('删掉音频片段：工程总长按剩下的片段算；撤销回来', async () => {
    const saves = recordSaves()
    const { result } = await openWith(stacked())
    act(() => result.current.removeClips(['m'], true))
    expect(kinds(result)).toEqual([
      ['k', 'host', 0, 0, 3_000],
      ['p', 'video', 1, 0, 2_000],
    ])
    expect(result.current.film?.durationMs).toBe(3_000)
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.html).toMatch(/id="film"[^>]*data-duration="3"/)

    act(() => result.current.undo())
    expect(result.current.film?.clips).toEqual(stacked())
  })

  it('有组件行在画面行上面：没给落点的镜头接在画面区第一行（组件那一行）末尾，波纹删除补的也是它', async () => {
    const { result } = await openWith([
      ...stacked(),
      audio({ id: 'q', start: 8_000, duration: 1_000 }),
      host({ id: 'j', start: 3_000, duration: 1_000 }),
    ])
    await add(result, piece({ duration: 1_500 }))
    const added = videosOf(result).find((clip) => clip.id !== 'p')
    expect(added).toMatchObject({ track: 0, start: 4_000 })

    // 声音区第 0 行的音频片段不跟着补
    act(() => result.current.removeClips(['k'], true))
    expect(kinds(result)).toEqual([
      [added?.id, 'video', 0, 1_000, 1_500],
      ['p', 'video', 1, 0, 2_000],
      ['m', 'audio', 0, 0, 8_000],
      ['q', 'audio', 0, 8_000, 1_000],
      ['j', 'host', 0, 0, 1_000],
    ])
  })

  // 手写的带时间的文字：画面区第 2 行 1–3 秒，在视频片段后面
  const NOTE = '<p id="note" data-start="1" data-duration="2" data-track-index="2">手写文字</p>'

  it('手写的带时间元素读成「其他」片段：能挪动、裁两端、换行、隐藏和删除，工程总长都按它算', async () => {
    const saves = recordSaves()
    const { result } = await openWith([video({ id: 'v', duration: 2_000 })], NOTE)
    const note = result.current.film?.clips.find((clip) => clip.kind === 'other')
    expect(note).toEqual({
      kind: 'other',
      id: expect.any(String) as unknown,
      label: '手写文字',
      start: 1_000,
      duration: 2_000,
      track: 2,
      hidden: false,
      z: 0,
    })
    expect(result.current.film?.durationMs).toBe(3_000)
    const id = note?.id ?? ''

    act(() =>
      result.current.retime(new Map([[id, { start: 500, duration: 4_000, mediaStart: 0 }]])),
    )
    expect(result.current.film?.durationMs).toBe(4_500)
    act(() => result.current.moveClip(id, { track: 1, start: 2_000 }, 'up'))
    act(() => result.current.setHidden([id], true))
    expect(result.current.film?.clips.find((clip) => clip.id === id)).toMatchObject({
      kind: 'other',
      start: 2_000,
      duration: 4_000,
      track: 1,
      hidden: true,
    })
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.html).toMatch(
      /<p data-hidden="" [^>]*id="note"[^>]*data-start="2" data-duration="4" data-track-index="1">手写文字<\/p>/,
    )
    expect(tagOf(saves[0]?.html, 'note')).not.toMatch(/data-(media|playback)-start/)

    act(() => result.current.removeClips([id], false))
    expect(result.current.film?.clips.map((clip) => clip.kind)).toEqual(['video'])
    expect(result.current.film?.durationMs).toBe(2_000)
  })
})
