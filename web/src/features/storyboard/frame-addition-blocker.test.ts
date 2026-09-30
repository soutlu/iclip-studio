import { describe, expect, it } from 'vitest'
import { pickerBlockerOf, uploadBlockerOf } from './frame-addition-blocker'
import { MAX_REFERENCE_IMAGES, REFERENCE_LIMIT_TEXT } from './shots'

const open = { editingDisabled: false, hasPrompt: true, imageCount: 2, uploading: false }

describe('pickerBlockerOf / uploadBlockerOf', () => {
  it('能改、有正文、没在传、没满时都不挡', () => {
    expect(pickerBlockerOf(open)).toBeUndefined()
    expect(uploadBlockerOf(open)).toBeUndefined()
  })

  it.each([
    ['不能编辑', { editingDisabled: true, uploading: true, hasPrompt: false }, '当前不能编辑分镜'],
    ['正在上传', { uploading: true, hasPrompt: false }, '正在上传，请稍候'],
    ['选中的是未引用的图', { hasPrompt: false }, '先选一段文案'],
  ])('%s：两处都挡，原因按这个先后取', (_case, patch, reason) => {
    expect(pickerBlockerOf({ ...open, ...patch })).toBe(reason)
    expect(uploadBlockerOf({ ...open, ...patch })).toBe(reason)
  })

  it('满了只挡上传新图，仍能打开选择器关联已有图片', () => {
    const full = { ...open, imageCount: MAX_REFERENCE_IMAGES }
    expect(pickerBlockerOf(full)).toBeUndefined()
    expect(uploadBlockerOf(full)).toBe(REFERENCE_LIMIT_TEXT)
  })
})
