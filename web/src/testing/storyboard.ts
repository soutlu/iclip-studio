/** 分镜工作台组件测试共用的操作：添加图片的入口只在正文里，要走 `@` 选图的末格「+」。 */

import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/** 聚焦这段正文（光标在段首）敲 `@`，点选图弹层末格的「+」，返回打开的「添加图片」弹窗。
 * 敲下的 `@` 留在正文里，之后关联或上传的引用会把它换掉。 */
export const openAddImage = async (editor: HTMLElement) => {
  act(() => editor.focus())
  await userEvent.keyboard('@')
  const menu = await screen.findByRole('listbox', { name: '插入参考图' })
  await userEvent.click(within(menu).getByRole('option', { name: '添加图片' }))
  return screen.findByRole('dialog', { name: '添加图片' })
}
