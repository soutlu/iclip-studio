import { describe, expect, it } from 'vitest'
import { disallowedMediaHosts, parseAllowedHosts, parseExportRequest } from './request'
import { exportRequest } from './testing'

describe('parseExportRequest', () => {
  it('合法的请求通过，字幕的逐词时间与标点按合同补默认值', () => {
    const body = exportRequest()
    const sentences = (
      body['media'] as { subtitles: Record<string, { sentences: Record<string, unknown>[] }> }
    ).subtitles
    const first = Object.values(sentences)[0]?.sentences[0]
    if (first) delete first['words']
    const result = parseExportRequest(body)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Object.values(result.request.media.subtitles)[0]?.sentences[0]?.words).toEqual([])
    }
  })

  it.each<[string, (body: Record<string, unknown>) => void, string]>([
    ['缺少草稿', (body) => delete body['document'], 'document'],
    [
      '素材地址不是 http(s)',
      (body) => {
        const media = body['media'] as { music: { url: string } }
        media.music.url = 'file:///etc/passwd'
      },
      'media.music.url',
    ],
    [
      '上传头不是字符串',
      (body) => {
        const upload = body['upload'] as { headers: Record<string, unknown> }
        upload.headers['x-oss-object-acl'] = 1
      },
      'upload.headers.x-oss-object-acl',
    ],
    [
      '画面段时长短于 100 毫秒（合同约束）',
      (body) => {
        const document = body['document'] as { layer0: { duration: number }[] }
        document.layer0[0]!.duration = 50
      },
      'document.layer0.0',
    ],
  ])('%s时不通过，说明指到出错的字段', (_, mutate, path) => {
    const body = exportRequest()
    mutate(body)
    const result = parseExportRequest(body)
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

  it('素材片与配乐的主机都要在白名单里；上传地址不检查', () => {
    const parsed = parseExportRequest(exportRequest({ mediaHost: 'Evil.example.net' }))
    if (!parsed.ok) throw new Error(parsed.message)
    expect(disallowedMediaHosts(parsed.request, new Set(['oss.example.com']))).toEqual([
      'evil.example.net',
    ])
    expect(disallowedMediaHosts(parsed.request, new Set(['evil.example.net']))).toEqual([])
  })

  it('端口是主机的一部分', () => {
    const parsed = parseExportRequest(exportRequest({ mediaHost: '127.0.0.1:8815' }))
    if (!parsed.ok) throw new Error(parsed.message)
    expect(disallowedMediaHosts(parsed.request, new Set(['127.0.0.1']))).toEqual(['127.0.0.1:8815'])
    expect(disallowedMediaHosts(parsed.request, new Set(['127.0.0.1:8815']))).toEqual([])
  })
})
