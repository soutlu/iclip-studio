import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const HF_VERSION = '0.9.31'
export const TARBALL = {
  url: `https://codeload.github.com/heygen-com/hyperframes/tar.gz/refs/tags/v${HF_VERSION}`,
  sha256: '2a237209ea7b5bcf106b05eec368c87e0bb0981ed66e7ddd0f572fa764f788ed',
  root: `hyperframes-${HF_VERSION}`,
}

export const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const CACHE_DIR = join(WEB_ROOT, 'node_modules', '.cache', 'hyperframes', HF_VERSION)
export const FIXTURES_DIR = join(WEB_ROOT, 'scripts', 'hyperframes-fixtures')
export const DEFAULT_OUT = join(WEB_ROOT, 'public', 'hyperframes')

const LIBRARY_INPUTS = ['catalog.json', 'registry.lock.json', 'patches', 'thumbnails', 'fonts']

export async function libraryVersion(library) {
  const hash = createHash('sha256')
  const add = (data) => hash.update(data).update('\0')
  add(HF_VERSION)
  for (const script of ['hyperframes-registry.mjs', 'hyperframes-shared.mjs']) {
    add(script)
    add(await readFile(join(WEB_ROOT, 'scripts', script)))
  }
  for (const entry of LIBRARY_INPUTS) {
    const path = join(library, entry)
    if (!existsSync(path)) continue
    const files = (await stat(path)).isDirectory()
      ? (await listFiles(path)).map((file) => posix.join(entry, file))
      : [entry]
    for (const file of files) {
      add(file)
      add(await readFile(join(library, file)))
    }
  }
  return hash.digest('hex').slice(0, 12)
}

export const CJK_FONT = {
  family: 'Noto Sans SC',
  weights: [400, 700],
}

/** 版本目录里组装时写下的字体表：中文分片、各字体族的中文孪生描述与样式表路径，发布组件目录时读它。 */
export const FONT_TABLE = 'fonts.json'

export const RUNTIME = {
  hyperframes: `vendor/hyperframes/${HF_VERSION}/hyperframe.runtime.iife.js`,
  gsap: 'vendor/npm/gsap@3.14.2/dist/gsap.min.js',
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex')

export class IntegrityError extends Error {}

export class SyncError extends Error {}

const NPM_REGISTRY = (process.env.NPM_CONFIG_REGISTRY ?? 'https://registry.npmjs.org/').replace(
  /\/?$/,
  '/',
)

async function download(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`下载失败 ${response.status}：${url}`)
  return Buffer.from(await response.arrayBuffer())
}

export async function writeAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, data)
  await rename(temp, path)
}

export async function fetchVerified(url, cachePath, expected) {
  const data = existsSync(cachePath) ? await readFile(cachePath) : await download(url)
  const actual = sha256(data)
  if (expected !== null && actual !== expected) {
    throw new IntegrityError(
      `校验和不符：${cachePath}\n  期望 ${expected}\n  实际 ${actual}\n来源 ${url}`,
    )
  }
  if (!existsSync(cachePath)) await writeAtomic(cachePath, data)
  return { data, sha256: actual }
}

async function extractTarball(file, dir) {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await run('tar', ['-xzf', file, '-C', dir], { maxBuffer: 1 << 26 })
}

export async function sourceTree(tarball) {
  const file = tarball ?? join(CACHE_DIR, 'hyperframes.tar.gz')
  const { sha256: actual } = await fetchVerified(TARBALL.url, file, TARBALL.sha256)
  const dir = join(CACHE_DIR, 'src')
  const marker = join(dir, '.extracted')
  if (!existsSync(marker) || (await readFile(marker, 'utf8')) !== actual) {
    await extractTarball(file, dir)
    await writeFile(marker, actual)
  }
  return join(dir, TARBALL.root)
}

