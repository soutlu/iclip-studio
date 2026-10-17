import { describe, expect, it } from 'vitest'
import { captionMetrics, wrapCaption } from './caption-layout'

describe('自定义字幕在源画布上的排版', () => {
  it('字号、描边与边距按源尺寸取整；半像素与服务端相同向上取整', () => {
    expect(captionMetrics({ width: 1080, height: 1920 })).toEqual({
      fontSize: 86,
      outline: 7,
      marginSide: 65,
      marginBottom: 230,
      lineWidth: 936,
    })
    expect(captionMetrics({ width: 75, height: 100 })).toEqual({
      fontSize: 5,
      outline: 1,
      marginSide: 5,
      marginBottom: 12,
      lineWidth: 63,
    })
  })
  it('中文与长英文按实际整行宽度贪心换行，不按空格等分或拆开组合字形', () => {
    const measure = (text: string) =>
      [...text].reduce((width, char) => width + (/[A-Z]/.test(char) ? 6 : 10), 0)
    expect(wrapCaption('品牌字幕预览', 30, measure)).toBe('品牌字\n幕预览')
    expect(wrapCaption('ABCDEFGHIJK', 30, measure)).toBe('ABCDE\nFGHIJ\nK')
    expect(wrapCaption('a\u0301b', 20, (text) => text.length * 10)).toBe('a\u0301\nb')
  })
  it('保留显式换行并规整控制字符，自动断行两端不留下空格', () => {
    expect(wrapCaption(' AB CD\r\n{E}\\F\n\n', 30, (text) => text.length * 10)).toBe(
      'AB\nCD\n｛E｝\n＼F',
    )
  })
  it('换用更宽的字体会重新排成更多行，单簇超宽明确失败', () => {
    expect(wrapCaption('ABCD', 20, (text) => text.length * 5)).toBe('ABCD')
    expect(wrapCaption('ABCD', 20, (text) => text.length * 10)).toBe('AB\nCD')
    expect(() => wrapCaption('字', 20, () => 21)).toThrow('字幕字形超过可用画面宽度')
  })
})
