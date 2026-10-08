import { describe, expect, it } from 'vitest'
import { isEditableTarget, splitVideoFiles } from './reference-upload'

const fileOf = (name: string, type: string) => new File(['x'], name, { type })

describe('splitVideoFiles', () => {
  it('只留 MP4 与 MOV，按原顺序；其余（图片、别的视频格式、文件夹那样没有类型的）计入被挑掉的个数', () => {
    const mp4 = fileOf('a.mp4', 'video/mp4')
    const mov = fileOf('b.mov', 'video/quicktime')
    const result = splitVideoFiles([
      fileOf('c.png', 'image/png'),
      mp4,
      fileOf('d.webm', 'video/webm'),
      mov,
      fileOf('素材夹', ''),
    ])
    expect(result).toEqual({ rejected: 3, videos: [mp4, mov] })
  })

  it('全是视频时一个都不挑掉', () => {
    expect(splitVideoFiles([fileOf('a.mp4', 'video/mp4')]).rejected).toBe(0)
  })
})

describe('isEditableTarget', () => {
  it.each([
    ['输入框', () => document.createElement('input')],
    ['文本框', () => document.createElement('textarea')],
    [
      '可编辑区域里的元素',
      () => {
        const editor = document.createElement('div')
        editor.setAttribute('contenteditable', 'true')
        const inner = document.createElement('span')
        editor.append(inner)
        return inner
      },
    ],
  ])('%s：粘贴归它', (_name, make) => {
    expect(isEditableTarget(make())).toBe(true)
  })

  it.each([
    ['页面本身', () => document.body],
    ['按钮', () => document.createElement('button')],
    ['没有目标', () => null],
  ])('%s：粘贴当上传', (_name, make) => {
    expect(isEditableTarget(make())).toBe(false)
  })
})
