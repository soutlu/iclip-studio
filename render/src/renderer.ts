/**
 * 用 @hyperframes/producer 渲染一份合成页。临时项目目录里：组件库按同样的相对位置链接进来（合成页里
 * 组件与运行时的路径都相对组件目录根），素材先取到 media/ 下，合成页用本地路径引用它们；字体 CSS
 * 里的字体在合成页里先声明一次，HyperFrames 就不另补（见 fonts.ts）。
 *
 * 素材自己取而不交给 producer：producer 只取 https 且主机不是内网字面地址的素材，取不到时报的是笼统的
 * 渲染失败；自己取可以把「素材取不到」单独报出来（media-unreachable），producer 只读本地文件。
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { resolveConfig } from '@hyperframes/engine'
import { createRenderJob, executeRenderJob } from '@hyperframes/producer'
import { declareLinkedFonts } from './fonts'
import { ExportFailure, type ExportWorker, type RenderedFile } from './jobs'
import { producerLogger, type Logger } from './log'
import { uploadFile } from './upload'

export interface RendererOptions {
  /** 临时项目目录的父目录。 */
  workDir: string
  /** 有硬件视频编码器时用它编码。 */
  gpuEncode: boolean
  logger: Logger
  /** 单个素材下载的上限，默认 10 分钟。 */
  mediaTimeoutMs?: number
}

const describeUrl = (url: string) => {
  const parsed = new URL(url)
  return `${parsed.host}${parsed.pathname}`
}

/** 素材取到 dir/media/；返回「原地址 → 相对项目目录的路径」。取不到即 media-unreachable。 */
async function downloadMedia(
  urls: string[],
  dir: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Record<string, string>> {
  await mkdir(join(dir, 'media'), { recursive: true })
  const paths: Record<string, string> = {}
  for (const url of new Set(urls)) {
    const name = `${createHash('sha256').update(url).digest('hex').slice(0, 16)}${extname(new URL(url).pathname) || '.bin'}`
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      })
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new ExportFailure(
          'media-unreachable',
          `素材取不到：${describeUrl(url)}（${response.status}）`,
        )
      }
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        createWriteStream(join(dir, 'media', name)),
      )
    } catch (error) {
      if (signal.aborted || error instanceof ExportFailure) throw error
      throw new ExportFailure(
        'media-unreachable',
        `素材取不到：${describeUrl(url)}（${error instanceof Error ? error.message : String(error)}）`,
      )
    }
    paths[url] = `media/${name}`
  }
  return paths
}

export function createProducerWorker(options: RendererOptions): ExportWorker {
  const producerConfig = resolveConfig({ browserGpuMode: 'auto' })
  return {
    async render(job, { signal, onProgress }): Promise<RenderedFile> {
      await mkdir(options.workDir, { recursive: true })
      const dir = await mkdtemp(join(options.workDir, `export-${job.id}-`))
      const cleanup = () => rm(dir, { recursive: true, force: true })
      const log = options.logger.child({ exportId: job.id })
      try {
        for (const entry of await readdir(job.registryDir)) {
          if (entry.startsWith('.')) continue
          await symlink(join(job.registryDir, entry), join(dir, entry))
        }
        const started = Date.now()
        const paths = await downloadMedia(
          job.mediaUrls,
          dir,
          signal,
          options.mediaTimeoutMs ?? 10 * 60_000,
        )
        log.info('素材已取到', { count: job.mediaUrls.length, ms: Date.now() - started })
        await writeFile(
          join(dir, 'index.html'),
          await declareLinkedFonts(job.compose(paths), job.registryDir),
        )
        const output = join(dir, 'export.mp4')
        const renderJob = createRenderJob({
          fps: 30,
          quality: 'standard',
          format: 'mp4',
          useGpu: options.gpuEncode,
          producerConfig,
          logger: producerLogger(log),
        })
        await executeRenderJob(
          renderJob,
          dir,
          output,
          (progressJob) => onProgress(progressJob.progress / 100),
          signal,
        )
        return { file: output, cleanup }
      } catch (error) {
        await cleanup()
        if (signal.aborted || error instanceof ExportFailure) throw error
        throw new ExportFailure(
          'render-failed',
          error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error),
        )
      }
    },
    upload: uploadFile,
  }
}
