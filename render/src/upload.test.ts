import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExportFailure } from './jobs'
import { uploadFile } from './upload'

let dir: string
let server: Server | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'render-upload-'))
})

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
  await rm(dir, { recursive: true, force: true })
})

/** 本机上传目标：记下收到的头与内容，按给定状态码回答。 */
async function target(status: number) {
  const received: { headers: IncomingHttpHeaders; body: Buffer; method: string }[] = []
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks), method: req.method ?? '' })
      res.writeHead(status).end(status >= 400 ? '<Error><Code>AccessDenied</Code></Error>' : '')
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return { url: `http://127.0.0.1:${address.port}/exports/a.mp4?Signature=x`, received }
}

describe('uploadFile', () => {
  it('PUT 原样发送文件，带上给定的头与 Content-Length，不用分块传输', async () => {
    const file = join(dir, 'a.mp4')
    await writeFile(file, Buffer.alloc(300_000, 7))
    const { url, received } = await target(200)
    await uploadFile(
      file,
      { url, headers: { 'Content-Type': 'video/mp4', 'x-oss-object-acl': 'private' } },
      new AbortController().signal,
    )
    expect(received).toHaveLength(1)
    expect(received[0]!.method).toBe('PUT')
    expect(received[0]!.headers['content-length']).toBe('300000')
    expect(received[0]!.headers['transfer-encoding']).toBeUndefined()
    expect(received[0]!.headers['content-type']).toBe('video/mp4')
    expect(received[0]!.headers['x-oss-object-acl']).toBe('private')
    expect(received[0]!.body.equals(Buffer.alloc(300_000, 7))).toBe(true)
  })

  it('非 2xx 时抛出 upload-failed，说明带上状态码与回应', async () => {
    const file = join(dir, 'a.mp4')
    await writeFile(file, 'x')
    const { url } = await target(403)
    const error = await uploadFile(file, { url, headers: {} }, new AbortController().signal).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(ExportFailure)
    expect((error as ExportFailure).code).toBe('upload-failed')
    expect((error as ExportFailure).message).toContain('403')
    expect((error as ExportFailure).message).toContain('AccessDenied')
  })

  it('连不上上传地址时抛出 upload-failed', async () => {
    const file = join(dir, 'a.mp4')
    await writeFile(file, 'x')
    const error = await uploadFile(
      file,
      { url: 'http://127.0.0.1:1/a.mp4', headers: {} },
      new AbortController().signal,
    ).catch((caught: unknown) => caught)
    expect((error as ExportFailure).code).toBe('upload-failed')
  })
})
