/**
 * 导出任务：只在内存里，先进先出、一次一个。状态 queued → rendering → uploading → done，
 * 失败为 failed，取消为 cancelled。终态后保留 1 小时，进行中的不过期；服务重启后全部丢失。
 */
import type { Logger } from './log'

export type ExportStatus = 'queued' | 'rendering' | 'uploading' | 'done' | 'failed' | 'cancelled'

export type FailureCode = 'render-failed' | 'upload-failed' | 'media-unreachable' | 'timeout'

/** 渲染或上传失败；`code` 原样出现在 GET /exports/{id} 的 error 里。 */
export class ExportFailure extends Error {
  readonly code: FailureCode

  constructor(code: FailureCode, message: string) {
    super(message)
    this.name = 'ExportFailure'
    this.code = code
  }
}

/** 渲染出的文件；cleanup 删掉临时目录。 */
export interface RenderedFile {
  file: string
  cleanup(): Promise<void>
}

export interface UploadTarget {
  url: string
  headers: Record<string, string>
}

/**
 * 要渲染的内容：受理时那一版组件库的目录、素材地址，以及按「素材地址 → 渲染时用的地址」生成合成页的函数
 * （渲染器先把素材取到本地，再用本地路径生成合成页）。
 */
export interface RenderJobInput {
  id: string
  /** 组件库这一版的目录（`<RENDER_REGISTRY_ROOT>/<version>/`），合成页里组件与运行时的路径都相对它。 */
  registryDir: string
  mediaUrls: string[]
  compose(mediaPaths: Readonly<Record<string, string>>): string
}

/** 实际干活的部分：渲染合成页、上传成片。测试里换成假的。 */
export interface ExportWorker {
  render(
    job: RenderJobInput,
    options: { signal: AbortSignal; onProgress: (progress: number) => void },
  ): Promise<RenderedFile>
  upload(file: string, target: UploadTarget, signal: AbortSignal): Promise<void>
}

export interface ExportInput extends RenderJobInput {
  conversationId: string
  upload: UploadTarget
}

export interface ExportView {
  id: string
  conversationId: string
  status: ExportStatus
  progress: number
  queuePosition: number | null
  error: { code: FailureCode; message: string } | null
}

interface ExportRecord {
  input: ExportInput
  status: ExportStatus
  progress: number
  error: { code: FailureCode; message: string } | null
  finishedAt: number | null
  controller: AbortController | null
}

const TERMINAL = new Set<ExportStatus>(['done', 'failed', 'cancelled'])

export interface QueueOptions {
  worker: ExportWorker
  logger: Logger
  /** 一个任务从开始渲染到上传完成的上限，超时即 failed（timeout）。 */
  timeoutMs: number
  /** 终态任务保留多久，默认 1 小时。 */
  ttlMs?: number
  now?: () => number
}

export class ExportQueue {
  private readonly records = new Map<string, ExportRecord>()
  private readonly waiting: string[] = []
  private running: string | null = null
  private readonly worker: ExportWorker
  private readonly logger: Logger
  private readonly timeoutMs: number
  private readonly ttlMs: number
  private readonly now: () => number
  private idle: Promise<void> = Promise.resolve()

  constructor(options: QueueOptions) {
    this.worker = options.worker
    this.logger = options.logger
    this.timeoutMs = options.timeoutMs
    this.ttlMs = options.ttlMs ?? 60 * 60 * 1000
    this.now = options.now ?? Date.now
  }

  /** 排队；同一 id 还在（未过期）时返回 false。过期删除后同一 id 可以再提交。 */
  submit(input: ExportInput): boolean {
    this.sweep()
    if (this.records.has(input.id)) return false
    this.records.set(input.id, {
      input,
      status: 'queued',
      progress: 0,
      error: null,
      finishedAt: null,
      controller: null,
    })
    this.waiting.push(input.id)
    this.logger.info('导出已排队', { exportId: input.id, queuePosition: this.waiting.length - 1 })
    this.pump()
    return true
  }

