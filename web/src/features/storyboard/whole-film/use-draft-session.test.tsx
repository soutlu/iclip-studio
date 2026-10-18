import { act, renderHook, waitFor } from '@testing-library/react'
import { delay, http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import type {
  WholeFilmDocument,
  WholeFilmDraftIn,
  WholeFilmDraftOut,
} from '@/shared/api/generated/types.gen'
import { server } from '@/testing/mocks/server'
import { mockWholeFilmDraft, putMockWholeFilmDraft } from '@/testing/mocks/whole-film'
import { draftOf, video } from '@/testing/whole-film'
import { setClipVolume } from './editing/layer0'
import { REFUSAL_TEXT } from './refusal-text'
import { useDraftSession } from './use-draft-session'

const CONVERSATION = '6b0f3a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'
const SOURCE = '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9'
const ENDPOINT = '*/api/conversations/:conversationId/whole-film/draft'

const film = (): WholeFilmDocument => draftOf([video('v1', SOURCE, 0, 2_000)])

/** 记下每次保存的请求体，再交给默认的 mock 处理 */
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

const NO_DRAFT: WholeFilmDraftOut = { revision: 0, document: null, updatedAt: null }

const open = (initial: WholeFilmDraftOut = NO_DRAFT, debounceMs = 10) => {
  const onNotice = vi.fn<(message: string) => void>()
  const hook = renderHook(() => useDraftSession(CONVERSATION, initial, { debounceMs, onNotice }))
  return { ...hook, onNotice }
}

type Session = ReturnType<typeof open>['result']

const volume = (result: Session, value: number) => {
  act(() => {
    result.current.apply(setClipVolume(result.current.draft, { clipId: 'v1', volume: value }))
  })
}

/** 改过草稿的用例都等保存落定，免得卸载时补存的那一下落进下一个用例 */
const settled = (result: Session) => waitFor(() => expect(result.current.save.kind).toBe('idle'))

describe('useDraftSession', () => {
  it('还没有草稿时从空草稿开始，打开不保存', async () => {
    const saves = recordSaves()
    const { result } = open()
    expect(result.current.draft.layer0).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(saves).toEqual([])
  })

  it('停下后整份保存，下一次带上一次答复的版本号；撤销也会保存', async () => {
    const saves = recordSaves()
    const { result } = open(putMockWholeFilmDraft(CONVERSATION, film()))
    volume(result, 0.5)
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]).toMatchObject({ revision: 1 })
    expect(saves[0]?.document.layer0[0]).toMatchObject({ volume: 0.5 })
    await settled(result)
    act(() => result.current.undo())
    await waitFor(() => expect(saves).toHaveLength(2))
    expect(saves[1]).toMatchObject({ revision: 2 })
    expect(saves[1]?.document.layer0[0]).toMatchObject({ volume: 1 })
    await waitFor(() => expect(mockWholeFilmDraft(CONVERSATION)?.revision).toBe(3))
    await settled(result)
  })

  it('同一时刻只有一次保存在途，回来后再存最新的一版', async () => {
    const saves = recordSaves(80)
    const { result } = open(putMockWholeFilmDraft(CONVERSATION, film()))
    volume(result, 0.5)
    await waitFor(() => expect(saves).toHaveLength(1))
    volume(result, 0.2)
    volume(result, 0.3)
    await waitFor(() => expect(saves).toHaveLength(2))
    expect(saves[1]).toMatchObject({ revision: 2 })
    expect(saves[1]?.document.layer0[0]).toMatchObject({ volume: 0.3 })
    await settled(result)
    expect(saves).toHaveLength(2)
  })

  it('别处已存过更新的一版：换成那一版、清空历史，并告诉用户', async () => {
    const stored = putMockWholeFilmDraft(CONVERSATION, film())
    const newer = draftOf([video('v1', SOURCE, 500, 3_000)])
    putMockWholeFilmDraft(CONVERSATION, newer)
    const { result, onNotice } = open(stored)
    volume(result, 0.5)
    await waitFor(() => expect(result.current.draft).toEqual(newer))
    expect(result.current.canUndo).toBe(false)
    expect(onNotice).toHaveBeenCalledWith(
      '整片草稿已在别处改过，已换成最新的一版；刚才没保存的改动已放弃',
    )
    await settled(result)
    expect(mockWholeFilmDraft(CONVERSATION)?.revision).toBe(2)
  })

  it('保存失败时说明原因，下次改动再存', async () => {
    server.use(
      http.put(ENDPOINT, () => HttpResponse.json({ detail: '服务暂时不可用' }, { status: 503 }), {
        once: true,
      }),
    )
    const { result } = open(putMockWholeFilmDraft(CONVERSATION, film()))
    volume(result, 0.5)
    await waitFor(() =>
      expect(result.current.save).toEqual({
        kind: 'failed',
        message: '整片草稿保存失败：服务暂时不可用',
      }),
    )
    volume(result, 0.6)
    await waitFor(() => expect(mockWholeFilmDraft(CONVERSATION)?.revision).toBe(2))
    await settled(result)
  })

  it('被拒的编辑不进历史，用一句话说明', () => {
    const { result, onNotice } = open()
    act(() => {
      result.current.apply({ ok: false, refusal: 'too-many-clips' })
    })
    expect(result.current.canUndo).toBe(false)
    expect(onNotice).toHaveBeenCalledWith(REFUSAL_TEXT['too-many-clips'])
  })

  it('关掉时还有没存的改动就立刻存', async () => {
    const { result, unmount } = open(putMockWholeFilmDraft(CONVERSATION, film()), 60_000)
    volume(result, 0.4)
    unmount()
    await waitFor(() => expect(mockWholeFilmDraft(CONVERSATION)?.revision).toBe(2))
    expect(mockWholeFilmDraft(CONVERSATION)?.document.layer0[0]).toMatchObject({ volume: 0.4 })
  })
})
