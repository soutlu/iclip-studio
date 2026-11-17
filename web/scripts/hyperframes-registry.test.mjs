import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  FIXTURES_DIR,
  FONT_TABLE,
  RUNTIME,
  WEB_ROOT,
  libraryVersion,
  listFiles,
  publishedCatalog,
} from './hyperframes-shared.mjs'

let work
let library
beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'hf-registry-'))
  library = join(work, 'library')
  await cp(FIXTURES_DIR, library, { recursive: true })
})
afterEach(() => rm(work, { recursive: true, force: true }))

const append = async (path, text) =>
  writeFile(join(library, path), `${await readFile(join(library, path), 'utf8')}${text}`)

describe('libraryVersion', () => {
  it('输入相同时版本号相同；说明文件等不参与组装的文件不算输入', async () => {
    const version = await libraryVersion(library)
    expect(version).toMatch(/^[0-9a-f]{12}$/)
    expect(await libraryVersion(library)).toBe(version)
    const copy = join(work, 'copy')
    await cp(library, copy, { recursive: true })
    expect(await libraryVersion(copy)).toBe(version)
    await writeFile(join(library, 'README.md'), '说明\n')
    expect(await libraryVersion(library)).toBe(version)
  })

  it.each([
    ['组件目录', () => append('catalog.json', '\n')],
    ['锁文件', () => append('registry.lock.json', '\n')],
    ['改写的文件', () => append('patches/compositions/fixtures/fixture-scene.html', '\n')],
    ['改写清单', () => append('patches/manifest.json', '\n')],
    ['封面', () => append('thumbnails/fixture-scene.svg', '\n')],
    ['新加的封面', () => writeFile(join(library, 'thumbnails/extra.svg'), '<svg/>')],
  ])('%s变了，版本号就变', async (_, change) => {
    const before = await libraryVersion(library)
    await change()
    expect(await libraryVersion(library)).not.toBe(before)
  })

  it('fonts/ 下的字体文件新加或改了，版本号就变', async () => {
    await mkdir(join(library, 'fonts', 'brand'), { recursive: true })
    const before = await libraryVersion(library)
    await writeFile(join(library, 'fonts', 'brand', 'a.ttf'), 'a')
    const added = await libraryVersion(library)
    expect(added).not.toBe(before)
    await writeFile(join(library, 'fonts', 'brand', 'a.ttf'), 'b')
    expect(await libraryVersion(library)).not.toBe(added)
  })
})

describe('hf:registry', () => {
  const css = 'vendor/fonts/families/playfair-display-0123456789ab.css'

  /** 照组装结果摆好版本目录（组件文件取自改写目录，字体表手写），再运行脚本；脚本因此跳过组装、只发布目录。 */
  async function publishAssembled() {
    const out = join(work, 'out')
    const version = await libraryVersion(library)
    await cp(join(library, 'patches', 'compositions'), join(out, version, 'compositions'), {
      recursive: true,
    })
    await writeFile(
      join(out, version, FONT_TABLE),
      JSON.stringify({
        slices: [],
        twins: { 'Playfair Display': [] },
        css: { 'Playfair Display': css },
      }),
    )
    await writeFile(join(out, version, 'marker'), '')
    const result = spawnSync(
      process.execPath,
      [join(WEB_ROOT, 'scripts', 'hyperframes-registry.mjs'), '--library', library, '--out', out],
      { encoding: 'utf8' },
    )
    return { out, version, result }
  }

  it('版本目录已存在时跳过组装，按版本目录里的组件文件写带 version 的 catalog.json', async () => {
    const { out, version, result } = await publishAssembled()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)

    const source = JSON.parse(await readFile(join(library, 'catalog.json'), 'utf8'))
    const published = JSON.parse(await readFile(join(out, 'catalog.json'), 'utf8'))
    expect(published).toEqual(
      await publishedCatalog(
        source,
        version,
        (path) => readFile(join(out, version, path), 'utf8'),
        (dir) => listFiles(join(out, version), dir),
      ),
    )
    const fontItems = published.items.flatMap((item) =>
      item.variables
        .filter((variable) => variable.type === 'font')
        .map((variable) => [item.name, variable.default]),
    )
    expect(fontItems).toEqual([
      ['default-caption', ''],
      ['fixture-fields', ''],
      ['fixture-brand-card', 'Playfair Display'],
    ])
    expect(published.runtime).toEqual(RUNTIME)
    expect(published.cjk).toEqual({ family: 'Noto Sans SC', slices: [] })
    expect(published.fonts['Playfair Display']).toEqual({ css, brand: '示例品牌', cjk: [] })
    expect(published.items.find((item) => item.name === 'fixture-fields').chars).not.toBe('')
    expect((await readdir(join(out, version))).sort()).toEqual([
      'compositions',
      FONT_TABLE,
      'marker',
    ])
    expect((await readdir(out)).sort()).toEqual(['catalog.json', version].sort())
  })

  it('每个条目带上 final-cut 工程要拷的文件：共用目录里只有 src，专有目录里 src 在前、其余文件按路径排在后面', async () => {
    const { out, version, result } = await publishAssembled()
    expect(result.status).toBe(0)

    const published = JSON.parse(await readFile(join(out, 'catalog.json'), 'utf8'))
    expect(Object.fromEntries(published.items.map((item) => [item.name, item.files]))).toEqual({
      'default-caption': ['compositions/fixtures/default-caption.html'],
      'fixture-scene': ['compositions/fixtures/fixture-scene.html'],
      'fixture-overlay': ['compositions/fixtures/fixture-overlay.html'],
      'fixture-fields': ['compositions/fixtures/fixture-fields.html'],
      'fixture-brand-card': ['compositions/fixtures/fixture-brand-card.html'],
      'fixture-sidecar': [
        'compositions/fixture-sidecar/fixture-sidecar.html',
        'compositions/fixture-sidecar/assets/fixture-sidecar.json',
      ],
      'fixture-passthrough': ['compositions/fixtures/fixture-passthrough.html'],
    })
    for (const path of published.items.flatMap((item) => item.files)) {
      expect(existsSync(join(out, version, path)), path).toBe(true)
    }
  })

  it('专有目录里有不是文本的文件：失败，报错写明条目和文件，不写 catalog.json', async () => {
    const binary = 'compositions/fixture-sidecar/assets/pixel.png'
    await writeFile(
      join(library, 'patches', binary),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
    )
    const manifestPath = join(library, 'patches', 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.files[binary] = { replaces: null }
    await writeFile(manifestPath, JSON.stringify(manifest))

    const { out, result } = await publishAssembled()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`fixture-sidecar → ${binary}`)
    expect(existsSync(join(out, 'catalog.json'))).toBe(false)
  })
})
