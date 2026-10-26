/**
 * 渲染服务入口：读配置 → 检查 Chrome → 探测浏览器渲染方式（hardware / software）与视频编码器
 * 并写进日志 → 起 HTTP 服务。启动时清掉上次留下的临时项目目录。组件库每次受理导出时读（见 library.ts）。
 */
import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import {
  detectGpuEncoder,
  resolveBrowserGpuMode,
  resolveHeadlessShellPath,
} from '@hyperframes/engine'
import { ConfigError, loadConfig } from './config'
import { ExportQueue } from './jobs'
import { loadLibrary } from './library'
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

  const chromePath = resolveHeadlessShellPath()
  if (!chromePath) {
    logger.error('找不到 chrome-headless-shell', {
      hint: '设置 PRODUCER_HEADLESS_SHELL_PATH 或用 @puppeteer/browsers 安装',
    })
    process.exit(1)
  }
  const chrome = (await run(chromePath, ['--version'])).stdout.trim()
  const gpu = await resolveBrowserGpuMode('auto', { chromePath })
  const encoder = await detectGpuEncoder()
  logger.info('渲染环境', {
    chrome,
    chromePath,
    gpu,
    videoEncoder: encoder ?? 'libx264（软件）',
    registryRoot: config.registryRoot,
  })
  if (gpu === 'software') logger.warn('浏览器使用软件渲染', { reason: '探测不到可用的 GPU' })

  await rm(config.workDir, { recursive: true, force: true })
  const queue = new ExportQueue({
    worker: createProducerWorker({
      workDir: config.workDir,
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
    library: () => loadLibrary(config.registryRoot),
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
