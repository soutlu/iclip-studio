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
import { declareLinkedFonts, undeclaredProjectFonts } from './fonts'
import { ExportFailure, type ExportWorker, type RenderedFile } from './jobs'
import { producerLogger, type Logger } from './log'
import { MAIN_FILE, VENDOR_DIR, withLocalMedia, type ProjectFile } from './project'
import { outputResolutionFor } from './resolution'
import { uploadFile } from './upload'

export interface RendererOptions {
  workDir: string
  /** 渲染使用的浏览器路径（由 `startBrowserGuard` 生成的启动脚本）。 */
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
 * 渲染前检测到 `data-composition-src` 指向的组件文件不可用（如缺失或非 HTML）时，
 * 返回问题文件及原因摘要；非此类错误时返回 undefined。
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

/** 将素材下载至 `dir`，返回「下载地址 → 相对 `dir` 的文件名」映射。 */
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
 * 将工程文件写入 `project` 目录（校验所有目标路径均落在工程根目录内），随后将公共资源目录拷贝至 `vendor/`。
 */
async function writeProject(project: string, files: readonly ProjectFile[], vendorDir: string) {
  const root = resolve(project)
  for (const file of files) {
    const target = resolve(root, file.path)
    if (!target.startsWith(`${root}${sep}`))
      throw new ExportFailure('render-failed', `工程文件「${file.path}」超出工程根目录范围`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content, { flag: 'wx' })
  }
  // 采用拷贝而非符号链接：渲染器仅允许读取工程目录内的文件，指向外部的符号链接会被拒绝；
  // 而放行外部文件的选项不支持 glb、wasm 等资源类型。设置 dereference 以展开公共目录中的符号链接。
  await cp(vendorDir, join(root, VENDOR_DIR), { recursive: true, dereference: true })
}

/**
 * 检查整个工程（含主文件及挂载的组件文件）：存在 error 时抛出 `lint-failed` 并列出前若干条「文件：code」；
 * 仅存在 warning 时记录警告日志并继续渲染。
 */
async function checkProject(project: string, log: Logger): Promise<void> {
  // 不传入入口文件路径，确保校验范围覆盖整个工程而非单个入口文件
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

/**
 * 检测工程中已使用但未通过 @font-face 声明的字体：渲染服务禁止访问外网，未声明字体将无法拉取并被静默回退。
 * 若存在此类字体则抛出 `font-missing`，message 为「、」分隔的字体名称列表。
 */
async function checkFonts(project: string, files: readonly ProjectFile[]): Promise<void> {
  const missing = await undeclaredProjectFonts(project, files)
  if (missing.length > 0) throw new ExportFailure('font-missing', missing.join('、'))
}

export function createProducerWorker(options: RendererOptions): ExportWorker {
  const producerConfig = resolveConfig({ browserGpuMode: 'auto', chromePath: options.chromePath })
  return {
    async render(job, { signal, onProgress }): Promise<RenderedFile> {
      await mkdir(options.workDir, { recursive: true })
      // 临时目录结构：project/ 存放工程文件，导出视频输出至其外层以避免与工程文件重名
      const dir = await mkdtemp(join(options.workDir, `export-${job.id}-`))
      const cleanup = () => rm(dir, { recursive: true, force: true })
      const log = options.logger.child({ exportId: job.id })
      try {
        const main = job.files.find((file) => file.path === MAIN_FILE)?.content ?? ''
        const outputResolution = outputResolutionFor(main, job.resolution)
        const project = join(dir, 'project')
        await writeProject(project, job.files, job.vendorDir)
        // 优先执行字体检查：工程检查虽会拦截部分缺字场景但仅返回规则码，此处可明确指出缺失的字体名称
        await checkFonts(project, job.files)
        await checkProject(project, log)
        // 素材下载至工程内新建的临时子目录（由 mkdtemp 生成唯一名称，避免与工程文件冲突）
        const mediaDir = await mkdtemp(join(project, 'media-'))
        const started = Date.now()
        const downloaded = await downloadMedia(
          job.media.values(),
          mediaDir,
          signal,
          options.mediaTimeoutMs ?? 10 * 60_000,
        )
        log.info('素材已取到', { count: downloaded.size, ms: Date.now() - started })
        // 仅在用于导出的主文件副本中将素材地址替换为本地路径
        const local = new Map(
          [...job.media].flatMap(([address, download]) => {
            const name = downloaded.get(download)
            return name === undefined ? [] : [[address, `${basename(mediaDir)}/${name}`] as const]
          }),
        )
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
          // 渲染器通过调整设备像素比按目标预设尺寸输出，保持工程画布本身的逻辑宽高不变
          ...(outputResolution === undefined ? {} : { outputResolution }),
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
        // 渲染前探测素材文件：视频片段标记为包含音轨，但对应素材文件实际无音频流
        if (extractSafeRenderErrorCode(error) === 'ASSET_MEDIA_TYPE_MISMATCH')
          throw new ExportFailure('media-mismatch', SILENT_SOURCE_TEXT)
        const unusable = unusableCompositions(error)
        if (unusable !== undefined)
          throw new ExportFailure('render-failed', `工程中的组件文件无法使用：${unusable}`)
        throw new ExportFailure(
          'render-failed',
          error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error),
        )
      }
    },
    upload: uploadFile,
  }
}