  get(id: string): ExportView | undefined {
    this.sweep()
    const record = this.records.get(id)
    if (!record) return undefined
    const position = this.waiting.indexOf(id)
    return {
      id,
      conversationId: record.input.conversationId,
      status: record.status,
      progress: record.progress,
      queuePosition: record.status === 'queued' ? position : null,
      error: record.status === 'failed' ? record.error : null,
    }
  }

  /** 取消排队中、渲染中或上传中的任务；已是终态的不改。返回任务是否存在。 */
  cancel(id: string): boolean {
    this.sweep()
    const record = this.records.get(id)
    if (!record) return false
    if (TERMINAL.has(record.status)) return true
    const index = this.waiting.indexOf(id)
    if (index >= 0) this.waiting.splice(index, 1)
    record.status = 'cancelled'
    record.finishedAt = this.now()
    record.controller?.abort(new Error('cancelled'))
    this.logger.info('导出已取消', { exportId: id })
    return true
  }

  stats(): { running: number; waiting: number } {
    return { running: this.running ? 1 : 0, waiting: this.waiting.length }
  }

  /** 删掉终态超过保留期的任务。 */
  sweep(): void {
    const now = this.now()
    for (const [id, record] of this.records) {
      if (record.finishedAt !== null && now - record.finishedAt >= this.ttlMs) {
        this.records.delete(id)
      }
    }
  }

  /** 当前任务（若有）处理完的承诺；测试与优雅退出用。 */
  settled(): Promise<void> {
    return this.idle
  }

  /** 退出前取消全部进行中与排队的任务。 */
  cancelAll(): void {
    for (const id of [...this.waiting, ...(this.running ? [this.running] : [])]) this.cancel(id)
  }

  private pump(): void {
    if (this.running) return
    const id = this.waiting.shift()
    if (!id) return
    const record = this.records.get(id)
    if (!record) return
    this.running = id
    this.idle = this.process(record).finally(() => {
      this.running = null
      this.pump()
    })
  }

  private async process(record: ExportRecord): Promise<void> {
    const { input } = record
    const log = this.logger.child({ exportId: input.id, conversationId: input.conversationId })
    const controller = new AbortController()
    record.controller = controller
    record.status = 'rendering'
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('timeout'))
    }, this.timeoutMs)
    const started = this.now()
    let rendered: RenderedFile | null = null
    // 取消随时可能在等待期间发生（cancel 直接改状态），每次 await 之后都要重新看。
    const cancelled = (): boolean => record.status === 'cancelled'
    log.info('开始渲染')
    try {
      rendered = await this.worker.render(
        {
          id: input.id,
          registryDir: input.registryDir,
          mediaUrls: input.mediaUrls,
          compose: input.compose,
        },
        {
          signal: controller.signal,
          onProgress: (progress) => {
            if (record.status === 'rendering') {
              record.progress = Math.max(record.progress, Math.min(1, Math.max(0, progress)))
            }
          },
        },
      )
      if (cancelled()) return
      record.status = 'uploading'
      log.info('渲染完成，开始上传', { renderMs: this.now() - started })
      await this.worker.upload(rendered.file, input.upload, controller.signal)
      if (cancelled()) return
      record.status = 'done'
      record.finishedAt = this.now()
      log.info('导出完成', { totalMs: this.now() - started })
    } catch (error) {
      if (cancelled()) return
      const failure = timedOut
        ? new ExportFailure('timeout', `超过 ${Math.round(this.timeoutMs / 1000)} 秒未完成`)
        : error instanceof ExportFailure
          ? error
          : new ExportFailure(
              'render-failed',
              error instanceof Error ? error.message : String(error),
            )
      record.status = 'failed'
      record.error = { code: failure.code, message: failure.message }
      record.finishedAt = this.now()
      log.error('导出失败', { code: failure.code, message: failure.message })
    } finally {
      clearTimeout(timer)
      record.controller = null
      if (rendered) {
        await rendered.cleanup().catch((error: unknown) => log.warn('临时文件删除失败', { error }))
      }
    }
  }
}
