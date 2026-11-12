import fixtureCatalogJson from '../../scripts/hyperframes-fixtures/catalog.json'
import type {
  CatalogItem,
  ComponentCatalog,
} from '@/features/storyboard/whole-film/composition/catalog'
import {
  writeFilm,
  type Canvas,
  type PictureBlock,
} from '@/features/storyboard/whole-film/composition/film'

// 源目录里没有组装时才生成的内容：分片表留空，条目补上空的 chars
const fixtureSource = fixtureCatalogJson as Omit<ComponentCatalog, 'version' | 'cjk' | 'items'> & {
  items: Omit<CatalogItem, 'chars'>[]
}

export const fixtureCatalog: ComponentCatalog = {
  ...fixtureSource,
  version: 'test-fixtures',
  cjk: { family: 'Noto Sans SC', slices: [] },
  items: fixtureSource.items.map((item) => ({ ...item, chars: '' })),
}

export const picture = (overrides: Partial<PictureBlock> = {}): PictureBlock => ({
  id: 'clip-1',
  label: 'A · 镜头 1',
  jobId: '6f1b5c3e-2a4d-4e8f-9b1c-0d2e3f4a5b6c',
  src: 'https://media.test/videos/a.mp4',
  start: 0,
  duration: 2000,
  mediaStart: 0,
  track: 0,
  volume: 1,
  ...overrides,
})

export const filmFile = (
  blocks: PictureBlock[] = [picture()],
  canvas: Canvas = { width: 1080, height: 1920 },
): string => writeFilm({ canvas, blocks }, fixtureCatalog)
