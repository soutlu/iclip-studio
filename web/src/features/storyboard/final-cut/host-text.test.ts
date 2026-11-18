import { describe, expect, it } from 'vitest'
import { fixtureCatalog, host } from '@/testing/final-cut'
import type { CatalogItem, ComponentCatalog } from './composition/catalog'
import { hostTextIn } from './host-text'
import { SOURCE_SHOWN, type ShownLocale } from './locales'

/** 测试组件库加一个条目：一个不是文字的字段，后面跟主文案、副文案两个文字字段。 */
const twoTexts: CatalogItem = {
  ...(fixtureCatalog.items[0] as CatalogItem),
  name: 'two-texts',
  variables: [
    { id: 'bold', type: 'boolean', label: '加粗', default: false },
    { id: 'title', type: 'string', label: '主文案', default: '' },
    { id: 'sub', type: 'string', label: '副文案', default: '默认副文案' },
  ],
}
const catalog: ComponentCatalog = { ...fixtureCatalog, items: [...fixtureCatalog.items, twoTexts] }
const clip = (values: Record<string, string>) => host({ item: 'two-texts', values })
const english = (values: Record<string, string>): ShownLocale => ({ code: 'en', values })

describe('贴片、场景片段上的文字', () => {
  it('按字段的先后取第一个非空的；换行和连着的空白合成一个空格', () => {
    expect(hostTextIn(SOURCE_SHOWN, clip({ title: '新品\n  上市' }), catalog, {})).toBe('新品 上市')
    // 主文案空着（默认值也是空的）：取副文案，没填用条目的默认值
    expect(hostTextIn(SOURCE_SHOWN, clip({ title: ' ' }), catalog, {})).toBe('默认副文案')
  })

  it('一个文字字段都没有、都是空的、条目查不到时没有文字', () => {
    expect(hostTextIn(SOURCE_SHOWN, host({ item: 'fixture-scene' }), catalog, {})).toBeNull()
    expect(hostTextIn(SOURCE_SHOWN, clip({ title: '', sub: '' }), catalog, {})).toBeNull()
    expect(hostTextIn(SOURCE_SHOWN, host({ item: 'missing' }), catalog, {})).toBeNull()
  })

  it('其它语言下随语言的字段取这种语言的字，没翻的取原文；固定的字段取原文', () => {
    const values = { title: '新品上市', sub: '秋季' }
    const bindings = { title: 'txt_title-1_title' }
    expect(
      hostTextIn(english({ 'txt_title-1_title': 'New in' }), clip(values), catalog, bindings),
    ).toBe('New in')
    expect(hostTextIn(english({}), clip(values), catalog, bindings)).toBe('新品上市')
    // 译文是空的：这种语言下这个字段没有字，取下一个字段
    expect(hostTextIn(english({ 'txt_title-1_title': '' }), clip(values), catalog, bindings)).toBe(
      '秋季',
    )
    // 原文下随语言的字段也取原文
    expect(hostTextIn(SOURCE_SHOWN, clip(values), catalog, bindings)).toBe('新品上市')
  })
})
