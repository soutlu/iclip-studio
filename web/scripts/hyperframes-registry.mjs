#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import {
  CDN_HOST_PATTERN,
  CJK_FONT,
  DEFAULT_OUT,
  FIXTURES_DIR,
  HF_VERSION,
  IntegrityError,
  RUNTIME,
  SyncError,
  WEB_ROOT,
  checkCatalogFonts,
  cjkTwinFaces,
  compositionTarget,
  fontFaceDescriptors,
  fontFaces,
  fontPackage,
  installedFiles,
  isLatinSubset,
  libraryVersion,
  listFiles,
  localFontFaces,
  localReferences,
  localize,
  npmPackage,
  publishedCatalog,
  registryItems,
  sha256,
  sourceTree,
  writeAtomic,
} from './hyperframes-shared.mjs'

const RUNTIME_TEXT = /\.(html?|css|m?js|cjs)$/i
const COMPONENT_BACKGROUND = /background:\s*(?:#(?:0a0a0a|000000|000|0a0805)|rgba?\([^)]*\))\s*;/g

const args = process.argv.slice(2)
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const updateLock = args.includes('--update-lock')
const tarballArg = option('--tarball')
const smokeDir = option('--smoke')
const libraryDir = resolve(option('--library') ?? FIXTURES_DIR)
const outDir = resolve(option('--out') ?? DEFAULT_OUT)
const displayPath = (path) => relative(WEB_ROOT, path)

async function assemble(temp, catalog, lock) {
  const writeOut = async (path, data) => {
    await mkdir(dirname(join(temp, path)), { recursive: true })
    await writeFile(join(temp, path), data)
  }
  const patchesDir = join(libraryDir, 'patches')
  const manifest = JSON.parse(await readFile(join(patchesDir, 'manifest.json'), 'utf8'))
  const patchedNew = new Set(
    Object.entries(manifest.files)
      .filter(([, { replaces }]) => replaces === null)
      .map(([target]) => target),
  )

  const fromTarball = smokeDir
    ? null
    : new Set(catalog.items.filter((item) => !patchedNew.has(item.src)).map((item) => item.name))
  const items = []
  if (smokeDir || fromTarball.size > 0) {
    const src = await sourceTree(tarballArg)
    const installable = async ({ dir, item }) => {
      for (const file of installedFiles(item)) {
        if (!existsSync(join(dir, file.path))) return false
        if (!RUNTIME_TEXT.test(file.target)) continue
        const text = await readFile(join(dir, file.path), 'utf8')
        if (localize(text, file.target).unsupported.length > 0) return false
      }
      return true
    }
    for (const entry of await registryItems(src)) {
      if (fromTarball ? fromTarball.has(entry.name) : await installable(entry)) items.push(entry)
    }
    await writeOut('LICENSE', await readFile(join(src, 'LICENSE')))
  }
  const installed = new Map()
  for (const { name, dir, item } of items) {
    for (const file of installedFiles(item)) {
      const data = await readFile(join(dir, file.path))
      const previous = installed.get(file.target)
      if (previous && !previous.data.equals(data)) {
        throw new SyncError(`${name} 与 ${previous.name} 都装到 ${file.target}，内容不同`)
      }
      installed.set(file.target, { name, data })
    }
  }

  const npmFiles = new Map()
  const fontCss = new Map()
  const addNpm = ({ name, version, file }) => {
    const key = `${name}@${version}`
    if (!npmFiles.has(key)) npmFiles.set(key, { name, version, files: new Set() })
    npmFiles.get(key).files.add(file)
  }
  const [, gsapName, gsapVersion, gsapFile] = /^vendor\/npm\/([^@]+)@([^/]+)\/(.+)$/.exec(
    RUNTIME.gsap,
  )
  addNpm({ name: gsapName, version: gsapVersion, file: gsapFile })
  const localizeText = (data, target, owner) => {
    const result = localize(data.toString('utf8'), target)
    if (result.unsupported.length > 0) {
      throw new SyncError(`${owner} 的 ${target} 有换不了的外链：${result.unsupported.join('；')}`)
    }
    for (const need of result.needs) {
      if (need.npm) addNpm(need.npm)
      else fontCss.set(need.css, need.fonts)
    }
    return result.text
  }
  for (const [target, { name, data }] of installed) {
    await writeOut(target, RUNTIME_TEXT.test(target) ? localizeText(data, target, name) : data)
  }
  const patched = new Map()
  for (const target of Object.keys(manifest.files)) {
    const data = await readFile(join(patchesDir, target))
    patched.set(target, RUNTIME_TEXT.test(target) ? localizeText(data, target, '改写') : data)
  }

  const npmLock = {}
  const opened = new Map()
  const openPackage = async (name, version) => {
    const key = `${name}@${version}`
    if (!opened.has(key)) {
      const expected = lock === null ? null : (lock.npm[key] ?? null)
      if (lock !== null && !smokeDir && expected === null)
        throw new SyncError(`锁文件里没有 ${key}，运行 --update-lock`)
      const pkg = await npmPackage(name, version, expected)
      npmLock[key] = pkg.sha256
      opened.set(key, pkg.dir)
    }
    return opened.get(key)
  }
  const copyFromPackage = async (name, version, dir, file) =>
    writeOut(`vendor/npm/${name}@${version}/${file}`, await readFile(join(dir, file)))
  const copyLicense = async (name, version, dir) => {
    for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license']) {
      if (existsSync(join(dir, file))) await copyFromPackage(name, version, dir, file)
    }
  }
  for (const { name, version, files } of npmFiles.values()) {
    const dir = await openPackage(name, version)
    for (const file of files) {
      if (!existsSync(join(dir, file))) throw new SyncError(`${name}@${version} 里没有 ${file}`)
      await copyFromPackage(name, version, dir, file)
    }
    await copyLicense(name, version, dir)
  }

  const writeFonts = async (cssPath, families, display, subsetFilter) => {
    const rules = []
    for (const { family, faces } of families) {
      const pkg = fontPackage(family)
      const dir = await openPackage(pkg.name, pkg.version)
      const { css, files } = await fontFaces(family, faces, display, dir, pkg, subsetFilter)
      rules.push(css)
      for (const file of files) await copyFromPackage(pkg.name, pkg.version, dir, file)
      await copyLicense(pkg.name, pkg.version, dir)
    }
    await writeOut(cssPath, `${rules.join('\n')}\n`)
  }
  for (const [cssPath, fonts] of fontCss) {
    await writeFonts(cssPath, fonts.families, fonts.display, isLatinSubset)
  }
  const cjkFaces = CJK_FONT.weights.map((weight) => ({ style: 'normal', weight: String(weight) }))
  await writeFonts(
    CJK_FONT.css,
    [{ family: CJK_FONT.family, faces: cjkFaces }],
    'block',
    isLatinSubset,
  )

  const require = createRequire(import.meta.url)
  const corePackage = require.resolve('@hyperframes/core/package.json')
  const core = JSON.parse(await readFile(corePackage, 'utf8'))
  if (core.version !== HF_VERSION) {
    throw new SyncError(`已安装的 @hyperframes/core 是 ${core.version}，组件库是 ${HF_VERSION}`)
  }
  await writeOut(
    RUNTIME.hyperframes,
    await readFile(join(dirname(corePackage), 'dist', 'hyperframe.runtime.iife.js')),
  )

  for (const [target, { replaces }] of Object.entries(manifest.files)) {
    const path = join(temp, target)
    if (replaces === null && existsSync(path))
      throw new SyncError(`改写 ${target} 应是新文件，但组件库里已有`)
    if (replaces !== null) {
      if (!existsSync(path))
        throw new SyncError(`改写 ${target} 替换的原文件不存在（组件未收录？）`)
      const actual = sha256(await readFile(path))
      if (actual !== replaces)
        throw new SyncError(`改写 ${target} 的原文已变（${actual}），需要按新原文重新改写`)
    }
    await writeOut(target, patched.get(target))
  }

  const componentFiles = smokeDir
    ? items.filter(({ kind }) => kind === 'component').map(({ item }) => compositionTarget(item))
    : catalog.items.filter((item) => item.kind === 'component').map((item) => item.src)
  for (const target of componentFiles) {
    const path = join(temp, target)
    if (!existsSync(path)) throw new SyncError(`组件目录里的 ${target} 不存在`)
    const text = await readFile(path, 'utf8')
    const transparent = text.replace(COMPONENT_BACKGROUND, 'background: transparent;')
    if (transparent !== text) await writeFile(path, transparent)
  }

  const googleFaces = new Map()
  for (const { families } of fontCss.values()) {
    for (const { family, faces } of families) {
      if (!googleFaces.has(family)) googleFaces.set(family, new Map())
      for (const face of faces) googleFaces.get(family).set(`${face.weight}/${face.style}`, face)
    }
  }
  const registryFaces = []
  for (const path of await listFiles(temp)) {
    if (/\.(html?|css)$/i.test(path) && !path.startsWith('vendor/npm/')) {
      registryFaces.push(...fontFaceDescriptors(await readFile(join(temp, path), 'utf8')))
    }
  }
  const notoPackage = fontPackage(CJK_FONT.family)
  const notoDir = await openPackage(notoPackage.name, notoPackage.version)
  for (const [family, { css: cssPath, faces: localFaces }] of Object.entries(catalog.fonts)) {
    if (localFaces !== undefined) {
      const css = await localFontFaces({
        family,
        faces: localFaces,
        cssPath,
        libraryDir,
        outDir: temp,
      })
      await writeOut(cssPath, `${css}\n`)
      continue
    }
    const faces = googleFaces.get(family)
    let latin = ''
    if (faces) {
      const pkg = fontPackage(family)
      const dir = await openPackage(pkg.name, pkg.version)
      const result = await fontFaces(
        family,
        [...faces.values()],
        'block',
        dir,
        pkg,
        isLatinSubset,
        '../../npm',
      )
      for (const file of result.files) await copyFromPackage(pkg.name, pkg.version, dir, file)
      latin = result.css
    }
    const descriptors = registryFaces.filter(
      (face) => face.family.toLowerCase() === family.toLowerCase(),
    )
    if (descriptors.length === 0) throw new SyncError(`组件库里没有字体「${family}」的 @font-face`)
    const cjk = await cjkTwinFaces(family, descriptors, notoDir)
    await writeOut(cssPath, `${[latin, cjk].filter(Boolean).join('\n')}\n`)
  }

  const thumbnailsDir = join(libraryDir, 'thumbnails')
  if (existsSync(thumbnailsDir)) {
    for (const file of await listFiles(thumbnailsDir)) {
      await writeOut(`thumbnails/${file}`, await readFile(join(thumbnailsDir, file)))
    }
  }

  const files = await listFiles(temp)
  const leftovers = []
  for (const path of files.filter(
    (file) => RUNTIME_TEXT.test(file) && !file.startsWith('vendor/npm/'),
  )) {
    if (CDN_HOST_PATTERN.test(await readFile(join(temp, path), 'utf8'))) leftovers.push(path)
  }
  if (leftovers.length > 0) throw new SyncError(`仍有外链：\n  ${leftovers.join('\n  ')}`)

  if (smokeDir) return { npmLock, files }
  const present = new Set(files)
  const missing = catalog.items
    .filter((item) => item.thumbnail !== null && !present.has(`thumbnails/${item.thumbnail}`))
    .map((item) => `${item.name} 的封面 → thumbnails/${item.thumbnail}`)
  for (const path of files.filter(
    (file) => /\.(html?|css)$/i.test(file) && !file.startsWith('vendor/npm/'),
  )) {
    for (const { reference, resolved } of localReferences(
      await readFile(join(temp, path), 'utf8'),
      path,
    )) {
      if (!present.has(resolved)) missing.push(`${path} → ${reference}`)
    }
  }
  if (missing.length > 0) throw new SyncError(`引用的文件不存在：\n  ${missing.join('\n  ')}`)

  return { npmLock, files }
}

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

