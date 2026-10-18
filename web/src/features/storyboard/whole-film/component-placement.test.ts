import { describe, expect, it } from 'vitest'
import { card, contextOf, draftOf, expectOk, source, video } from '@/testing/whole-film'
import catalogJson from './catalog/catalog.json'
import { itemOf, transitionSpecs, type ComponentCatalog } from './component-catalog'
import { placeComponent, type Placing } from './component-placement'
import type { WholeFilmDraft } from './editing/draft'

const catalog = catalogJson as ComponentCatalog
const item = (name: string) => {
  const found = itemOf(catalog, name)
  if (found === undefined) throw new Error(`目录里没有 ${name}`)
  return found
}

const context = { ...contextOf({ s1: source(20_000) }), transitions: transitionSpecs(catalog) }
const env = { context }

/** v1 0–3000、v2 3000–5000 */
const film = (): WholeFilmDraft =>
  draftOf([video('v1', 's1', 0, 3_000), video('v2', 's1', 0, 2_000)])

const click = (playheadMs = 0, cutAfterClipId?: string): Placing => ({
  via: 'click',
  playheadMs,
  cutAfterClipId,
})

describe('placeComponent', () => {
  it('片头放最前，2 秒，可填项不写进草稿（取组件默认值）', () => {
    const { draft } = expectOk(placeComponent(film(), item('logo-sting'), click(), env))
    expect(draft.layer0[0]).toMatchObject({
      type: 'component',
      role: 'intro',
      component: 'logo-sting',
      duration: 2_000,
    })
    expect(draft.layer0[0]).toHaveProperty('variables', {})
  })

  it('那一端已有片尾就换组件：时长不变，原来填的可填项不带过去', () => {
    const withOutro = draftOf([
      video('v1', 's1', 0, 3_000),
      card('c1', 'outro', 3_500, { wordmark: '改过的名字' }),
    ])
    const { draft } = expectOk(placeComponent(withOutro, item('logo-brand-close'), click(), env))
    expect(draft.layer0[1]).toMatchObject({ component: 'logo-brand-close', duration: 3_500 })
    expect(draft.layer0[1]).toHaveProperty('variables', {})
  })

  it('点转场卡片放到选中那一段后面的切点，时长取组件原定的', () => {
    const { draft } = expectOk(placeComponent(film(), item('fade-through'), click(0, 'v1'), env))
    expect(draft.transitions).toEqual([
      { id: 't1', afterClipId: 'v1', component: 'fade-through', duration: 900, variables: {} },
    ])
  })

  it('点转场卡片、什么都没选：放到离播放头最近的切点', () => {
    const three = draftOf([
      video('v1', 's1', 0, 3_000),
      video('v2', 's1', 0, 2_000),
      video('v3', 's1', 0, 2_000),
    ])
    const { draft } = expectOk(placeComponent(three, item('fade-through'), click(4_600), env))
    expect(draft.transitions[0]?.afterClipId).toBe('v2')
  })

  it('点转场卡片：选中最后一段、成片里没有切点，都拒绝', () => {
    expect(placeComponent(film(), item('fade-through'), click(0, 'v2'), env)).toEqual({
      ok: false,
      refusal: 'not-a-cut',
    })
    const single = draftOf([video('v1', 's1', 0, 3_000)])
    expect(placeComponent(single, item('fade-through'), click(0, 'v1'), env)).toEqual({
      ok: false,
      refusal: 'no-cut',
    })
  })

  it('拖转场到画面轨：放到离松手处最近的切点；切点两边放不下时拒绝', () => {
    const three = draftOf([
      video('v1', 's1', 0, 3_000),
      video('v2', 's1', 0, 2_000),
      video('v3', 's1', 0, 300),
    ])
    const near = expectOk(
      placeComponent(
        three,
        item('fade-through'),
        { via: 'drop', lane: 'film', timeMs: 2_600 },
        env,
      ),
    )
    expect(near.draft.transitions[0]?.afterClipId).toBe('v1')
    expect(
      placeComponent(
        three,
        item('fade-through'),
        { via: 'drop', lane: 'film', timeMs: 5_100 },
        env,
      ),
    ).toEqual({ ok: false, refusal: 'transition-does-not-fit' })
  })

  it('包装从播放头开始，取组件自带时长，放不下截短到整片结尾', () => {
    const { draft } = expectOk(placeComponent(film(), item('hw-arrow'), click(500), env))
    expect(draft.overlays).toEqual([
      { id: 'o1', component: 'hw-arrow', start: 500, duration: 4_000, variables: {} },
    ])
    const short = draftOf([video('v1', 's1', 0, 1_500)])
    const truncated = expectOk(placeComponent(short, item('hw-arrow'), click(0), env))
    expect(truncated.draft.overlays[0]).toMatchObject({ start: 0, duration: 1_500 })
  })

  it('字幕组件换掉字幕样式', () => {
    const { draft } = expectOk(placeComponent(film(), item('caption-highlight'), click(), env))
    expect(draft.captions.component).toBe('caption-highlight')
  })

  it('拖到不对的轨上拒绝；拖到包装轨按松手处放', () => {
    expect(
      placeComponent(film(), item('logo-sting'), { via: 'drop', lane: 'overlay', timeMs: 0 }, env),
    ).toEqual({ ok: false, refusal: 'drop-elsewhere' })
    const { draft } = expectOk(
      placeComponent(film(), item('hw-arrow'), { via: 'drop', lane: 'overlay', timeMs: 800 }, env),
    )
    expect(draft.overlays[0]?.start).toBe(800)
  })
})
