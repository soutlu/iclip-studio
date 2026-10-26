import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { fixtureCatalog } from '../whole-film'
import { handlers } from './handlers'

/**
 * 组件库目录只在单测里由 MSW 给出（测试组件库的目录）；浏览器里的 mock 环境读组装好的
 * public/hyperframes/catalog.json，不经过这里。
 */
const componentCatalog = http.get('/hyperframes/catalog.json', () =>
  HttpResponse.json(fixtureCatalog),
)

export const server = setupServer(...handlers, componentCatalog)
