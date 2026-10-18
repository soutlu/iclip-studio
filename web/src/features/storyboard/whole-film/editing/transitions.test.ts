import { describe, expect, it } from 'vitest'
import { card, contextOf, draftOf, expectOk, FADE, video } from '@/testing/whole-film'
import { removeTransition, setTransition } from './transitions'
import { cutsOf } from './timeline'

/** 片头 0–2000、v1 2000–5000、v2 5000–5800、片尾 5800–7300 */
const film = () =>
  draftOf([
    card('c1', 'intro', 2_000),
    video('v1', 's1', 0, 3_000),
    video('v2', 's1', 0, 800),
    card('c2', 'outro', 1_500),
  ])

const context = contextOf(
  {},
  {},
  {
    fade: FADE,
    wipe: { cutAt: 0, durationMs: 300 },
    long: { cutAt: 0.5, durationMs: 2_000 },
    tail: { cutAt: 0, durationMs: 800 },
    tailTooLong: { cutAt: 0, durationMs: 801 },
  },
)

const put = (afterClipId: string, component = 'fade') => ({
  afterClipId,
  component,
  variables: { tone: 'soft' },
})

describe('setTransition', () => {
  it('挂在切点前一段上，时长取组件原定的时长；片头结束也是切点', () => {
    const { draft } = expectOk(setTransition(film(), put('c1'), context))
    expect(draft.transitions).toEqual([
      {
        id: 't1',
        afterClipId: 'c1',
        component: 'fade',
        duration: 500,
        variables: { tone: 'soft' },
      },
    ])
    expect(cutsOf(draft).map((c) => [c.timeMs, c.transition?.id ?? null])).toEqual([
      [2_000, 't1'],
      [5_000, null],
      [5_800, null],
    ])
  })

  it('同一个切点再放就替换，id 不变、时长换成新组件的', () => {
    const once = expectOk(setTransition(film(), put('v1'), context)).draft
    const twice = expectOk(setTransition(once, put('v1', 'wipe'), context)).draft
    expect(twice.transitions).toEqual([
      {
        id: 't1',
        afterClipId: 'v1',
        component: 'wipe',
        duration: 300,
        variables: { tone: 'soft' },
      },
    ])
  })

  it.each([
    ['切点在正中，后一段不够长', 'long', false],
    ['从切点开始、正好铺满后一段', 'tail', true],
    ['从切点开始、比后一段长 1 毫秒', 'tailTooLong', false],
  ])('转场要落在切点前后两段之内：%s', (_, component, fits) => {
    const result = setTransition(film(), put('v1', component), context)
    expect(result.ok ? 'ok' : result.refusal).toBe(fits ? 'ok' : 'transition-does-not-fit')
  })

  it('最后一段后面没有切点；不认识的段、目录里没有的组件拒绝', () => {
    expect(setTransition(film(), put('c2'), context)).toEqual({ ok: false, refusal: 'not-a-cut' })
    expect(setTransition(film(), put('x'), context)).toEqual({ ok: false, refusal: 'unknown-clip' })
    expect(setTransition(film(), put('v1', 'nope'), context)).toEqual({
      ok: false,
      refusal: 'unknown-component',
    })
  })
})

describe('removeTransition', () => {
  it('删掉转场；不认识的拒绝', () => {
    const { draft } = expectOk(setTransition(film(), put('v1'), context))
    expect(expectOk(removeTransition(draft, { transitionId: 't1' })).draft.transitions).toEqual([])
    expect(removeTransition(draft, { transitionId: 'x' })).toEqual({
      ok: false,
      refusal: 'unknown-clip',
    })
  })
})
