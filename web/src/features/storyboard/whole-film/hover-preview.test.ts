import { describe, expect, it } from 'vitest'
import catalogJson from './catalog/catalog.json'
import { durationMsOf, itemOf, type ComponentCatalog } from './component-catalog'
import { hoverPreviewOf } from './hover-preview'

const catalog = catalogJson as ComponentCatalog
const ORIGIN = 'https://studio.example.com'

const itemNamed = (name: string) => {
  const item = itemOf(catalog, name)
  if (item === undefined) throw new Error(`目录里没有 ${name}`)
  return item
}

describe('悬停预览页', () => {
  it.each([
    ['画面类组件', 'cosmic-orb', 'block'],
    ['特效类组件', 'camera-shake', 'component'],
  ])('%s：只放这一个组件，横版 1920×1080，时长取组件自己的', (_, name, kind) => {
    const item = itemNamed(name)
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
    expect(hoverPreviewOf({ ...itemNamed('cosmic-orb'), duration: null }, catalog, ORIGIN)).toBe(
      undefined,
    )
  })
})
