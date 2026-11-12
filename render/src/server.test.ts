import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExportQueue } from './jobs'
import type { ComponentLibrary } from './library'
import { createExportServer } from './server'
import {
  catalog,
  CLIP_URL,
  exportRequest,
  filmFile,
  flush,
  manualWorker,
  memoryLogger,
  picture,
  SOURCE_JOB,
} from './testing'

let base: string
let close: () => Promise<void>
let renders: ReturnType<typeof manualWorker>['renders']
let current: ComponentLibrary

beforeEach(async () => {
  const manual = manualWorker()
  renders = manual.renders
  current = { catalog, dir: '/registry/test-fixtures' }
  const { logger } = memoryLogger()
  const queue = new ExportQueue({ worker: manual.worker, logger, timeoutMs: 60_000 })
  const server = createExportServer({
    queue,
    library: async () => current,
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
const check = (body: unknown) => send('/films/check', body)

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

  it('每次受理都读当前的组件库：发布新的一版后不用重启，任务用受理时那一版的目录', async () => {
    expect((await post(exportRequest({ id: crypto.randomUUID() }))).status).toBe(202)
    current = { catalog: { ...catalog, version: 'next' }, dir: '/registry/next' }
    expect((await post(exportRequest({ id: crypto.randomUUID() }))).status).toBe(202)
    await flush()
    await renders[0]?.pending.reject(new Error('stop'))
    await flush()
    expect(renders.map((render) => render.registryDir)).toEqual([
      '/registry/test-fixtures',
      '/registry/next',
    ])
  })

  it('渲染用的那一份：文件里的素材地址换成下载到本地的路径，别的不变', async () => {
    expect((await post(exportRequest())).status).toBe(202)
    await flush()
    const local = renders[0]!.compose({ 'https://oss.example.com/clip.mp4?sig=1': 'media/a.mp4' })
    expect(local).toBe(filmFile().replaceAll(CLIP_URL, 'media/a.mp4'))
  })

  it.each<[string, unknown, string]>([
    ['请求体不是 JSON', '{oops', 'invalid-request'],
    ['形状不对', { ...exportRequest(), id: 'nope' }, 'invalid-request'],
    [
      '素材主机不在白名单',
      exportRequest({ mediaHost: 'evil.example.net' }),
      'media-host-not-allowed',
    ],
    ['文件里的素材没有给下载地址', { ...exportRequest(), media: {} }, 'missing-media'],
    [
      '成片文件里有脚本',
      {
        ...exportRequest(),
        film: filmFile().replace('</div>', '<script>alert(1)</script></div>'),
      },
      'invalid-film',
    ],
    ['成片里还没有画面', { ...exportRequest(), film: filmFile([]), media: {} }, 'invalid-film'],
  ])('%s时答 400（%s）', async (_, body, code) => {
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

  it('POST /films/check 合写法时答 200：重写后的文件、总时长和用到的素材', async () => {
    const second = picture({ id: 'clip-2', start: 2000, duration: 1500, mediaStart: 3000 })
    const response = await check({ film: filmFile([picture(), second]) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      html: filmFile([picture(), second]),
      durationMs: 3500,
      sources: [{ jobId: SOURCE_JOB, url: CLIP_URL }],
    })
  })

  it.each<[string, unknown, string]>([
    ['没有成片文件', {}, 'invalid-request'],
    [
      '文件不合写法',
      { film: filmFile().replace('<video ', '<video onerror="alert(1)" ') },
      'invalid-film',
    ],
  ])('POST /films/check %s时答 400（%s）', async (_, body, code) => {
    const response = await check(body)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code })
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
