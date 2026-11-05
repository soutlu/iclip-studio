import type { Logger } from './log'

export type ExportStatus = 'queued' | 'rendering' | 'uploading' | 'done' | 'failed' | 'cancelled'

export type FailureCode = 'render-failed' | 'upload-failed' | 'media-unreachable' | 'timeout'

export class ExportFailure extends Error {
  readonly code: FailureCode

  constructor(code: FailureCode, message: string) {
    super(message)
    this.name = 'ExportFailure'
    this.code = code
  }
}

export interface RenderedFile {
  file: string
  cleanup(): Promise<void>
}

export interface UploadTarget {
  url: string
  headers: Record<string, string>
}

export interface RenderJobInput {
  id: string
  registryDir: string
  mediaUrls: string[]
  compose(mediaPaths: Readonly<Record<string, string>>): string
}

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
  timeoutMs: number
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

  sweep(): void {
    const now = this.now()
    for (const [id, record] of this.records) {
      if (record.finishedAt !== null && now - record.finishedAt >= this.ttlMs) {
        this.records.delete(id)
      }
    }
  }

  settled(): Promise<void> {
    return this.idle
  }

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