export async function registryItems(src) {
  const registry = JSON.parse(await readFile(join(src, 'registry', 'registry.json'), 'utf8'))
  const items = []
  for (const entry of registry.items) {
    const folder =
      entry.type === 'hyperframes:block'
        ? 'blocks'
        : entry.type === 'hyperframes:component'
          ? 'components'
          : null
    if (!folder) continue
    const dir = join(src, 'registry', folder, entry.name)
    const item = JSON.parse(await readFile(join(dir, 'registry-item.json'), 'utf8'))
    items.push({ name: entry.name, kind: folder === 'blocks' ? 'block' : 'component', dir, item })
  }
  return items
}

export const installedFiles = (item) =>
  (item.files ?? []).filter((file) => !file.target.endsWith('.md'))

export const compositionTarget = (item) =>
  item.files.find(
    (file) => file.type === 'hyperframes:composition' || file.type === 'hyperframes:snippet',
  )?.target

export function category(tags) {
  if (!tags || tags.length === 0) return 'scenes'
  const set = new Set(tags)
  if (set.has('captions') || set.has('caption-style')) return 'captions'
  if (set.has('code-animation')) return 'code-animation'
  if (set.has('transition')) return 'transitions'
  if (set.has('social') || set.has('overlay')) return 'social'
  if (set.has('data') || set.has('chart') || set.has('map')) return 'data'
  if (set.has('html-in-canvas') || set.has('webgl') || set.has('shader')) return 'vfx'
  if (set.has('text-effect')) return 'text-effects'
  if (set.has('effect') || set.has('grain') || set.has('vignette')) return 'effects'
  return 'scenes'
}

export const placement = (categoryId) => (categoryId === 'captions' ? 'caption' : null)

export function rootAttributes(html) {
  const tag = /<[a-z]+\b[^>]*\bdata-composition-id\b[^>]*>/i.exec(html)?.[0] ?? ''
  const number = (attribute) => {
    const value = new RegExp(`\\b${attribute}\\s*=\\s*["']?([\\d.]+)`).exec(tag)?.[1]
    return value === undefined ? null : Number(value)
  }
  return {
    width: number('data-width'),
    height: number('data-height'),
    duration: number('data-duration'),
  }
}

export const isTextFile = (path) => /\.(html?|css|m?js|cjs|json|svg)$/i.test(path)

const isRuntimeText = (path) => /\.(html?|css|m?js|cjs)$/i.test(path)

const CDN_HOSTS = [
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdnjs.cloudflare.com',
  'unpkg.com',
  'www.gstatic.com',
  'static.heygen.ai',
]
const CDN_URL = new RegExp(
  `https?://(?:${CDN_HOSTS.map((host) => host.replaceAll('.', '\\.')).join('|')})[^\\s"'\`)<>\\\\]*`,
  'g',
)
export const CDN_HOST_PATTERN = new RegExp(
  CDN_HOSTS.map((host) => host.replaceAll('.', '\\.')).join('|'),
)

const RANGE_PINS = {
  'd3@7': '7.9.0',
  'us-atlas@3': '3.0.1',
  'world-atlas@2': '2.0.2',
}

const MIRRORS = [
  {
    prefix: 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
    to: { name: 'three', version: '0.128.0', file: 'build/three.min.js' },
  },
  {
    prefix: 'https://www.gstatic.com/draco/versioned/decoders/1.5.6/',
    to: {
      name: 'three',
      version: '0.147.0',
      dir: 'examples/js/libs/draco/',
      files: ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js'],
    },
  },
]

const FONTSOURCE_VERSION = '5.3.0'
const FONT_PACKAGES = {
  'Noto Sans SC': { name: '@fontsource/noto-sans-sc', version: '5.3.1' },
  'Roboto Flex': { name: '@fontsource-variable/roboto-flex', version: '5.2.8', variable: true },
}
export function fontPackage(family) {
  return (
    FONT_PACKAGES[family] ?? {
      name: `@fontsource/${family.toLowerCase().replaceAll(' ', '-')}`,
      version: FONTSOURCE_VERSION,
    }
  )
}

const npmPath = (name, version, file) => `vendor/npm/${name}@${version}/${file}`

