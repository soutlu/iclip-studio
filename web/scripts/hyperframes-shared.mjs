import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
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
  css: 'vendor/fonts/noto-sans-sc.css',
  weights: [400, 700],
}

export const RUNTIME = {
  hyperframes: 'vendor/hyperframes/hyperframe.runtime.iife.js',
  gsap: 'vendor/npm/gsap@3.14.2/dist/gsap.min.js',
  cjkFont: CJK_FONT.css,
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

const CJK_BLOCKS = [
  [0x2e80, 0x2fdf],
  [0x3000, 0x30ff],
  [0x3100, 0x31ff],
  [0x3200, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe1f],
  [0xfe30, 0xfe4f],
  [0xff00, 0xffef],
  [0x20000, 0x3134f],
]

function parseRanges(value) {
  return value.split(',').map((part) => {
    const [from, to] = part.trim().replace(/^U\+/i, '').split('-')
    return [parseInt(from, 16), parseInt(to ?? from, 16)]
  })
}

export function cjkUnicodeRange(value) {
  const parts = []
  for (const [from, to] of parseRanges(value)) {
    for (const [blockFrom, blockTo] of CJK_BLOCKS) {
      const start = Math.max(from, blockFrom)
      const end = Math.min(to, blockTo)
      if (start <= end) {
        const hex = (code) => code.toString(16)
        parts.push(start === end ? `U+${hex(start)}` : `U+${hex(start)}-${hex(end)}`)
      }
    }
  }
  return parts.length > 0 ? parts.join(',') : null
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

export async function cjkTwinFaces(family, descriptors, notoDir) {
  if (family) return ''
  const pkg = fontPackage(CJK_FONT.family)
  const metadata = JSON.parse(await readFile(join(notoDir, 'metadata.json'), 'utf8'))
  const unicode = JSON.parse(await readFile(join(notoDir, 'unicode.json'), 'utf8'))
  const slices = Object.entries(unicode).flatMap(([subset, value]) => {
    const slice = /^\[(\d+)\]$/.exec(subset)?.[1]
    const unicodeRange = slice === undefined ? null : cjkUnicodeRange(value)
    return unicodeRange ? [{ slice, unicodeRange }] : []
  })
  const rules = []
  const seen = new Set()
  for (const { weight, style } of descriptors) {
    const key = `${weight}/${style}`
    if (seen.has(key)) continue
    seen.add(key)
    const notoWeight = Number.parseInt(weight, 10) < 550 ? 400 : 700
    for (const { slice, unicodeRange } of slices) {
      const file = `files/${metadata.id}-${slice}-${notoWeight}-normal.woff2`
      rules.push(
        `@font-face{font-family:'${family}';font-style:${style};font-display:block;font-weight:${weight};` +
          `src:url(../../npm/${pkg.name}@${pkg.version}/${file}) format('woff2');unicode-range:${unicodeRange}}`,
      )
    }
  }
  return rules.join('\n')
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

export async function publishedCatalog(catalog, version, compositionText) {
  const items = []
  for (const item of catalog.items) {
    const declared = item.variables.some((variable) => variable.id === FONT_VARIABLE.id)
    items.push(
      !declared && READS_FONT_VARIABLE.test(await compositionText(item.src))
        ? { ...item, variables: [...item.variables, FONT_VARIABLE] }
        : item,
    )
  }
  const fonts = Object.fromEntries(
    Object.entries(catalog.fonts).map(([family, { faces: _faces, ...font }]) => [family, font]),
  )
  return { version, ...catalog, fonts, items }
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

export async function listFiles(root, dir = '') {
  const result = []
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const rel = dir ? posix.join(dir, entry.name) : entry.name
    if (entry.isDirectory()) result.push(...(await listFiles(root, rel)))
    else result.push(rel)
  }
  return result.sort()
}
