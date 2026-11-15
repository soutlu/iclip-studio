import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { join } from 'node:path'
import type { Logger } from './log'

export interface BrowserGuard {
  /** 渲染引擎用的浏览器路径：一个启动脚本，带上参数再启动真实的浏览器。 */
  chromePath: string
  close(): Promise<void>
}

// 浏览器默认还会让链路本地地址（169.254/16、fe80::/10）绕过代理；`<-loopback>` 去掉默认的绕过规则，
// 只把回环地址加回来：渲染引擎在 localhost 上起的文件服务照常直连
const BYPASS = '<-loopback>;localhost;127.0.0.0/8;[::1]'

const FORBIDDEN = 'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/** 请求要去的主机；请求目标解析不出主机时原样给出（页面也能直接访问代理的端口）。 */
function targetHost(req: IncomingMessage): string {
  const target = req.url ?? ''
  try {
    return new URL(req.method === 'CONNECT' ? `http://${target}` : target).hostname || target
  } catch {
    return target.slice(0, 200)
  }
}

/**
 * 让渲染用的浏览器连不了回环以外的地址：在回环地址上开一个一律答 403 的代理，再在 `dir` 里写一个启动脚本，
 * 给真实的浏览器 `browser` 加上指向它的 `--proxy-server`。被拦的主机记一条 warn 日志，同一主机只记一次；
 * 被拦的请求在页面里就是加载失败，不让导出失败。
 */
export async function startBrowserGuard(
  browser: string,
  dir: string,
  logger: Logger,
): Promise<BrowserGuard> {
  const reported = new Set<string>()
  const refuse = (req: IncomingMessage) => {
    const host = targetHost(req)
    if (reported.has(host)) return
    reported.add(host)
    logger.warn('拦截了渲染页面的外部请求', { host })
  }
  // 页面的连接随时可能断开：套接字出错只是这一条连接作废，不能让服务崩掉
  const refuseSocket = (req: IncomingMessage, socket: Duplex) => {
    refuse(req)
    socket.on('error', () => socket.destroy())
    socket.end(FORBIDDEN)
  }
  const proxy = createServer((req, res) => {
    refuse(req)
    res.writeHead(403, { Connection: 'close' }).end()
  })
  proxy.on('connect', refuseSocket)
  proxy.on('upgrade', refuseSocket)
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject)
    proxy.listen(0, '127.0.0.1', () => {
      proxy.off('error', reject)
      resolve()
    })
  })
  const { port } = proxy.address() as AddressInfo

  await mkdir(dir, { recursive: true })
  const chromePath = join(dir, 'chrome-headless-shell')
  const flags = [
    `--proxy-server=http://127.0.0.1:${port}`,
    `--proxy-bypass-list=${BYPASS}`,
    // WebRTC 的 UDP 不走代理，默认会直连任意地址；只许它走代理，也就连不出去
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  ]
  await writeFile(chromePath, `#!/bin/sh\nexec ${[browser, ...flags].map(quote).join(' ')} "$@"\n`)
  await chmod(chromePath, 0o755)
  return {
    chromePath,
    close: () =>
      new Promise<void>((resolve) => {
        proxy.close(() => resolve())
        proxy.closeAllConnections()
      }),
  }
}
