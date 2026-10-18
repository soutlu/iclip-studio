import { describe, expect, it } from 'vitest'
import { card, draftOf, expectOk, spans, video } from '@/testing/whole-film'
import { addEndCard, replaceEndCardComponent } from './end-cards'
import { filmDuration } from './timeline'

const film = () => draftOf([video('v1', 's1', 0, 3_000), video('v2', 's1', 0, 2_000)])

const brandFields = { wordmark: 'name', tagline: 'slogan' } as const

describe('addEndCard', () => {
  it('片头放最前、片尾放最后，默认 2 秒，视频段跟着后移', () => {
    const intro = expectOk(
      addEndCard(film(), {
        role: 'intro',
        component: 'logo-sting',
        variables: { wordmark: '拾步' },
      }),
    ).draft
    const both = expectOk(
      addEndCard(intro, { role: 'outro', component: 'cta-close', variables: {} }),
    ).draft
    expect(spans(both)).toEqual([
      ['c1', 0, 2_000],
      ['v1', 2_000, 5_000],
      ['v2', 5_000, 7_000],
      ['c2', 7_000, 9_000],
    ])
    expect(both.layer0[0]).toMatchObject({
      type: 'component',
      role: 'intro',
      component: 'logo-sting',
      variables: { wordmark: '拾步' },
    })
  })

  it('各至多一个', () => {
    const withIntro = draftOf([card('c1', 'intro', 2_000), video('v1', 's1', 0, 1_000)])
    expect(addEndCard(withIntro, { role: 'intro', component: 'x', variables: {} })).toEqual({
      ok: false,
      refusal: 'end-card-exists',
    })
  })

  it('剩余时长不足 2 秒时缩到剩余时长，不足 0.1 秒不能加', () => {
    const almostFull = draftOf([video('v1', 'big', 0, 119_500)])
    const { draft } = expectOk(
      addEndCard(almostFull, { role: 'outro', component: 'x', variables: {} }),
    )
    expect(spans(draft).at(-1)).toEqual(['c1', 119_500, 120_000])
    const full = draftOf([video('v1', 'big', 0, 119_950)])
    expect(addEndCard(full, { role: 'outro', component: 'x', variables: {} })).toEqual({
      ok: false,
      refusal: 'film-too-long',
    })
    expect(
      addEndCard(film(), { role: 'intro', component: 'x', variables: {}, durationMs: 99 }),
    ).toEqual({ ok: false, refusal: 'too-short' })
  })

  it('指定时长', () => {
    const { draft } = expectOk(
      addEndCard(film(), { role: 'intro', component: 'x', variables: {}, durationMs: 3_500 }),
    )
    expect(filmDuration(draft)).toBe(8_500)
  })
})

describe('replaceEndCardComponent', () => {
  const withIntro = (variables: Record<string, string>) =>
    draftOf([card('c1', 'intro', 3_000, variables), video('v1', 's1', 0, 1_000)], {
      transitions: [
        { id: 't1', afterClipId: 'c1', component: 'fade', duration: 500, variables: {} },
      ],
    })

  it('换样式：时长与转场不变，品牌名沿用这一端已经填的值（用户改过的也带过去）', () => {
    const { draft } = expectOk(
      replaceEndCardComponent(withIntro({ wordmark: '拾步鞋履', accent: 'green' }), {
        role: 'intro',
        component: 'titlecard-lockup',
        variables: { wordmark: '拾步', tagline: '走一整天也不累', size: 64 },
        brandFields,
      }),
    )
    expect(draft.layer0[0]).toMatchObject({
      id: 'c1',
      duration: 3_000,
      component: 'titlecard-lockup',
      variables: { wordmark: '拾步鞋履', tagline: '走一整天也不累', size: 64 },
    })
    expect(draft.transitions).toHaveLength(1)
  })

  it('原组件没有的品牌项取新组件的默认值', () => {
    const { draft } = expectOk(
      replaceEndCardComponent(withIntro({ accent: 'green' }), {
        role: 'intro',
        component: 'titlecard-lockup',
        variables: { wordmark: '拾步' },
        brandFields,
      }),
    )
    expect(draft.layer0[0]).toMatchObject({ variables: { wordmark: '拾步' } })
  })

  it('同一个组件原样返回；这一端没有片头片尾时拒绝', () => {
    const before = withIntro({ wordmark: '拾步' })
    expect(
      expectOk(
        replaceEndCardComponent(before, {
          role: 'intro',
          component: 'intro-card',
          variables: {},
          brandFields,
        }),
      ).draft,
    ).toBe(before)
    expect(
      replaceEndCardComponent(before, {
        role: 'outro',
        component: 'x',
        variables: {},
        brandFields,
      }),
    ).toEqual({ ok: false, refusal: 'unknown-clip' })
  })
})
