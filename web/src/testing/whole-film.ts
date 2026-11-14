import fixtureCatalogJson from '../../scripts/hyperframes-fixtures/catalog.json'
import type {
  CatalogItem,
  ComponentCatalog,
} from '@/features/storyboard/whole-film/composition/catalog'
import {
  writeFilm,
  type AudioClip,
  type Canvas,
  type FilmClip,
  type HostClip,
  type VideoClip,
} from '@/features/storyboard/whole-film/composition/film'

// 源目录里没有组装时才生成的内容：运行库路径照组装结果写，分片表留空，条目补上空的 chars
const fixtureSource = fixtureCatalogJson as Omit<
  ComponentCatalog,
  'version' | 'runtime' | 'cjk' | 'items'
> & {
  items: Omit<CatalogItem, 'chars'>[]
}

export const fixtureCatalog: ComponentCatalog = {
  ...fixtureSource,
  version: 'test-fixtures',
  runtime: {
    hyperframes: 'vendor/hyperframes/0.9.31/hyperframe.runtime.iife.js',
    gsap: 'vendor/npm/gsap@3.14.2/dist/gsap.min.js',
  },
  cjk: { family: 'Noto Sans SC', slices: [] },
  items: fixtureSource.items.map((item) => ({ ...item, chars: '' })),
}

export const video = (overrides: Partial<VideoClip> = {}): VideoClip => ({
  kind: 'video',
  id: 'clip-1',
  label: 'A · 镜头 1',
  jobId: '6f1b5c3e-2a4d-4e8f-9b1c-0d2e3f4a5b6c',
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

export const AUDIO_JOB = '0c9a8b7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d'

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
  jobId: AUDIO_JOB,
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

export const filmFile = (
  clips: FilmClip[] = [video()],
  canvas: Canvas = { width: 1080, height: 1920 },
): string => writeFilm({ canvas, clips }, fixtureCatalog)
