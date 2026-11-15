import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExportQueue } from './jobs'
import { createExportServer } from './server'
import {
  audio,
  AUDIO_URL,
  CLIP_URL,
  exportRequest,
  flush,
  host,
  mainFile,
  manualWorker,
  memoryLogger,
  video,
} from './testing'

const VENDOR_DIR = '/registry/vendor'

let base: string
let close: () => Promise<void>
let renders: ReturnType<typeof manualWorker>['renders']

beforeEach(async () => {
  const manual = manualWorker()
  renders = manual.renders
  const { logger } = memoryLogger()
  const queue = new ExportQueue({ worker: manual.worker, logger, timeoutMs: 60_000 })
  const server = createExportServer({
    queue,
    vendorDir: VENDOR_DIR,
    allowedHosts: new Set(['oss.example.com']),
    logger,
    health: () => ({ gpu: 'software', chrome: 'Chrome Headless Shell 152.0.7977.30' }),
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () => new Promise((resolve) => server.close(() => resolve()))
})

afterEach(async () => {
  await close()
})

const send = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const post = (body: unknown) => send('/exports', body)

const withMain = (content: string, others: { path: string; content: string }[] = []) => [
  { path: 'index.html', content },
  ...others,
]

describe('渲染服务接口', () => {
  it('POST /exports 合法时答 202，可以查询任务的渲染状态', async () => {
    const response = await post(exportRequest())
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ id: '11111111-2222-4333-8444-555555555555' })
    await flush()
    const status = await (
      await fetch(`${base}/exports/11111111-2222-4333-8444-555555555555`)
    ).json()
    expect(status).toEqual({
      id: '11111111-2222-4333-8444-555555555555',
      conversationId: '99999999-8888-4777-8666-555555555555',
      status: 'rendering',
      progress: 0,
      queuePosition: null,
      error: null,
    })
  })

  it('受理后交给渲染的是原样的工程文件、主文件里素材地址到下载地址的对应和公共目录', async () => {
    const component = {
      path: 'compositions/fixtures/fixture-fields.html',
      content: '<html></html>',
    }
    const files = withMain(mainFile([video(), host({ track: 1 })]), [component])
    expect((await post(exportRequest({ files }))).status).toBe(202)
    await flush()
    expect(renders[0]).toMatchObject({ files, vendorDir: VENDOR_DIR })
    expect(renders[0]?.media).toEqual(
      new Map([[CLIP_URL, 'https://oss.example.com/clip.mp4?sig=1']]),
    )
  })

  it('主文件里有音频片段：音频也要给下载地址，隐藏的音频片段也一样', async () => {
    const files = withMain(mainFile([video(), audio({ hidden: true })]))
    const missing = await post(exportRequest({ files }))
    expect(missing.status).toBe(400)
    expect(await missing.json()).toMatchObject({ code: 'missing-media' })

    const request = exportRequest({ files })
    const audioDownload = 'https://oss.example.com/music.mp3?sig=2'
    const media = { ...(request['media'] as object), [AUDIO_URL]: { url: audioDownload } }
    expect((await post({ ...request, media })).status).toBe(202)
    await flush()
    expect(renders[0]?.media.get(AUDIO_URL)).toBe(audioDownload)
  })

  it('素材表里多给的地址不下载', async () => {
    const request = exportRequest()
    const media = {
      ...(request['media'] as object),
      'https://media.iclip.test/unused.mp4': { url: 'https://oss.example.com/unused.mp4' },
    }
    expect((await post({ ...request, media })).status).toBe(202)
    await flush()
    expect([...(renders[0]?.media.keys() ?? [])]).toEqual([CLIP_URL])
  })

  it.each<[string, unknown, string]>([
    ['请求体不是 JSON', '{oops', 'invalid-request'],
    ['形状不对', { ...exportRequest(), id: 'nope' }, 'invalid-request'],
    ['没有工程文件', { ...exportRequest(), files: [] }, 'invalid-request'],
    [
      '素材主机不在白名单',
      exportRequest({ mediaHost: 'evil.example.net' }),
      'media-host-not-allowed',
    ],
    ['文件里的素材没有给下载地址', { ...exportRequest(), media: {} }, 'missing-media'],
    [
      '工程里没有主文件',
      exportRequest({ files: [{ path: 'main.html', content: mainFile() }] }),
      'invalid-project',
    ],
    ...(
      [
        ['../escape.html', '往上跳出工程'],
        ['a/../../escape.html', '中间带 ..'],
        ['./index2.html', '带 . 段'],
        ['/etc/passwd', '以 / 开头'],
        ['compositions/', '以 / 结尾'],
        ['a//b.html', '空段'],
        ['a\\b.html', '反斜杠'],
        ['a\u0000b.html', '控制字符'],
        ['vendor/npm/gsap.js', '以 vendor/ 开头'],
        ['vendor', '就叫 vendor'],
        ['Vendor/x.js', '大小写不同的 vendor'],
      ] as const
    ).map(([path, why]): [string, unknown, string] => [
      `工程文件的路径${why}`,
      exportRequest({ files: withMain(mainFile(), [{ path, content: 'x' }]) }),
      'invalid-project',
    ]),
    [
      '工程文件重复',
      exportRequest({
        files: withMain(mainFile(), [
          { path: 'a.html', content: '1' },
          { path: 'a.html', content: '2' },
        ]),
      }),
      'invalid-project',
    ],
    [
      '一个路径既是文件又是目录',
      exportRequest({
        files: withMain(mainFile(), [
          { path: 'a', content: '1' },
          { path: 'a/b.html', content: '2' },
        ]),
      }),
      'invalid-project',
    ],
  ])('%s时答 400（%s），不排进队列', async (_, body, code) => {
    const response = await post(body)
    expect(response.status).toBe(400)
    const payload = (await response.json()) as { code: string; message: string }
    expect(payload.code).toBe(code)
    expect(payload.message.length).toBeGreaterThan(0)
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({
      queue: { running: 0, waiting: 0 },
    })
  })

  it('同一 id 再提交答 409', async () => {
    expect((await post(exportRequest())).status).toBe(202)
    const response = await post(exportRequest())
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'duplicate-id' })
  })

  it('GET 不存在的任务答 404；DELETE 取消答 204，已是终态再取消也答 204，不存在答 404', async () => {
    expect((await fetch(`${base}/exports/missing`)).status).toBe(404)
    await post(exportRequest())
    await flush()
    const url = `${base}/exports/11111111-2222-4333-8444-555555555555`
    expect((await fetch(url, { method: 'DELETE' })).status).toBe(204)
    expect(((await (await fetch(url)).json()) as { status: string }).status).toBe('cancelled')
    expect((await fetch(url, { method: 'DELETE' })).status).toBe(204)
    expect((await fetch(`${base}/exports/missing`, { method: 'DELETE' })).status).toBe(404)
  })

  it('没有检查成片文件的接口：POST /films/check 答 404', async () => {
    const response = await send('/films/check', { film: mainFile() })
    expect(response.status).toBe(404)
  })

  it('GET /health 报告浏览器渲染方式、Chrome 版本与队列', async () => {
    await post(exportRequest())
    await post(exportRequest({ id: '22222222-2222-4333-8444-555555555555' }))
    await flush()
    expect(await (await fetch(`${base}/health`)).json()).toEqual({
      status: 'ok',
      gpu: 'software',
      chrome: 'Chrome Headless Shell 152.0.7977.30',
      queue: { running: 1, waiting: 1 },
    })
  })
})
