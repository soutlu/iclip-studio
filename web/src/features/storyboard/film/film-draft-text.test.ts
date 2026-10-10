import { describe, expect, it } from 'vitest'
import type { FilmFrame, FilmGroup } from './film.api'
import { newImageToken, toDraftText, toRequestText, toShownText } from './film-draft-text'

const frame = (node: string, number: number | null, url: string | null): FilmFrame => ({
  aspectRatio: null,
  kind: 'photo',
  label: node,
  missing: [],
  node,
  number,
  prompt: null,
  url,
})

const groupOf = (frames: FilmFrame[]): FilmGroup => ({
  aspectRatio: '9:16',
  frames,
  index: 1,
  model: 'm',
  prompt: '',
  seconds: 4,
  settings: [],
  shots: [],
  video: 'v',
})

/** 列表三张：a、b 与镜头的机位图 view；后面接一张没进列表的机位图。 */
const before = groupOf([
  frame('a', 1, 'https://example.com/a.png'),
  frame('b', 2, 'https://example.com/b.png'),
  frame('view', 3, 'https://example.com/view.png'),
  frame('later', null, null),
])

const added = 'https://example.com/new.png'

describe('草稿里的图', () => {
  it('列表变了，草稿照样指着原来那张图：显示与发送都按当下的编号', () => {
    const draft = toDraftText('参考@Image3，a 是 @Image1，b 是 @Image2。', before)
    // 别处删掉了 a：b 成了 @1，机位图成了 @2。
    const after = groupOf([
      frame('b', 1, 'https://example.com/b.png'),
      frame('view', 2, 'https://example.com/view.png'),
    ])

    expect(toShownText(draft, after)).toBe('参考@Image2，a 是 @Image0，b 是 @Image1。')
    expect(toShownText(draft, before)).toBe('参考@Image3，a 是 @Image1，b 是 @Image2。')
  })

  it('这组没有的编号原样留着，保存时由后端拒绝', () => {
    expect(toShownText(toDraftText('看 @Image9。', before), before)).toBe('看 @Image9。')
  })

  it('新插入的图按 M+1 起编，同一地址只记一次；地址就是列表里某张图的，用那张的编号', () => {
    const images: string[] = []
    const text = toRequestText(
      toDraftText(
        `${newImageToken(added)}与${newImageToken('https://example.com/b.png')}，再看${newImageToken(added)}，@Image1`,
        before,
      ),
      before,
      images,
    )

    expect(text).toBe('@Image4与@Image2，再看@Image4，@Image1')
    expect(images).toEqual([added])
  })

  it('一段镜头的几段文字共用一份新图：第二段接着往后编', () => {
    const images: string[] = []
    const second = 'https://example.com/second.png'

    expect(toRequestText(newImageToken(added), before, images)).toBe('@Image4')
    expect(toRequestText(`${newImageToken(second)}${newImageToken(added)}`, before, images)).toBe(
      '@Image5@Image4',
    )
    expect(images).toEqual([added, second])
  })

  it('新插入的图在页面上原样是记号，不当成编号', () => {
    const token = newImageToken(added)
    expect(toShownText(toDraftText(`前${token}后`, before), before)).toBe(`前${token}后`)
  })
})
