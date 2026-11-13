import catalogJson from '../../web/scripts/hyperframes-fixtures/catalog.json'
import type {
  CatalogItem,
  ComponentCatalog,
} from '../../web/src/features/storyboard/whole-film/composition/catalog'
import {
  writeFilm,
  type AudioBlock,
  type ComponentBlock,
  type FilmBlock,
  type PictureBlock,
} from '../../web/src/features/storyboard/whole-film/composition/film'
import type { ExportWorker, RenderedFile, UploadTarget } from './jobs'
import { createLogger, type Logger } from './log'

// 源目录里没有组装时才生成的内容：分片表只给西文基本字符那一片，条目补上空的 chars
const source = catalogJson as Omit<ComponentCatalog, 'version' | 'cjk' | 'items'> & {
  items: Omit<CatalogItem, 'chars'>[]
}

export const catalog: ComponentCatalog = {
  ...source,
  version: 'test-fixtures',
  cjk: {
    family: 'Noto Sans SC',
    slices: [
      {
        range: 'U+0020-007E',
        files: {
          '400': 'vendor/fonts/noto-sans-sc-latin-400.woff2',
          '700': 'vendor/fonts/noto-sans-sc-latin-700.woff2',
        },
      },
    ],
  },
  items: source.items.map((item) => ({ ...item, chars: '' })),
}

export const SOURCE_JOB = '6f1b5c3e-2a4d-4e8f-9b1c-0d2e3f4a5b6c'
export const CLIP_URL = 'https://media.iclip.test/videos/clip.mp4'
export const AUDIO_JOB = '0c9a8b7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d'
export const AUDIO_URL = 'https://media.iclip.test/audio/music.mp3'

export function picture(overrides: Partial<PictureBlock> = {}): PictureBlock {
  return {
    kind: 'picture',
    id: 'clip-1',
    label: '镜头 1',
    jobId: SOURCE_JOB,
    src: CLIP_URL,
    start: 0,
    duration: 2000,
    mediaStart: 0,
    track: 0,
    volume: 1,
    z: 0,
    hidden: false,
    ...overrides,
  }
}

/** 测试组件库里带可填项的那个条目。 */
export function component(overrides: Partial<ComponentBlock> = {}): ComponentBlock {
  return {
    kind: 'component',
    id: 'title-1',
    label: '测试可填项',
    component: 'fixture-fields',
    src: 'compositions/fixtures/fixture-fields.html',
    start: 0,
    duration: 2000,
    playbackStart: 0,
    track: 0,
    values: {},
    z: 0,
    hidden: false,
    ...overrides,
  }
}

export function audio(overrides: Partial<AudioBlock> = {}): AudioBlock {
  return {
    kind: 'audio',
    id: 'music-1',
    label: '配乐',
    jobId: AUDIO_JOB,
    src: AUDIO_URL,
    start: 0,
    duration: 2000,
    mediaStart: 0,
    track: 0,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    loop: false,
    hidden: false,
    ...overrides,
  }
}

export function filmFile(
  blocks: FilmBlock[] = [picture()],
  canvas = { width: 720, height: 1280 },
): string {
  return writeFilm({ canvas, blocks }, catalog)
}

export function exportRequest(
  overrides: { id?: string; mediaHost?: string } = {},
): Record<string, unknown> {
  const host = overrides.mediaHost ?? 'oss.example.com'
  return {
    id: overrides.id ?? '11111111-2222-4333-8444-555555555555',
    conversationId: '99999999-8888-4777-8666-555555555555',
    film: filmFile(),
    media: { [CLIP_URL]: { url: `https://${host}/clip.mp4?sig=1` } },
    upload: {
      url: 'https://upload.example.com/exports/a.mp4?Signature=x',
      headers: { 'Content-Type': 'video/mp4', 'x-oss-object-acl': 'private' },
    },
  }
}

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

export function manualWorker() {
  const renders: {
    id: string
    registryDir: string
    compose: (paths: Readonly<Record<string, string>>) => string
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
        renders.push({
          id: job.id,
          registryDir: job.registryDir,
          compose: job.compose,
          signal,
          onProgress,
          pending: { resolve, reject },
        })
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

export const flush = () => new Promise((resolve) => setImmediate(resolve))