async function assembleInto(target, catalog, lock) {
  const temp = `${target}.${process.pid}.tmp`
  await rm(temp, { recursive: true, force: true })
  await mkdir(temp, { recursive: true })
  try {
    const result = await assemble(temp, catalog, lock)
    await rename(temp, target)
    return result
  } catch (error) {
    await rm(temp, { recursive: true, force: true })
    throw error
  }
}

async function main() {
  const lockPath = join(libraryDir, 'registry.lock.json')
  const catalog = await readJson(join(libraryDir, 'catalog.json'))
  if ('version' in catalog)
    throw new SyncError('源目录的 catalog.json 不写 version，组装时按输入生成')
  checkCatalogFonts(catalog.fonts)
  if (smokeDir) {
    const lock = existsSync(lockPath) ? await readJson(lockPath) : { npm: {} }
    await rm(smokeDir, { recursive: true, force: true })
    await mkdir(smokeDir, { recursive: true })
    const { files } = await assemble(smokeDir, catalog, lock)
    console.log(`冒烟筛选用的组件库：${displayPath(smokeDir)}（${files.length} 个文件）`)
    return
  }
  await mkdir(outDir, { recursive: true })

  if (updateLock) {
    const scratch = join(outDir, `.update-lock.${process.pid}`)
    const { npmLock } = await assembleInto(scratch, catalog, null)
    const sorted = Object.fromEntries(
      Object.entries(npmLock).sort(([a], [b]) => a.localeCompare(b)),
    )
    await writeFile(lockPath, `${JSON.stringify({ npm: sorted }, null, 2)}\n`)
    console.log(`锁文件已更新：${displayPath(lockPath)}`)
    const version = await libraryVersion(libraryDir)
    if (existsSync(join(outDir, version))) await rm(scratch, { recursive: true, force: true })
    else await rename(scratch, join(outDir, version))
    await publishCatalog(catalog, version)
    return
  }

  if (!existsSync(lockPath)) throw new SyncError(`缺少锁文件 ${lockPath}，先运行 --update-lock`)
  const version = await libraryVersion(libraryDir)
  const versionDir = join(outDir, version)
  if (existsSync(versionDir)) {
    console.log(`组件库 ${version} 已组装过，跳过：${displayPath(versionDir)}`)
  } else {
    const { files } = await assembleInto(versionDir, catalog, await readJson(lockPath))
    console.log(`组件库已组装：${displayPath(versionDir)}（${files.length} 个文件）`)
  }
  await publishCatalog(catalog, version)
}

async function publishCatalog(catalog, version) {
  const versionDir = join(outDir, version)
  const published = await publishedCatalog(catalog, version, (src) =>
    readFile(join(versionDir, src), 'utf8'),
  )
  await writeAtomic(join(outDir, 'catalog.json'), `${JSON.stringify(published, null, 2)}\n`)
  console.log(`组件目录已写入：${displayPath(join(outDir, 'catalog.json'))}（version ${version}）`)
}

try {
  await main()
} catch (error) {
  console.error(
    `hf:registry 失败：${error instanceof SyncError || error instanceof IntegrityError ? error.message : (error?.stack ?? error)}`,
  )
  process.exit(1)
}
