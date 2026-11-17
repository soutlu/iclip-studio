import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type * as z from 'zod'
import type { ExportQueue } from './jobs'
import { localizeProject } from './locale'
import type { Logger } from './log'
import { MAIN_FILE, mediaAddresses, projectProblem } from './project'
import { disallowedMediaHosts, parseRequest, zExportRequest } from './request'

export interface ServerContext {
  queue: ExportQueue
  /** 公共目录（组件库根下的 `vendor/`）：渲染时工程里的 `vendor` 指向它。 */
  vendorDir: string
  allowedHosts: Set<string>
  logger: Logger
  health: () => { gpu: 'hardware' | 'software'; chrome: string }
}

// 工作区一段对话最多 20 MB；按 JSON 转义最坏翻倍，再给素材表和上传地址留出余量
const MAX_BODY = 48 * 1024 * 1024

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
    const message = error instanceof BodyTooLarge ? '请求体超过 48 MB' : '请求体不是 JSON'
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

/** 请求体的类型是不是 JSON（不看 charset 等参数）。 */
const isJson = (req: IncomingMessage) =>
  req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() === 'application/json'

async function createExport(req: IncomingMessage, res: ServerResponse, context: ServerContext) {
  // 渲染页面里的脚本能访问回环地址上的本服务；只收 JSON 类型，浏览器的跨源请求就得先过预检，页面发不出导出
  if (!isJson(req)) {
    fail(res, 415, 'unsupported-media-type', '请求体须为 application/json')
    return
  }
  const request = await readRequest(req, res, zExportRequest)
  if (!request) return
  const problem = projectProblem(request.files)
  if (problem !== undefined) {
    fail(res, 400, 'invalid-project', problem)
    return
  }
  const localized = localizeProject(request.files, request.locale ?? null)
  if (!localized.ok) {
    fail(res, 400, 'invalid-locale', localized.message)
    return
  }
  const { files, variables, dropped } = localized.value
  // 只记条数：值表里的字不进日志
  if (dropped > 0)
    context.logger.warn('值表里有主文件没声明的变量，已去掉', {
      exportId: request.id,
      locale: request.locale,
      count: dropped,
    })
  // 按导出的那种语言的主文件取素材：别的语言的配音不用下载
  const main = files.find((file) => file.path === MAIN_FILE)?.content ?? ''
  const downloads = new Map<string, string>()
  for (const address of mediaAddresses(main)) {
    const download = request.media[address]?.url
    if (download === undefined) {
      fail(res, 400, 'missing-media', `素材「${address}」缺少下载地址`)
      return
    }
    downloads.set(address, download)
  }
  const rejected = disallowedMediaHosts([...downloads.values()], context.allowedHosts)
  if (rejected.length > 0) {
    fail(res, 400, 'media-host-not-allowed', `素材地址的主机不在允许范围：${rejected.join('、')}`)
    return
  }
  const accepted = context.queue.submit({
    id: request.id,
    conversationId: request.conversationId,
    files,
    media: downloads,
    variables,
    vendorDir: context.vendorDir,
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
