import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithTooltip } from '@/testing/render'
import { fixtureCatalog } from '@/testing/whole-film'
import { isLightColor, swatchColors, type CatalogItem } from './component-catalog'
import { ComponentPopover } from './component-popover'
import type { ComponentVariables } from './editing/draft'

const option = (value: string) => ({ value, label: `选项${value}` })

const item: CatalogItem = {
  name: 'sample',
  kind: 'component',
  title: '示例组件',
  description: '组件说明不在浮层里',
  category: 'scenes',
  placement: null,
  src: 'compositions/components/sample.html',
  size: null,
  duration: 4,
  thumbnail: null,
  fonts: [],
  variables: [
    { id: 'text', type: 'string', label: '文字', default: 'Hello' },
    { id: 'size', type: 'number', label: '字号', default: 72, unit: 'px' },
    { id: 'color', type: 'color', label: '颜色', default: '#171717' },
    {
      id: 'weight',
      type: 'enum',
      label: '粗细',
      default: 'b',
      options: ['a', 'b', 'c', 'd'].map(option),
    },
    {
      id: 'motion',
      type: 'enum',
      label: '动效',
      default: 'a',
      options: ['a', 'b', 'c', 'd', 'e'].map(option),
    },
    { id: 'loop', type: 'boolean', label: '循环', default: false },
    { id: 'logo', type: 'image', label: '标志', default: 'logo.svg' },
  ],
}

/** 只有字体项的组件；`fallback` 是目录里的默认值（品牌组件写成品牌字体） */
const withFont = (fallback: string): CatalogItem => ({
  ...item,
  variables: [{ id: 'font', type: 'font', label: '字体', default: fallback }],
})

/** 测试组件库里唯一带品牌的字体 */
const BRAND_FONT = 'Playfair Display'

const renderPopover = (values: ComponentVariables = {}, target: CatalogItem = item) => {
  const onChange = vi.fn()
  renderWithTooltip(
    <ComponentPopover
      catalog={fixtureCatalog}
      item={target}
      onChange={onChange}
      onRemove={() => {}}
      values={values}
    />,
  )
  return { onChange }
}

describe('组件调整浮层', () => {
  it('清空填过的文字：去掉这一项，不存空字', async () => {
    const user = userEvent.setup()
    const { onChange } = renderPopover({ text: '你好', size: 64 })
    const text = screen.getByLabelText('文字')
    expect(text).toHaveValue('你好')
    await user.clear(text)
    await user.type(text, '{Enter}')
    expect(onChange).toHaveBeenLastCalledWith({ size: 64 })
  })

  it('数字是带单位的短输入框，显示现在的值', async () => {
    const user = userEvent.setup()
    const { onChange } = renderPopover()
    const size = screen.getByLabelText('字号')
    expect(size).toHaveValue(72)
    await user.clear(size)
    await user.type(size, '48{Enter}')
    expect(onChange).toHaveBeenLastCalledWith({ size: 48 })
  })

  it('颜色是一排色块（默认色在前、当前色打勾）加「其他颜色」', async () => {
    const user = userEvent.setup()
    const { onChange } = renderPopover()
    const colors = screen.getByRole('group', { name: '颜色' })
    const swatches = within(colors).getAllByRole('button')
    expect(swatches.map((button) => button.getAttribute('aria-label'))).toEqual(
      swatchColors('#171717', '#171717'),
    )
    expect(swatches[0]).toHaveAttribute('aria-pressed', 'true')
    expect(within(colors).getByLabelText('其他颜色')).toHaveAttribute('type', 'color')
    await user.click(swatches[1] as HTMLElement)
    expect(onChange).toHaveBeenLastCalledWith({ color: swatches[1]?.getAttribute('aria-label') })
  })

  it('不超过 4 个选项用分段按钮，更多用下拉', async () => {
    const user = userEvent.setup()
    const { onChange } = renderPopover()
    const weight = screen.getByRole('group', { name: '粗细' })
    expect(within(weight).getAllByRole('button')).toHaveLength(4)
    expect(within(weight).getByRole('button', { name: '选项b' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await user.click(within(weight).getByRole('button', { name: '选项d' }))
    expect(onChange).toHaveBeenLastCalledWith({ weight: 'd' })
    expect(screen.queryByRole('group', { name: '动效' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('动效')).toHaveTextContent('选项a')
  })

  it('字体是向上展开的下拉：「默认」加上每个带品牌的字体，选项文字是品牌缩写；选了写进取值', async () => {
    const user = userEvent.setup()
    const { onChange } = renderPopover({}, withFont(''))
    const font = screen.getByLabelText('字体')
    expect(font).toHaveTextContent('默认')
    await user.click(font)
    expect(screen.getByRole('menu')).toHaveAttribute('data-side', 'top')
    expect(screen.getAllByRole('menuitemradio').map((option) => option.textContent)).toEqual([
      '默认',
      '示例品牌',
    ])
    expect(screen.getByRole('menuitemradio', { name: '默认' })).toBeChecked()
    await user.click(screen.getByRole('menuitemradio', { name: '示例品牌' }))
    expect(onChange).toHaveBeenLastCalledWith({ font: BRAND_FONT })
  })

  it('选了品牌字体的显示品牌缩写；选「默认」回到组件自带的字体，不再存这一项', async () => {
    const user = userEvent.setup()
    const { onChange } = renderPopover({ font: BRAND_FONT }, withFont(''))
    const font = screen.getByLabelText('字体')
    expect(font).toHaveTextContent('示例品牌')
    await user.click(font)
    expect(screen.getByRole('menuitemradio', { name: '示例品牌' })).toBeChecked()
    await user.click(screen.getByRole('menuitemradio', { name: '默认' }))
    expect(onChange).toHaveBeenLastCalledWith({})
  })

  it('品牌组件的字体项默认是品牌字体：选「默认」存空字符串，用组件自带的字体', async () => {
    const user = userEvent.setup()
    const { onChange } = renderPopover({}, withFont(BRAND_FONT))
    const font = screen.getByLabelText('字体')
    expect(font).toHaveTextContent('示例品牌')
    await user.click(font)
    await user.click(screen.getByRole('menuitemradio', { name: '默认' }))
    expect(onChange).toHaveBeenLastCalledWith({ font: '' })
  })

  it('开关项是开关', async () => {
    const user = userEvent.setup()
    const { onChange } = renderPopover()
    const loop = screen.getByRole('switch', { name: '循环' })
    expect(loop).toHaveAttribute('aria-checked', 'false')
    await user.click(loop)
    expect(onChange).toHaveBeenLastCalledWith({ loop: true })
  })
})

describe('颜色色块', () => {
  it('默认色在最前，其后是常用色，大小写不同的同一色只留一个', () => {
    const colors = swatchColors('#FFFFFF', '#ffffff')
    expect(colors[0]).toBe('#FFFFFF')
    expect(colors.filter((color) => color.toLowerCase() === '#ffffff')).toHaveLength(1)
  })

  it('现在用的颜色不在其中时排在默认色后面', () => {
    expect(swatchColors('#171717', '#123456').slice(0, 2)).toEqual(['#171717', '#123456'])
  })

  it('浅色色块上的勾用深色', () => {
    expect(isLightColor('#ffffff')).toBe(true)
    expect(isLightColor('#171717')).toBe(false)
    expect(isLightColor('var(--brand)')).toBe(false)
  })
})
