import { describe, expect, it } from 'vitest'
import { mediaAddresses, projectPathProblem, projectProblem, withLocalMedia } from './project'
import { audio, AUDIO_URL, CLIP_URL, mainFile, video } from './testing'

describe('工程文件的路径', () => {
  it.each([
    'index.html',
    'compositions/fixtures/a.html',
    'compositions/fixture-sidecar/assets/a.json',
    '.hidden/a.html',
    'vendors/a.js',
    '中文/文件.html',
  ])('%s 合规', (path) => {
    expect(projectPathProblem(path)).toBeUndefined()
  })

  it.each([
    '',
    '../a.html',
    'a/../b.html',
    './a.html',
    'a/./b.html',
    '/a.html',
    'a/',
    'a//b',
    'a\\b',
    'a\nb',
    'vendor',
    'vendor/a.js',
    'VENDOR/a.js',
  ])('%j 不合规', (path) => {
    expect(projectPathProblem(path)).toBeDefined()
  })

  it('一组文件：要有主文件，路径不重复（不分大小写），一个路径不能既是文件又是目录', () => {
    const main = { path: 'index.html', content: '' }
    expect(projectProblem([main, { path: 'a/b.html', content: '' }])).toBeUndefined()
    expect(projectProblem([{ path: 'a.html', content: '' }])).toContain('index.html')
    expect(
      projectProblem([main, { path: 'A.html', content: '' }, { path: 'a.html', content: '' }]),
    ).toContain('重复')
    expect(
      projectProblem([main, { path: 'a/b/c.html', content: '' }, { path: 'a/b', content: '' }]),
    ).toContain('目录')
  })
})

describe('主文件里的素材', () => {
  const html = mainFile([video(), audio({ hidden: true }), video({ id: 'clip-2', start: 2000 })])

  it('列出 <video>、<audio> 的 src，不重复', () => {
    expect(mediaAddresses(html)).toEqual([CLIP_URL, AUDIO_URL])
  })

  it('导出用的那一份只换 <video>、<audio> 的 src，别的一个字不动', () => {
    const local = withLocalMedia(
      html,
      new Map([
        [CLIP_URL, 'media-x/a.mp4'],
        [AUDIO_URL, 'media-x/b.m4a'],
      ]),
    )
    expect(local).toBe(
      html
        .replaceAll(`src="${CLIP_URL}"`, 'src="media-x/a.mp4"')
        .replace(`src="${AUDIO_URL}"`, 'src="media-x/b.m4a"'),
    )
  })

  it('地址写在手写的元素里、带着 HTML 转义时也认得出、换得掉', () => {
    const written =
      '<!doctype html><html><head><!-- 注释 --></head><body><div id="r">' +
      '<audio src=\'https://a.test/x.mp3?a=1&amp;b=2\' data-start="0"></audio></div></body></html>'
    expect(mediaAddresses(written)).toEqual(['https://a.test/x.mp3?a=1&b=2'])
    expect(withLocalMedia(written, new Map([['https://a.test/x.mp3?a=1&b=2', 'm/x.mp3']]))).toBe(
      written.replace("src='https://a.test/x.mp3?a=1&amp;b=2'", 'src="m/x.mp3"'),
    )
  })
})
