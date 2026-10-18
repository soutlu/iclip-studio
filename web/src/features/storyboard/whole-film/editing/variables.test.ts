import { expect, it } from 'vitest'
import { card, draftOf, expectOk, video } from '@/testing/whole-film'
import { setComponentVariables } from './variables'

const film = () =>
  draftOf([card('c1', 'intro', 2_000, { wordmark: '拾步' }), video('v1', 's1', 0, 1_000)], {
    transitions: [{ id: 't1', afterClipId: 'c1', component: 'fade', duration: 500, variables: {} }],
  })

it('改片头、转场的可填项；视频段没有可填项', () => {
  const intro = expectOk(
    setComponentVariables(film(), { id: 'c1', variables: { wordmark: '拾步鞋履' } }),
  )
  expect(intro.draft.layer0[0]).toMatchObject({ variables: { wordmark: '拾步鞋履' } })
  const transition = expectOk(
    setComponentVariables(film(), { id: 't1', variables: { tone: 'dark' } }),
  )
  expect(transition.draft.transitions[0]?.variables).toEqual({ tone: 'dark' })
  expect(setComponentVariables(film(), { id: 'v1', variables: {} })).toEqual({
    ok: false,
    refusal: 'unknown-clip',
  })
})
