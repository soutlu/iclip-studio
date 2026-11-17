import { openComposition, type Composition } from '@hyperframes/sdk'
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
import { CAPTION_FOLLOW_REFUSAL_TEXT } from './caption-edit'
import { groupTrimmed, splitAt, timingOf } from './clip-edit'
import {
  CAPTIONS_PATH,
  CAPTIONS_PROBLEM_TEXT,
  captionsHostElement,
  captionsScene,
  captionVariable,
} from './composition/captions'
import {
  FONT_BLOCK_END,
  FONT_BLOCK_START,
  type AudioClip,
  type CaptionClip,
  type FilmClip,
  type VideoClip,
} from './composition/film'
import { readProject, type StoredFile } from './final-cut.api'
import { soundPairOf } from './sound-pair'
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

/** 从现在起数读了几次主文件（读工程时还会读字幕场景文件，不算在里面）。 */
const countMainReads = () => {
  const reads = { count: 0 }
  server.use(
    http.get(READ, ({ request }) => {
      if (new URL(request.url).searchParams.get('path') === MAIN_PATH) reads.count += 1
      return undefined
    }),
  )
  return reads
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

/**
 * 打开工程：`stored` 是编辑器读到的主文件（null 是还没有工程；工作区里可能已经有更新的一版），字幕场景文件
 * 和语言值表和编辑器一样经 `readProject` 读。
 */
const open = async (
  stored: StoredFile | null = null,
  debounceMs = 10,
  conversation = CONVERSATION,
  catalog = fixtureCatalog,
) => {
  const read = stored === null ? null : await readProject(conversation)
  const initial = stored === null || read === null ? null : { ...read, main: stored }
  const onNotice = vi.fn<(message: string) => void>()
  const { connection, notify } = fakeConnection()
  const hook = renderHook(
    () => useFilmSession(conversation, initial, catalog, { debounceMs, onNotice }),
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
      'final-cut 已在别处修改，已切换到最新版本；未保存的改动已放弃',
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
      'final-cut 已在别处修改，已切换到最新版本；未保存的改动已放弃',
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
        message: 'final-cut 保存失败：工作区写不进去',
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
    const { result, onNotice, notify } = await open(
      putMockProjectMain(CONVERSATION, mainFile([video()], CANVAS)),
    )
    const reads = countMainReads()
    await add(result, piece({ mediaStart: 3_000 }))
    await waitFor(() => expect(saves).toHaveLength(1))
    // 通知不带版本号，在保存还没回来的时候就到了
    notify(MAIN_PATH)
    await settled(result)
    await waitFor(() => expect(reads.count).toBe(1))
    notify(MAIN_PATH)
    await waitFor(() => expect(reads.count).toBe(2))
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
      'final-cut 已在别处修改，已切换到最新版本；未保存的改动已放弃',
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
    const { result, notify } = await open(
      putMockProjectMain(CONVERSATION, mainFile([video()], CANVAS)),
    )
    const reads = countMainReads()
    expect(result.current.filesRevision).toBe(0)
    notify('final-cut/compositions/fixtures/fixture-fields.html')
    expect(result.current.filesRevision).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(reads.count).toBe(0)
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

  it('每一份带着序号和从上一份来的那一步：编辑、撤销是这一步的改动，换语言这类不是编辑换的没有', async () => {
    const { result } = await openThree()
    const opened = result.current.film
    expect(opened?.step).toBeNull()
    const revision = opened?.revision ?? 0
    const lengthOfB = (duration: number) =>
      new Map([['b', { start: 2_000, duration, mediaStart: 0 }]])
    const durationOfB = (seconds: number) =>
      expect.objectContaining({ path: '/elements/b/timing/duration', value: seconds }) as unknown

    act(() => result.current.retime(lengthOfB(500)))
    expect(result.current.film?.revision).toBe(revision + 1)
    expect(result.current.film?.step).toEqual([
      expect.objectContaining({
        file: 'index.html',
        patches: expect.arrayContaining([durationOfB(0.5)]) as unknown,
      }),
    ])

    act(() => result.current.undo())
    expect(result.current.film?.revision).toBe(revision + 2)
    expect(result.current.film?.step).toEqual([
      expect.objectContaining({ patches: expect.arrayContaining([durationOfB(1)]) as unknown }),
    ])

    act(() => result.current.setLocale('zh'))
    expect(result.current.film).toMatchObject({ revision: revision + 3, step: null })
  })

  it('同一个片段连着很快改两次：算两步撤销，撤销一次只退回一次', async () => {
    const { result } = await openThree()
    const lengthOfB = (duration: number) =>
      new Map([['b', { start: 2_000, duration, mediaStart: 0 }]])
    act(() => result.current.retime(lengthOfB(500)))
    act(() => result.current.retime(lengthOfB(250)))
    act(() => result.current.undo())
    expect(spans(result)[1]).toEqual([OTHER_SRC, 2_000, 500])
    act(() => result.current.undo())
    expect(spans(result)[1]).toEqual([OTHER_SRC, 2_000, 1_000])
    expect(result.current.film?.canUndo).toBe(false)
    act(() => result.current.redo())
    expect(spans(result)[1]).toEqual([OTHER_SRC, 2_000, 500])
    expect(result.current.film).toMatchObject({ canUndo: true, canRedo: true })
  })

  it('撤销时引擎报错（补丁只应用了一半）：文件留在撤销之前的样子，撤销记录清空并提示，不多存一次', async () => {
    const saves = recordSaves()
    const { result, onNotice } = await openThree()
    act(() =>
      result.current.retime(
        new Map([
          ['b', { start: 2_000, duration: 600, mediaStart: 0 }],
          ['c', { start: 3_400, duration: 1_000, mediaStart: 400 }],
        ]),
      ),
    )
    await waitFor(() => expect(saves).toHaveLength(1))
    await settled(result)
    const edited = result.current.film?.html
    const editedSpans = spans(result)

    // 引擎的方法都在同一个原型上：让下一次应用补丁只应用第一个就报错
    const { openComposition } = await import('@hyperframes/sdk')
    const probe = await openComposition('<div data-composition-id="probe"></div>', {
      history: false,
    })
    const engines = Object.getPrototypeOf(probe) as Composition
    probe.dispose()
    const applyPatches = engines.applyPatches
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(engines, 'applyPatches').mockImplementationOnce(function (this: Composition, patches) {
      applyPatches.call(this, patches.slice(0, 1))
      throw new Error('补丁对不上')
    })

    act(() => result.current.undo())
    expect(onNotice).toHaveBeenCalledWith('撤销失败，已清空撤销记录')
    await waitFor(() =>
      expect(result.current.film).toMatchObject({ canUndo: false, canRedo: false }),
    )
    expect(result.current.film?.html).toBe(edited)
    expect(spans(result)).toEqual(editedSpans)
    // 换回去的引擎接着能用：再改一次只动这一处，撤销一步回到报错前的样子
    act(() => result.current.setHidden(['a'], true))
    act(() => result.current.undo())
    expect(result.current.film?.html).toBe(edited)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await settled(result)
    expect(saves).toHaveLength(1)
  })

  it('删掉一个片段、开着波纹编辑：后面的片段往前补上；撤销回来', async () => {
    const saves = recordSaves()
    const { result } = await openThree()
    act(() => {
      result.current.removeClips(['b'], true)
    })
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
    act(() => {
      result.current.removeClips(['b'], false)
    })
    expect(spans(result)).toEqual([
      [video().src, 0, 2_000],
      [video().src, 3_000, 1_500],
    ])
  })

  it('把几个片段一起挪到新的起点（合拢空档）：算一步撤销，工程总长跟着变', async () => {
    const { result } = await openThree()
    act(() => {
      result.current.removeClips(['b'], false)
    })
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

    act(() => {
      result.current.removeClips(['a'], true)
    })
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
    act(() => {
      result.current.removeClips(['a', 'b', 'c'], true)
    })
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
    expect(onNotice).toHaveBeenCalledWith('final-cut 保存失败：工作区写不进去')
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
      link: null,
      syncOrigin: null,
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
      clip.kind === 'audio' || clip.kind === 'caption' ? null : clip.z,
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
    act(() => {
      result.current.removeClips(['k'], false)
    })
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

    act(() => {
      result.current.removeClips(['k'], false)
    })
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
    const comicSans = result.current.film?.html
    expect(tagOf(comicSans, 'brand')).not.toContain('--font-display')
    expect(tagOf(comicSans, 'brand')).toContain('scale: 0.375')
    act(() => result.current.setValues('brand', { font: 'Playfair Display' }))
    expect(tagOf(result.current.film?.html, 'brand')).toContain(
      "--font-display: 'Playfair Display', 'Noto Sans SC', sans-serif",
    )
    act(() => result.current.undo())
    expect(result.current.film?.html).toBe(comicSans)
    act(() => result.current.undo())
    // 撤销时引擎倒着加回两个字体变量，行内样式里两条的先后会对调，只比每条声明
    const sortedStyles = (html: string | undefined) =>
      (html ?? '').replaceAll(
        /style="([^"]*)"/g,
        (_, css: string) => `style="${css.split('; ').toSorted().join('; ')}"`,
      )
    expect(sortedStyles(result.current.film?.html)).toBe(sortedStyles(original))
    expect(result.current.film?.canUndo).toBe(false)
  })

  it('改视频片段、音频片段上的属性：几项一起写进文件、读回来是新的值，算一步撤销；值没变、片段已经删掉时不动工程', async () => {
    const saves = recordSaves()
    const { result } = await openWith(stacked())
    act(() =>
      result.current.setAttributes(['p'], {
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

    act(() => result.current.setAttributes(['m'], { loop: 'true', 'data-volume': '1.995262' }))
    expect(result.current.film?.clips[2]).toMatchObject({ loop: true, volume: 1.995262 })
    act(() => result.current.undo())
    expect(result.current.film?.clips[2]).toEqual(audio({ id: 'm', duration: 8_000 }))
    act(() => result.current.undo())
    expect(result.current.film?.clips).toEqual(stacked())
    expect(result.current.film?.canUndo).toBe(false)

    const before = result.current.film?.html
    act(() => result.current.setAttributes(['m'], { 'data-volume': '1', loop: null }))
    act(() => result.current.setAttributes(['gone'], { 'data-volume': '0.5' }))
    expect(result.current.film?.html).toBe(before)
    expect(result.current.film?.canUndo).toBe(false)
  })

  it('删掉音频片段：工程总长按剩下的片段算；撤销回来', async () => {
    const saves = recordSaves()
    const { result } = await openWith(stacked())
    act(() => {
      result.current.removeClips(['m'], true)
    })
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
    act(() => {
      result.current.removeClips(['k'], true)
    })
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
      link: null,
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

    act(() => {
      result.current.removeClips([id], false)
    })
    expect(result.current.film?.clips.map((clip) => clip.kind)).toEqual(['video'])
    expect(result.current.film?.durationMs).toBe(2_000)
  })
})

describe('useFilmSession · 切开', () => {
  /** 打开一份直接写好的主文件。 */
  const openHtml = (html: string) => {
    const conversation = crypto.randomUUID()
    return open(putMockProjectMain(conversation, html), 10, conversation)
  }
  /** 在 `atMs` 处切开 `id` 这个片段（连同链接的片段）。 */
  const splitClip = (result: Session, id: string, atMs: number) => {
    const film = result.current.film
    const clip = film?.clips.find((each) => each.id === id)
    if (film === null || film === undefined || clip === undefined) throw new Error(`没有片段 ${id}`)
    const plan = splitAt(clip, atMs, film.clips, film.links)
    if (!('cuts' in plan)) throw new Error(`切不了：${plan.refusal}`)
    act(() => result.current.split(plan.cuts))
  }
  /** 存出的文件里根下的元素，按文件里的先后。 */
  const rootChildren = (html: string | undefined) => [
    ...(new DOMParser().parseFromString(html ?? '', 'text/html').getElementById('film')?.children ??
      []),
  ]
  const attributesOf = (element: Element | undefined) =>
    Object.fromEntries([...(element?.attributes ?? [])].map((each) => [each.name, each.value]))

  it('后半段是原元素的整份复制，紧跟在它后面：模型里没有的属性、样式、子元素都带上，只换编号、起止和入点；一步撤销', async () => {
    const saves = recordSaves()
    const file = mainFile(
      [
        video({
          id: 'v',
          start: 1_000,
          duration: 6_000,
          playbackRate: 2,
          fadeIn: 300,
          fadeOut: 400,
        }),
        video({ id: 'w', start: 7_000, duration: 1_000, src: OTHER_SRC }),
      ],
      CANVAS,
    )
      // 根下片段前面有一个不带时间的元素，片段上有代理写进去、编辑器不认识的属性和子元素
      .replace('<video ', '<div class="backdrop"></div>\n<video data-agent-note="保留" ')
      .replace('</video>', '<track kind="captions" src="captions.vtt"></video>')
    const { result } = await openHtml(file)
    splitClip(result, 'v', 3_000)

    const clips = result.current.film?.clips ?? []
    expect(
      clips.map((clip) => [clip.id === 'v' || clip.id === 'w', clip.start, clip.duration]),
    ).toEqual([
      [true, 1_000, 2_000],
      [false, 3_000, 4_000],
      [true, 7_000, 1_000],
    ])
    expect(clips[1]).toMatchObject({
      mediaStart: 4_000,
      playbackRate: 2,
      fadeIn: 300,
      fadeOut: 400,
    })
    expect(result.current.film?.canUndo).toBe(true)

    await waitFor(() => expect(saves).toHaveLength(1))
    const [backdrop, first, second, last] = rootChildren(saves[0]?.html)
    expect(backdrop?.className).toBe('backdrop')
    expect(first?.id).toBe('v')
    expect(last?.id).toBe('w')
    const newId = second?.id ?? ''
    expect(newId).not.toBe('v')
    const { id, 'data-hf-id': hfId, ...copied } = attributesOf(second)
    expect([id, hfId]).toEqual([newId, newId])
    expect(copied).toEqual({
      ...attributesOf(first),
      id: undefined,
      'data-hf-id': undefined,
      'data-start': '3',
      'data-duration': '4',
      'data-media-start': '4',
    })
    expect(copied['data-agent-note']).toBe('保留')
    expect(second?.querySelector('track')?.getAttribute('src')).toBe('captions.vtt')
    expect(attributesOf(first)).toMatchObject({ 'data-start': '1', 'data-duration': '2' })

    act(() => result.current.undo())
    expect(result.current.film?.clips.map((clip) => [clip.id, clip.start, clip.duration])).toEqual([
      ['v', 1_000, 6_000],
      ['w', 7_000, 1_000],
    ])
    expect(result.current.film?.canUndo).toBe(false)
  })

  it('贴片、场景片段的后半段写从组件的第几秒开始播；可填项的值、叠放顺序、隐藏都照抄', async () => {
    const { result } = await openWith([
      host({ id: 't', duration: 4_000, values: { headline: '新品' }, z: 3, hidden: true }),
    ])
    splitClip(result, 't', 1_500)
    const [first, second] = result.current.film?.clips ?? []
    expect(first).toMatchObject({ id: 't', start: 0, duration: 1_500, playbackStart: 0 })
    expect(second).toMatchObject({
      kind: 'host',
      start: 1_500,
      duration: 2_500,
      playbackStart: 1_500,
      values: { headline: '新品' },
      z: 3,
      hidden: true,
    })
  })

  it('链接的一对一起切，算一步撤销：后半段那一对换成新的链接名，两边都切到时同源标记也换新', async () => {
    const saves = recordSaves()
    const file = mainFile(
      [video({ id: 'v', duration: 4_000 }), audio({ id: 'a', duration: 4_000 })],
      CANVAS,
    )
      .replace('<video ', '<video data-link="lk-1" data-sync-origin="lk-9" ')
      .replace('<audio ', '<audio data-link="lk-1" data-sync-origin="lk-9" ')
    const { result } = await openHtml(file)
    splitClip(result, 'a', 1_000)
    expect(
      result.current.film?.clips.map((clip) => [clip.kind, clip.start, clip.duration]),
    ).toEqual([
      ['video', 0, 1_000],
      ['video', 1_000, 3_000],
      ['audio', 0, 1_000],
      ['audio', 1_000, 3_000],
    ])
    await waitFor(() => expect(saves).toHaveLength(1))
    const pairing = rootChildren(saves[0]?.html).map((element) => [
      element.getAttribute('data-link'),
      element.getAttribute('data-sync-origin'),
    ])
    expect(pairing).toEqual([
      ['lk-1', 'lk-9'],
      ['lk-2', 'lk-3'],
      ['lk-1', 'lk-9'],
      ['lk-2', 'lk-3'],
    ])

    act(() => result.current.undo())
    expect(result.current.film?.clips).toHaveLength(2)
    expect(result.current.film?.canUndo).toBe(false)
  })

  it('链接的片段结尾没对齐：各自切在同一处，结尾不动', async () => {
    const file = mainFile(
      [video({ id: 'v', duration: 4_000 }), audio({ id: 'a', start: 500, duration: 5_000 })],
      CANVAS,
    )
      .replace('<video ', '<video data-link="lk-1" ')
      .replace('<audio ', '<audio data-link="lk-1" ')
    const { result } = await openHtml(file)
    splitClip(result, 'v', 2_000)
    expect(
      result.current.film?.clips.map((clip) => [clip.kind, clip.start, clip.start + clip.duration]),
    ).toEqual([
      ['video', 0, 2_000],
      ['video', 2_000, 4_000],
      ['audio', 500, 2_000],
      ['audio', 2_000, 5_500],
    ])
  })

  it('后半段写不进去（片段里带着脚本）：整个不切，提示原因', async () => {
    const file = mainFile([host({ id: 't', duration: 4_000 })], CANVAS).replace(
      '></div>\n</div>',
      '><script>window.note = 1</script></div>\n</div>',
    )
    const { result, onNotice } = await openHtml(file)
    const before = result.current.film?.html
    splitClip(result, 't', 1_000)
    expect(onNotice).toHaveBeenCalledWith('片段里带有无法复制的内容，无法切开')
    expect(result.current.film?.html).toBe(before)
    expect(result.current.film?.canUndo).toBe(false)
  })
})

describe('useFilmSession · 分离音频、合并回视频、联动', () => {
  /** 主文件根下的元素各自的属性，按文件里的先后。 */
  const savedElements = (html: string | undefined) =>
    [
      ...(new DOMParser().parseFromString(html ?? '', 'text/html').getElementById('film')
        ?.children ?? []),
    ].map((element) =>
      Object.fromEntries([...element.attributes].map((each) => [each.name, each.value])),
    )
  const clipsOf = (result: Session) => result.current.film?.clips ?? []
  const clipOf = (result: Session, id: string) => {
    const clip = clipsOf(result).find((each) => each.id === id)
    if (clip === undefined) throw new Error(`没有片段 ${id}`)
    return clip
  }
  const pairIn = (result: Session, id: string) => {
    const pair = soundPairOf(clipOf(result, id), clipsOf(result))
    if (pair === undefined) throw new Error(`${id} 不成对`)
    return pair
  }
  /** 片段的「开始、时长、入点」和链接名。 */
  const timingAndLink = (result: Session, id: string) => {
    const clip = clipOf(result, id)
    return [clip.start, clip.duration, timingOf(clip).mediaStart, clip.link]
  }

  // 画面 1 秒起 2 秒长、入点 0.5 秒，带淡入、音量；声音区已经有一条配乐
  const shot = video({
    id: 'v',
    label: 'A · 镜头 1',
    start: 1_000,
    duration: 2_000,
    mediaStart: 500,
    volume: 0.5,
    fadeIn: 300,
    playbackRate: 1.5,
  })
  const music = audio({ id: 'm', start: 0, duration: 6_000 })

  /** 分离过原声、联动着的一对（2–4 秒，入点 1 秒），原声在人声行（声音区第 0 行），配乐在第 1 行。 */
  const pairFilm = (overrides: { video?: Partial<VideoClip>; audio?: Partial<AudioClip> } = {}) => [
    audio({
      id: 'a',
      label: 'A · 镜头 1 · 原声',
      src: shot.src,
      start: 2_000,
      duration: 2_000,
      mediaStart: 1_000,
      volume: 0.5,
      link: 'lk-1',
      syncOrigin: 'lk-1',
      ...overrides.audio,
    }),
    video({
      id: 'v',
      start: 2_000,
      duration: 2_000,
      mediaStart: 1_000,
      muted: true,
      link: 'lk-1',
      syncOrigin: 'lk-1',
      ...overrides.video,
    }),
    audio({ id: 'm', start: 0, duration: 8_000, track: 1 }),
  ]

  it('分离：原声片段写在视频前面、照抄地址起止入点速度和声音属性，视频关掉原声、去掉声音属性，两段同一个链接名和出处；声音区最上面新开人声行；一步撤销', async () => {
    const saves = recordSaves()
    const { result } = await openWith([shot, music])
    let added: string | undefined
    act(() => {
      added = result.current.detach('v')
    })
    if (added === undefined) throw new Error('没有分离出原声')
    await waitFor(() => expect(saves).toHaveLength(1))
    const [first, second, third] = savedElements(saves[0]?.html)
    expect(first).toEqual({
      id: added,
      'data-hf-id': added,
      'data-label': 'A · 镜头 1 · 原声',
      'data-start': '1',
      'data-duration': '2',
      'data-track-index': '0',
      'data-link': 'lk-1',
      class: 'clip audio',
      src: shot.src,
      'data-media-start': '0.5',
      'data-volume': '0.5',
      'data-playback-rate': '1.5',
      'data-fade-in': '0.3',
      'data-sync-origin': 'lk-1',
    })
    expect(second).toMatchObject({
      id: 'v',
      muted: 'true',
      'data-link': 'lk-1',
      'data-sync-origin': 'lk-1',
      'data-media-start': '0.5',
      'data-start': '1',
    })
    for (const gone of ['data-has-audio', 'data-volume', 'data-fade-in'])
      expect(second).not.toHaveProperty(gone)
    // 原来的配乐往下排一号，行名是「人声」「配乐」
    expect(third).toMatchObject({ id: 'm', 'data-track-index': '1' })
    expect(pairIn(result, added)).toMatchObject({ linked: true, offsetMs: 0 })

    act(() => result.current.undo())
    expect(clipsOf(result)).toEqual([shot, music])
    expect(result.current.film?.canUndo).toBe(false)
  })

  it('分离：隐藏着的视频分离出的原声也隐藏；有空着的人声行时放进去，不新开行', async () => {
    const { result } = await openWith([
      ...pairFilm(),
      video({ id: 'w', start: 5_000, duration: 1_000, hidden: true }),
    ])
    let added: string | undefined
    act(() => {
      added = result.current.detach('w')
    })
    if (added === undefined) throw new Error('没有分离出原声')
    expect(clipOf(result, added)).toMatchObject({ track: 0, hidden: true, start: 5_000 })
    expect(clipOf(result, 'm').track).toBe(1)
    // 新的链接名不和已有的 lk-1 重名
    expect(clipOf(result, added).link).toBe('lk-2')
  })

  it('合并：原声上的声音属性写回视频，视频打开原声、去掉链接名和出处，原声删掉；一步撤销', async () => {
    const saves = recordSaves()
    const before = pairFilm({ audio: { volume: 2, fadeOut: 400 } })
    const { result } = await openWith(before)
    act(() => {
      result.current.merge(pairIn(result, 'a'))
    })
    await waitFor(() => expect(saves).toHaveLength(1))
    const elements = savedElements(saves[0]?.html)
    expect(elements.map((element) => element['id'])).toEqual(['v', 'm'])
    expect(elements[0]).toMatchObject({
      'data-volume': '2',
      'data-fade-out': '0.4',
      'data-has-audio': 'true',
    })
    for (const gone of ['muted', 'data-link', 'data-sync-origin', 'data-fade-in'])
      expect(elements[0]).not.toHaveProperty(gone)
    act(() => result.current.undo())
    expect(clipsOf(result)).toEqual(before)
  })

  it('联动开关：关掉时两段去掉链接名、出处还在；打开时写上新的链接名；各一步撤销', async () => {
    const { result } = await openWith(pairFilm())
    act(() => result.current.setLinked(pairIn(result, 'a'), false))
    expect([clipOf(result, 'a'), clipOf(result, 'v')]).toMatchObject([
      { link: null, syncOrigin: 'lk-1' },
      { link: null, syncOrigin: 'lk-1' },
    ])
    expect(pairIn(result, 'v').linked).toBe(false)
    act(() => result.current.undo())
    expect(clipsOf(result)).toEqual(pairFilm())
    expect(result.current.film?.canUndo).toBe(false)

    // 新的链接名不和出处 lk-1 重名
    const unlinked = await openWith(pairFilm({ video: { link: null }, audio: { link: null } }))
    act(() => unlinked.result.current.setLinked(pairIn(unlinked.result, 'a'), true))
    expect(pairIn(unlinked.result, 'v').linked).toBe(true)
    expect(clipOf(unlinked.result, 'a').link).toBe('lk-2')
    act(() => unlinked.result.current.undo())
    expect(clipOf(unlinked.result, 'v').link).toBeNull()
  })

  it('联动开着、一起裁开头：各自的入点按算好的写，不被引擎再挪一次，链接名还在', async () => {
    const { result } = await openWith(pairFilm())
    const timings = groupTrimmed(
      clipsOf(result).filter((clip) => clip.id !== 'm'),
      'start',
      500,
      clipsOf(result),
      () => 10_000,
    )
    act(() => result.current.retime(timings))
    expect(timingAndLink(result, 'v')).toEqual([2_500, 1_500, 1_500, 'lk-1'])
    expect(timingAndLink(result, 'a')).toEqual([2_500, 1_500, 1_500, 'lk-1'])
    expect(pairIn(result, 'a').offsetMs).toBe(0)
    // 解除再写回链接名和改时间算一步撤销
    act(() => result.current.undo())
    expect(clipsOf(result)).toEqual(pairFilm())
    expect(result.current.film?.canUndo).toBe(false)
  })

  it('联动开着、只改视频（伙伴结尾没对齐不跟着裁）：原声不动，两段的链接名都还在', async () => {
    const { result } = await openWith(pairFilm({ audio: { duration: 2_500 } }))
    act(() =>
      result.current.retime(new Map([['v', { start: 2_000, duration: 1_000, mediaStart: 1_000 }]])),
    )
    expect(timingAndLink(result, 'v')).toEqual([2_000, 1_000, 1_000, 'lk-1'])
    expect(timingAndLink(result, 'a')).toEqual([2_000, 2_500, 1_000, 'lk-1'])
  })

  it('联动开着、换行挪动：一起挪的伙伴只挪一次；对齐口型只挪原声，联动不变', async () => {
    const { result } = await openWith(pairFilm({ audio: { start: 2_400 } }))
    act(() =>
      result.current.moveClip(
        'v',
        { track: 0, start: 3_000 },
        null,
        undefined,
        new Map([['a', 3_400]]),
      ),
    )
    expect(timingAndLink(result, 'v')).toEqual([3_000, 2_000, 1_000, 'lk-1'])
    expect(timingAndLink(result, 'a')).toEqual([3_400, 2_000, 1_000, 'lk-1'])
    act(() => result.current.resync('a', 3_000))
    expect(timingAndLink(result, 'a')).toEqual([3_000, 2_000, 1_000, 'lk-1'])
    expect(timingAndLink(result, 'v')).toEqual([3_000, 2_000, 1_000, 'lk-1'])
  })

  it('联动开着、挪动以后撤销、重做：整份文件回到挪之前、挪之后，链接名都在；照常保存', async () => {
    const saves = recordSaves()
    const { result } = await openWith(pairFilm({ audio: { start: 2_400 } }))
    const before = savedElements(result.current.film?.html)
    act(() =>
      result.current.moveClip(
        'v',
        { track: 0, start: 3_000 },
        null,
        undefined,
        new Map([['a', 3_400]]),
      ),
    )
    const moved = savedElements(result.current.film?.html)
    await waitFor(() => expect(saves).toHaveLength(1))

    act(() => result.current.undo())
    expect(savedElements(result.current.film?.html)).toEqual(before)
    expect([timingAndLink(result, 'v'), timingAndLink(result, 'a')]).toEqual([
      [2_000, 2_000, 1_000, 'lk-1'],
      [2_400, 2_000, 1_000, 'lk-1'],
    ])
    await waitFor(() => expect(saves).toHaveLength(2))
    expect(savedElements(saves[1]?.html)).toEqual(before)

    act(() => result.current.redo())
    expect(savedElements(result.current.film?.html)).toEqual(moved)
    expect(pairIn(result, 'v').linked).toBe(true)
    await waitFor(() => expect(saves).toHaveLength(3))
    expect(savedElements(saves[2]?.html)).toEqual(moved)
  })

  it('合拢空档、波纹删除补位：联动的伙伴挪同样的时间差；联动关着时伙伴不动', async () => {
    const lead = video({ id: 'x', start: 0, duration: 1_000 })
    const { result } = await openWith([lead, ...pairFilm()])
    act(() => result.current.restart(new Map([['v', 1_000]])))
    expect(clipOf(result, 'a').start).toBe(1_000)
    act(() => result.current.undo())
    act(() => {
      result.current.removeClips(['x'], true)
    })
    expect([clipOf(result, 'v').start, clipOf(result, 'a').start]).toEqual([1_000, 1_000])
    expect(clipOf(result, 'a').link).toBe('lk-1')

    const unlinked = pairFilm({ video: { link: null }, audio: { link: null } })
    const other = await openWith([lead, ...unlinked])
    act(() => other.result.current.restart(new Map([['v', 1_000]])))
    expect(clipOf(other.result, 'a').start).toBe(2_000)
  })
})

describe('useFilmSession · 字幕', () => {
  const SCENE_PATH = `final-cut/${CAPTIONS_PATH}`

  type Write = { path: string; content: string; expectedVersion: number | null }

  /** 每次写工程文件（新建或按版本写），按先后记成相对工程根的路径、内容和带的版本号（新建是 null）。 */
  const recordWrites = () => {
    const writes: Write[] = []
    server.use(
      http.put(WRITE, async ({ request }) => {
        const body = (await request.clone().json()) as Write
        writes.push({ ...body, path: body.path.replace(/^final-cut\//, '') })
        return undefined
      }),
      http.post(CREATE, async ({ request }) => {
        const body = (await request.clone().json()) as Omit<Write, 'expectedVersion'>
        writes.push({ ...body, expectedVersion: null })
        return undefined
      }),
    )
    return writes
  }

  const captionsOf = (result: Session): CaptionClip[] =>
    (result.current.film?.clips ?? []).filter((clip) => clip.kind === 'caption')

  const parse = (html: string | undefined) =>
    new DOMParser().parseFromString(html ?? '', 'text/html')

  /** 主文件根上声明的变量，变量 → 默认值。 */
  const variablesIn = (html: string | undefined) =>
    Object.fromEntries(
      (
        JSON.parse(
          parse(html).documentElement.getAttribute('data-composition-variables') ?? '[]',
        ) as { id: string; default: unknown }[]
      ).map((declaration) => [declaration.id, declaration.default]),
    )

  /** 主文件里字幕宿主的属性；没有宿主时是 undefined。 */
  const hostIn = (html: string | undefined) => {
    const host = parse(html).getElementById('captions')
    return host === null
      ? undefined
      : Object.fromEntries([...host.attributes].map((item) => [item.name, item.value]))
  }

  /** 场景文件里的各句字幕，写成「编号、开始、时长、读的变量、元素里的字」。 */
  const sceneCaptions = (scene: string | undefined) =>
    [...parse((scene ?? '').replace(/<\/?template>/g, '')).querySelectorAll('.caption')].map(
      (element) => [
        element.id,
        Number(element.getAttribute('data-start')),
        Number(element.getAttribute('data-duration')),
        element.getAttribute('data-var-text'),
        (element as HTMLElement).innerHTML.replaceAll('<br>', '\n'),
      ],
    )

  const storedScene = (conversation: string) => mockWorkspaceFile(conversation, SCENE_PATH)?.content

  type Line = Pick<CaptionClip, 'id' | 'start' | 'duration' | 'variable' | 'text'> &
    Partial<Pick<CaptionClip, 'owner'>>
  const line = (key: string, start: number, duration: number, text: string): Line => ({
    id: `cap-${key}`,
    variable: `cap_${key}`,
    start,
    duration,
    text,
  })

  /**
   * 工作区里放一份带字幕的工程：主文件按 `clips` 写，根下最后是字幕宿主、根上每句一个变量（照编辑器用 SDK
   * 写），场景文件里放上 `lines`。`scene` 给了就用它当场景文件。
   */
  const putCaptioned = async (
    conversation: string,
    clips: FilmClip[],
    lines: Line[],
    scene = captionsScene(CANVAS, fixtureCatalog, lines),
  ) => {
    const main = await openComposition(mainFile(clips, CANVAS))
    const end = Math.max(...[...clips, ...lines].map((clip) => clip.start + clip.duration))
    main.addElement('film', 99, captionsHostElement(CANVAS, end))
    for (const each of lines) main.declareVariable(captionVariable(each))
    putMockWorkspaceFile(conversation, SCENE_PATH, scene)
    return putMockProjectMain(conversation, main.serialize())
  }

  const openCaptioned = async (clips: FilmClip[], lines: Line[]) => {
    const conversation = crypto.randomUUID()
    const stored = await putCaptioned(conversation, clips, lines)
    return { conversation, ...(await open(stored, 10, conversation)) }
  }

  const addCaption = async (result: Session, start: number, duration: number, text: string) => {
    let id: string | undefined
    await act(async () => {
      const ids = await result.current.addCaptions(() => [{ start, duration, text, owner: null }])
      id = ids?.[0]
    })
    if (id === undefined) throw new Error('没有加上字幕')
    return id
  }

  /** 马上把没存的都存掉，等存完。 */
  const saveAll = (result: Session) =>
    act(async () => {
      await result.current.settle()
    })

  it('加第一句：先建好空的场景文件，再一步写上宿主、根上的变量和这句字幕；场景先存、主文件后存', async () => {
    const conversation = crypto.randomUUID()
    const writes = recordWrites()
    const { result } = await open(
      putMockProjectMain(conversation, mainFile([video({ duration: 3_000 })], CANVAS)),
      10,
      conversation,
    )
    const id = await addCaption(result, 500, 2_000, '第一句')
    expect(captionsOf(result)).toEqual([
      expect.objectContaining({ id, start: 500, duration: 2_000, text: '第一句' }),
    ])
    await waitFor(() =>
      expect(writes.map((write) => [write.path, write.expectedVersion])).toEqual([
        [CAPTIONS_PATH, null],
        [CAPTIONS_PATH, 1],
        ['index.html', 1],
      ]),
    )
    expect(sceneCaptions(writes[0]?.content)).toEqual([])

    const main = mockProjectMain(conversation)?.content
    const variable = captionsOf(result)[0]?.variable ?? ''
    expect(variablesIn(main)).toEqual({ [variable]: '第一句' })
    expect(hostIn(main)).toMatchObject({
      'data-composition-src': CAPTIONS_PATH,
      'data-start': '0',
      'data-duration': '3',
      'data-no-timeline': '',
    })
    expect(hostIn(main)).not.toHaveProperty('data-variable-values')
    const scene = storedScene(conversation)
    expect(sceneCaptions(scene)).toEqual([[id, 0.5, 2, variable, '第一句']])
    expect(scene?.trim().startsWith('<template>')).toBe(true)
    expect(scene).not.toContain('data-composition-variables')
    expect(result.current.film?.captionsProblem).toBeUndefined()

    // 一步撤销：宿主、变量、这句字幕一起没了；场景文件留着（空的）
    act(() => result.current.undo())
    expect(captionsOf(result)).toEqual([])
    expect(hostIn(result.current.film?.html)).toBeUndefined()
    expect(variablesIn(result.current.film?.html)).toEqual({})
    await waitFor(() => expect(sceneCaptions(storedScene(conversation))).toEqual([]))
    act(() => result.current.redo())
    expect(captionsOf(result).map((caption) => caption.id)).toEqual([id])
    expect(hostIn(result.current.film?.html)).toBeDefined()
  })

  it('加第二句：按开始时间排进场景，再声明一个变量；字幕在最后时宿主和根上的总长跟着变长', async () => {
    const { result, conversation } = await openCaptioned(
      [video({ duration: 3_000 })],
      [line('a1', 1_000, 1_000, '第一句')],
    )
    expect(captionsOf(result).map((caption) => caption.text)).toEqual(['第一句'])
    const later = await addCaption(result, 4_000, 2_000, '最后一句')
    const earlier = await addCaption(result, 0, 1_000, '开头')
    expect(result.current.film?.durationMs).toBe(6_000)
    expect(hostIn(result.current.film?.html)?.['data-duration']).toBe('6')
    await saveAll(result)
    expect(sceneCaptions(storedScene(conversation)).map(([id]) => id)).toEqual([
      earlier,
      'cap-a1',
      later,
    ])
    expect(Object.values(variablesIn(mockProjectMain(conversation)?.content))).toEqual([
      '第一句',
      '最后一句',
      '开头',
    ])
  })

  it('宿主时长跟着总长变：加片段变长，删掉片段变短，最晚的是字幕时按字幕的结尾', async () => {
    const { result } = await openCaptioned(
      [video({ duration: 3_000 })],
      [line('a1', 1_000, 1_000, '第一句')],
    )
    const hostLength = () => hostIn(result.current.film?.html)?.['data-duration']
    expect(hostLength()).toBe('3')
    await add(result, piece({ duration: 2_000 }))
    expect(hostLength()).toBe('5')
    const added = videosOf(result).find((clip) => clip.id !== 'clip-1')?.id ?? ''
    act(() => {
      result.current.removeClips([added, 'clip-1'], false)
    })
    expect(result.current.film?.durationMs).toBe(2_000)
    expect(hostLength()).toBe('2')
    act(() =>
      result.current.retime(
        new Map([['cap-a1', { start: 3_000, duration: 1_500, mediaStart: 0 }]]),
      ),
    )
    expect(hostLength()).toBe('4.5')
  })

  it('改字：变量的默认值和场景里的字都改成新的，一步撤销、重做两个文件一起退、一起进', async () => {
    const { result, conversation } = await openCaptioned(
      [video()],
      [line('a1', 0, 1_000, '第一句')],
    )
    act(() => result.current.setCaptionText('cap-a1', '改过的\n两行', 'zh'))
    expect(captionsOf(result)[0]?.text).toBe('改过的\n两行')
    expect(variablesIn(result.current.film?.html)).toEqual({ cap_a1: '改过的\n两行' })
    await saveAll(result)
    expect(sceneCaptions(storedScene(conversation))).toEqual([
      ['cap-a1', 0, 1, 'cap_a1', '改过的\n两行'],
    ])
    // 字没变时不记一步
    act(() => result.current.setCaptionText('cap-a1', '改过的\n两行', 'zh'))
    act(() => result.current.undo())
    expect(variablesIn(result.current.film?.html)).toEqual({ cap_a1: '第一句' })
    expect(result.current.film?.canUndo).toBe(false)
    await saveAll(result)
    expect(sceneCaptions(storedScene(conversation))[0]?.[4]).toBe('第一句')
    expect(variablesIn(mockProjectMain(conversation)?.content)).toEqual({ cap_a1: '第一句' })
    act(() => result.current.redo())
    expect(captionsOf(result)[0]?.text).toBe('改过的\n两行')
    await waitFor(() =>
      expect(sceneCaptions(storedScene(conversation))[0]?.[4]).toBe('改过的\n两行'),
    )
  })

  it('删一句：场景里的元素和根上的变量都没了，一步撤销两个都回来；删到没有时场景文件和宿主都留着', async () => {
    const { result, conversation } = await openCaptioned(
      [video()],
      [line('a1', 0, 1_000, '第一句'), line('b2', 1_000, 1_000, '第二句')],
    )
    act(() => {
      result.current.removeClips(['cap-a1'], true)
    })
    expect(captionsOf(result).map((caption) => caption.id)).toEqual(['cap-b2'])
    expect(variablesIn(result.current.film?.html)).toEqual({ cap_b2: '第二句' })
    expect(videosOf(result)).toEqual([video()])
    act(() => result.current.undo())
    expect(captionsOf(result).map((caption) => caption.text)).toEqual(['第一句', '第二句'])
    expect(variablesIn(result.current.film?.html)).toEqual({ cap_a1: '第一句', cap_b2: '第二句' })
    act(() => result.current.redo())
    act(() => {
      result.current.removeClips(['cap-b2'], false)
    })
    expect(captionsOf(result)).toEqual([])
    await saveAll(result)
    expect(sceneCaptions(storedScene(conversation))).toEqual([])
    expect(variablesIn(mockProjectMain(conversation)?.content)).toEqual({})
    expect(hostIn(mockProjectMain(conversation)?.content)).toBeDefined()
  })

  it('打开工程：没有宿主但场景文件在（加了又撤销留下的）也读它，加字幕时不再新建', async () => {
    const conversation = crypto.randomUUID()
    putMockWorkspaceFile(conversation, SCENE_PATH, captionsScene(CANVAS, fixtureCatalog))
    const writes = recordWrites()
    const { result } = await open(
      putMockProjectMain(conversation, mainFile([video()], CANVAS)),
      10,
      conversation,
    )
    await addCaption(result, 0, 1_000, '一句')
    await saveAll(result)
    expect(writes.map((write) => [write.path, write.expectedVersion])).toEqual([
      [CAPTIONS_PATH, 1],
      ['index.html', 1],
    ])
  })

  it('建场景文件时工作区里已经有了（409）：用那一份和它的版本号接着加，不当成别处改的', async () => {
    const conversation = crypto.randomUUID()
    const { result, onNotice } = await open(
      putMockProjectMain(conversation, mainFile([video()], CANVAS)),
      10,
      conversation,
    )
    // 打开以后才出现的场景文件，已经写过两版
    putMockWorkspaceFile(conversation, SCENE_PATH, captionsScene(CANVAS, fixtureCatalog))
    putMockWorkspaceFile(conversation, SCENE_PATH, captionsScene(CANVAS, fixtureCatalog))
    const writes = recordWrites()
    await addCaption(result, 0, 1_000, '一句')
    await saveAll(result)
    expect(writes.map((write) => [write.path, write.expectedVersion])).toEqual([
      [CAPTIONS_PATH, null],
      [CAPTIONS_PATH, 2],
      ['index.html', 1],
    ])
    expect(onNotice).not.toHaveBeenCalled()
    expect(result.current.film?.canUndo).toBe(true)
  })

  it('打开工程：宿主挂载的场景文件不存在时按没有字幕打开，提示一句', async () => {
    const conversation = crypto.randomUUID()
    const stored = await putCaptioned(conversation, [video()], [line('a1', 0, 1_000, '一句')])
    server.use(
      http.get(READ, ({ request }) =>
        new URL(request.url).searchParams.get('path') === SCENE_PATH
          ? HttpResponse.json({ detail: '文件不存在' }, { status: 404 })
          : undefined,
      ),
    )
    const { result, onNotice } = await open(stored, 10, conversation)
    expect(captionsOf(result)).toEqual([])
    expect(onNotice).toHaveBeenCalledExactlyOnceWith('字幕文件不存在，已按没有字幕打开 final-cut')
  })

  it('字幕场景存的时候版本对不上（409）：两个文件都换成工作区里的那一份，撤销记录清空并提示', async () => {
    const { result, conversation, onNotice } = await openCaptioned(
      [video()],
      [line('a1', 0, 1_000, '第一句')],
    )
    const writes = recordWrites()
    // 别处把场景文件和主文件都改了：场景里只剩另一句，主文件里换成它的变量
    const theirs = [line('z9', 500, 1_000, '别处写的')]
    await putCaptioned(conversation, [video({ duration: 4_000 })], theirs)
    act(() => result.current.setCaptionText('cap-a1', '本地改的', 'zh'))
    await waitFor(() => expect(onNotice).toHaveBeenCalledOnce())
    expect(onNotice).toHaveBeenCalledWith(
      'final-cut 已在别处修改，已切换到最新版本；未保存的改动已放弃',
    )
    expect(writes.map((write) => write.path)).toEqual([CAPTIONS_PATH])
    expect(captionsOf(result).map((caption) => [caption.id, caption.text])).toEqual([
      ['cap-z9', '别处写的'],
    ])
    expect(videosOf(result)[0]?.duration).toBe(4_000)
    expect(result.current.film?.canUndo).toBe(false)
    expect(result.current.save.kind).toBe('idle')
  })

  it('场景文件在别处改了（通知）：两个文件都换成工作区里的那一份', async () => {
    const { result, conversation, onNotice, notify } = await openCaptioned(
      [video()],
      [line('a1', 0, 1_000, '第一句')],
    )
    act(() => result.current.setCaptionText('cap-a1', '本地改的', 'zh'))
    putMockWorkspaceFile(
      conversation,
      SCENE_PATH,
      captionsScene(CANVAS, fixtureCatalog, [line('a1', 200, 800, '第一句')]),
    )
    notify(SCENE_PATH)
    await waitFor(() => expect(onNotice).toHaveBeenCalledOnce())
    expect(captionsOf(result).map((caption) => [caption.start, caption.text])).toEqual([
      [200, '第一句'],
    ])
    expect(result.current.film?.canUndo).toBe(false)
  })

  it('场景自己声明了变量、或宿主带了取值：给出原因', async () => {
    const conversation = crypto.randomUUID()
    const lines = [line('a1', 0, 1_000, '一句')]
    const declared = captionsScene(CANVAS, fixtureCatalog, lines).replace(
      'data-no-timeline',
      `data-no-timeline data-composition-variables='[{"id":"x","type":"string","label":"x","default":"y"}]'`,
    )
    const stored = await putCaptioned(conversation, [video()], lines, declared)
    const { result } = await open(stored, 10, conversation)
    expect(result.current.film?.captionsProblem).toBe(CAPTIONS_PROBLEM_TEXT)

    const other = crypto.randomUUID()
    const { content } = await putCaptioned(other, [video()], lines)
    const valued = putMockProjectMain(
      other,
      content.replace(
        'data-track-kind="captions"',
        `data-track-kind="captions" data-variable-values="{}"`,
      ),
    )
    const reopened = await open(valued, 10, other)
    expect(reopened.result.current.film?.captionsProblem).toBe(CAPTIONS_PROBLEM_TEXT)
  })

  it('字幕的名字就是它的字：换行和连着的空白合成一个空格，字照旧带着换行', async () => {
    const { result } = await openCaptioned([video()], [line('a1', 0, 1_000, '第一句')])
    expect(captionsOf(result)[0]?.label).toBe('第一句')
    act(() => result.current.setCaptionText('cap-a1', ' 改过的\n\n两  行 ', 'zh'))
    expect(captionsOf(result)[0]).toMatchObject({
      label: '改过的 两 行',
      text: ' 改过的\n\n两  行 ',
    })
    act(() => result.current.setCaptionText('cap-a1', ' \n ', 'zh'))
    expect(captionsOf(result)[0]?.label).toBe('字幕')
  })

  /** 存下来的场景文件里各句的「编号、开始、时长」（秒）。 */
  const storedTimings = (conversation: string) =>
    sceneCaptions(storedScene(conversation)).map(([id, start, duration]) => [id, start, duration])
  /** 存下来的主文件里视频片段的开始（秒）。 */
  const storedVideoStarts = (conversation: string) =>
    [...parse(mockProjectMain(conversation)?.content).querySelectorAll('video')].map((element) =>
      Number(element.getAttribute('data-start')),
    )

  it('一起改字幕和视频片段的时间（一起挪、一起裁）：各改在自己的文件里，一步撤销两个都退回', async () => {
    const { result, conversation } = await openCaptioned(
      [video({ duration: 1_000 })],
      [line('a1', 0, 1_000, '第一句')],
    )
    act(() =>
      result.current.retime(
        new Map([
          ['clip-1', { start: 500, duration: 1_000, mediaStart: 0 }],
          ['cap-a1', { start: 500, duration: 800, mediaStart: 0 }],
        ]),
      ),
    )
    await saveAll(result)
    expect(storedTimings(conversation)).toEqual([['cap-a1', 0.5, 0.8]])
    expect(storedVideoStarts(conversation)).toEqual([0.5])
    act(() => result.current.undo())
    await saveAll(result)
    expect(storedTimings(conversation)).toEqual([['cap-a1', 0, 1]])
    expect(storedVideoStarts(conversation)).toEqual([0])
  })

  it('视频片段换行时一起挪的字幕：字幕改在字幕场景里', async () => {
    const { result, conversation } = await openCaptioned(
      [video({ duration: 1_000 })],
      [line('a1', 0, 1_000, '第一句'), line('b2', 3_000, 1_000, '第二句')],
    )
    act(() =>
      result.current.moveClip(
        'clip-1',
        { track: 1, start: 1_000 },
        null,
        undefined,
        new Map([['cap-a1', 1_000]]),
      ),
    )
    await saveAll(result)
    expect(storedTimings(conversation)).toEqual([
      ['cap-a1', 1, 1],
      ['cap-b2', 3, 1],
    ])
  })

  it('隐藏字幕：隐藏的是主文件里的字幕宿主，每句都算隐藏；一步撤销', async () => {
    const { result, conversation } = await openCaptioned(
      [video()],
      [line('a1', 0, 1_000, '第一句'), line('b2', 1_000, 1_000, '第二句')],
    )
    act(() => result.current.setHidden(['cap-a1', 'cap-b2'], true))
    expect(captionsOf(result).map((caption) => caption.hidden)).toEqual([true, true])
    expect(videosOf(result)[0]?.hidden).toBe(false)
    await saveAll(result)
    expect(hostIn(mockProjectMain(conversation)?.content)).toHaveProperty('data-hidden', '')
    expect(storedScene(conversation)).not.toContain('data-hidden')
    act(() => result.current.undo())
    expect(captionsOf(result).map((caption) => caption.hidden)).toEqual([false, false])
    expect(hostIn(result.current.film?.html)).not.toHaveProperty('data-hidden')
  })

  it('字幕跟着视频片段挪过去会压到别的字幕：整步不做（视频片段也不挪），提示原因，不记撤销', async () => {
    const { result, onNotice } = await openCaptioned(
      [video({ duration: 2_000 })],
      [
        { ...line('a1', 500, 1_000, '它的字幕'), owner: 'clip-1' },
        line('b2', 3_500, 1_000, '挡路'),
      ],
    )
    const before = result.current.film?.html
    act(() =>
      result.current.retime(
        new Map([['clip-1', { start: 3_000, duration: 2_000, mediaStart: 0 }]]),
      ),
    )
    expect(onNotice).toHaveBeenCalledWith(CAPTION_FOLLOW_REFUSAL_TEXT)
    expect(videosOf(result)[0]?.start).toBe(0)
    expect(captionsOf(result).map((caption) => caption.start)).toEqual([500, 3_500])
    expect(result.current.film?.html).toBe(before)
    expect(result.current.film?.canUndo).toBe(false)
  })

  describe('语言', () => {
    const EN_PATH = 'final-cut/locales/en.json'
    const DE_PATH = 'final-cut/locales/de.json'
    const STALE_TEXT = 'final-cut 已在别处修改，已切换到最新版本；未保存的改动已放弃'

    /** 工作区里存着的一份值表，读成对象；没有时是 undefined。 */
    const storedValues = (conversation: string, path: string): unknown => {
      const content = mockWorkspaceFile(conversation, path)?.content
      return content === undefined ? undefined : JSON.parse(content)
    }

    /** 带字幕的工程（一段视频片段和 `lines`），工作区里再放上 `files`（工作区里的路径 → 内容），打开它。 */
    const openLocalized = async (
      lines: Line[],
      files: Record<string, string>,
      catalog = fixtureCatalog,
    ) => {
      const conversation = crypto.randomUUID()
      const stored = await putCaptioned(conversation, [video()], lines)
      for (const [path, content] of Object.entries(files))
        putMockWorkspaceFile(conversation, path, content)
      return { conversation, ...(await open(stored, 10, conversation, catalog)) }
    }

    it('读工程时读到 locales/ 下的值表，不认识的语言、别的文件不算；切到 English 时字幕的名字是英文，没翻的是原文，原文不变', async () => {
      const { result } = await openLocalized(
        [line('a1', 0, 1_000, '第一句'), line('b2', 1_000, 1_000, '第二句')],
        {
          [EN_PATH]: '{"cap_a1": "First line"}',
          'final-cut/locales/ja.json': '{"cap_a1": "一行目"}',
          'final-cut/locales/en.txt': '{}',
          'final-cut/compositions/locales/de.json': '{}',
        },
      )
      expect(result.current.film?.locales).toEqual(['en'])
      expect(result.current.film?.locale).toEqual({ code: 'zh', values: null })
      expect(captionsOf(result).map((caption) => caption.label)).toEqual(['第一句', '第二句'])
      // 工程里没有的语言切不过去
      act(() => result.current.setLocale('fr'))
      expect(result.current.film?.locale.code).toBe('zh')
      act(() => result.current.setLocale('en'))
      expect(result.current.film?.locale).toEqual({
        code: 'en',
        values: { cap_a1: 'First line' },
      })
      expect(captionsOf(result).map((caption) => [caption.label, caption.text])).toEqual([
        ['First line', '第一句'],
        ['第二句', '第二句'],
      ])
    })

    it('值表不是 JSON 对象：读工程时说明原因', async () => {
      const conversation = crypto.randomUUID()
      await putCaptioned(conversation, [video()], [line('a1', 0, 1_000, '第一句')])
      putMockWorkspaceFile(conversation, EN_PATH, '["cap_a1"]')
      await expect(readProject(conversation)).rejects.toThrow(
        'English 的语言文件写法不对，无法打开 final-cut；请把它改成变量 id 对应文字的 JSON 对象',
      )
    })

    it('加一种语言：建一份空的值表、切过去，不算一步撤销；工作区里已经有了（409）就用那一份，不当成别处改的，没改不重写', async () => {
      const { result, conversation, onNotice } = await openLocalized(
        [line('a1', 0, 1_000, '第一句')],
        {},
      )
      const writes = recordWrites()
      await act(async () => {
        await result.current.addLocale('de')
      })
      expect(writes).toEqual([{ path: 'locales/de.json', content: '{}\n', expectedVersion: null }])
      expect(result.current.film?.locales).toEqual(['de'])
      expect(result.current.film?.locale).toEqual({ code: 'de', values: {} })
      expect(result.current.film?.canUndo).toBe(false)

      // 打开以后别处建好的 Français 值表，写法和编辑器存出的不一样
      const theirs = '{"cap_a1":"Première"}'
      putMockWorkspaceFile(conversation, 'final-cut/locales/fr.json', theirs)
      await act(async () => {
        await result.current.addLocale('fr')
      })
      expect(result.current.film?.locales).toEqual(['de', 'fr'])
      expect(result.current.film?.locale.code).toBe('fr')
      expect(captionsOf(result)[0]?.label).toBe('Première')
      await saveAll(result)
      // 只有那一次没建成的新建：值表没改，不重写
      expect(writes.map((write) => write.path)).toEqual(['locales/de.json', 'locales/fr.json'])
      expect(mockWorkspaceFile(conversation, 'final-cut/locales/fr.json')).toEqual({
        content: theirs,
        version: 1,
      })
      expect(onNotice).not.toHaveBeenCalled()
    })

    it('外语下改字：写进那种语言的值表，原文（变量的默认值、场景里的字）不动；一次一步撤销；清空时从值表里去掉', async () => {
      const { result, conversation } = await openLocalized([line('a1', 0, 1_000, '第一句')], {
        [EN_PATH]: '{}',
      })
      act(() => result.current.setLocale('en'))
      act(() => result.current.setCaptionText('cap-a1', 'Hello', 'en'))
      expect(result.current.film?.locale.values).toEqual({ cap_a1: 'Hello' })
      expect(captionsOf(result)[0]).toMatchObject({ text: '第一句', label: 'Hello' })
      expect(variablesIn(result.current.film?.html)).toEqual({ cap_a1: '第一句' })
      await saveAll(result)
      expect(mockWorkspaceFile(conversation, EN_PATH)?.content).toBe('{\n  "cap_a1": "Hello"\n}\n')
      expect(sceneCaptions(storedScene(conversation))[0]?.[4]).toBe('第一句')
      expect(variablesIn(mockProjectMain(conversation)?.content)).toEqual({ cap_a1: '第一句' })

      // 字没变时不记一步；撤销一步就回到没翻
      act(() => result.current.setCaptionText('cap-a1', 'Hello', 'en'))
      act(() => result.current.undo())
      expect(result.current.film?.locale.values).toEqual({})
      expect(captionsOf(result)[0]?.label).toBe('第一句')
      expect(result.current.film?.canUndo).toBe(false)
      act(() => result.current.redo())
      expect(result.current.film?.locale.values).toEqual({ cap_a1: 'Hello' })

      act(() => result.current.setCaptionText('cap-a1', '', 'en'))
      expect(result.current.film?.locale.values).toEqual({})
      await saveAll(result)
      expect(mockWorkspaceFile(conversation, EN_PATH)?.content).toBe('{}\n')

      // 中文照旧改原文，值表不动
      act(() => result.current.setCaptionText('cap-a1', '改过的', 'zh'))
      expect(captionsOf(result)[0]).toMatchObject({ text: '改过的', label: '改过的' })
      expect(result.current.film?.locale.values).toEqual({})
    })

    it('删一句字幕、删掉字幕属于的视频片段：同一步里从所有值表里去掉它的值；撤销都回来', async () => {
      const { result, conversation } = await openLocalized(
        [
          line('a1', 0, 1_000, '第一句'),
          { ...line('b2', 1_000, 1_000, '第二句'), owner: 'clip-1' },
        ],
        {
          [EN_PATH]: '{"cap_a1": "One", "cap_b2": "Two"}',
          [DE_PATH]: '{"cap_a1": "Eins"}',
        },
      )
      act(() => {
        result.current.removeClips(['cap-a1'], false)
      })
      await saveAll(result)
      expect(storedValues(conversation, EN_PATH)).toEqual({ cap_b2: 'Two' })
      expect(storedValues(conversation, DE_PATH)).toEqual({})
      act(() => result.current.undo())
      await saveAll(result)
      expect(storedValues(conversation, EN_PATH)).toEqual({ cap_a1: 'One', cap_b2: 'Two' })
      expect(storedValues(conversation, DE_PATH)).toEqual({ cap_a1: 'Eins' })

      act(() => {
        result.current.removeClips(['clip-1'], false)
      })
      expect(captionsOf(result).map((caption) => caption.id)).toEqual(['cap-a1'])
      await saveAll(result)
      expect(storedValues(conversation, EN_PATH)).toEqual({ cap_a1: 'One' })
    })

    it('主文件的字体块按原文和所有值表里的字一起声明：外文的字也有字形；撤销改值表的那一步，字体块跟着回去', async () => {
      const catalog = {
        ...fixtureCatalog,
        cjk: {
          family: 'Noto Sans SC',
          slices: [
            { range: 'U+00e0-00ff', files: { '700': 'vendor/fonts/latin-ext-700.woff2' } },
            { range: 'U+4e00-9fff', files: { '700': 'vendor/fonts/cjk-700.woff2' } },
            { range: 'U+0020-007e', files: { '700': 'vendor/fonts/latin-700.woff2' } },
          ],
        },
      }
      const { result, conversation } = await openLocalized(
        [line('a1', 0, 1_000, '第一句')],
        { [DE_PATH]: '{"cap_a1": "Grüße"}' },
        catalog,
      )
      const html = () => result.current.film?.html ?? ''
      // 中文显示着也带上德文的字
      expect(html()).toContain('latin-ext-700.woff2')
      expect(html()).toContain('cjk-700.woff2')
      act(() => result.current.setCaptionText('cap-a1', 'Grusse', 'de'))
      expect(html()).not.toContain('latin-ext-700.woff2')
      await saveAll(result)
      expect(mockProjectMain(conversation)?.content).not.toContain('latin-ext-700.woff2')
      act(() => result.current.undo())
      expect(html()).toContain('latin-ext-700.woff2')
    })

    it('值表存的时候版本对不上（409）：整个工程换成工作区里的那一份，提示，撤销记录清空', async () => {
      const { result, conversation, onNotice } = await openLocalized(
        [line('a1', 0, 1_000, '第一句')],
        { [EN_PATH]: '{}' },
      )
      putMockWorkspaceFile(conversation, EN_PATH, '{"cap_a1": "Theirs"}')
      act(() => result.current.setLocale('en'))
      act(() => result.current.setCaptionText('cap-a1', 'Mine', 'en'))
      await waitFor(() => expect(onNotice).toHaveBeenCalledExactlyOnceWith(STALE_TEXT))
      expect(result.current.film?.locale).toEqual({ code: 'en', values: { cap_a1: 'Theirs' } })
      expect(result.current.film?.canUndo).toBe(false)
      expect(result.current.save.kind).toBe('idle')
    })

    it('切换语言不写文件；自己存值表的通知不算别处改的、预览不为它重新加载；别处加了一种语言算别处改的', async () => {
      const { result, conversation, onNotice, notify } = await openLocalized(
        [line('a1', 0, 1_000, '第一句')],
        { [EN_PATH]: '{}' },
      )
      const writes = recordWrites()
      act(() => result.current.setLocale('en'))
      act(() => result.current.setLocale('zh'))
      act(() => result.current.setLocale('en'))
      await saveAll(result)
      expect(writes).toEqual([])

      act(() => result.current.setCaptionText('cap-a1', 'Hi', 'en'))
      await saveAll(result)
      const reads = countMainReads()
      notify(EN_PATH)
      await waitFor(() => expect(reads.count).toBe(1))
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(onNotice).not.toHaveBeenCalled()
      expect(result.current.film?.canUndo).toBe(true)
      expect(result.current.filesRevision).toBe(0)

      putMockWorkspaceFile(conversation, DE_PATH, '{}')
      notify(DE_PATH)
      await waitFor(() => expect(result.current.film?.locales).toEqual(['en', 'de']))
      expect(onNotice).toHaveBeenCalledExactlyOnceWith(STALE_TEXT)
      expect(result.current.film?.locale).toEqual({ code: 'en', values: { cap_a1: 'Hi' } })
    })
  })

  describe('贴片、场景的文字：固定 / 随语言', () => {
    const EN_PATH = 'final-cut/locales/en.json'
    const DE_PATH = 'final-cut/locales/de.json'

    /** 主文件里片段 `id` 的取值和随语言的字段（属性写法不对时测试直接失败）。 */
    const hostIn = (html: string | undefined, id: string) => {
      const element = parse(html).getElementById(id)
      if (element === null) return undefined
      const bindings = element.getAttribute('data-locale-bindings')
      return {
        values: JSON.parse(element.getAttribute('data-variable-values') ?? 'null') as unknown,
        bindings: bindings === null ? null : (JSON.parse(bindings) as unknown),
      }
    }
    const storedValues = (conversation: string, path: string): unknown =>
      JSON.parse(mockWorkspaceFile(conversation, path)?.content ?? 'null')
    const html = (result: Session) => result.current.film?.html

    /**
     * 工作区里放一份工程打开：主文件按 `clips` 写，`bind` 里的字段（片段编号 → 字段 → 中文）照编辑器的写法
     * 随语言；再放上 `files`（工作区里的路径 → 内容）。
     */
    const openTexts = async (
      clips: FilmClip[],
      files: Record<string, string> = {},
      bind: Record<string, Record<string, string>> = {},
    ) => {
      const conversation = crypto.randomUUID()
      const main = await openComposition(mainFile(clips, CANVAS))
      for (const [id, fields] of Object.entries(bind)) {
        const bindings: Record<string, string> = {}
        for (const [field, text] of Object.entries(fields)) {
          bindings[field] = `txt_${id}_${field}`
          main.declareVariable({
            id: bindings[field],
            type: 'string',
            label: '文字',
            default: text,
          })
        }
        main.setAttribute(id, 'data-locale-bindings', JSON.stringify(bindings))
      }
      const stored = putMockProjectMain(conversation, main.serialize())
      for (const [path, content] of Object.entries(files))
        putMockWorkspaceFile(conversation, path, content)
      return { conversation, ...(await open(stored, 10, conversation)) }
    }

    it('加第一种外语：有中文的文字字段随语言（根上声明变量、默认值是现在的中文，宿主记下），全是西文的固定；一步撤销，值表还在；再加一种不再改', async () => {
      const { result, conversation } = await openTexts([
        host({ id: 'zh', values: { text: '新品上市' } }),
        host({ id: 'latin', values: { text: 'NEW IN · AW26' } }),
        // 没填：用条目的默认值「示例文字」
        host({ id: 'blank', values: {} }),
      ])
      await act(async () => {
        await result.current.addLocale('en')
      })
      expect(hostIn(html(result), 'zh')).toEqual({
        values: { text: '新品上市' },
        bindings: { text: 'txt_zh_text' },
      })
      expect(hostIn(html(result), 'latin')).toEqual({
        values: { text: 'NEW IN · AW26' },
        bindings: null,
      })
      expect(hostIn(html(result), 'blank')).toEqual({
        values: {},
        bindings: { text: 'txt_blank_text' },
      })
      expect(variablesIn(html(result))).toEqual({
        txt_zh_text: '新品上市',
        txt_blank_text: '示例文字',
      })
      expect(result.current.film?.bindings).toEqual(
        new Map([
          ['zh', { text: 'txt_zh_text' }],
          ['blank', { text: 'txt_blank_text' }],
        ]),
      )
      await saveAll(result)
      expect(hostIn(mockProjectMain(conversation)?.content, 'zh')?.bindings).toEqual({
        text: 'txt_zh_text',
      })

      act(() => result.current.undo())
      expect(variablesIn(html(result))).toEqual({})
      expect(hostIn(html(result), 'zh')?.bindings).toBeNull()
      expect(result.current.film?.locales).toEqual(['en'])
      expect(result.current.film?.canUndo).toBe(false)

      act(() => result.current.redo())
      await act(async () => {
        await result.current.addLocale('de')
      })
      expect(variablesIn(html(result))).toEqual({
        txt_zh_text: '新品上市',
        txt_blank_text: '示例文字',
      })
      act(() => result.current.undo())
      expect(variablesIn(html(result))).toEqual({})
    })

    it('有外语以后新加的贴片按默认规则随语言，没有外语时加的不随语言', async () => {
      const { result } = await openTexts([video()])
      const fields = fixtureItem('fixture-fields')
      const addAt = async (values: Record<string, string>, start: number) => {
        await act(() => result.current.addItem(CANVAS, fields, values, { track: 1, start }))
        return result.current.film?.clips.find(
          (clip) => clip.kind === 'host' && clip.start === start,
        )?.id
      }
      const before = await addAt({}, 0)
      await act(async () => {
        await result.current.addLocale('en')
      })
      const chinese = await addAt({ text: '早秋新品' }, 5_000)
      const latin = await addAt({ text: 'AUTUMN LINEN' }, 10_000)
      if (before === undefined || chinese === undefined || latin === undefined)
        throw new Error('没有加上贴片')
      // 加 English 时已有的那个跟着改成随语言
      expect(hostIn(html(result), before)?.bindings).toEqual({ text: `txt_${before}_text` })
      expect(hostIn(html(result), chinese)?.bindings).toEqual({ text: `txt_${chinese}_text` })
      expect(hostIn(html(result), latin)?.bindings).toBeNull()
      expect(variablesIn(html(result))[`txt_${chinese}_text`]).toBe('早秋新品')
      // 加贴片和它的绑定是一步
      act(() => result.current.undo())
      expect(hostIn(html(result), latin)).toBeUndefined()
      act(() => result.current.undo())
      expect(hostIn(html(result), chinese)).toBeUndefined()
      expect(variablesIn(html(result))[`txt_${chinese}_text`]).toBeUndefined()
    })

    it('切换：固定 → 随语言声明变量（默认值是现在的字）、宿主记下；随语言 → 固定去掉记录、变量和所有值表里的值；各一步撤销', async () => {
      const { result, conversation } = await openTexts(
        [host({ id: 't1', values: { text: '新品上市' } })],
        { [EN_PATH]: '{"txt_t1_text": "New in"}', [DE_PATH]: '{"txt_t1_text": "Neu"}' },
        { t1: { text: '新品上市' } },
      )
      act(() => result.current.setFollowsLocale('t1', 'text', false))
      expect(hostIn(html(result), 't1')).toEqual({ values: { text: '新品上市' }, bindings: null })
      expect(variablesIn(html(result))).toEqual({})
      await saveAll(result)
      expect(storedValues(conversation, EN_PATH)).toEqual({})
      expect(storedValues(conversation, DE_PATH)).toEqual({})
      // 已经是固定的：不记一步
      act(() => result.current.setFollowsLocale('t1', 'text', false))
      act(() => result.current.undo())
      expect(hostIn(html(result), 't1')?.bindings).toEqual({ text: 'txt_t1_text' })
      await saveAll(result)
      expect(storedValues(conversation, EN_PATH)).toEqual({ txt_t1_text: 'New in' })
      expect(result.current.film?.canUndo).toBe(false)

      act(() => result.current.setFollowsLocale('t1', 'text', false))
      act(() => result.current.setFollowsLocale('t1', 'text', true))
      expect(hostIn(html(result), 't1')?.bindings).toEqual({ text: 'txt_t1_text' })
      expect(variablesIn(html(result))).toEqual({ txt_t1_text: '新品上市' })
      expect(result.current.film?.locale.values).toBeNull()
      act(() => result.current.undo())
      expect(hostIn(html(result), 't1')?.bindings).toBeNull()
      expect(variablesIn(html(result))).toEqual({})
    })

    it('中文下改随语言的字段：宿主的取值和根变量的默认值一起改，一步撤销；固定的字段只改宿主的取值', async () => {
      const { result } = await openTexts(
        [host({ id: 't1', values: { text: '新品上市' } }), host({ id: 't2', start: 2_000 })],
        { [EN_PATH]: '{}' },
        { t1: { text: '新品上市' } },
      )
      act(() => result.current.setItemText('t1', 'text', '早秋新品', 'zh'))
      expect(hostIn(html(result), 't1')?.values).toEqual({ text: '早秋新品' })
      expect(variablesIn(html(result))).toEqual({ txt_t1_text: '早秋新品' })
      // 「内容与样式」整串写进来时也一样
      act(() => result.current.setValues('t1', { text: '秋冬新品', weight: '700' }))
      expect(variablesIn(html(result))).toEqual({ txt_t1_text: '秋冬新品' })
      act(() => result.current.undo())
      act(() => result.current.undo())
      expect(hostIn(html(result), 't1')?.values).toEqual({ text: '新品上市' })
      expect(variablesIn(html(result))).toEqual({ txt_t1_text: '新品上市' })

      act(() => result.current.setItemText('t2', 'text', '固定的字', 'zh'))
      expect(hostIn(html(result), 't2')).toEqual({ values: { text: '固定的字' }, bindings: null })
      expect(variablesIn(html(result))).toEqual({ txt_t1_text: '新品上市' })
    })

    it('外语下改随语言的字段写进那种语言的值表，清空就去掉；中文原文不动；固定的字段不能改', async () => {
      const { result, conversation } = await openTexts(
        [host({ id: 't1', values: { text: '新品上市' } }), host({ id: 't2', start: 2_000 })],
        { [EN_PATH]: '{}' },
        { t1: { text: '新品上市' } },
      )
      act(() => result.current.setLocale('en'))
      act(() => result.current.setItemText('t1', 'text', 'New in', 'en'))
      expect(result.current.film?.locale.values).toEqual({ txt_t1_text: 'New in' })
      expect(hostIn(html(result), 't1')?.values).toEqual({ text: '新品上市' })
      expect(variablesIn(html(result))).toEqual({ txt_t1_text: '新品上市' })
      await saveAll(result)
      expect(storedValues(conversation, EN_PATH)).toEqual({ txt_t1_text: 'New in' })

      act(() => result.current.setItemText('t1', 'text', '', 'en'))
      expect(result.current.film?.locale.values).toEqual({})
      act(() => result.current.undo())
      expect(result.current.film?.locale.values).toEqual({ txt_t1_text: 'New in' })
      act(() => result.current.undo())
      expect(result.current.film?.canUndo).toBe(false)

      act(() => result.current.setItemText('t2', 'text', 'Fixed', 'en'))
      expect(hostIn(html(result), 't2')?.values).toEqual({})
      expect(result.current.film?.locale.values).toEqual({})
      expect(result.current.film?.canUndo).toBe(false)
    })

    it('贴片的外文也有字形：值表里贴片文字的字算进字体块', async () => {
      const catalog = {
        ...fixtureCatalog,
        cjk: {
          family: 'Noto Sans SC',
          slices: [
            { range: 'U+00e0-00ff', files: { '700': 'vendor/fonts/latin-ext-700.woff2' } },
            { range: 'U+0020-007e', files: { '700': 'vendor/fonts/latin-700.woff2' } },
          ],
        },
      }
      const conversation = crypto.randomUUID()
      const main = await openComposition(
        mainFile([host({ id: 't1', values: { text: '新品上市' } })], CANVAS),
      )
      main.declareVariable({
        id: 'txt_t1_text',
        type: 'string',
        label: '文字',
        default: '新品上市',
      })
      main.setAttribute('t1', 'data-locale-bindings', '{"text":"txt_t1_text"}')
      putMockWorkspaceFile(conversation, DE_PATH, '{}')
      const stored = putMockProjectMain(conversation, main.serialize())
      const { result } = await open(stored, 10, conversation, catalog)
      expect(html(result)).not.toContain('latin-ext-700.woff2')
      act(() => result.current.setItemText('t1', 'text', 'Grüße', 'de'))
      expect(html(result)).toContain('latin-ext-700.woff2')
    })

    it('删贴片：同一步里去掉它随语言字段的根变量和所有值表里的值；撤销都回来', async () => {
      const { result, conversation } = await openTexts(
        [host({ id: 't1', values: { text: '新品上市' } }), video({ start: 2_000 })],
        {
          [EN_PATH]: '{"txt_t1_text": "New in", "other": "x"}',
          [DE_PATH]: '{"txt_t1_text": "Neu"}',
        },
        { t1: { text: '新品上市' } },
      )
      act(() => {
        result.current.removeClips(['t1'], false)
      })
      expect(variablesIn(html(result))).toEqual({})
      await saveAll(result)
      expect(storedValues(conversation, EN_PATH)).toEqual({ other: 'x' })
      expect(storedValues(conversation, DE_PATH)).toEqual({})
      act(() => result.current.undo())
      await saveAll(result)
      expect(hostIn(html(result), 't1')?.bindings).toEqual({ text: 'txt_t1_text' })
      expect(variablesIn(html(result))).toEqual({ txt_t1_text: '新品上市' })
      expect(storedValues(conversation, EN_PATH)).toEqual({ txt_t1_text: 'New in', other: 'x' })
      expect(storedValues(conversation, DE_PATH)).toEqual({ txt_t1_text: 'Neu' })
    })

    it('切开随语言的贴片：后半段换成按自己编号取的根变量，声明和各语言的值复制一份；两半各改各的', async () => {
      const { result } = await openTexts(
        [host({ id: 't1', duration: 4_000, values: { text: '新品上市' } })],
        { [EN_PATH]: '{"txt_t1_text": "New in"}' },
        { t1: { text: '新品上市' } },
      )
      const film = result.current.film
      const clip = film?.clips.find((each) => each.id === 't1')
      if (film === null || film === undefined || clip === undefined) throw new Error('没有 t1')
      const plan = splitAt(clip, 1_500, film.clips, film.links)
      if (!('cuts' in plan)) throw new Error(`切不了：${plan.refusal}`)
      act(() => result.current.split(plan.cuts))
      const second = result.current.film?.clips.find(
        (each) => each.kind === 'host' && each.id !== 't1',
      )?.id
      if (second === undefined) throw new Error('没有后半段')
      expect(hostIn(html(result), 't1')?.bindings).toEqual({ text: 'txt_t1_text' })
      expect(hostIn(html(result), second)?.bindings).toEqual({ text: `txt_${second}_text` })
      expect(variablesIn(html(result))).toEqual({
        txt_t1_text: '新品上市',
        [`txt_${second}_text`]: '新品上市',
      })
      act(() => result.current.setLocale('en'))
      expect(result.current.film?.locale.values).toEqual({
        txt_t1_text: 'New in',
        [`txt_${second}_text`]: 'New in',
      })
      act(() => result.current.setItemText(second, 'text', 'Later', 'en'))
      expect(result.current.film?.locale.values).toEqual({
        txt_t1_text: 'New in',
        [`txt_${second}_text`]: 'Later',
      })
      // 切开是一步：撤销两次回到没切
      act(() => result.current.undo())
      act(() => result.current.undo())
      expect(variablesIn(html(result))).toEqual({ txt_t1_text: '新品上市' })
      expect(result.current.film?.locale.values).toEqual({ txt_t1_text: 'New in' })
    })
  })
})
