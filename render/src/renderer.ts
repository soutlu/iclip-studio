import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { lintProject } from '@hyperframes/core/lint'
import { resolveConfig } from '@hyperframes/engine'
import {
  createRenderJob,
  executeRenderJob,
  extractSafeRenderErrorCode,
} from '@hyperframes/producer'
import { declareLinkedFonts } from './fonts'
import { ExportFailure, type ExportWorker, type RenderedFile } from './jobs'
import { producerLogger, type Logger } from './log'
import { MAIN_FILE, VENDOR_DIR, withLocalMedia, type ProjectFile } from './project'
import { uploadFile } from './upload'

export interface RendererOptions {
  workDir: string
  /** 渲染用的浏览器：`startBrowserGuard` 给的启动脚本。 */
  chromePath: string
  gpuEncode: boolean
  logger: Logger
  mediaTimeoutMs?: number
}

/** 报错时列出的检查结果条数。 */
const LISTED_FINDINGS = 5

const SILENT_SOURCE_TEXT =
  '有视频片段标记为有声音，但素材文件没有声音，无法导出；请将该视频片段设为静音后重新导出'

/**
 * 渲染前查到 `data-composition-src` 指的文件用不了（不在工程里、不是 HTML 等）时，列出是哪些文件、
 * 什么原因；不是这种错误时是 undefined。
 */
function unusableCompositions(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const { code, problems } = error as { code?: unknown; problems?: unknown }
  if (code !== 'EMPTY_COMPOSITION' || !Array.isArray(problems)) return undefined
  return (problems as { srcPath?: unknown; detail?: unknown }[])
    .map((problem) => `${String(problem.srcPath)}（${String(problem.detail)}）`)
    .join('、')
}

const describeUrl = (url: string) => {
  const parsed = new URL(url)
  return `${parsed.host}${parsed.pathname}`
}

/** 把素材下载进 `dir`，答复下载地址 → 相对 `dir` 的文件名。 */
async function downloadMedia(
  urls: Iterable<string>,
  dir: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Map<string, string>> {
  const paths = new Map<string, string>()
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
          `素材下载失败：${describeUrl(url)}（${response.status}）`,
        )
      }
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        createWriteStream(join(dir, name)),
      )
    } catch (error) {
      if (signal.aborted || error instanceof ExportFailure) throw error
      throw new ExportFailure(
        'media-unreachable',
        `素材下载失败：${describeUrl(url)}（${error instanceof Error ? error.message : String(error)}）`,
      )
    }
    paths.set(url, name)
  }
  return paths
}

/**
 * 把工程文件写进 `project`：每个路径都要落在 `project` 里面。再把公共目录整个拷成工程里的 `vendor`。
 */
async function writeProject(project: string, files: readonly ProjectFile[], vendorDir: string) {
  const root = resolve(project)
  for (const file of files) {
    const target = resolve(root, file.path)
    if (!target.startsWith(`${root}${sep}`))
      throw new ExportFailure('render-failed', `工程文件「${file.path}」不在工程目录里`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content, { flag: 'wx' })
  }
  // 拷贝而不用软链：渲染器只取工程目录里的文件，软链到工程外的取不到；放行工程外文件的开关又不放
  // glb、wasm 这类类型。dereference：公共目录里有软链时拷它指向的内容，不把链接原样拷进工程
  await cp(vendorDir, join(root, VENDOR_DIR), { recursive: true, dereference: true })
}

/**
 * 检查整个工程（主文件和它挂载的组件文件）：有 error 时以 `lint-failed` 失败，列出前几条「文件：code」；
 * 只有 warning 时记一条日志，照常渲染。
 */
async function checkProject(project: string, log: Logger): Promise<void> {
  // 不传入口文件：传了只查入口这一个文件
  const result = await lintProject(project, undefined, { host: 'studio' })
  const findings = result.results.flatMap(({ file, result: { findings } }) =>
    findings.map((finding) => ({ ...finding, file })),
  )
  if (result.totalErrors > 0) {
    const listed = findings
      .filter((finding) => finding.severity === 'error')
      .slice(0, LISTED_FINDINGS)
      .map((finding) => `${finding.file}：${finding.code}`)
      .join('、')
    throw new ExportFailure(
      'lint-failed',
      `工程检查有 ${result.totalErrors} 个错误：${listed}${result.totalErrors > LISTED_FINDINGS ? '等' : ''}`,
    )
  }
  if (result.totalWarnings > 0) {
    const codes = findings
      .filter((finding) => finding.severity === 'warning')
      .map((finding) => finding.code)
    log.warn('工程检查有警告', { count: result.totalWarnings, codes: [...new Set(codes)] })
  }
}

export function createProducerWorker(options: RendererOptions): ExportWorker {
  const producerConfig = resolveConfig({ browserGpuMode: 'auto', chromePath: options.chromePath })
  return {
    async render(job, { signal, onProgress }): Promise<RenderedFile> {
      await mkdir(options.workDir, { recursive: true })
      // 临时目录里：project/ 是工程，导出的视频放在工程外面，不会和工程文件同名
      const dir = await mkdtemp(join(options.workDir, `export-${job.id}-`))
      const cleanup = () => rm(dir, { recursive: true, force: true })
      const log = options.logger.child({ exportId: job.id })
      try {
        const project = join(dir, 'project')
        await writeProject(project, job.files, job.vendorDir)
        await checkProject(project, log)
        // 素材放进工程里新建的目录：目录名由 mkdtemp 取，不会和工程文件重名
        const mediaDir = await mkdtemp(join(project, 'media-'))
        const started = Date.now()
        const downloaded = await downloadMedia(
          job.media.values(),
          mediaDir,
          signal,
          options.mediaTimeoutMs ?? 10 * 60_000,
        )
        log.info('素材已取到', { count: downloaded.size, ms: Date.now() - started })
        // 只在导出用的这一份主文件里换素材地址
        const local = new Map(
          [...job.media].flatMap(([address, download]) => {
            const name = downloaded.get(download)
            return name === undefined ? [] : [[address, `${basename(mediaDir)}/${name}`] as const]
          }),
        )
        const main = job.files.find((file) => file.path === MAIN_FILE)?.content ?? ''
        await writeFile(
          join(project, MAIN_FILE),
          await declareLinkedFonts(withLocalMedia(main, local), project),
        )
        const output = join(dir, 'export.mp4')
        const renderJob = createRenderJob({
          fps: 30,
          quality: 'standard',
          format: 'mp4',
          useGpu: options.gpuEncode,
          ...(job.variables === null ? {} : { variables: { ...job.variables } }),
          producerConfig,
          logger: producerLogger(log),
        })
        await executeRenderJob(
          renderJob,
          project,
          output,
          (progressJob) => onProgress(progressJob.progress / 100),
          signal,
        )
        return { file: output, cleanup }
      } catch (error) {
        await cleanup()
        if (signal.aborted || error instanceof ExportFailure) throw error
        // 渲染前逐个探测素材文件：标了有声音的视频片段，素材里却没有音轨
        if (extractSafeRenderErrorCode(error) === 'ASSET_MEDIA_TYPE_MISMATCH')
          throw new ExportFailure('media-mismatch', SILENT_SOURCE_TEXT)
        const unusable = unusableCompositions(error)
        if (unusable !== undefined)
          throw new ExportFailure('render-failed', `工程里的组件文件无法使用：${unusable}`)
        throw new ExportFailure(
          'render-failed',
          error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error),
        )
      }
    },
    upload: uploadFile,
  }
}
