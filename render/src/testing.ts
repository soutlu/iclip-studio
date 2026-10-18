/** 测试用的请求、队列与假的渲染器。 */
import catalogJson from '../../web/src/features/storyboard/whole-film/catalog/catalog.json'
import type { ComponentCatalog } from '../../web/src/features/storyboard/whole-film/composition/catalog'
import type { ExportWorker, RenderedFile, UploadTarget } from './jobs'
import { createLogger, type Logger } from './log'

export const catalog = catalogJson as unknown as ComponentCatalog

export const SOURCE_JOB = '6f1b5c3e-2a4d-4e8f-9b1c-0d2e3f4a5b6c'
export const SUBTITLE_JOB = '7a2c6d4f-3b5e-4f9a-8c2d-1e3f4a5b6c7d'
export const MUSIC_JOB = '8b3d7e5a-4c6f-4a0b-9d3e-2f4a5b6c7d8e'

/** 一份合法的 POST /exports 请求体：一段成片带字幕、配乐、一个包装。 */
export function exportRequest(
  overrides: { id?: string; mediaHost?: string } = {},
): Record<string, unknown> {
  const host = overrides.mediaHost ?? 'oss.example.com'
  return {
    id: overrides.id ?? '11111111-2222-4333-8444-555555555555',
    conversationId: '99999999-8888-4777-8666-555555555555',
    document: {
      canvas: { width: 720, height: 1280 },
      layer0: [
        {
          id: 'a',
          type: 'video',
          start: 0,
          duration: 2000,
          playbackStart: 0,
          sourceJobId: SOURCE_JOB,
          volume: 1,
        },
      ],
      transitions: [],
      captions: { component: 'default-caption', edits: [] },
      music: { jobId: MUSIC_JOB, offset: 0, volume: 0.5 },
      overlays: [
        { id: 'o', component: 'store-badge-lockup', start: 0, duration: 1000, variables: {} },
      ],
    },
    media: {
      videos: { [SOURCE_JOB]: { url: `https://${host}/clip.mp4?sig=1` } },
      music: { url: `https://${host}/music.mp3` },
      subtitles: {
        [SOURCE_JOB]: {
          subtitleJobId: SUBTITLE_JOB,
          sentences: [
            {
              startMs: 0,
              endMs: 800,
              text: '你好。',
              speaker: null,
              words: [{ startMs: 0, endMs: 800, text: '你好', punctuation: '。' }],
            },
          ],
        },
      },
    },
    upload: {
      url: 'https://upload.example.com/exports/a.mp4?Signature=x',
      headers: { 'Content-Type': 'video/mp4', 'x-oss-object-acl': 'private' },
    },
  }
}

/** 收集日志行的记录器。 */
export function memoryLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = []
  return {
    logger: createLogger('debug', (line) =>
      lines.push(JSON.parse(line) as Record<string, unknown>),
    ),
    lines,
  }
}

interface Pending<T> {
  resolve(value: T): void
  reject(error: unknown): void
}

/**
 * 手动推进的假渲染器：每次 render / upload 挂起，由测试决定何时完成、失败或观察取消。
 */
export function manualWorker() {
  const renders: {
    id: string
    signal: AbortSignal
    onProgress: (progress: number) => void
    pending: Pending<RenderedFile>
  }[] = []
  const uploads: {
    file: string
    target: UploadTarget
    signal: AbortSignal
    pending: Pending<void>
  }[] = []
  const cleaned: string[] = []
  const worker: ExportWorker = {
    render: (job, { signal, onProgress }) =>
      new Promise<RenderedFile>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        renders.push({ id: job.id, signal, onProgress, pending: { resolve, reject } })
      }),
    upload: (file, target, signal) =>
      new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        uploads.push({ file, target, signal, pending: { resolve, reject } })
      }),
  }
  const rendered = (id: string): RenderedFile => ({
    file: `/tmp/${id}.mp4`,
    cleanup: async () => {
      cleaned.push(id)
    },
  })
  return { worker, renders, uploads, cleaned, rendered }
}

/** 等挂起的 promise 链走完一轮。 */
export const flush = () => new Promise((resolve) => setImmediate(resolve))
