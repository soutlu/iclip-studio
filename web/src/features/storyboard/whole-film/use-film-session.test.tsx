import { act, renderHook, waitFor } from '@testing-library/react'
import { delay, http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import type { WholeFilmDraftIn, WholeFilmDraftOut } from '@/shared/api/generated/types.gen'
import { server } from '@/testing/mocks/server'
import { mockWholeFilmDraft, putMockWholeFilmDraft } from '@/testing/mocks/whole-film'
import { filmFile, fixtureCatalog, picture } from '@/testing/whole-film'
import { MAX_FILM_MS } from './composition/film'
import { FILM_LIMIT_TEXT, useFilmSession, type NewPicture } from './use-film-session'

const CONVERSATION = '6b0f3a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'
const OTHER_JOB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const ENDPOINT = '*/api/conversations/:conversationId/whole-film/draft'
const CANVAS = { width: 720, height: 1280 }

const recordSaves = (slow = 0) => {
  const saves: WholeFilmDraftIn[] = []
  server.use(
    http.put(ENDPOINT, async ({ request }) => {
      saves.push((await request.clone().json()) as WholeFilmDraftIn)
      if (slow > 0) await delay(slow)
      return undefined
    }),
  )
  return saves
}

const NO_DRAFT: WholeFilmDraftOut = { revision: 0, html: null, updatedAt: null }

const open = async (initial: WholeFilmDraftOut = NO_DRAFT, debounceMs = 10) => {
  const onNotice = vi.fn<(message: string) => void>()
  const hook = renderHook(() =>
    useFilmSession(CONVERSATION, initial, fixtureCatalog, { debounceMs, onNotice }),
  )
  await waitFor(() => expect(hook.result.current.opening).toBe(false))
  return { ...hook, onNotice }
}

type Session = Awaited<ReturnType<typeof open>>['result']

const piece = (overrides: Partial<NewPicture> = {}): NewPicture => ({
  label: 'A · 镜头 1',
  jobId: picture().jobId,
  src: picture().src,
  mediaStart: 0,
  duration: 2_000,
  ...overrides,
})

const add = (result: Session, ...pictures: NewPicture[]) =>
  act(() => result.current.addPictures(CANVAS, pictures))

const spans = (result: Session) =>
  result.current.film?.pictures.map((block) => [block.jobId, block.start, block.duration])

const settled = (result: Session) => waitFor(() => expect(result.current.save.kind).toBe('idle'))

describe('useFilmSession', () => {
  it('还没有成片时没有文件，打开不保存', async () => {
    const saves = recordSaves()
    const { result } = await open()
    expect(result.current.film).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(saves).toEqual([])
  })

  it('打开存着的成片：读出画面块和画幅，不改就不保存', async () => {
    const saves = recordSaves()
    const second = picture({ id: 'clip-2', jobId: OTHER_JOB, start: 2_000, mediaStart: 500 })
    const stored = putMockWholeFilmDraft(CONVERSATION, filmFile([picture(), second], CANVAS))
    const { result } = await open(stored)
    expect(result.current.film).toMatchObject({
      canvas: CANVAS,
      pictures: [picture(), second],
      durationMs: 4_000,
      canUndo: false,
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(saves).toEqual([])
  })

  it('第一次加素材时按画幅建一份成片，素材接在末尾；停下后整份保存', async () => {
    const saves = recordSaves()
    const { result } = await open()
    await add(result, piece(), piece({ mediaStart: 3_000, duration: 1_500 }))
    expect(spans(result)).toEqual([
      [picture().jobId, 0, 2_000],
      [picture().jobId, 2_000, 1_500],
    ])
    expect(result.current.film).toMatchObject({ canvas: CANVAS, durationMs: 3_500 })
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.revision).toBe(0)
    expect(saves[0]?.html).toContain('data-duration="3.5"')
    expect(saves[0]?.html.match(/&quot;id&quot;:&quot;src-/g)).toHaveLength(1)
    await settled(result)

    await add(result, piece({ jobId: OTHER_JOB, src: 'https://media.test/videos/b.mp4' }))
    expect(spans(result)?.at(-1)).toEqual([OTHER_JOB, 3_500, 2_000])
    await waitFor(() => expect(saves).toHaveLength(2))
    expect(saves[1]?.revision).toBe(1)
    await settled(result)
    expect(mockWholeFilmDraft(CONVERSATION)?.revision).toBe(2)
  })

  it('撤销退回加之前的样子，重做再加回来，两次都会保存', async () => {
    const saves = recordSaves()
    const { result } = await open(
      putMockWholeFilmDraft(CONVERSATION, filmFile([picture()], CANVAS)),
    )
    await add(result, piece({ mediaStart: 3_000 }))
    await waitFor(() => expect(saves).toHaveLength(1))
    await settled(result)
    expect(result.current.film?.canUndo).toBe(true)

    act(() => result.current.undo())
    expect(spans(result)).toEqual([[picture().jobId, 0, 2_000]])
    expect(result.current.film).toMatchObject({ durationMs: 2_000, canRedo: true })
    await waitFor(() => expect(saves).toHaveLength(2))
    await settled(result)

    act(() => result.current.redo())
    expect(spans(result)).toHaveLength(2)
    await waitFor(() => expect(saves).toHaveLength(3))
    await settled(result)
  })

  it('指定了落点：从那一行的那个时间放起，几段一段接一段；成片总长跟着变', async () => {
    const saves = recordSaves()
    const { result } = await open({
      revision: 1,
      html: filmFile([picture({ duration: 2_000 })]),
      updatedAt: null,
    })
    await act(() =>
      result.current.addPictures(
        CANVAS,
        [piece({ jobId: OTHER_JOB, duration: 1_000 }), piece({ jobId: OTHER_JOB, duration: 500 })],
        { track: 0, start: 4_000 },
      ),
    )
    expect(spans(result)).toEqual([
      [picture().jobId, 0, 2_000],
      [OTHER_JOB, 4_000, 1_000],
      [OTHER_JOB, 5_000, 500],
    ])
    expect(result.current.film?.durationMs).toBe(5_500)
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.html).toContain('data-duration="5.5"')
  })

  const threeBlocks = () =>
    putMockWholeFilmDraft(
      CONVERSATION,
      filmFile([
        picture({ id: 'a', duration: 2_000 }),
        picture({ id: 'b', jobId: OTHER_JOB, start: 2_000, duration: 1_000 }),
        picture({ id: 'c', start: 3_000, duration: 1_500 }),
      ]),
    )

  it('改一个块的起止和入点：一步撤销，成片总长跟着变，存出的文件写着新的时间', async () => {
    const saves = recordSaves()
    const { result } = await open(threeBlocks())
    act(() => result.current.retime('c', { start: 3_400, duration: 2_000, mediaStart: 400 }))
    expect(result.current.film?.pictures.at(-1)).toMatchObject({
      start: 3_400,
      duration: 2_000,
      mediaStart: 400,
    })
    expect(result.current.film?.durationMs).toBe(5_400)
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.html).toContain('data-start="3.4" data-duration="2" data-media-start="0.4"')
    expect(saves[0]?.html).toMatch(/id="film"[^>]*data-duration="5.4"/)

    act(() => result.current.undo())
    expect(spans(result)?.at(-1)).toEqual([picture().jobId, 3_000, 1_500])
    expect(result.current.film?.durationMs).toBe(4_500)
    expect(result.current.film?.canUndo).toBe(false)
  })

  it('删掉一个块、开着波纹编辑：后面的块往前补上，用不到的素材变量一起去掉', async () => {
    const saves = recordSaves()
    const { result } = await open(threeBlocks())
    act(() => result.current.removeBlocks(['b'], true))
    expect(spans(result)).toEqual([
      [picture().jobId, 0, 2_000],
      [picture().jobId, 2_000, 1_500],
    ])
    expect(result.current.film?.durationMs).toBe(3_500)
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.html).not.toContain(OTHER_JOB)

    act(() => result.current.undo())
    expect(spans(result)).toHaveLength(3)
    expect(result.current.film?.html).toContain(`src-${OTHER_JOB}`)
  })

  it('删掉一个块、关着波纹编辑：留下空档', async () => {
    const { result } = await open(threeBlocks())
    act(() => result.current.removeBlocks(['b'], false))
    expect(spans(result)).toEqual([
      [picture().jobId, 0, 2_000],
      [picture().jobId, 3_000, 1_500],
    ])
  })

  it('把块全删掉：成片还在，只是没有画面', async () => {
    const { result } = await open(threeBlocks())
    act(() => result.current.removeBlocks(['a', 'b', 'c'], true))
    expect(spans(result)).toEqual([])
    expect(result.current.film?.durationMs).toBe(0)
    expect(result.current.film?.html).not.toContain('data-composition-variables')
  })

  it('加进去会超过两分钟：不动成片，并告诉用户', async () => {
    const saves = recordSaves()
    const { result, onNotice } = await open()
    await add(result, piece({ duration: MAX_FILM_MS - 1_000 }))
    await waitFor(() => expect(saves).toHaveLength(1))
    await settled(result)
    await add(result, piece({ duration: 1_001 }))
    expect(spans(result)).toHaveLength(1)
    expect(onNotice).toHaveBeenCalledWith(FILM_LIMIT_TEXT)
    await add(result, piece({ duration: 1_000 }))
    expect(spans(result)).toHaveLength(2)
    await waitFor(() => expect(saves).toHaveLength(2))
    await settled(result)
  })

  it('还没有成片时连着加两次：只建一份成片，两次加的都在', async () => {
    const saves = recordSaves()
    const { result } = await open()
    await act(async () => {
      await Promise.all([
        result.current.addPictures(CANVAS, [piece()]),
        result.current.addPictures(CANVAS, [piece({ mediaStart: 3_000 })]),
      ])
    })
    expect(spans(result)).toEqual([
      [picture().jobId, 0, 2_000],
      [picture().jobId, 2_000, 2_000],
    ])
    await waitFor(() => expect(saves.at(-1)?.html.match(/<video /g)).toHaveLength(2))
    await settled(result)
  })

  it('同一时刻只有一次保存在途，回来后再存最新的一版', async () => {
    const saves = recordSaves(80)
    const { result } = await open()
    await add(result, piece())
    await waitFor(() => expect(saves).toHaveLength(1))
    await add(result, piece({ mediaStart: 2_000 }))
    await add(result, piece({ mediaStart: 4_000 }))
    await waitFor(() => expect(saves).toHaveLength(2))
    expect(saves[1]?.revision).toBe(1)
    expect(saves[1]?.html.match(/<video /g)).toHaveLength(3)
    await settled(result)
    expect(saves).toHaveLength(2)
  })

  it('别处已存过更新的一版：换成那一版、清空历史，并告诉用户', async () => {
    const stored = putMockWholeFilmDraft(CONVERSATION, filmFile([picture()], CANVAS))
    const newer = picture({ mediaStart: 500, duration: 3_000 })
    putMockWholeFilmDraft(CONVERSATION, filmFile([newer], CANVAS))
    const { result, onNotice } = await open(stored)
    await add(result, piece({ mediaStart: 6_000 }))
    await waitFor(() => expect(result.current.film?.pictures).toEqual([newer]))
    expect(result.current.film?.canUndo).toBe(false)
    expect(onNotice).toHaveBeenCalledWith(
      '成片草稿已在别处改过，已换成最新的一版；刚才没保存的改动已放弃',
    )
    await settled(result)
    expect(mockWholeFilmDraft(CONVERSATION)?.revision).toBe(2)
  })

  it('保存失败时说明原因，重新保存后恢复', async () => {
    server.use(
      http.put(ENDPOINT, () => HttpResponse.json({ detail: '渲染服务连不上' }, { status: 502 }), {
        once: true,
      }),
    )
    const { result } = await open()
    await add(result, piece())
    await waitFor(() =>
      expect(result.current.save).toEqual({
        kind: 'failed',
        message: '成片草稿保存失败：渲染服务连不上',
      }),
    )
    act(() => result.current.flush())
    await settled(result)
    expect(mockWholeFilmDraft(CONVERSATION)?.revision).toBe(1)
  })

  it('settle 先把没存的存完，答复存着的版本号', async () => {
    const { result } = await open(undefined, 60_000)
    await add(result, piece())
    let revision: number | undefined
    await act(async () => {
      revision = await result.current.settle()
    })
    expect(revision).toBe(1)
    expect(mockWholeFilmDraft(CONVERSATION)?.html).toBe(result.current.film?.html)
  })
})
