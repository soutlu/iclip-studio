import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { fixtureCatalog } from '../whole-film'
import { handlers } from './handlers'

const componentCatalog = http.get('/hyperframes/catalog.json', () =>
  HttpResponse.json(fixtureCatalog),
)

export const server = setupServer(...handlers, componentCatalog)
