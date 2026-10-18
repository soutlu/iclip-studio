import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { restrictFetch } from './network'
import { memoryLogger } from './testing'

let server: Server
let host: string
const original = globalThis.fetch

beforeEach(async () => {
  server = createServer((_, res) => res.writeHead(200).end('ok'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  globalThis.fetch = original
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('restrictFetch', () => {
  it('允许的主机照常访问；其他主机直接失败、不发请求，每个主机只记一次日志', async () => {
    const { logger, lines } = memoryLogger()
    restrictFetch(new Set([host]), logger)
    expect(await (await fetch(`http://${host}/a`)).text()).toBe('ok')
    await expect(fetch('https://fonts.googleapis.com/css2?family=Inter')).rejects.toThrow(
      '渲染服务不访问 fonts.googleapis.com',
    )
    await expect(fetch(new Request('https://fonts.googleapis.com/x'))).rejects.toThrow()
    expect(lines.filter((line) => line['event'] === '拦截了外部请求')).toEqual([
      expect.objectContaining({ host: 'fonts.googleapis.com', level: 'warn' }),
    ])
  })
})
