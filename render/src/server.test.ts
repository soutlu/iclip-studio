import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExportQueue } from './jobs'
import type { ComponentLibrary } from './library'
import { createExportServer } from './server'
import { catalog, exportRequest, flush, manualWorker, memoryLogger } from './testing'

let base: string
let close: () => Promise<void>
let renders: ReturnType<typeof manualWorker>['renders']
/** 渲染服务每次受理时读到的组件库；用例可以换掉它，模拟发布了新的一版 */
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

const post = (body: unknown) =>
  fetch(`${base}/exports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

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
    const renamed = (component: string) => {
      const body = exportRequest({ id: crypto.randomUUID() })
      const document = body['document'] as { overlays: { component: string }[] }
      document.overlays[0]!.component = component
      return body
    }
    expect((await post(renamed('fixture-overlay-v2'))).status).toBe(400)

    const overlay = catalog.items.find((item) => item.name === 'fixture-overlay')!
    current = {
      catalog: {
        ...catalog,
        version: 'next',
        items: [...catalog.items, { ...overlay, name: 'fixture-overlay-v2' }],
      },
      dir: '/registry/next',
    }
    expect((await post(renamed('fixture-overlay-v2'))).status).toBe(202)
    await flush()
    expect(renders.map((render) => render.registryDir)).toEqual(['/registry/next'])
  })

  it('画面轨上只有组件段、没有视频也没有画布：照样受理并开始渲染', async () => {
    const body = exportRequest()
    body['document'] = {
      ...(body['document'] as Record<string, unknown>),
      canvas: null,
      layer0: [
        {
          id: 'c',
          type: 'component',
          start: 0,
          duration: 2000,
          playbackStart: 0,
          component: 'fixture-scene',
          variables: {},
        },
      ],
    }
    body['media'] = {
      videos: {},
      music: { url: 'https://oss.example.com/music.mp3' },
      subtitles: {},
    }
    const response = await post(body)
    expect(response.status).toBe(202)
    await flush()
    const { id } = (await response.json()) as { id: string }
    expect(await (await fetch(`${base}/exports/${id}`)).json()).toMatchObject({
      status: 'rendering',
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
      '素材片没有给地址',
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
