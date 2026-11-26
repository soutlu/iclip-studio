import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import { FilterBarRoot } from './filter-bar'
import type { FilterOption } from './filter-option'
import { SelectFilter } from './select-filter'

const OPTIONS: FilterOption[] = [
  { id: 'zh', label: '中文' },
  { description: '美式或英式', id: 'en', label: 'English' },
  { id: 'none', label: '多语种' },
]

function Bar({ onChange }: { onChange: (value: string | undefined) => void }) {
  const [value, setValue] = useState<string | undefined>()
  return (
    <FilterBarRoot>
      <SelectFilter
        id="locale"
        noun="语种"
        onChange={(next) => {
          onChange(next)
          setValue(next)
        }}
        options={OPTIONS}
        value={value}
        width="w-48"
      />
    </FilterBarRoot>
  )
}

describe('SelectFilter', () => {
  it('每行是单选项：选一项弹层关上、焦点回到触发器、触发器写这一项；点另一项换成它，再点选中的那项清空', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    await renderWithProviders(<Bar onChange={onChange} />)

    const pick = async (trigger: string, option: string) => {
      await user.click(screen.getByRole('button', { name: trigger }))
      const popup = await screen.findByRole('dialog', { name: '选择语种' })
      await user.click(
        within(within(popup).getByRole('radiogroup', { name: '语种' })).getByRole('radio', {
          name: new RegExp(`^${option}`),
        }),
      )
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '选择语种' })).toBeNull())
    }

    await pick('语种：语种', '中文')
    expect(onChange).toHaveBeenLastCalledWith('zh')
    expect(screen.getByRole('button', { name: '语种：中文' })).toHaveFocus()
    expect(screen.getByRole('button', { name: '语种：中文' })).toHaveTextContent('中文')

    await user.click(screen.getByRole('button', { name: '语种：中文' }))
    const popup = await screen.findByRole('dialog', { name: '选择语种' })
    expect(within(popup).getByRole('radio', { name: '中文' })).toBeChecked()
    expect(within(popup).getByRole('radio', { name: /^English/ })).not.toBeChecked()
    expect(within(popup).getByText('美式或英式')).toBeVisible()
    await user.click(within(popup).getByRole('radio', { name: /^English/ }))
    expect(onChange).toHaveBeenLastCalledWith('en')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '选择语种' })).toBeNull())

    await pick('语种：English', 'English')
    expect(onChange).toHaveBeenLastCalledWith(undefined)
    expect(screen.getByRole('button', { name: '语种：语种' })).toHaveFocus()
  })
})
