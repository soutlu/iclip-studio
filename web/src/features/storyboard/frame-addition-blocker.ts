/** 往选中段添加图片被挡住的原因：「+」的提示、选择器的上传按钮与粘贴的 toast 都读这里，文案只此一份。 */

import { MAX_REFERENCE_IMAGES, REFERENCE_LIMIT_TEXT } from './shots'

type AdditionState = {
  /** 只读或正在提交出片，整页不能改。 */
  editingDisabled: boolean
  /** 这一段已有一张新图在上传。 */
  uploading: boolean
  /** 选中的是有正文的段；未引用的图没有正文，没处插引用。 */
  hasPrompt: boolean
  /** 本组已有几张图。 */
  imageCount: number
}

/** 打开「添加图片」（关联已有或上传）被挡住的原因。张数上限不挡：满了仍能关联已有图片。 */
export const pickerBlockerOf = ({
  editingDisabled,
  hasPrompt,
  uploading,
}: AdditionState): string | undefined => {
  if (editingDisabled) return '当前不能编辑分镜'
  if (uploading) return '正在上传，请稍候'
  if (!hasPrompt) return '先选一段文案'
  return undefined
}

/** 粘贴、选择器上传、重试这类直接上传新图被挡住的原因：在打开选择器的基础上多一条张数上限。 */
export const uploadBlockerOf = (state: AdditionState): string | undefined =>
  pickerBlockerOf(state) ??
  (state.imageCount >= MAX_REFERENCE_IMAGES ? REFERENCE_LIMIT_TEXT : undefined)
