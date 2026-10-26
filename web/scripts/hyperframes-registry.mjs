#!/usr/bin/env node
/**
 * 把一份组件库源目录组装成站点与渲染服务读的组件库（输出不入库；正式组件库在部署侧，见 docs/deploy.md）。
 *
 *   pnpm hf:registry                                   组装入库的测试组件库（scripts/hyperframes-fixtures/）
 *                                                      到 public/hyperframes/
 *   pnpm hf:registry --library <源目录> --out <输出目录>  组装指定的组件库
 *   pnpm hf:registry --update-lock [--library <源目录>]   重新下载并重写源目录的 registry.lock.json
 *                                                      （升级版本，或改了组件目录、本地化规则、改写之后）
 *   pnpm hf:registry --tarball <路径>                   用本机已有的 HyperFrames 源码包（仍核对 sha256）
 *   pnpm hf:registry --library <源目录> --smoke <目录>   冒烟筛选用（render/scripts/smoke-catalog.mjs）：装上
 *                                                      源码包里所有文件齐全、外链能本地化的组件，写到指定目录
 *
 * 源目录：catalog.json（组件目录）、registry.lock.json（npm 包 tgz 的摘要）、patches/（改写：manifest.json
 * 记下每个文件替换的原文摘要，null 为新文件）、thumbnails/（面板封面）、fonts/（字体文件）。
 * 组件目录的 fonts 是 字体名 → `{ css, brand?, faces? }`：css 是这个字体整套字形的 CSS 写到哪里；brand 是
 * 品牌缩写，带 brand 的字体是字体可填项的选项；faces 只写在源目录，列出 fonts/ 下的字体文件
 * `[{ file, weight, style }]`，没写 faces 的字体来自组件引用的网页字体。
 * 输出：<输出目录>/catalog.json（见 publishedCatalog：加上 version 与字体可填项，字体去掉 faces）与
 * <输出目录>/<version>/（组件、运行时、字体、封面）。
 * version 是全部输入的摘要（见 libraryVersion）；版本目录已存在就不再组装，只写 catalog.json。版本目录生成后
 * 不再改动，旧版本目录不删。
 *
 * 步骤：目录里有不是由改写新增的组件时，下载 tag 源码包并核对 sha256，把这些组件按 `hyperframes add` 的
 * 安装位置放好 → 组件与改写里的外链换成本地文件（npm 包与 fontsource 字体，tgz 核对锁文件里的摘要）→ 放入 HyperFrames
 * 运行时 → 套用改写 → 组件去掉底色 → 写组件字体的整套字形 → 放入封面 → 确认没有外链残留、引用的文件都在。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import {
  CDN_HOST_PATTERN,
  CJK_FONT,
  DEFAULT_OUT,
  FIXTURES_DIR,
  HF_VERSION,
  IntegrityError,
  RUNTIME,
  SyncError,
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

/** 在 temp 里组装出完整的组件库；返回用到的 npm 包 tgz 摘要与全部文件。`lock` 为 null 时重新取摘要。 */
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

  // 1. 按安装位置放好源码包里收录的组件；不同组件装到同一位置时内容必须相同。全部组件都由改写
  //    新增时不需要源码包。冒烟筛选装上所有文件齐全、外链能本地化的组件，由渲染结果决定收不收。
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

  // 2. 外链换成本地路径，记下要放进 vendor/ 的文件。
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
  // 改写的文件同样换外链，第 6 步写入；它们要的脚本与字体在下面几步一起放进 vendor/。
  const patched = new Map()
  for (const target of Object.keys(manifest.files)) {
    const data = await readFile(join(patchesDir, target))
    patched.set(target, RUNTIME_TEXT.test(target) ? localizeText(data, target, '改写') : data)
  }

  // 3. npm 包：tgz 核对摘要后取出用到的文件，连同许可证。
  const npmLock = {}
  const opened = new Map()
  const openPackage = async (name, version) => {
    const key = `${name}@${version}`
    if (!opened.has(key)) {
      // 冒烟筛选可能用到锁文件之外的包：没有记录的按 npm 给的完整性核对。
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

  // 4. 字体：Google Fonts 请求换成 fontsource 的字体文件加我们写的 CSS；字幕用的中文字体另出一份。
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
    () => true,
  )

  // 5. HyperFrames 运行时：取已安装的同版本 @hyperframes/core。
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

  // 6. 改写：manifest.json 记下每个文件替换的原文摘要（新文件为 null）；原文变了就要重新改写。
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

  // 6b. 组件（不含区块）的合成文件去掉底色，照 HyperFrames Studio 安装组件时的做法
  //     （packages/studio/src/utils/blockInstaller.ts 的 makeComponentBackgroundTransparent，正则原样照抄）：
  //     组件叠在画面上，不能把底下的画面盖黑。组件目录说了算；冒烟筛选没有目录，按源码包的归类。
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

  // 7. 组件字体的整套字形：组件目录里每个字体一份 CSS，合成页按用到的组件与选中的字体引用，渲染服务把它
  //    内联进合成页。写了 faces 的字体用源目录 fonts/ 下的字体文件，每个字重、字形一条 @font-face。其余
  //    字体来自组件：有些组件只写字体名、不引用字体文件，所以西文字形收组件库各处向 Google Fonts 请求过的
  //    全部字重。中文字形对这个字体出现过的每种字重、字形各出一组（原因见 cjkTwinFaces）。
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
      const local = await localFontFaces({
        family,
        faces: localFaces,
        cssPath,
        libraryDir,
        outDir: temp,
      })
      const cjk = await cjkTwinFaces(family, local.descriptors, notoDir)
      await writeOut(cssPath, `${local.css}\n${cjk}\n`)
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

  // 8. 面板封面。
  const thumbnailsDir = join(libraryDir, 'thumbnails')
  if (existsSync(thumbnailsDir)) {
    for (const file of await listFiles(thumbnailsDir)) {
      await writeOut(`thumbnails/${file}`, await readFile(join(thumbnailsDir, file)))
    }
  }

  // 9. 不能再有外链。
  const files = await listFiles(temp)
  const leftovers = []
  for (const path of files.filter(
    (file) => RUNTIME_TEXT.test(file) && !file.startsWith('vendor/npm/'),
  )) {
    if (CDN_HOST_PATTERN.test(await readFile(join(temp, path), 'utf8'))) leftovers.push(path)
  }
  if (leftovers.length > 0) throw new SyncError(`仍有外链：\n  ${leftovers.join('\n  ')}`)

  // 10. 组件里写死的本地路径、目录里的封面都要能取到（按运行时的解析方式）。冒烟筛选要实际渲染这些组件
  //     来判断，跳过。
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

/** 组装到 out 旁的临时目录，成功后改名为 target；失败时删掉临时目录。 */
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
    console.log(`冒烟筛选用的组件库：${smokeDir}（${files.length} 个文件）`)
    return
  }
  await mkdir(outDir, { recursive: true })

  if (updateLock) {
    // 锁文件是版本号的输入：先在临时目录组装、写好锁文件，再按新的版本号放好。
    const scratch = join(outDir, `.update-lock.${process.pid}`)
    const { npmLock } = await assembleInto(scratch, catalog, null)
    const sorted = Object.fromEntries(
      Object.entries(npmLock).sort(([a], [b]) => a.localeCompare(b)),
    )
    await writeFile(lockPath, `${JSON.stringify({ npm: sorted }, null, 2)}\n`)
    console.log(`锁文件已更新：${lockPath}`)
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
    console.log(`组件库 ${version} 已组装过，跳过：${versionDir}`)
  } else {
    const { files } = await assembleInto(versionDir, catalog, await readJson(lockPath))
    console.log(`组件库已组装：${versionDir}（${files.length} 个文件）`)
  }
  await publishCatalog(catalog, version)
}

/**
 * 写 <out>/catalog.json（见 publishedCatalog），整份原子替换。字体可填项按版本目录里的组件文件判断，
 * 版本目录已组装过、这次跳过组装时结果也一样。
 */
async function publishCatalog(catalog, version) {
  const versionDir = join(outDir, version)
  const published = await publishedCatalog(catalog, version, (src) =>
    readFile(join(versionDir, src), 'utf8'),
  )
  await writeAtomic(join(outDir, 'catalog.json'), `${JSON.stringify(published, null, 2)}\n`)
  console.log(`组件目录已写入：${join(outDir, 'catalog.json')}（version ${version}）`)
}

try {
  await main()
} catch (error) {
  console.error(
    `hf:registry 失败：${error instanceof SyncError || error instanceof IntegrityError ? error.message : (error?.stack ?? error)}`,
  )
  process.exit(1)
}
