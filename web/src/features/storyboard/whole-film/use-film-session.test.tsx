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

const open = async (
  initial: WholeFilmDraftOut = NO_DRAFT,
  debounceMs = 10,
  conversation = CONVERSATION,
) => {
  const onNotice = vi.fn<(message: string) => void>()
  const hook = renderHook(() =>
    useFilmSession(conversation, initial, fixtureCatalog, { debounceMs, onNotice }),
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

  // 每次用一段新的对话：上一个用例收尾时的保存晚到，也改不到这一个用例存着的成片
  const openThree = () => {
    const conversation = crypto.randomUUID()
    const stored = putMockWholeFilmDraft(
      conversation,
      filmFile([
        picture({ id: 'a', duration: 2_000 }),
        picture({ id: 'b', jobId: OTHER_JOB, start: 2_000, duration: 1_000 }),
        picture({ id: 'c', start: 3_000, duration: 1_500 }),
      ]),
    )
    return open(stored, 10, conversation)
  }

  it('改几个块的起止和入点：算一步撤销，成片总长跟着变，存出的文件写着新的时间', async () => {
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
    expect(spans(result)?.slice(1)).toEqual([
      [OTHER_JOB, 2_000, 600],
      [picture().jobId, 3_400, 2_000],
    ])
    expect(result.current.film?.pictures.at(-1)).toMatchObject({ mediaStart: 400 })
    expect(result.current.film?.durationMs).toBe(5_400)
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.html).toContain('data-start="3.4" data-duration="2" data-media-start="0.4"')
    expect(saves[0]?.html).toMatch(/id="film"[^>]*data-duration="5.4"/)

    act(() => result.current.undo())
    expect(spans(result)?.slice(1)).toEqual([
      [OTHER_JOB, 2_000, 1_000],
      [picture().jobId, 3_000, 1_500],
    ])
    expect(result.current.film?.durationMs).toBe(4_500)
    expect(result.current.film?.canUndo).toBe(false)
  })

  it('删掉一个块、开着波纹编辑：后面的块往前补上，用不到的素材变量一起去掉', async () => {
    const saves = recordSaves()
    const { result } = await openThree()
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
    const { result } = await openThree()
    act(() => result.current.removeBlocks(['b'], false))
    expect(spans(result)).toEqual([
      [picture().jobId, 0, 2_000],
      [picture().jobId, 3_000, 1_500],
    ])
  })

  it('把几个块一起挪到新的起点（合拢空档）：算一步撤销，成片总长跟着变', async () => {
    const { result } = await openThree()
    act(() => result.current.removeBlocks(['b'], false))
    act(() => result.current.restart(new Map([['c', 2_000]])))
    expect(spans(result)).toEqual([
      [picture().jobId, 0, 2_000],
      [picture().jobId, 2_000, 1_500],
    ])
    expect(result.current.film?.durationMs).toBe(3_500)

    act(() => result.current.undo())
    expect(spans(result)?.at(-1)).toEqual([picture().jobId, 3_000, 1_500])
    expect(result.current.film?.durationMs).toBe(4_500)
  })

  const layout = (result: Session) =>
    result.current.film?.pictures.map((block) => [block.id, block.track, block.start, block.z])

  it('把块换到下面一行、和上面那行的块重叠：在文件里写到那个块前面，被它盖住；一步撤销', async () => {
    const saves = recordSaves()
    const { result } = await openThree()
    act(() => result.current.moveBlock('c', { track: 1, start: 500 }))
    expect(layout(result)).toEqual([
      ['c', 1, 500, 0],
      ['a', 0, 0, 0],
      ['b', 0, 2_000, 0],
    ])
    expect(result.current.film?.durationMs).toBe(3_000)
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.html).toMatch(/id="c"[^>]*data-start="0.5"[^>]*data-track-index="1"/)

    act(() => result.current.undo())
    expect(layout(result)).toEqual([
      ['a', 0, 0, 0],
      ['b', 0, 2_000, 0],
      ['c', 0, 3_000, 0],
    ])
    expect(result.current.film?.canUndo).toBe(false)
  })

  it('再把它换回上面一行、压在下面那行的块上：写到最后，盖住它', async () => {
    const { result } = await openThree()
    act(() => result.current.moveBlock('a', { track: 1, start: 0 }))
    act(() => result.current.moveBlock('c', { track: 0, start: 500 }))
    expect(layout(result)).toEqual([
      ['a', 1, 0, 0],
      ['b', 0, 2_000, 0],
      ['c', 0, 500, 0],
    ])
  })

  it('把镜头加到下面一行：写在上面那一行所有块的前面', async () => {
    const { result } = await openThree()
    await act(() =>
      result.current.addPictures(CANVAS, [piece({ duration: 1_000 })], { track: 1, start: 2_500 }),
    )
    const added = result.current.film?.pictures.find((block) => block.track === 1)
    expect(layout(result)?.map(([id]) => id)).toEqual([added?.id, 'a', 'b', 'c'])
    expect(added).toMatchObject({ start: 2_500, z: 0 })
  })

  it('下面一行的块先放在空处、再横着挪到上面那行的块底下：文件里仍在它前面，被它盖住', async () => {
    const { result } = await openThree()
    await act(() =>
      result.current.addPictures(CANVAS, [piece({ duration: 1_000 })], { track: 1, start: 6_000 }),
    )
    const added = result.current.film?.pictures.find((block) => block.track === 1)
    if (added === undefined) throw new Error('镜头没有加进去')
    act(() =>
      result.current.retime(new Map([[added.id, { start: 500, duration: 1_000, mediaStart: 0 }]])),
    )
    expect(layout(result)).toEqual([
      [added.id, 1, 500, 0],
      ['a', 0, 0, 0],
      ['b', 0, 2_000, 0],
      ['c', 0, 3_000, 0],
    ])
  })

  it('第 0 行没有块时，最上面那一行就是第一行：没给落点的镜头接在它末尾，波纹编辑补的也是它', async () => {
    const conversation = crypto.randomUUID()
    const stored = putMockWholeFilmDraft(
      conversation,
      filmFile([
        picture({ id: 'low', track: 2, duration: 5_000 }),
        picture({ id: 'a', track: 1, duration: 2_000 }),
        picture({ id: 'b', track: 1, start: 2_000, duration: 1_000 }),
      ]),
    )
    const { result } = await open(stored, 10, conversation)
    await add(result, piece({ duration: 1_500 }))
    const added = result.current.film?.pictures.find(
      (block) => !['low', 'a', 'b'].includes(block.id),
    )
    expect(added).toMatchObject({ track: 1, start: 3_000 })

    act(() => result.current.removeBlocks(['a'], true))
    expect(layout(result)).toEqual([
      ['low', 2, 0, 0],
      ['b', 1, 0, 0],
      [added?.id, 1, 1_000, 0],
    ])
  })

  const hiddenIds = (result: Session) =>
    result.current.film?.pictures.filter((block) => block.hidden).map((block) => block.id)

  it('把几个块一起隐藏：算一步撤销，存出的文件带着隐藏标记，成片总长不变；再显示回来标记去掉', async () => {
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

  it('隐藏标记跟着块走，不跟着行：放进隐藏着的行的镜头照常显示，隐藏的块换到别的行仍然隐藏', async () => {
    const { result } = await openThree()
    act(() => result.current.moveBlock('c', { track: 1, start: 0 }))
    act(() => result.current.setHidden(['c'], true))
    await act(() =>
      result.current.addPictures(CANVAS, [piece({ duration: 1_000 })], { track: 1, start: 5_000 }),
    )
    const added = result.current.film?.pictures.find((block) => block.start === 5_000)
    expect(added?.hidden).toBe(false)

    act(() => result.current.moveBlock('a', { track: 1, start: 2_000 }))
    expect(hiddenIds(result)).toEqual(['c'])
    act(() => result.current.moveBlock('c', { track: 0, start: 3_000 }))
    expect(hiddenIds(result)).toEqual(['c'])
  })

  it('把块搬进最上面新开的一行：别的块换成新的行号，它写在最后盖住它们；一步撤销', async () => {
    const saves = recordSaves()
    const { result } = await openThree()
    act(() =>
      result.current.moveBlock(
        'c',
        { track: 0, start: 500 },
        new Map([
          ['a', 1],
          ['b', 1],
        ]),
      ),
    )
    expect(layout(result)).toEqual([
      ['a', 1, 0, 0],
      ['b', 1, 2_000, 0],
      ['c', 0, 500, 0],
    ])
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.html).toMatch(/id="a"[^>]*data-track-index="1"/)
    expect(saves[0]?.html).toMatch(/id="c"[^>]*data-start="0.5"[^>]*data-track-index="0"/)

    act(() => result.current.undo())
    expect(layout(result)).toEqual([
      ['a', 0, 0, 0],
      ['b', 0, 2_000, 0],
      ['c', 0, 3_000, 0],
    ])
    expect(result.current.film?.canUndo).toBe(false)
  })

  it('成组挪动、被抓的块搬进最上面新开的一行：跟着的块留在原来那一行（行号跟着改）只挪时间；一步撤销', async () => {
    const saves = recordSaves()
    const { result } = await openThree()
    act(() =>
      result.current.moveBlock(
        'b',
        { track: 0, start: 2_500 },
        new Map([
          ['a', 1],
          ['c', 1],
        ]),
        new Map([['a', 500]]),
      ),
    )
    expect(layout(result)).toEqual([
      ['a', 1, 500, 0],
      ['c', 1, 3_000, 0],
      ['b', 0, 2_500, 0],
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

  it('成组挪动、被抓的块换到已有的另一行：跟着的块只挪时间；一步撤销', async () => {
    const conversation = crypto.randomUUID()
    const stored = putMockWholeFilmDraft(
      conversation,
      filmFile([
        picture({ id: 'z', start: 1_500, duration: 1_000, track: 1 }),
        picture({ id: 'x', duration: 1_000 }),
        picture({ id: 'y', start: 3_000, duration: 1_000 }),
      ]),
    )
    const { result } = await open(stored, 10, conversation)
    act(() =>
      result.current.moveBlock('z', { track: 0, start: 1_700 }, undefined, new Map([['x', 200]])),
    )
    expect(layout(result)).toEqual([
      ['x', 0, 200, 0],
      ['y', 0, 3_000, 0],
      ['z', 0, 1_700, 0],
    ])

    act(() => result.current.undo())
    expect(layout(result)).toEqual([
      ['z', 1, 1_500, 0],
      ['x', 0, 0, 0],
      ['y', 0, 3_000, 0],
    ])
    expect(result.current.film?.canUndo).toBe(false)
  })

  it('把镜头加进两行之间新开的一行：下面的行往后排一号，新块写在上面那一行的块前面', async () => {
    const conversation = crypto.randomUUID()
    const stored = putMockWholeFilmDraft(
      conversation,
      filmFile([
        picture({ id: 'low', track: 1, duration: 5_000 }),
        picture({ id: 'a', duration: 2_000 }),
      ]),
    )
    const { result } = await open(stored, 10, conversation)
    await act(() =>
      result.current.addPictures(
        CANVAS,
        [piece({ duration: 1_000 })],
        { track: 1, start: 500 },
        new Map([['low', 2]]),
      ),
    )
    const added = result.current.film?.pictures.find((block) => block.track === 1)
    expect(layout(result)).toEqual([
      ['low', 2, 0, 0],
      [added?.id, 1, 500, 0],
      ['a', 0, 0, 0],
    ])

    act(() => result.current.undo())
    expect(layout(result)).toEqual([
      ['low', 1, 0, 0],
      ['a', 0, 0, 0],
    ])
  })

  it('把块全删掉：成片还在，只是没有画面', async () => {
    const { result } = await openThree()
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
