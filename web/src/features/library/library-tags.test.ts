import { describe, expect, it } from 'vitest'
import { mockLibraryTagTree, mockTagId } from '@/testing/mocks/library-tags'
import {
  dimensionEntriesOf,
  knownTagIds,
  replaceDimensionTags,
  tagIndexOf,
  tagNamesOf,
  tagOptionsOf,
} from './library-tags'

const index = tagIndexOf(mockLibraryTagTree())
const id = mockTagId
const dimension = (name: string) => {
  const found = index.dimensions.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`没有维度「${name}」`)
  return found
}
const UNKNOWN = '00000000-0000-4000-8000-000000000000'

describe('tagNamesOf', () => {
  it('按树的先后排：维度先后、同一维度里大类后跟它的小类；不认识的 id 不显示', () => {
    expect(
      tagNamesOf(index, [id('对比测评'), UNKNOWN, id('开箱测评型'), id('卫衣'), id('TikTok')]),
    ).toEqual(['TikTok', '卫衣', '开箱测评型', '对比测评'])
  })

  it('维度本身不算取值', () => {
    expect(tagNamesOf(index, [dimension('品类').id])).toEqual([])
  })
})

describe('replaceDimensionTags', () => {
  it('只换这一维度的取值，其余维度原样留着，交回整份按树的先后', () => {
    const before = [id('AMZ'), id('拖鞋'), id('标准开箱流程')]
    expect(
      replaceDimensionTags(index, before, dimension('内容结构').id, [
        id('图文幻灯片'),
        id('产品展示型'),
      ]),
    ).toEqual([id('AMZ'), id('拖鞋'), id('产品展示型'), id('图文幻灯片')])
  })

  it('给了别的维度的 id 不收，清空就是去掉这一维度的全部', () => {
    const before = [id('AMZ'), id('拖鞋')]
    expect(replaceDimensionTags(index, before, dimension('品类').id, [id('DTC')])).toEqual([
      id('AMZ'),
    ])
  })
})

describe('dimensionEntriesOf / knownTagIds', () => {
  it('取一个维度上已选的取值；不认识的 id 去掉', () => {
    const ids = [id('拖鞋'), id('AMZ'), UNKNOWN, id('卫衣')]
    expect(dimensionEntriesOf(index, dimension('品类').id, ids).map((entry) => entry.name)).toEqual(
      ['拖鞋', '卫衣'],
    )
    expect(knownTagIds(index, ids)).toEqual([id('AMZ'), id('拖鞋'), id('卫衣')])
  })
})

describe('tagOptionsOf', () => {
  it('两层的维度：大类是可选的组头，小类缩进跟在它后面', () => {
    const options = tagOptionsOf(dimension('内容结构'))
    expect(options.slice(0, 3).map(({ label, depth, group }) => ({ depth, group, label }))).toEqual(
      [
        { depth: 0, group: true, label: '产品展示型' },
        { depth: 1, group: false, label: '360°全景展示' },
        { depth: 1, group: false, label: '细节微距特写' },
      ],
    )
    expect(options).toHaveLength(7 + 24)
  })

  it('一层的维度：都是平的', () => {
    expect(
      tagOptionsOf(dimension('场景')).every((option) => !option.group && option.depth === 0),
    ).toBe(true)
  })
})
