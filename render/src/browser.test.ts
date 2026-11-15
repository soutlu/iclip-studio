import { execFile } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startBrowserGuard, type BrowserGuard } from './browser'
import { memoryLogger } from './testing'

const run = promisify(execFile)

let dir: string
let guard: BrowserGuard
let lines: Record<string, unknown>[]
let proxyPort: number
let launched: string[]

beforeEach(async () => {
  // 路径里带单引号：启动脚本要原样转义
  dir = await mkdtemp(join(tmpdir(), "browser-guard-'q'-"))
  const browser = join(dir, 'fake-browser')
  await writeFile(browser, '#!/bin/sh\nfor arg in "$@"; do echo "$arg"; done\n')
  await chmod(browser, 0o755)
  const memory = memoryLogger()
  lines = memory.lines
  guard = await startBrowserGuard(browser, join(dir, 'launcher'), memory.logger)
  launched = (await run(guard.chromePath, ['--version', 'two words'])).stdout.trimEnd().split('\n')
  proxyPort = Number(/^--proxy-server=http:\/\/127\.0\.0\.1:(\d+)$/.exec(launched[0] ?? '')?.[1])
})

afterEach(async () => {
  await guard.close()
  await rm(dir, { recursive: true, force: true })
})

/** 经代理发一个 CONNECT，答复的状态码。 */
const tunnel = (target: string) =>
  new Promise<number>((resolve, reject) => {
    request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: target })
      .on('connect', (res, socket) => {
        socket.destroy()
        resolve(res.statusCode ?? 0)
      })
      .on('error', reject)
      .end()
  })

/** 经代理发一个普通请求，答复的状态码。 */
const forward = (url: string) =>
  new Promise<number>((resolve, reject) => {
    request({ host: '127.0.0.1', port: proxyPort, path: url }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
      .on('error', reject)
      .end()
  })

/** 直接往代理端口写 `text`，读到代理关掉连接为止，答复原文。 */
const raw = (text: string) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    connect(proxyPort, '127.0.0.1', function (this: Socket) {
      this.end(text)
    })
      .on('data', (chunk: Buffer) => chunks.push(chunk))
      .on('close', () => resolve(Buffer.concat(chunks).toString('latin1')))
      .on('error', reject)
  })

const blockedHosts = () =>
  lines.filter((line) => line['event'] === '拦截了渲染页面的外部请求').map((line) => line['host'])

describe('startBrowserGuard', () => {
  it('启动脚本带上代理参数、只让回环地址直连、不许 WebRTC 直连，再原样传上调用方的参数', () => {
    expect(launched).toEqual([
      `--proxy-server=http://127.0.0.1:${proxyPort}`,
      '--proxy-bypass-list=<-loopback>;localhost;127.0.0.0/8;[::1]',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--version',
      'two words',
    ])
  })

  it('代理一律答 403；每个被拦的主机只记一次 warn 日志', async () => {
    expect(await tunnel('outside.invalid:443')).toBe(403)
    expect(await tunnel('outside.invalid:443')).toBe(403)
    expect(await tunnel('192.0.2.1:443')).toBe(403)
    expect(await forward('http://169.254.169.254/latest/meta-data')).toBe(403)
    expect(blockedHosts()).toEqual(['outside.invalid', '192.0.2.1', '169.254.169.254'])
    expect(lines.every((line) => line['level'] === 'warn')).toBe(true)
  })

  it('乱写的请求也答拒绝，代理照常工作', async () => {
    expect(await raw('CONNECT %%% HTTP/1.1\r\n\r\n')).toMatch(/^HTTP\/1\.1 4\d\d /)
    expect(await raw('CONNECT :::: HTTP/1.1\r\nHost: x\r\n\r\n')).toMatch(/^HTTP\/1\.1 4\d\d /)
    expect(await forward('/relative')).toBe(403)
    expect(await tunnel('outside.invalid:443')).toBe(403)
  })
})
