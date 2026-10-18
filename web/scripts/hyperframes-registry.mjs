#!/usr/bin/env node
/**
 * 同步 HyperFrames 组件库到 public/hyperframes/<版本>/（不入库；web 镜像、render 镜像构建时与 make setup 各跑一次）。
 *
 *   pnpm hf:registry                      按锁文件同步；已是最新时什么也不做
 *   pnpm hf:registry --update-lock        重新下载并重写锁文件（升级版本，或改了组件目录、本地化规则、补丁之后）
 *   pnpm hf:registry --tarball <路径>     用本机已有的源码包（仍核对 sha256）
 *   pnpm hf:registry --smoke <目录>       冒烟筛选用（render/scripts/smoke-catalog.mjs）：装上源码包里
 *                                         所有文件齐全、外链能本地化的组件，写到指定目录；不核对锁文件
 *
 * 步骤：下载 tag 源码包并核对 sha256 → 把组件目录（catalog.json）收录的组件按 `hyperframes add`
 * 的安装位置放好 → 外链换成本地文件（npm 包与 fontsource 字体，tgz 核对锁文件里的摘要）→ 放入
 * HyperFrames 运行时 → 套用 hyperframes-patches/ 的改写 → 组件去掉底色 → 写组件字体的整套字形 → 确认没有外链残留 →
 * 每个文件与锁文件逐一核对。
 * 输出目录里的 .hyperframes-sync.json 记录锁文件摘要；再跑时文件全部一致即跳过，有改动即报错。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import {
  CATALOG_DIR,
  CDN_HOST_PATTERN,
  CJK_FONT,
  HF_VERSION,
  IntegrityError,
  LOCK_PATH,
  OUTPUT_DIR,
  PATCHES_DIR,
  RUNTIME,
  TARBALL,
  WEB_ROOT,
  cjkTwinFaces,
  compositionTarget,
  fontFaceDescriptors,
  fontFaces,
  fontPackage,
  installedFiles,
  isLatinSubset,
  listFiles,
  localReferences,
  localize,
  npmPackage,
  registryItems,
  sha256,
  sourceTree,
} from './hyperframes-shared.mjs'

const STAMP = '.hyperframes-sync.json'
const RUNTIME_TEXT = /\.(html?|css|m?js|cjs)$/i
const COMPONENT_BACKGROUND = /background:\s*(?:#(?:0a0a0a|000000|000|0a0805)|rgba?\([^)]*\))\s*;/g

const args = process.argv.slice(2)
const updateLock = args.includes('--update-lock')
const tarballArg = args.includes('--tarball') ? args[args.indexOf('--tarball') + 1] : undefined
const smokeDir = args.includes('--smoke') ? args[args.indexOf('--smoke') + 1] : undefined

class SyncError extends Error {}

/** 决定同步结果的入库输入：锁文件、组件目录、改写文件与同步脚本。任一变化都要重新组装。 */
async function inputsDigest(lockText) {
  const parts = [lockText, await readFile(join(CATALOG_DIR, 'catalog.json'), 'utf8')]
  // 同步脚本本身（本地化规则等）改了也要重新组装。
  for (const script of ['hyperframes-registry.mjs', 'hyperframes-shared.mjs']) {
    parts.push(await readFile(join(WEB_ROOT, 'scripts', script), 'utf8'))
  }
  for (const path of await listFiles(PATCHES_DIR)) {
    parts.push(path, await readFile(join(PATCHES_DIR, path), 'utf8'))
  }
  return sha256(parts.join('\0'))
}

/**
 * 输出目录与锁文件逐一核对。没有同步标记、或入库输入变了时返回 false（需要重新组装，
 * 组装结果再与锁文件核对）；标记与输入一致而文件对不上（被改过）时报错。
 */
