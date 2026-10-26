import { describe, expect, it } from 'vitest'
import { fixtureCatalog as catalog, fixtureItem } from '@/testing/whole-film'
import { durationMsOf } from './component-catalog'
import { hoverPreviewOf } from './hover-preview'

const ORIGIN = 'https://studio.example.com'

describe('悬停预览页', () => {
  it.each([
    ['画面类组件', 'fixture-scene', 'block'],
    ['特效类组件', 'fixture-overlay', 'component'],
  ])('%s：只放这一个组件，横版 1920×1080，时长取组件自己的', (_, name, kind) => {
    const item = fixtureItem(name)
    expect(item.kind).toBe(kind)
    const state = hoverPreviewOf(item, catalog, ORIGIN)
    if (state?.kind !== 'ready') throw new Error('没有生成预览页')
    expect(state.durationMs).toBe(durationMsOf(item))
    expect(state.html).toContain('data-width="1920" data-height="1080"')
    expect(state.html).toContain(`<base href="${ORIGIN}/hyperframes/${catalog.version}/">`)
    const hosts = state.html.match(/data-composition-src="[^"]*"/g) ?? []
    expect(hosts).toHaveLength(1)
    expect(hosts[0]).toContain(name)
  })

  it('没有时长的组件不做预览', () => {
    expect(
      hoverPreviewOf({ ...fixtureItem('fixture-scene'), duration: null }, catalog, ORIGIN),
    ).toBe(undefined)
  })
})