function parseGoogleFonts(url) {
  const query = new URL(url.replaceAll('&amp;', '&')).searchParams
  const display = query.get('display') ?? 'auto'
  const families = query.getAll('family').map((spec) => {
    const [name, axes] = spec.split(':')
    const family = name.replaceAll('+', ' ')
    if (!axes) return { family, faces: [{ style: 'normal', weight: '400' }] }
    const [keys, values] = axes.split('@')
    const names = keys.split(',')
    if (values.includes('..')) return { family, faces: [{ style: 'normal', weight: 'variable' }] }
    const faces = values.split(';').map((tuple) => {
      const parts = Object.fromEntries(
        tuple.split(',').map((value, index) => [names[index], value]),
      )
      return { style: parts.ital === '1' ? 'italic' : 'normal', weight: parts.wght ?? '400' }
    })
    return { family, faces }
  })
  return { display, families }
}

// 按来源地址起的临时文件名；写出内容后由 relocate 换成按内容摘要命名
const googleFontsCss = (fonts) => `vendor/fonts/${sha256(JSON.stringify(fonts)).slice(0, 12)}.css`

function resolveUrl(url) {
  const jsdelivr = /^https?:\/\/cdn\.jsdelivr\.net\/npm\/((?:@[^/]+\/)?[^/@]+)@([^/]+)\/(.+)$/.exec(
    url,
  )
  if (jsdelivr) {
    const [, name, range, file] = jsdelivr
    if (file.endsWith('+esm')) return { unsupported: `jsDelivr 打包的 ES 模块：${url}` }
    const version = /^\d+\.\d+\.\d+$/.test(range) ? range : RANGE_PINS[`${name}@${range}`]
    if (!version) return { unsupported: `jsDelivr 上没钉版本的 ${name}@${range}` }
    return { path: npmPath(name, version, file), needs: [{ npm: { name, version, file } }] }
  }
  if (url.startsWith('https://fonts.googleapis.com/css')) {
    const fonts = parseGoogleFonts(url)
    const css = googleFontsCss(fonts)
    return { path: css, needs: [{ fonts, css }] }
  }
  for (const mirror of MIRRORS) {
    if (url !== mirror.prefix) continue
    const { name, version } = mirror.to
    if (mirror.to.file) {
      return { path: npmPath(name, version, mirror.to.file), needs: [{ npm: mirror.to }] }
    }
    return {
      path: npmPath(name, version, mirror.to.dir),
      needs: mirror.to.files.map((file) => ({
        npm: { name, version, file: mirror.to.dir + file },
      })),
    }
  }
  return { unsupported: `没有本地化规则：${url}` }
}

function moduleRanges(text, path) {
  if (/\.m?js$/.test(path)) {
    return [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'`]https?:\/\/[^"'`]+["'`]/g)].map(
      (match) => [match.index, match.index + match[0].length],
    )
  }
  return [
    ...text.matchAll(
      /<script\b[^>]*\btype\s*=\s*["']?(?:module|importmap)\b[^>]*>[\s\S]*?<\/script>/gi,
    ),
  ].map((match) => [match.index, match.index + match[0].length])
}