async function upToDate(lock, inputs) {
  const stampPath = join(OUTPUT_DIR, STAMP)
  if (!existsSync(stampPath)) return false
  const stamp = JSON.parse(await readFile(stampPath, 'utf8'))
  if (stamp.inputs !== inputs) return false
  const actual = (await listFiles(OUTPUT_DIR)).filter((path) => path !== STAMP)
  const problems = actual.filter((path) => !(path in lock.files)).map((path) => `多出 ${path}`)
  for (const [path, digest] of Object.entries(lock.files)) {
    if (!existsSync(join(OUTPUT_DIR, path))) problems.push(`缺少 ${path}`)
    else if (sha256(await readFile(join(OUTPUT_DIR, path))) !== digest)
      problems.push(`被改动 ${path}`)
  }
  if (problems.length > 0) {
    throw new SyncError(
      `${OUTPUT_DIR} 与锁文件不一致：\n  ${problems.slice(0, 20).join('\n  ')}\n删除该目录后重跑可重新同步。`,
    )
  }
  return true
}

/** 组件目录（人工维护的 catalog.json）收录的组件名。 */
async function includedNames() {
  const catalog = JSON.parse(await readFile(join(CATALOG_DIR, 'catalog.json'), 'utf8'))
  if (catalog.version !== HF_VERSION) {
    throw new SyncError(`组件目录是 ${catalog.version}，同步脚本是 ${HF_VERSION}`)
  }
  return new Set(catalog.items.map((item) => item.name))
}

