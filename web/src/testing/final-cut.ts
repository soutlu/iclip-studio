import fixtureCatalogJson from '../../scripts/hyperframes-fixtures/catalog.json'
import type {
  CatalogItem,
  ComponentCatalog,
} from '@/features/storyboard/final-cut/composition/catalog'
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
} from '@/features/storyboard/final-cut/composition/film'

// 源目录里没有组装时才生成的内容：运行库路径照组装结果写，分片表留空，条目补上空的 chars，
// 文件清单照组装结果写（只有 fixture-sidecar 带着专有目录里的文件）
const fixtureSource = fixtureCatalogJson as Omit<
  ComponentCatalog,
  'version' | 'runtime' | 'cjk' | 'items'
> & {
  items: Omit<CatalogItem, 'chars' | 'files'>[]
}
const ownFiles: Record<string, string[]> = {
  'fixture-sidecar': ['compositions/fixture-sidecar/assets/fixture-sidecar.json'],
}

export const fixtureCatalog: ComponentCatalog = {
  ...fixtureSource,
  version: 'test-fixtures',
  runtime: {
    hyperframes: 'vendor/hyperframes/0.9.31/hyperframe.runtime.iife.js',
    gsap: 'vendor/npm/gsap@3.14.2/dist/gsap.min.js',
  },
  cjk: { family: 'Noto Sans SC', slices: [] },
  items: fixtureSource.items.map((item) => ({
    ...item,
    chars: '',
    files: [item.src, ...(ownFiles[item.name] ?? [])],
  })),
}

export const video = (overrides: Partial<VideoClip> = {}): VideoClip => ({
  kind: 'video',
  id: 'clip-1',
  label: 'A · 镜头 1',
  src: 'https://media.test/videos/a.mp4',
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
  ...overrides,
})

/** 测试组件库里带可填项的那个条目。 */
export const host = (overrides: Partial<HostClip> = {}): HostClip => ({
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
  ...overrides,
})

export const audio = (overrides: Partial<AudioClip> = {}): AudioClip => ({
  kind: 'audio',
  id: 'music-1',
  label: '配乐',
  src: 'https://media.test/audio/music.mp3',
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
  ...overrides,
})

/**
 * 测试用的工程主文件：新建工程的模板，根下按先后放上 `clips`（视频、组件或块、音频三种；「其他」片段
 * 用 `extra` 直接写 HTML，放在最后），字体块按片段算好，根上的总长是最晚的结尾。
 */
export const mainFile = (
  clips: FilmClip[] = [video()],
  canvas: Canvas = { width: 1080, height: 1920 },
  extra = '',
): string => {
  const elements = clips.map((clip) => {
    switch (clip.kind) {
      case 'video':
        return videoElement(clip)
      case 'audio':
        return audioElement(clip)
      case 'host': {
        const item = itemNamed(fixtureCatalog, clip.item)
        if (item === undefined) throw new Error(`测试组件库里没有条目 ${clip.item}`)
        return hostElement(clip, item, canvas, fixtureCatalog)
      }
      case 'other':
        throw new Error('「其他」片段用 extra 直接写 HTML')
    }
  })
  const duration = Math.max(0, ...clips.map((clip) => clip.start + clip.duration))
  const children = [...elements, ...(extra === '' ? [] : [extra])]
    .map((written) => `${written}\n`)
    .join('')
  return withFontBlock(
    emptyProject(canvas, fixtureCatalog, children, duration),
    clips,
    fixtureCatalog,
  )
}
