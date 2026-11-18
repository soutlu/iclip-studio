import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Plugin } from 'vite'
import { appOriginOfMockToken } from '../src/testing/mocks/preview-token.ts'

const HOST_PATH = /^\/api\/final-cut\/preview\/([^/]+)\/host$/
const FILES_PATH = /^\/api\/final-cut\/preview\/([^/]+)\/files\/(.+)$/
const VENDOR_DIR = 'vendor/'

const CATALOG_FILE = join(import.meta.dirname, '../public/hyperframes/catalog.json')

const answer = (response: ServerResponse, status: number, body: unknown) => {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

const redirect = (response: ServerResponse, location: string) => {
  response.statusCode = 307
  response.setHeader('Location', location)
  response.setHeader('Cache-Control', 'no-store')
  response.end()
}

/** 工程里的相对路径合不合规：照后端，不许空段、`.`、`..` 和反斜杠。 */
const projectPathOk = (path: string) =>
  !path.includes('\\') &&
  !path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')

/**
 * 按后端的规则回答预览页的两个地址：
 * - `GET /api/final-cut/preview/<令牌>/host`：令牌无效 403；请求的主机名就是应用自己的（在应用域名下
 *   打开了预览页）404；否则给出令牌里的应用来源。
 * - `GET /api/final-cut/preview/<令牌>/files/<路径>`：令牌无效 403，路径不合规 404；`vendor/` 开头的
 *   和后端一样 307 到公共目录。工程自己的文件在 mock 里没有存到预览域名这边，307 到公共组件库当前版本
 *   目录里的同名文件（组件文件按原路径拷进工程，名字一样）。
 */
const answerPreview = (request: IncomingMessage, response: ServerResponse, next: () => void) => {
  const path = request.url?.split('?')[0] ?? ''
  const host = HOST_PATH.exec(path)
  const files = FILES_PATH.exec(path)
  const token = host?.[1] ?? files?.[1]
  if (request.method !== 'GET' || token === undefined) {
    next()
    return
  }
  const appOrigin = appOriginOfMockToken(decodeURIComponent(token))
  if (appOrigin === null) {
    answer(response, 403, { detail: '预览令牌无效' })
    return
  }
  const hostname = new URL(`http://${request.headers.host ?? ''}`).hostname
  if (hostname === new URL(appOrigin).hostname) {
    answer(response, 404, { detail: 'Not Found' })
    return
  }
  if (host !== null) {
    answer(response, 200, { appOrigin })
    return
  }
  const file = decodeURIComponent(files?.[2] ?? '')
  if (!projectPathOk(file)) {
    answer(response, 404, { detail: 'final-cut 工程里没有这个文件' })
    return
  }
  if (file.startsWith(VENDOR_DIR)) {
    redirect(response, `/hyperframes/vendor/${encodeURI(file.slice(VENDOR_DIR.length))}`)
    return
  }
  const { version } = JSON.parse(readFileSync(CATALOG_FILE, 'utf8')) as { version: string }
  redirect(response, `/hyperframes/${version}/${encodeURI(file)}`)
}

/**
 * 只在 mock 模式下由 dev/preview 服务器提供预览页取应用来源、取工程文件的地址：预览页在另一个主机名上，
 * 应用页的 MSW 管不到它。
 */
export const mockPreviewHostPlugin = (): Plugin => ({
  configurePreviewServer(server) {
    server.middlewares.use(answerPreview)
  },
  configureServer(server) {
    server.middlewares.use(answerPreview)
  },
  name: 'cue-mock-preview-host',
})
