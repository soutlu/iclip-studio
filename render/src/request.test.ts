import { describe, expect, it } from 'vitest'
import { disallowedMediaHosts, parseAllowedHosts, parseRequest, zExportRequest } from './request'
import { CLIP_URL, exportRequest } from './testing'

describe('导出请求', () => {
  it('合法的请求通过', () => {
    expect(parseRequest(zExportRequest, exportRequest()).ok).toBe(true)
  })

  it.each<[string, (body: Record<string, unknown>) => void, string]>([
    ['缺少成片文件', (body) => delete body['film'], 'film'],
    [
      '下载地址不是 http(s)',
      (body) => {
        const media = body['media'] as Record<string, { url: string }>
        media[CLIP_URL] = { url: 'file:///etc/passwd' }
      },
      `media.${CLIP_URL}.url`,
    ],
    [
      '上传头不是字符串',
      (body) => {
        const upload = body['upload'] as { headers: Record<string, unknown> }
        upload.headers['x-oss-object-acl'] = 1
      },
      'upload.headers.x-oss-object-acl',
    ],
  ])('%s时不通过，说明指到出错的字段', (_, mutate, path) => {
    const body = exportRequest()
    mutate(body)
    const result = parseRequest(zExportRequest, body)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message.startsWith(path)).toBe(true)
  })
})

describe('素材主机白名单', () => {
  it('解析逗号分隔的主机，去空白、转小写', () => {
    expect(parseAllowedHosts(' OSS.example.com , 127.0.0.1:8815,,')).toEqual(
      new Set(['oss.example.com', '127.0.0.1:8815']),
    )
    expect(parseAllowedHosts(undefined)).toEqual(new Set())
  })

  it('不在白名单里的主机逐个列出，不重复', () => {
    const urls = ['https://Evil.example.net/a.mp4', 'https://evil.example.net/b.mp4']
    expect(disallowedMediaHosts(urls, new Set(['oss.example.com']))).toEqual(['evil.example.net'])
    expect(disallowedMediaHosts(urls, new Set(['evil.example.net']))).toEqual([])
  })

  it('端口是主机的一部分', () => {
    const urls = ['http://127.0.0.1:8815/a.mp4']
    expect(disallowedMediaHosts(urls, new Set(['127.0.0.1']))).toEqual(['127.0.0.1:8815'])
    expect(disallowedMediaHosts(urls, new Set(['127.0.0.1:8815']))).toEqual([])
  })
})
