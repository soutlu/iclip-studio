import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FIXTURES_DIR, WEB_ROOT, libraryVersion } from './hyperframes-shared.mjs'

// 每个用例一份测试组件库的副本，改动不碰入库的文件。
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
})

describe('hf:registry', () => {
  it('版本目录已存在时跳过组装，只写带 version 的 catalog.json', async () => {
    const out = join(work, 'out')
    const version = await libraryVersion(library)
    await mkdir(join(out, version), { recursive: true })
    await writeFile(join(out, version, 'marker'), '')

    const result = spawnSync(
      process.execPath,
      [join(WEB_ROOT, 'scripts', 'hyperframes-registry.mjs'), '--library', library, '--out', out],
      { encoding: 'utf8' },
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)

    const source = JSON.parse(await readFile(join(library, 'catalog.json'), 'utf8'))
    const published = JSON.parse(await readFile(join(out, 'catalog.json'), 'utf8'))
    expect(published).toEqual({ version, ...source })
    // 没有重新组装，也没有留下临时目录或临时文件
    expect(await readdir(join(out, version))).toEqual(['marker'])
    expect((await readdir(out)).sort()).toEqual(['catalog.json', version].sort())
  })
})