const PRECONNECT =
  /[ \t]*<link\b[^>]*\brel\s*=\s*["']?(?:preconnect|dns-prefetch)\b[^>]*>[ \t]*\r?\n?/gi

const tagRanges = (text, name) =>
  [...text.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((match) => [
    match.index,
    match.index + match[0].length,
  ])
const within = (ranges, offset) => ranges.some(([from, to]) => offset >= from && offset < to)

export function localize(text, path) {
  if (!isRuntimeText(path)) return { text, needs: [], unsupported: [] }
  const stripped = text.replace(PRECONNECT, (tag) => (CDN_HOST_PATTERN.test(tag) ? '' : tag))
  const modules = moduleRanges(stripped, path)
  const links = tagRanges(stripped, 'link')
  const needs = []
  const unsupported = []
  const output = stripped.replace(CDN_URL, (url, offset) => {
    if (within(modules, offset)) {
      unsupported.push(`ES 模块导入：${url}`)
      return url
    }
    const resolved = resolveUrl(url)
    if (resolved.unsupported) {
      unsupported.push(resolved.unsupported)
      return url
    }
    needs.push(...resolved.needs)
    return within(links, offset)
      ? posix.relative(posix.dirname(path), resolved.path)
      : resolved.path
  })
  return { text: output, needs, unsupported }
}

const LOCAL_REFERENCE =
  /<(link|script|img|video|audio|source|image|use)\b[^>]*?\s(?:src|href|xlink:href)\s*=\s*["']([^"'#?]+)[^"']*["']|url\(\s*["']?([^"')#?]+)/gi

export function localReferences(text, path) {
  const blank = (match) => ' '.repeat(match.length)
  const masked = text
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(
      /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,
      (_, open, body, close) => open + blank(body) + close,
    )
    .replace(/\/\*[\s\S]*?\*\//g, blank)
  const result = []
  for (const match of masked.matchAll(LOCAL_REFERENCE)) {
    const tag = match[1]?.toLowerCase()
    const reference = (match[2] ?? match[3]).trim()
    if (!reference || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|\$\{|\{\{)/i.test(reference)) continue
    if (!/\.[a-z0-9]{2,5}$/i.test(reference)) continue
    const fileRelative =
      path.endsWith('.css') ||
      tag === 'link' ||
      reference.startsWith('../') ||
      (tag === 'script' && reference.startsWith('./'))
    const resolved = fileRelative
      ? posix.normalize(posix.join(posix.dirname(path), reference))
      : posix.normalize(reference.replace(/^\.\//, ''))
    result.push({ reference, resolved })
  }
  return result
}

export async function npmPackage(name, version, expected) {
  const base = name.split('/').at(-1)
  const url = `${NPM_REGISTRY}${name}/-/${base}-${version}.tgz`
  const cachePath = join(CACHE_DIR, 'npm', `${name.replace('/', '__')}@${version}.tgz`)
  const { data, sha256: actual } = await fetchVerified(url, cachePath, expected)
  if (expected === null) {
    const meta = await fetch(`${NPM_REGISTRY}${name.replace('/', '%2f')}/${version}`).then(
      (response) => {
        if (!response.ok)
          throw new Error(`读取 npm 包信息失败 ${response.status}：${name}@${version}`)
        return response.json()
      },
    )
    const integrity = `sha512-${createHash('sha512').update(data).digest('base64')}`
    if (meta.dist?.integrity !== integrity) {
      throw new IntegrityError(`npm 包完整性不符：${name}@${version}`)
    }
  }
  const dir = join(CACHE_DIR, 'npm', `${name.replace('/', '__')}@${version}`)
  const marker = join(dir, '.extracted')
  if (!existsSync(marker) || (await readFile(marker, 'utf8')) !== actual) {
    await extractTarball(cachePath, dir)
    await writeFile(marker, actual)
  }
  return { dir: join(dir, 'package'), sha256: actual }
}

export async function fontFaces(
  family,
  faces,
  display,
  packageDir,
  pkg,
  subsetFilter,
  npmBase = '../npm',
) {
  const metadata = JSON.parse(await readFile(join(packageDir, 'metadata.json'), 'utf8'))
  const unicode = JSON.parse(await readFile(join(packageDir, 'unicode.json'), 'utf8'))
  const subsets = Object.keys(unicode).filter(subsetFilter)
  const css = []
  const files = []
  for (const face of faces) {
    for (const subset of subsets) {
      const slice = subset.replace(/^\[(\d+)\]$/, '$1')
      const weight = face.weight === 'variable' ? 'full' : face.weight
      const file = `files/${metadata.id}-${slice}-${weight}-${face.style}.woff2`
      if (!existsSync(join(packageDir, file))) {
        if (subset === 'latin')
          throw new Error(`${pkg.name} 没有 ${face.style} ${face.weight} 的字形文件 ${file}`)
        continue
      }
      files.push(file)
      const weightRange =
        face.weight === 'variable'
          ? `${metadata.variable.wght.min} ${metadata.variable.wght.max}`
          : face.weight
      css.push(
        `@font-face{font-family:'${family}';font-style:${face.style};font-display:${display};` +
          `font-weight:${weightRange};src:url(${npmBase}/${pkg.name}@${pkg.version}/${file}) format('woff2');` +
          `unicode-range:${unicode[subset]}}`,
      )
    }
  }
  return { css: css.join('\n'), files }
}

export const isLatinSubset = (subset) => subset === 'latin' || subset === 'latin-ext'

export async function cjkSlices(packageDir, pkg) {
  const metadata = JSON.parse(await readFile(join(packageDir, 'metadata.json'), 'utf8'))
  const unicode = JSON.parse(await readFile(join(packageDir, 'unicode.json'), 'utf8'))
  const slices = []
  const files = []
  for (const [subset, range] of Object.entries(unicode)) {
    const slice = subset.replace(/^\[(\d+)\]$/, '$1')
    const byWeight = {}
    for (const weight of CJK_FONT.weights) {
      const file = `files/${metadata.id}-${slice}-${weight}-normal.woff2`
      if (!existsSync(join(packageDir, file))) continue
      files.push(file)
      byWeight[weight] = npmPath(pkg.name, pkg.version, file)
    }
    if (Object.keys(byWeight).length > 0) slices.push({ range, files: byWeight })
  }
  return { slices, files }
}

const KEYWORD_WEIGHTS = { normal: '400', bold: '700' }
const cssValue = (block, property) =>
  new RegExp(`${property}\\s*:\\s*([^;}]+)`)
    .exec(block)?.[1]
    ?.trim()
    .replace(/^['"]|['"]$/g, '')
    .trim()

export function fontFaceDescriptors(text) {
  const result = []
  for (const [, block] of text.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const family = cssValue(block, 'font-family')
    if (!family) continue
    const weight = cssValue(block, 'font-weight') ?? '400'
    result.push({
      family,
      weight: KEYWORD_WEIGHTS[weight] ?? weight,
      style: cssValue(block, 'font-style') ?? 'normal',
    })
  }
  return result
}

export function twinDescriptors(descriptors) {
  const seen = new Set()
  const result = []
  for (const { weight, style } of descriptors) {
    const key = `${weight}/${style}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ weight, style })
  }
  return result
}

// 中文字体由成片按用到的字声明；组件文件里链整份中文字体的那一行在组装时去掉
const CJK_STYLESHEET_LINK =
  /[ \t]*<link\b[^>]*\bhref="[^"]*vendor\/fonts\/noto-sans-sc\.css"[^>]*>\n?/g
export const withoutCjkStylesheet = (html) => html.replace(CJK_STYLESHEET_LINK, '')

const HTML_COMMENT = /<!--[\s\S]*?-->/g
const NON_ASCII = /[\u0080-\u{10ffff}]/gu
export function componentChars(text) {
  const chars = new Set(text.replace(HTML_COMMENT, '').match(NON_ASCII))
  return [...chars].sort((a, b) => a.codePointAt(0) - b.codePointAt(0)).join('')
}

const ANIMATION_LIBRARY_TAG = /<script\b[^>]*\bsrc="[^"]*\/gsap[^"]*"/i
const USES_ANIMATION_LIBRARY = /\bgsap\./

/**
 * 组件文件用到动画库、自己却没引用它时，在它的第一段脚本前补上引用。
 * 成片文件不带脚本，组件单独放进成片时要靠自带的引用，不然它的脚本一运行就报错。
 */
export function withAnimationLibrary(html) {
  // 注释换成等长的空白：注释里的脚本不算，位置也不变
  const code = html.replace(HTML_COMMENT, (comment) => ' '.repeat(comment.length))
  if (!USES_ANIMATION_LIBRARY.test(code) || ANIMATION_LIBRARY_TAG.test(code)) return html
  const at = code.search(/<script\b/)
  if (at === -1) return html
  const tag = `<script src="${RUNTIME.gsap}"></script>`
  const lineStart = html.lastIndexOf('\n', at - 1) + 1
  const indent = html.slice(lineStart, at)
  return /^[ \t]*$/.test(indent)
    ? `${html.slice(0, lineStart)}${indent}${tag}\n${html.slice(lineStart)}`
    : `${html.slice(0, at)}${tag}${html.slice(at)}`
}

export const FONT_VARIABLE = { id: 'font', type: 'font', label: '字体', default: '' }

const READS_FONT_VARIABLE = /var\(\s*--font-(?:display|body)\b/

const FONT_CSS_PATH = /^vendor\/fonts\/families\/[^/]+\.css$/

export function checkCatalogFonts(fonts) {
  for (const [family, font] of Object.entries(fonts)) {
    if (typeof font !== 'object' || font === null || typeof font.css !== 'string')
      throw new SyncError(`字体「${family}」要写成 { css, brand?, faces? }`)
    if (!FONT_CSS_PATH.test(font.css))
      throw new SyncError(`字体「${family}」的 css 要放在 vendor/fonts/families/ 下：${font.css}`)
  }
}

export async function publishedCatalog(catalog, version, libraryText) {
  const items = []
  for (const item of catalog.items) {
    const text = await libraryText(item.src)
    const declared = item.variables.some((variable) => variable.id === FONT_VARIABLE.id)
    items.push({
      ...item,
      variables:
        !declared && READS_FONT_VARIABLE.test(text)
          ? [...item.variables, FONT_VARIABLE]
          : item.variables,
      chars: componentChars(text),
    })
  }
  const { slices, twins, css } = JSON.parse(await libraryText(FONT_TABLE))
  const fonts = Object.fromEntries(
    Object.entries(catalog.fonts).map(([family, { faces: _faces, ...font }]) => {
      if (!Object.hasOwn(css, family))
        throw new SyncError(`字体表中缺少字体「${family}」的样式表，请删除版本目录后重新组装`)
      const published = { ...font, css: css[family] }
      return [
        family,
        Object.hasOwn(twins, family) ? { ...published, cjk: twins[family] } : published,
      ]
    }),
  )
  return {
    version,
    ...catalog,
    runtime: RUNTIME,
    cjk: { family: CJK_FONT.family, slices },
    fonts,
    items,
  }
}

const FONT_FORMATS = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' }

export async function localFontFaces({ family, faces, cssPath, libraryDir, outDir }) {
  if (!Array.isArray(faces) || faces.length === 0)
    throw new SyncError(`字体「${family}」的 faces 要列出至少一个字体文件`)
  const rules = []
  for (const face of faces) {
    const file = posix.normalize(String(face.file ?? ''))
    if (!file.startsWith('fonts/'))
      throw new SyncError(`字体「${family}」的文件要在 fonts/ 下：${file}`)
    const format = FONT_FORMATS[posix.extname(file).slice(1).toLowerCase()]
    if (!format) throw new SyncError(`字体「${family}」的文件格式认不出：${file}`)
    const source = join(libraryDir, file)
    if (!existsSync(source)) throw new SyncError(`字体「${family}」的文件不存在：${file}`)
    await mkdir(dirname(join(outDir, file)), { recursive: true })
    await writeFile(join(outDir, file), await readFile(source))
    const weight = String(face.weight ?? 400)
    const style = face.style ?? 'normal'
    rules.push(
      `@font-face{font-family:'${family}';font-style:${style};font-display:block;font-weight:${weight};` +
        `src:url(${posix.relative(posix.dirname(cssPath), file)}) format('${format}')}`,
    )
  }
  return rules.join('\n')
}

// 组装结果里留在版本目录的顶层目录；其余顶层目录（组件自带的图片、声音、字体、模型、脚本）挪进 vendor/files/
const VERSION_DIRS = new Set(['compositions', 'thumbnails', 'vendor'])
const OWN_FILES = 'vendor/files'
// 第三方包原样拷贝的文件：其中的字符串不是组件库里的地址，不改写也不检查
const isPackageFile = (path) =>
  path.startsWith('vendor/npm/') || path.startsWith('vendor/hyperframes/')
const isOwnFile = (path) => path.startsWith(`${OWN_FILES}/`)
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const alternation = (paths) => paths.map(escapeRegExp).join('|')
// 地址前面紧挨着这些字符时不是地址的开头，比如 compositions/x/assets/a.png 里的 assets/a.png
const NOT_ADDRESS_START = '(?<![\\w.@/-])'
const lineOf = (text, offset) => text.slice(0, offset).split('\n').length

/** 把一份文本里指向挪走文件的地址改成新位置；地址按 localReferences 的规则区分按基准地址还是按文件位置解析。 */
function withMovedReferences(text, path, moved) {
  if (moved.size === 0) return text
  const dirs = [...new Set([...moved.keys()].map((file) => file.split('/')[0]))]
  const address = new RegExp(
    `${NOT_ADDRESS_START}((?:\\.{1,2}/)*)((?:${alternation(dirs)})/[^\\s"'\`()<>,;?#&\\\\]+)`,
    'g',
  )
  return text.replace(address, (whole, prefix, rest) => {
    const fileRelative = path.endsWith('.css') || prefix.startsWith('../')
    const resolved = fileRelative
      ? posix.normalize(posix.join(posix.dirname(path), prefix + rest))
      : posix.normalize(rest)
    const target = moved.get(resolved)
    if (target === undefined) return whole
    return fileRelative ? posix.relative(posix.dirname(path), target) : target
  })
}

// 组装时生成的字体样式表，内容随字体包与组装写法变化：文件名带内容摘要
function contentName(path, data) {
  const hash = sha256(data).slice(0, 12)
  if (/^vendor\/fonts\/families\/[^/]+\.css$/.test(path))
    return path.replace(/\.css$/, `-${hash}.css`)
  if (/^vendor\/fonts\/[^/]+\.css$/.test(path)) return `vendor/fonts/${hash}.css`
  return undefined
}

/**
 * 把组装目录整理成发布结构，使 vendor/ 下每个路径都对应唯一的内容（只增、不改、不删的前提）：
 * 1. 除 compositions/、thumbnails/、vendor/ 以外的顶层目录整体挪到 vendor/files/<目录名>-<内容摘要>/，
 *    条目文件与生成的样式表里指向这些文件的地址（src/href、url(...)、脚本字符串）改到新位置；
 *    挪走的文件原样保留，内容摘要按原文计算。
 * 2. 字体样式表改为按内容摘要命名，版本目录里引用它们的地址随之改写。
 *
 * @param {string} root 组装目录，vendor/ 位于其中
 * @returns {Promise<{ moved: Map<string, string>, renamed: Map<string, string> }>} 挪走的文件与改名的样式表，旧路径到新路径
 */
export async function relocate(root) {
  const moved = new Map()
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || VERSION_DIRS.has(entry.name)) continue
    const files = await listFiles(join(root, entry.name))
    const hash = createHash('sha256')
    for (const file of files) {
      hash.update(file).update('\0')
      hash.update(await readFile(join(root, entry.name, file))).update('\0')
    }
    const dir = `${OWN_FILES}/${entry.name}-${hash.digest('hex').slice(0, 12)}`
    await mkdir(join(root, OWN_FILES), { recursive: true })
    await rename(join(root, entry.name), join(root, dir))
    for (const file of files) moved.set(`${entry.name}/${file}`, `${dir}/${file}`)
  }

  const texts = (await listFiles(root)).filter(
    (path) => isTextFile(path) && !isPackageFile(path) && !isOwnFile(path),
  )
  for (const path of texts) {
    const text = await readFile(join(root, path), 'utf8')
    const rewritten = withMovedReferences(text, path, moved)
    if (rewritten !== text) await writeFile(join(root, path), rewritten)
  }

  const renamed = new Map()
  for (const path of texts) {
    const data = await readFile(join(root, path))
    const name = contentName(path, data)
    if (name === undefined) continue
    await rename(join(root, path), join(root, name))
    renamed.set(path, name)
  }
  if (renamed.size > 0) {
    const reference = new RegExp(alternation([...renamed.keys()]), 'g')
    for (const path of texts.filter((file) => !file.startsWith('vendor/'))) {
      const text = await readFile(join(root, path), 'utf8')
      const rewritten = text.replace(reference, (old) => renamed.get(old))
      if (rewritten !== text) await writeFile(join(root, path), rewritten)
    }
  }
  return { moved, renamed }
}

/**
 * 整理后的查漏：文本文件里仍有地址指向挪走文件的旧位置，或 vendor/ 里的网页、样式表引用了 vendor/ 以外的文件，
 * 就抛 SyncError 并列出文件与位置。第三方包的文件不检查。
 *
 * @param {string} root 整理后的组装目录
 * @param {Map<string, string>} moved relocate 返回的挪走的文件
 */
export async function checkRelocated(root, moved) {
  const problems = []
  const stale =
    moved.size === 0
      ? null
      : new RegExp(`${NOT_ADDRESS_START}(?:\\.{1,2}/)*(${alternation([...moved.keys()])})`, 'g')
  for (const path of await listFiles(root)) {
    if (!isTextFile(path) || isPackageFile(path)) continue
    const text = await readFile(join(root, path), 'utf8')
    for (const match of stale === null ? [] : text.matchAll(stale)) {
      problems.push(`${path}:${lineOf(text, match.index)} → ${match[1]}（仍指向旧位置）`)
    }
    if (!path.startsWith('vendor/') || !/\.(html?|css)$/i.test(path)) continue
    for (const { reference, resolved } of localReferences(text, path)) {
      if (!resolved.startsWith('vendor/'))
        problems.push(`${path} → ${reference}（指向 vendor/ 以外的文件）`)
    }
  }
  if (problems.length > 0) throw new SyncError(`查漏未通过：\n  ${problems.join('\n  ')}`)
}

/**
 * 把组装目录发布成 `<out>/<version>/`：先把其中 vendor/ 的文件并入 `<out>/vendor/`（只增，不改、不删），
 * 再把组装目录的 vendor/ 换成指向 ../vendor 的软链接，最后改名为版本目录。
 * `<out>/vendor/` 里已有同一路径而内容不同的文件时抛 SyncError，此时 `<out>/` 不受任何改动。
 *
 * @param {string} root 组装目录，必须与 outDir 在同一文件系统（文件靠改名并入）
 * @param {string} outDir 输出目录
 * @param {string} version 版本号
 */
export async function installVersion(root, outDir, version) {
  const source = join(root, 'vendor')
  const shared = join(outDir, 'vendor')
  const added = []
  const conflicts = []
  for (const file of await listFiles(source)) {
    const target = join(shared, file)
    if (!existsSync(target)) added.push(file)
    else if (!(await readFile(target)).equals(await readFile(join(source, file))))
      conflicts.push(`vendor/${file}`)
  }
  if (conflicts.length > 0) {
    throw new SyncError(
      `vendor/ 中已有同一路径、内容不同的文件，无法并入；共用文件的路径须随内容变化：\n  ${conflicts.join('\n  ')}`,
    )
  }
  for (const file of added) {
    await mkdir(dirname(join(shared, file)), { recursive: true })
    await rename(join(source, file), join(shared, file))
  }
  await rm(source, { recursive: true, force: true })
  await symlink('../vendor', source)
  await rename(root, join(outDir, version))
}

export async function listFiles(root, dir = '') {
  const result = []
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const rel = dir ? posix.join(dir, entry.name) : entry.name
    if (entry.isDirectory()) result.push(...(await listFiles(root, rel)))
    else result.push(rel)
  }
  return result.sort()
}
