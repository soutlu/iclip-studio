/**
 * 渲染服务入口：读配置 → 检查组件库与 Chrome → 探测浏览器渲染方式（hardware / software）与视频编码器
 * 并写进日志 → 起 HTTP 服务。启动时清掉上次留下的临时项目目录。
 */
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
import catalogJson from '../../web/src/features/storyboard/whole-film/catalog/catalog.json'
import type { ComponentCatalog } from '../../web/src/features/storyboard/whole-film/composition/catalog'
import { ConfigError, loadConfig } from './config'
import { ExportQueue } from './jobs'
import { createLogger } from './log'
import { restrictFetch } from './network'
import { createProducerWorker } from './renderer'
import { createExportServer } from './server'

const run = promisify(execFile)
// catalog.json 人工维护，形状即 ComponentCatalog（JSON 推不出字面量联合）。
const catalog = catalogJson as unknown as ComponentCatalog

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

  // 组件库按 HyperFrames 版本放在根目录下，与 web 镜像里 /hyperframes/<版本>/ 是同一份内容。
  const registryDir = join(config.registryRoot, catalog.version)
  const runtime = join(registryDir, catalog.runtime.hyperframes)
  if (!existsSync(runtime)) {
    logger.error('组件库不完整', { registryDir, missing: catalog.runtime.hyperframes })
    process.exit(1)
  }
  if (!existsSync(join(registryDir, '.hyperframes-sync.json'))) {
    logger.warn('组件库没有同步标记', { registryDir })
  }

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
    registryDir,
    hyperframes: catalog.version,
  })
  if (gpu === 'software') logger.warn('浏览器使用软件渲染', { reason: '探测不到可用的 GPU' })

  await rm(config.workDir, { recursive: true, force: true })
  const queue = new ExportQueue({
    worker: createProducerWorker({
      registryDir,
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
    catalog,
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
