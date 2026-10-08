import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import { FilterBarRoot } from './filter-bar'
import { MultiPickerFilter, type MultiPickerOption } from './multi-picker-filter'

const OPTIONS: MultiPickerOption[] = [
  { count: 2, description: '主播在直播布景前讲', id: 'live', label: '直播切片' },
  { count: 9, description: '模特穿上产品', id: 'try_on', label: '上身展示' },
  { count: 5, id: 'lifestyle', label: '场景种草' },
]

function Bar({
  searchable = false,
  onChange,
  initial = [],
}: {
  searchable?: boolean
  onChange: (value: string[]) => void
  initial?: string[]
}) {
  const [value, setValue] = useState<string[]>(initial)
  return (
    <FilterBarRoot>
      <MultiPickerFilter
        icon="tag"
        id="type"
        noun="片子类型"
        onChange={(next) => {
          onChange(next)
          setValue(next)
        }}
        options={OPTIONS}
        searchable={searchable}
        value={value}
        width="w-80"
      />
    </FilterBarRoot>
  )
}

describe('MultiPickerFilter', () => {
  it('不带搜索：每行是复选框，Tab 走过去、空格勾选；勾一项就回调，弹层留着，条件按候选先后排', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    await renderWithProviders(<Bar onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: '片子类型：片子类型' }))
    const popup = await screen.findByRole('dialog', { name: '选择片子类型' })
    await user.click(within(popup).getByRole('checkbox', { name: /场景种草/ }))
    expect(onChange).toHaveBeenLastCalledWith(['lifestyle'])

    // 弹层没关，接着用键盘勾上一项。
    within(popup)
      .getByRole('checkbox', { name: /上身展示/ })
      .focus()
    await user.keyboard(' ')
    expect(onChange).toHaveBeenLastCalledWith(['try_on', 'lifestyle'])
    expect(within(popup).getByRole('checkbox', { name: /上身展示/ })).toBeChecked()
    expect(within(popup).getByText('模特穿上产品')).toBeVisible()

    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: '片子类型：上身展示 +1' })).toBeVisible()
  })

  it('带搜索：列表标成多选，搜到的项回车勾上，已勾的再选一次取消', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    await renderWithProviders(<Bar initial={['live']} onChange={onChange} searchable />)

    await user.click(screen.getByRole('button', { name: '片子类型：直播切片' }))
    const popup = await screen.findByRole('dialog', { name: '选择片子类型' })
    expect(within(popup).getByRole('listbox')).toHaveAttribute('aria-multiselectable', 'true')

    await user.type(within(popup).getByRole('combobox', { name: '搜索片子类型' }), '种草')
    await user.keyboard('{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenLastCalledWith(['live', 'lifestyle'])

    await user.clear(within(popup).getByRole('combobox', { name: '搜索片子类型' }))
    await user.click(within(popup).getByRole('option', { name: /直播切片/ }))
    expect(onChange).toHaveBeenLastCalledWith(['lifestyle'])
  })

  it('已选但不在候选里的仍列在最前面，可以取消', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    await renderWithProviders(<Bar initial={['雪地靴']} onChange={onChange} searchable />)

    await user.click(screen.getByRole('button', { name: '片子类型：雪地靴' }))
    const popup = await screen.findByRole('dialog', { name: '选择片子类型' })
    const [first] = within(popup).getAllByRole('option')
    expect(first).toHaveAccessibleName(/雪地靴/)
    expect(first).toHaveAttribute('aria-selected', 'true')
    await user.click(first as HTMLElement)
    expect(onChange).toHaveBeenLastCalledWith([])
  })
})
