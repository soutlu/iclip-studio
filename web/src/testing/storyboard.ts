import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

export const openAddImage = async (editor: HTMLElement) => {
  act(() => editor.focus())
  await userEvent.keyboard('@')
  const menu = await screen.findByRole('listbox', { name: '插入参考图' })
  await userEvent.click(within(menu).getByRole('option', { name: '添加图片' }))
  return screen.findByRole('dialog', { name: '添加图片' })
}
