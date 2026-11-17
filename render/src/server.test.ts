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
let logLines: Record<string, unknown>[]

beforeEach(async () => {
  const manual = manualWorker()
  renders = manual.renders
  const { logger, lines } = memoryLogger()
  logLines = lines
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

const attr = (value: unknown) => JSON.stringify(value).replaceAll('"', '&quot;')

/** 根上声明了字幕变量和一个随语言字段的变量、贴片 t1 的「text」随语言的主文件。 */
const BOUND_MAIN = `<!doctype html><html data-composition-variables="${attr([
  { id: 'cap_a1', type: 'string', label: '字幕', default: '你好' },
  { id: 'txt_t1_text', type: 'string', label: '文字', default: '标题' },
])}"><head></head><body><div id="film" data-composition-id="film"><div id="t1" data-variable-values="${attr(
  { text: '标题' },
)}" data-locale-bindings="${attr({ text: 'txt_t1_text' })}"></div></div></body></html>`

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
    expect(renders[0]).toMatchObject({ files, variables: null, vendorDir: VENDOR_DIR })
    expect(renders[0]?.media).toEqual(
      new Map([[CLIP_URL, 'https://oss.example.com/clip.mp4?sig=1']]),
    )
  })

  it('中文（locale 是 null 或不带）：工程原样交给渲染，不给变量值，有值表也不读', async () => {
    const files = withMain(BOUND_MAIN, [{ path: 'locales/en.json', content: '{"cap_a1":1}' }])
    expect((await post({ ...exportRequest({ files }), locale: null })).status).toBe(202)
    expect(
      (await post(exportRequest({ files, id: '22222222-2222-4333-8444-555555555555' }))).status,
    ).toBe(202)
    await flush()
    expect(renders[0]).toMatchObject({ files, variables: null })
  })

  it('按语言导出：主文件里随语言的宿主换成那种语言的字，变量值是校验过的值表；没声明的变量去掉，日志只记条数', async () => {
    const table = '{"cap_a1":"Hello","txt_t1_text":"Title","stale_1":"旧的字"}'
    const files = withMain(BOUND_MAIN, [{ path: 'locales/en.json', content: table }])

    expect((await post({ ...exportRequest({ files }), locale: 'en' })).status).toBe(202)
    await flush()

    expect(renders[0]?.files).toEqual(
      withMain(BOUND_MAIN.replace(attr({ text: '标题' }), attr({ text: 'Title' })), files.slice(1)),
    )
    expect(renders[0]?.variables).toEqual({ cap_a1: 'Hello', txt_t1_text: 'Title' })
    const dropped = logLines.filter(
      (line) => line['event'] === '值表里有主文件没声明的变量，已去掉',
    )
    expect(dropped).toMatchObject([{ level: 'warn', locale: 'en', count: 1 }])
    expect(JSON.stringify(logLines)).not.toMatch(/旧的字|Hello|Title/)
  })

  it.each<[string, Record<string, unknown>, string]>([
    ['工程里没有这种语言的值表', { locale: 'de' }, 'invalid-locale'],
    ['值表里的值类型不对', { locale: 'en' }, 'invalid-locale'],
    ['不认识的语言', { locale: 'ja' }, 'invalid-request'],
    ['中文不用写成 zh', { locale: 'zh' }, 'invalid-request'],
  ])('按语言导出时%s：答 400（%s），不排进队列', async (_, extra, code) => {
    const files = withMain(BOUND_MAIN, [{ path: 'locales/en.json', content: '{"cap_a1":1}' }])
    const response = await post({ ...exportRequest({ files }), ...extra })
    expect(response.status).toBe(400)
    const payload = (await response.json()) as { code: string; message: string }
    expect(payload.code).toBe(code)
    // 给用户看的说明不带语言代码
    if (code === 'invalid-locale') expect(payload.message).not.toMatch(/\b(en|de|EN|DE)\b/)
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({
      queue: { running: 0, waiting: 0 },
    })
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

  it('POST /exports 的请求体类型不是 JSON 时答 415，不排进队列；JSON 带 charset 照常受理', async () => {
    const body = JSON.stringify(exportRequest())
    const plain = await fetch(`${base}/exports`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body,
    })
    expect(plain.status).toBe(415)
    expect(await plain.json()).toMatchObject({ code: 'unsupported-media-type' })
    const untyped = await fetch(`${base}/exports`, { method: 'POST', body: new Blob([body]) })
    expect(untyped.status).toBe(415)
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({
      queue: { running: 0, waiting: 0 },
    })

    const typed = await fetch(`${base}/exports`, {
      method: 'POST',
      headers: { 'Content-Type': 'Application/JSON; charset=utf-8' },
      body,
    })
    expect(typed.status).toBe(202)
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

  it('没有检查主文件的接口：POST /films/check 答 404', async () => {
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
