import catalogJson from '../../web/scripts/hyperframes-fixtures/catalog.json'
import type {
  CatalogItem,
  ComponentCatalog,
} from '../../web/src/features/storyboard/final-cut/composition/catalog'
import {
  audioElement,
  emptyProject,
  hostElement,
  itemNamed,
  videoElement,
  withFontBlock,
  type AudioClip,
  type Canvas,
  type FilmClip,
  type HostClip,
  type VideoClip,
} from '../../web/src/features/storyboard/final-cut/composition/film'
import type { ExportWorker, RenderedFile, RenderJobInput, UploadTarget } from './jobs'
import { createLogger, type Logger } from './log'
import type { ProjectFile } from './project'

// 源目录里没有组装时才生成的内容：运行库路径照组装结果写，分片表只给西文基本字符那一片，条目补上空的 chars，
// 文件清单照组装结果写（只有 fixture-sidecar 带着专有目录里的文件）
const source = catalogJson as Omit<ComponentCatalog, 'version' | 'runtime' | 'cjk' | 'items'> & {
  items: Omit<CatalogItem, 'chars' | 'files'>[]
}
const ownFiles: Record<string, string[]> = {
  'fixture-sidecar': ['compositions/fixture-sidecar/assets/fixture-sidecar.json'],
}

export const catalog: ComponentCatalog = {
  ...source,
  version: 'test-fixtures',
  runtime: {
    hyperframes: 'vendor/hyperframes/0.9.31/hyperframe.runtime.iife.js',
    gsap: 'vendor/npm/gsap@3.14.2/dist/gsap.min.js',
  },
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
  items: source.items.map((item) => ({
    ...item,
    chars: '',
    files: [item.src, ...(ownFiles[item.name] ?? [])],
  })),
}

export const CLIP_URL = 'https://media.iclip.test/videos/clip.mp4'
export const AUDIO_URL = 'https://media.iclip.test/audio/music.mp3'

export function video(overrides: Partial<VideoClip> = {}): VideoClip {
  return {
    kind: 'video',
    id: 'clip-1',
    label: '镜头 1',
    src: CLIP_URL,
    start: 0,
    duration: 2000,
    mediaStart: 0,
    track: 0,
    volume: 1,
    playbackRate: 1,
    fadeIn: 0,
    fadeOut: 0,
    muted: false,
    z: 0,
    hidden: false,
    link: null,
    syncOrigin: null,
    ...overrides,
  }
}

/** 测试组件库里带可填项的那个条目。 */
export function host(overrides: Partial<HostClip> = {}): HostClip {
  return {
    kind: 'host',
    id: 'title-1',
    label: '测试可填项',
    item: 'fixture-fields',
    src: 'compositions/fixtures/fixture-fields.html',
    start: 0,
    duration: 2000,
    playbackStart: 0,
    track: 0,
    values: {},
    z: 0,
    hidden: false,
    link: null,
    ...overrides,
  }
}

export function audio(overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    kind: 'audio',
    id: 'music-1',
    label: '配乐',
    src: AUDIO_URL,
    start: 0,
    duration: 2000,
    mediaStart: 0,
    track: 0,
    volume: 1,
    playbackRate: 1,
    fadeIn: 0,
    fadeOut: 0,
    loop: false,
    hidden: false,
    link: null,
    syncOrigin: null,
    ...overrides,
  }
}

/**
 * 测试用的工程主文件：新建工程的模板，根下按先后放上 `clips`（只认视频、组件或块、音频三种），
 * 字体块按片段算好，根上的总长是最晚的结尾。
 */
export function mainFile(
  clips: FilmClip[] = [video()],
  canvas: Canvas = { width: 720, height: 1280 },
  library: ComponentCatalog = catalog,
): string {
  const elements = clips.map((clip) => {
    switch (clip.kind) {
      case 'video':
        return videoElement(clip)
      case 'audio':
        return audioElement(clip)
      case 'host': {
        const item = itemNamed(library, clip.item)
        if (item === undefined) throw new Error(`测试组件库里没有条目 ${clip.item}`)
        return hostElement(clip, item, canvas, library)
      }
      case 'other':
        throw new Error('测试主文件不写「其他」片段，直接手写进 HTML')
    }
  })
  const duration = Math.max(0, ...clips.map((clip) => clip.start + clip.duration))
  return withFontBlock(
    emptyProject(canvas, library, elements.map((written) => `${written}\n`).join(''), duration),
    clips,
    library,
  )
}

export function exportRequest(
  overrides: { id?: string; mediaHost?: string; files?: ProjectFile[] } = {},
): Record<string, unknown> {
  const host = overrides.mediaHost ?? 'oss.example.com'
  return {
    id: overrides.id ?? '11111111-2222-4333-8444-555555555555',
    conversationId: '99999999-8888-4777-8666-555555555555',
    files: overrides.files ?? [{ path: 'index.html', content: mainFile() }],
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
  const renders: (RenderJobInput & {
    signal: AbortSignal
    onProgress: (progress: number) => void
    pending: Pending<RenderedFile>
  })[] = []
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
        renders.push({ ...job, signal, onProgress, pending: { resolve, reject } })
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
