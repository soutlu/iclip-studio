import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { fixtureCatalog } from '../final-cut'
import { handlers } from './handlers'

const componentCatalog = http.get('/hyperframes/catalog.json', () =>
  HttpResponse.json(fixtureCatalog),
)

/** 测试组件库当前版本目录里的条目文件：内容只写着自己的路径。 */
export const itemFileContent = (path: string) => `<!-- ${path} -->`

const itemFiles = http.get(`/hyperframes/${fixtureCatalog.version}/*`, ({ request }) =>
  HttpResponse.text(
    itemFileContent(new URL(request.url).pathname.replace(/^\/hyperframes\/[^/]+\//, '')),
  ),
)

export const server = setupServer(...handlers, componentCatalog, itemFiles)
