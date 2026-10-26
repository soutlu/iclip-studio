/**
 * 渲染服务的 HTTP 接口（compose 内网可达，不对外暴露，不鉴权）：
 *   POST   /exports        排队一个导出（202）；形状不对、素材主机不允许、合成失败答 400，同一 id 答 409
 *   GET    /exports/{id}   任务状态；没有这个任务答 404
 *   DELETE /exports/{id}   取消；终态也答 204；没有答 404
 *   GET    /health         服务状态、浏览器渲染方式（hardware / software）、Chrome 版本、队列
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  buildComposition,
  CompositionError,
} from '../../web/src/features/storyboard/whole-film/composition/build'
import type { ExportQueue } from './jobs'
import type { ComponentLibrary } from './library'
import type { Logger } from './log'
import { disallowedMediaHosts, parseExportRequest } from './request'

export interface ServerContext {
  queue: ExportQueue
  /** 当前的组件库；每次受理导出读一次，渲染用受理时那一版。 */
  library: () => Promise<ComponentLibrary>
  allowedHosts: Set<string>
  logger: Logger
  health: () => { gpu: 'hardware' | 'software'; chrome: string }
}

const MAX_BODY = 16 * 1024 * 1024

class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new BodyTooLarge()
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end()
    return
  }
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  })
  res.end(data)
}

const fail = (res: ServerResponse, status: number, code: string, message: string) =>
  send(res, status, { code, message })

async function createExport(req: IncomingMessage, res: ServerResponse, context: ServerContext) {
  let body: unknown
  try {
    body = JSON.parse(await readBody(req))
  } catch (error) {
    const message = error instanceof BodyTooLarge ? '请求体超过 16 MB' : '请求体不是 JSON'
    fail(res, 400, 'invalid-request', message)
    return
  }
  const parsed = parseExportRequest(body)
  if (!parsed.ok) {
    fail(res, 400, 'invalid-request', parsed.message)
    return
  }
  const { request } = parsed
  const rejected = disallowedMediaHosts(request, context.allowedHosts)
  if (rejected.length > 0) {
    fail(res, 400, 'media-host-not-allowed', `素材地址的主机不在允许范围：${rejected.join('、')}`)
    return
  }
  const library = await context.library()
  // 渲染时用取到本地的素材再生成一次；这里先按原地址生成，草稿有问题当场答 400。
  const compose = (paths: Readonly<Record<string, string>>) => {
    const local = (url: string) => paths[url] ?? url
    return buildComposition({
      draft: request.document,
      media: {
        videos: Object.fromEntries(
          Object.entries(request.media.videos).map(([id, video]) => [
            id,
            { url: local(video.url) },
          ]),
        ),
        music: request.media.music ? { url: local(request.media.music.url) } : null,
        subtitles: request.media.subtitles,
      },
      catalog: library.catalog,
    }).html
  }
  try {
    compose({})
  } catch (error) {
    if (error instanceof CompositionError) {
      fail(res, 400, error.code, error.message)
      return
    }
    throw error
  }
  // 只取草稿里真正用到的素材。
  const videoUrls = request.document.layer0.flatMap((clip) =>
    clip.type === 'video' ? [request.media.videos[clip.sourceJobId]?.url ?? ''] : [],
  )
  const musicUrl = request.document.music && request.media.music ? [request.media.music.url] : []
  const accepted = context.queue.submit({
    id: request.id,
    conversationId: request.conversationId,
    registryDir: library.dir,
    mediaUrls: [...new Set([...videoUrls, ...musicUrl])],
    compose,
    upload: request.upload,
  })
  if (!accepted) {
    fail(res, 409, 'duplicate-id', `导出 ${request.id} 已存在`)
    return
  }
  send(res, 202, { id: request.id })
}

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  context: ServerContext,
): Promise<void> {
  const { pathname } = new URL(req.url ?? '/', 'http://render')
  const exportId = /^\/exports\/([^/]+)$/.exec(pathname)?.[1]
  if (req.method === 'POST' && pathname === '/exports') {
    await createExport(req, res, context)
    return
  }
  if (exportId && req.method === 'GET') {
    const view = context.queue.get(decodeURIComponent(exportId))
    if (view) send(res, 200, view)
    else fail(res, 404, 'not-found', '没有这个导出')
    return
  }
  if (exportId && req.method === 'DELETE') {
    if (context.queue.cancel(decodeURIComponent(exportId))) send(res, 204)
    else fail(res, 404, 'not-found', '没有这个导出')
    return
  }
  if (req.method === 'GET' && pathname === '/health') {
    send(res, 200, { status: 'ok', ...context.health(), queue: context.queue.stats() })
    return
  }
  fail(res, 404, 'not-found', '没有这个接口')
}

export function createExportServer(context: ServerContext) {
  const server = createServer((req, res) => {
    handle(req, res, context).catch((error: unknown) => {
      context.logger.error('请求处理出错', { method: req.method, url: req.url, error })
      if (!res.headersSent) fail(res, 500, 'internal-error', '渲染服务内部错误')
      else res.end()
    })
  })
  // 空闲连接保持得比客户端（后端 httpx 默认 5 秒）久：渲染在同一个进程里，事件循环偶尔被占住时，
  // 按 Node 默认的 5 秒会在客户端正要复用连接时把它关掉，那一次请求就失败。
  server.keepAliveTimeout = 65_000
  server.headersTimeout = 66_000
  return server
}
