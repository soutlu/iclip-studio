import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  detectGpuEncoder,
  resolveBrowserGpuMode,
  resolveHeadlessShellPath,
} from '@hyperframes/engine'
import { startBrowserGuard } from './browser'
import { ConfigError, loadConfig } from './config'
import { ExportQueue } from './jobs'
import { createLogger } from './log'
import { restrictFetch } from './network'
import { createProducerWorker } from './renderer'
import { createExportServer } from './server'

const run = promisify(execFile)

async function main(): Promise<void> {
  const bootLogger = createLogger()
  let config
  try {
    config = loadConfig()
  } catch (error) {
    if (error instanceof ConfigError) {
      bootLogger.error('配置不完整', { message: error.message })
      process.exit(1)
    }
    throw error
  }
  const logger = createLogger(config.logLevel)
  restrictFetch(config.allowedHosts, logger)

  const browser = resolveHeadlessShellPath()
  if (!browser) {
    logger.error('找不到 chrome-headless-shell', {
      hint: '设置 PRODUCER_HEADLESS_SHELL_PATH 或用 @puppeteer/browsers 安装',
    })
    process.exit(1)
  }
  // 启动脚本放在 workDir 里：先清空 workDir 再写
  await rm(config.workDir, { recursive: true, force: true })
  const { chromePath } = await startBrowserGuard(browser, join(config.workDir, 'browser'), logger)
  const chrome = (await run(chromePath, ['--version'])).stdout.trim()
  const gpu = await resolveBrowserGpuMode('auto', { chromePath })
  const encoder = await detectGpuEncoder()
  logger.info('渲染环境', {
    chrome,
    chromePath: browser,
    gpu,
    videoEncoder: encoder ?? 'libx264（软件）',
    registryRoot: config.registryRoot,
  })
  if (gpu === 'software') logger.warn('浏览器使用软件渲染', { reason: '探测不到可用的 GPU' })

  const vendorDir = join(config.registryRoot, 'vendor')
  if (!existsSync(vendorDir)) {
    logger.error('组件库里没有公共目录', { vendorDir, hint: '检查 RENDER_REGISTRY_ROOT 的挂载' })
    process.exit(1)
  }

  const queue = new ExportQueue({
    worker: createProducerWorker({
      workDir: config.workDir,
      chromePath,
      gpuEncode: encoder !== null,
      logger,
    }),
    logger,
    timeoutMs: config.timeoutMs,
  })
  const sweeper = setInterval(() => queue.sweep(), 60_000)
  sweeper.unref()

  const server = createExportServer({
    queue,
    vendorDir,
    allowedHosts: config.allowedHosts,
    logger,
    health: () => ({ gpu, chrome }),
  })
  server.listen(config.port, () => {
    logger.info('渲染服务已启动', {
      port: config.port,
      allowedMediaHosts: [...config.allowedHosts],
    })
  })

  const shutdown = (signal: string) => {
    logger.info('渲染服务退出', { signal })
    server.close()
    queue.cancelAll()
    void queue
      .settled()
      .then(() => rm(config.workDir, { recursive: true, force: true }))
      .finally(() => process.exit(0))
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

await main()
