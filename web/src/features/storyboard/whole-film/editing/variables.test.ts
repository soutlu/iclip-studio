import { expect, it } from 'vitest'
import { card, draftOf, expectOk, overlay, video } from '@/testing/whole-film'
import { setComponentVariables } from './variables'

const film = () =>
  draftOf([card('c1', 2_000, { variables: { wordmark: '拾步' } }), video('v1', 's1', 0, 1_000)], {
    overlays: [overlay('o1', 0, 500)],
  })

it('改组件段、特效块的可填项；视频段没有可填项', () => {
  const segment = expectOk(
    setComponentVariables(film(), { id: 'c1', variables: { wordmark: '拾步鞋履' } }),
  )
  expect(segment.draft.layer0[0]).toMatchObject({ variables: { wordmark: '拾步鞋履' } })
  const block = expectOk(setComponentVariables(film(), { id: 'o1', variables: { tone: 'dark' } }))
  expect(block.draft.overlays[0]?.variables).toEqual({ tone: 'dark' })
  expect(setComponentVariables(film(), { id: 'v1', variables: {} })).toEqual({
    ok: false,
    refusal: 'unknown-clip',
  })
})
