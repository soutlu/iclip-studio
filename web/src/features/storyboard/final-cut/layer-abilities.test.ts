import { resolveEditingAffordances } from '@hyperframes/core/editing'
import { describe, expect, it } from 'vitest'
import {
  gsapOwns,
  layerAbilities,
  LayerRefusal,
  type LayerFacts,
  type RuntimeTimeline,
} from './layer-abilities'

const still = { move: false, resize: false, rotate: false }
const inner: LayerFacts = {
  tag: 'div',
  root: false,
  locked: false,
  animated: still,
}

/** 引擎自己对同样事实的判断：三样能不能改。 */
const engine = (facts: LayerFacts) => {
  const { capabilities } = resolveEditingAffordances({
    hasStableTarget: true,
    tag: facts.tag,
    inlineStyles: {},
    isCompositionHost: false,
    isCompositionRoot: facts.root,
    isInsideLockedComposition: facts.locked,
    isMasterView: false,
    existsInSource: true,
    hasEditableText: false,
    hasTimingStart: false,
    animationCount: 0,
  })
  return [
    capabilities.canApplyManualOffset,
    capabilities.canApplyManualSize,
    capabilities.canApplyManualRotation,
  ]
}

describe('一层能不能在画面上改', () => {
  it.each<[string, Partial<LayerFacts>, LayerRefusal]>([
    ['锁定的组件里的', { locked: true }, LayerRefusal.locked],
    ['合成的根', { root: true }, LayerRefusal.root],
    // 先后照引擎：锁定比根先说
    ['锁定组件里的根', { root: true, locked: true }, LayerRefusal.locked],
  ])('%s：三样都不能改，原因和引擎的判断一致', (_name, facts, refusal) => {
    const abilities = layerAbilities({ ...inner, ...facts })
    expect([abilities.move, abilities.resize, abilities.rotate]).toEqual(
      engine({ ...inner, ...facts }),
    )
    expect(abilities).toEqual({ move: false, resize: false, rotate: false, refusal })
  })

  it('别的层（视频、字幕的一句、元素和模板片段的宿主）：三样都能改', () => {
    expect(layerAbilities(inner)).toEqual({
      move: true,
      resize: true,
      rotate: true,
      refusal: LayerRefusal.none,
    })
    expect(engine(inner)).toEqual([true, true, true])
  })

  it('动画脚本在动它的哪一样，那一样就不能改', () => {
    expect(layerAbilities({ ...inner, animated: { ...still, rotate: true } })).toEqual({
      move: true,
      resize: true,
      rotate: false,
      refusal: LayerRefusal.animated,
    })
  })
})

describe('动画脚本在不在动它', () => {
  const element = {}
  const other = {}
  const timelines = (
    ...tweens: { targets: unknown[]; vars: Record<string, unknown> }[]
  ): Record<string, RuntimeTimeline> => ({
    main: {
      getChildren: () => tweens.map(({ targets, vars }) => ({ targets: () => targets, vars })),
    },
  })

  it('补间写位置：挪和缩放都算它在动，转不算', () => {
    const owned = timelines({ targets: [element], vars: { x: 0, opacity: 1 } })
    expect(gsapOwns(element, owned, 'move')).toBe(true)
    expect(gsapOwns(element, owned, 'resize')).toBe(true)
    expect(gsapOwns(element, owned, 'rotate')).toBe(false)
  })

  it('补间写角度、宽度：转、缩放算；关键帧里写的也算', () => {
    expect(
      gsapOwns(element, timelines({ targets: [element], vars: { rotation: 30 } }), 'rotate'),
    ).toBe(true)
    expect(
      gsapOwns(element, timelines({ targets: [element], vars: { width: 30 } }), 'resize'),
    ).toBe(true)
    const keyframed = timelines({ targets: [element], vars: { keyframes: [{ y: 10 }, { y: 0 }] } })
    expect(gsapOwns(element, keyframed, 'move')).toBe(true)
  })

  it('只动透明度、或者动的是别的元素、没有时间线：都不算', () => {
    expect(gsapOwns(element, timelines({ targets: [element], vars: { opacity: 0 } }), 'move')).toBe(
      false,
    )
    expect(gsapOwns(element, timelines({ targets: [other], vars: { x: 10 } }), 'move')).toBe(false)
    expect(gsapOwns(element, undefined, 'move')).toBe(false)
  })
})
