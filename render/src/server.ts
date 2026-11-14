import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type * as z from 'zod'
import { checkFilm, FilmProblem, localizedFilm, type CheckedFilm } from './film'
import type { ExportQueue } from './jobs'
import type { ComponentLibrary } from './library'
import type { Logger } from './log'
import { disallowedMediaHosts, parseRequest, zCheckRequest, zExportRequest } from './request'

export interface ServerContext {
  queue: ExportQueue
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

/** 读请求体并按 `schema` 校验；不合格时已经答复了 400，返回 null。 */
async function readRequest<T>(
  req: IncomingMessage,
  res: ServerResponse,
  schema: z.ZodType<T>,
): Promise<T | null> {
  let body: unknown
  try {
    body = JSON.parse(await readBody(req))
  } catch (error) {
    const message = error instanceof BodyTooLarge ? '请求体超过 16 MB' : '请求体不是 JSON'
    fail(res, 400, 'invalid-request', message)
    return null
  }
  const parsed = parseRequest(schema, body)
  if (!parsed.ok) {
    fail(res, 400, 'invalid-request', parsed.message)
    return null
  }
  return parsed.request
}

/** 检查成片文件；不合写法时已经答复了 400，返回 null。 */
async function checked(
  res: ServerResponse,
  film: string,
  library: ComponentLibrary,
  logger: Logger,
): Promise<CheckedFilm | null> {
  try {
    return await checkFilm(film, library.catalog)
  } catch (error) {
    if (!(error instanceof FilmProblem)) throw error
    logger.warn('成片文件没通过检查', { message: error.message, detail: error.detail })
    fail(res, 400, 'invalid-film', error.message)
    return null
  }
}

async function checkFilmFile(req: IncomingMessage, res: ServerResponse, context: ServerContext) {
  const request = await readRequest(req, res, zCheckRequest)
  if (!request) return
  const found = await checked(res, request.film, await context.library(), context.logger)
  if (!found) return
  send(res, 200, { html: found.html, durationMs: found.durationMs, sources: found.sources })
}

async function createExport(req: IncomingMessage, res: ServerResponse, context: ServerContext) {
  const request = await readRequest(req, res, zExportRequest)
  if (!request) return
  const library = await context.library()
  const found = await checked(res, request.film, library, context.logger)
  if (!found) return
  if (found.film.clips.length === 0) {
    fail(res, 400, 'invalid-film', '成片暂无内容，无法导出；请先加入内容')
    return
  }
  const downloads = new Map<string, string>()
  for (const { url } of found.sources) {
    const download = request.media[url]?.url
    if (download === undefined) {
      fail(res, 400, 'missing-media', `素材「${url}」缺少下载地址`)
      return
    }
    downloads.set(url, download)
  }
  const rejected = disallowedMediaHosts([...downloads.values()], context.allowedHosts)
  if (rejected.length > 0) {
    fail(res, 400, 'media-host-not-allowed', `素材地址的主机不在允许范围：${rejected.join('、')}`)
    return
  }
  const compose = (paths: Readonly<Record<string, string>>) => {
    const local = Object.fromEntries(
      [...downloads].flatMap(([url, download]) => {
        const path = paths[download]
        return path === undefined ? [] : [[url, path]]
      }),
    )
    return localizedFilm(found.film, local, library.catalog)
  }
  const accepted = context.queue.submit({
    id: request.id,
    conversationId: request.conversationId,
    registryDir: library.dir,
    mediaUrls: [...new Set(downloads.values())],
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
  if (req.method === 'POST' && pathname === '/films/check') {
    await checkFilmFile(req, res, context)
    return
  }
  if (exportId && req.method === 'GET') {
    const view = context.queue.get(decodeURIComponent(exportId))
    if (view) send(res, 200, view)
    else fail(res, 404, 'not-found', '该导出不存在')
    return
  }
  if (exportId && req.method === 'DELETE') {
    if (context.queue.cancel(decodeURIComponent(exportId))) send(res, 204)
    else fail(res, 404, 'not-found', '该导出不存在')
    return
  }
  if (req.method === 'GET' && pathname === '/health') {
    send(res, 200, { status: 'ok', ...context.health(), queue: context.queue.stats() })
    return
  }
  fail(res, 404, 'not-found', '该接口不存在')
}

export function createExportServer(context: ServerContext) {
  const server = createServer((req, res) => {
    handle(req, res, context).catch((error: unknown) => {
      context.logger.error('请求处理出错', { method: req.method, url: req.url, error })
      if (!res.headersSent) fail(res, 500, 'internal-error', '渲染服务内部错误')
      else res.end()
    })
  })
  // keepAliveTimeout 需大于后端 httpx 默认的 5 秒空闲复用窗口，避免复用瞬间连接被服务端关闭。
  server.keepAliveTimeout = 65_000
  server.headersTimeout = 66_000
  return server
}
