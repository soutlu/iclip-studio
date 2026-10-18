import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExportQueue } from './jobs'
import { createExportServer } from './server'
import { catalog, exportRequest, flush, manualWorker, memoryLogger } from './testing'

let base: string
let close: () => Promise<void>
let fake: ReturnType<typeof manualWorker>

beforeEach(async () => {
  fake = manualWorker()
  const { logger } = memoryLogger()
  const queue = new ExportQueue({ worker: fake.worker, logger, timeoutMs: 60_000 })
  const server = createExportServer({
    queue,
    catalog,
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

const post = (body: unknown) =>
  fetch(`${base}/exports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('渲染服务接口', () => {
  it('POST /exports 合法时答 202，任务排队后开始渲染，合成页里是草稿的内容', async () => {
    const response = await post(exportRequest())
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ id: '11111111-2222-4333-8444-555555555555' })
    await flush()
    expect(fake.renders).toHaveLength(1)
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

  it.each<[string, unknown, string]>([
    ['请求体不是 JSON', '{oops', 'invalid-request'],
    ['形状不对', { ...exportRequest(), id: 'nope' }, 'invalid-request'],
    [
      '素材主机不在白名单',
      exportRequest({ mediaHost: 'evil.example.net' }),
      'media-host-not-allowed',
    ],
    [
      '组件不在目录里',
      (() => {
        const body = exportRequest()
        const document = body['document'] as { overlays: { component: string }[] }
        document.overlays[0]!.component = 'no-such-component'
        return body
      })(),
      'unknown-component',
    ],
    [
      '片头组件当包装',
      (() => {
        const body = exportRequest()
        const document = body['document'] as { overlays: { component: string }[] }
        document.overlays[0]!.component = 'logo-sting'
        return body
      })(),
      'misplaced-component',
    ],
    [
      '成片没有给地址',
      (() => {
        const body = exportRequest()
        ;(body['media'] as { videos: Record<string, unknown> }).videos = {}
        return body
      })(),
      'missing-media',
    ],
    [
      '草稿没有画面',
      (() => {
        const body = exportRequest()
        const document = body['document'] as Record<string, unknown>
        document['layer0'] = []
        document['canvas'] = null
        return body
      })(),
      'invalid-draft',
    ],
  ])('%s时答 400（%s）', async (_, body, code) => {
    const response = await post(body)
    expect(response.status).toBe(400)
    const payload = (await response.json()) as { code: string; message: string }
    expect(payload.code).toBe(code)
    expect(payload.message.length).toBeGreaterThan(0)
    expect(fake.renders).toHaveLength(0)
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