/** 在临时目录里组装出完整的组件库；返回用到的 npm 包 tgz 摘要。 */
async function assemble(temp, lock) {
  const writeOut = async (path, data) => {
    await mkdir(dirname(join(temp, path)), { recursive: true })
    await writeFile(join(temp, path), data)
  }

  // 1. 按安装位置放好收录的组件；不同组件装到同一位置时内容必须相同。
  //    冒烟筛选装上所有文件齐全、外链能本地化的组件，由渲染结果决定收不收。
  const src = await sourceTree(tarballArg)
  const names = smokeDir ? null : await includedNames()
  const installable = async ({ dir, item }) => {
    for (const file of installedFiles(item)) {
      if (!existsSync(join(dir, file.path))) return false
      if (!RUNTIME_TEXT.test(file.target)) continue
      const text = await readFile(join(dir, file.path), 'utf8')
      if (localize(text, file.target).unsupported.length > 0) return false
    }
    return true
  }
  const items = []
  for (const entry of await registryItems(src)) {
    if (names ? names.has(entry.name) : await installable(entry)) items.push(entry)
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
  await writeOut('LICENSE', await readFile(join(src, 'LICENSE')))

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
  for (const [target, { name, data }] of installed) {
    if (!RUNTIME_TEXT.test(target)) {
      await writeOut(target, data)
      continue
    }
    const result = localize(data.toString('utf8'), target)
    if (result.unsupported.length > 0) {
      throw new SyncError(`${name} 的 ${target} 有换不了的外链：${result.unsupported.join('；')}`)
    }
    for (const need of result.needs) {
      if (need.npm) addNpm(need.npm)
      else fontCss.set(need.css, need.fonts)
    }
    await writeOut(target, result.text)
  }

  // 3. npm 包：tgz 核对摘要后取出用到的文件，连同许可证。
  const npmLock = {}
  const opened = new Map()
  const openPackage = async (name, version) => {
    const key = `${name}@${version}`
    if (!opened.has(key)) {
      // 冒烟筛选可能用到锁文件之外的包：没有记录的按 npm 给的完整性核对。
      const expected = updateLock ? null : (lock.npm[key] ?? null)
      if (!updateLock && !smokeDir && expected === null)
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
  const manifest = JSON.parse(await readFile(join(PATCHES_DIR, 'manifest.json'), 'utf8'))
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
    await writeOut(target, await readFile(join(PATCHES_DIR, target)))
  }

  // 6b. 组件（不含区块）的合成文件去掉底色，照 HyperFrames Studio 安装组件时的做法
  //     （packages/studio/src/utils/blockInstaller.ts 的 makeComponentBackgroundTransparent，正则原样照抄）：
  //     组件叠在画面上，不能把底下的画面盖黑。
  for (const { kind, item } of items) {
    if (kind !== 'component') continue
    const path = join(temp, compositionTarget(item))
    const text = await readFile(path, 'utf8')
    const transparent = text.replace(COMPONENT_BACKGROUND, 'background: transparent;')
    if (transparent !== text) await writeFile(path, transparent)
  }

  // 7. 组件字体的整套字形：组件目录里每个用到的网页字体一份 CSS，合成页按用到的组件引用，渲染服务把它
  //    内联进合成页。有些组件只写字体名、不引用字体文件，所以西文字形收组件库各处向 Google Fonts 请求过的
  //    全部字重；中文字形对这个字体在组件库里出现过的每种字重、字形各出一组（原因见 cjkTwinFaces）。
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
  const catalog = JSON.parse(await readFile(join(CATALOG_DIR, 'catalog.json'), 'utf8'))
  for (const [family, cssPath] of Object.entries(catalog.fonts)) {
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

  // 8. 不能再有外链。
  const files = await listFiles(temp)
  const leftovers = []
  for (const path of files.filter(
    (file) => RUNTIME_TEXT.test(file) && !file.startsWith('vendor/npm/'),
  )) {
    if (CDN_HOST_PATTERN.test(await readFile(join(temp, path), 'utf8'))) leftovers.push(path)
  }
  if (leftovers.length > 0) throw new SyncError(`仍有外链：\n  ${leftovers.join('\n  ')}`)

  // 9. 组件里写死的本地路径都要能取到（按运行时的解析方式）。冒烟筛选要实际渲染这些组件来判断，跳过。
  if (smokeDir) return { npmLock, files }
  const present = new Set(files)
  const missing = []
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

async function main() {
  const lockText = existsSync(LOCK_PATH) ? await readFile(LOCK_PATH, 'utf8') : null
  if (!updateLock && lockText === null)
    throw new SyncError(`缺少锁文件 ${LOCK_PATH}，先运行 --update-lock`)
  const lock = lockText === null ? null : JSON.parse(lockText)
  if (smokeDir) {
    await rm(smokeDir, { recursive: true, force: true })
    await mkdir(smokeDir, { recursive: true })
    const { files } = await assemble(smokeDir, lock)
    console.log(`冒烟筛选用的组件库：${smokeDir}（${files.length} 个文件）`)
    return
  }
  if (!updateLock && (await upToDate(lock, await inputsDigest(lockText)))) {
    console.log(`组件库已是最新：${OUTPUT_DIR}`)
    return
  }

  const temp = `${OUTPUT_DIR}.tmp`
  await rm(temp, { recursive: true, force: true })
  await mkdir(temp, { recursive: true })
  const { npmLock, files } = await assemble(temp, lock)
  const digests = {}
  let bytes = 0
  for (const path of files) {
    const data = await readFile(join(temp, path))
    digests[path] = sha256(data)
    bytes += data.length
  }

  let finalLockText = lockText
  if (updateLock) {
    const next = {
      version: HF_VERSION,
      tarball: { url: TARBALL.url, sha256: TARBALL.sha256 },
      npm: npmLock,
      files: digests,
    }
    finalLockText = `${JSON.stringify(next, null, 2)}\n`
    await writeFile(LOCK_PATH, finalLockText)
  } else {
    const problems = []
    for (const path of files) {
      if (!(path in lock.files)) problems.push(`锁文件里没有 ${path}`)
      else if (lock.files[path] !== digests[path]) problems.push(`摘要不符 ${path}`)
    }
    for (const path of Object.keys(lock.files))
      if (!(path in digests)) problems.push(`缺少 ${path}`)
    if (problems.length > 0) {
      throw new SyncError(
        `同步结果与锁文件不一致（改了组件目录或改写文件后要运行 --update-lock）：\n  ${problems.slice(0, 20).join('\n  ')}`,
      )
    }
  }

  const stamp = { inputs: await inputsDigest(finalLockText) }
  await writeFile(join(temp, STAMP), `${JSON.stringify(stamp)}\n`)
  await rm(OUTPUT_DIR, { recursive: true, force: true })
  await rename(temp, OUTPUT_DIR)
  console.log(
    `组件库已同步：${OUTPUT_DIR}（${files.length} 个文件，${(bytes / 1024 / 1024).toFixed(1)} MB）`,
  )
}

try {
  await main()
} catch (error) {
  console.error(
    `hf:registry 失败：${error instanceof SyncError || error instanceof IntegrityError ? error.message : (error?.stack ?? error)}`,
  )
  process.exit(1)
}
