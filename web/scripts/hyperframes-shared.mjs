/**
 * hyperframes-registry.mjs（构建时同步组件库）与 hyperframes-catalog.mjs（升级时生成组件目录）共用：
 * 版本与路径、下载与校验、组件库条目的读取、外链本地化规则。
 *
 * 外链本地化：组件库里的组件从 jsDelivr 取 GSAP、three 等脚本，从 Google Fonts 取字体；国内取不到，
 * 一律换成本地 `vendor/` 下的文件。脚本取 npm 上的同一版本（jsDelivr 的 /npm/ 本来就是 npm 包里的原文件），
 * Google Fonts 换成 fontsource 的字体文件加我们自己写的 CSS。换不了的（ES 模块导入等）记为不支持，
 * 由组件目录把整个组件排除。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const HF_VERSION = '0.8.168'
export const TARBALL = {
  url: `https://codeload.github.com/heygen-com/hyperframes/tar.gz/refs/tags/v${HF_VERSION}`,
  sha256: '6e0c38c6059c76410309d6b15914b416e6d9aec74faff96f55d16497345d20d3',
  /** 源码包里的顶层目录。 */
  root: `hyperframes-${HF_VERSION}`,
}

export const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const CACHE_DIR = join(WEB_ROOT, 'node_modules', '.cache', 'hyperframes', HF_VERSION)
export const OUTPUT_DIR = join(WEB_ROOT, 'public', 'hyperframes', HF_VERSION)
export const LOCK_PATH = join(WEB_ROOT, 'scripts', 'hyperframes-registry.lock.json')
export const PATCHES_DIR = join(WEB_ROOT, 'scripts', 'hyperframes-patches')
export const CATALOG_DIR = join(WEB_ROOT, 'src', 'features', 'storyboard', 'whole-film', 'catalog')

/** 合成页加载的运行时脚本（相对组件目录根）；组件里的 GSAP 也换成这一份。 */
/** 中文字体：字幕组件与合成页的默认字体都用它，经 `<link>` 引用这份 CSS。 */
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

/** 下载或缓存的文件与预期摘要不符。 */
export class IntegrityError extends Error {}

/** npm 源：构建期可用 NPM_CONFIG_REGISTRY 换成镜像源（见 web/Dockerfile）。 */
const NPM_REGISTRY = (process.env.NPM_CONFIG_REGISTRY ?? 'https://registry.npmjs.org/').replace(
  /\/?$/,
  '/',
)

async function download(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`下载失败 ${response.status}：${url}`)
  return Buffer.from(await response.arrayBuffer())
}

async function writeAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, data)
  await rename(temp, path)
}

/**
 * 取一份文件：有缓存用缓存，没有就下载；两种情况都核对 sha256，不符即报错（缓存被改过也报）。
 * `expected` 为 null 时只下载并返回实际摘要（--update-lock 用）。
 */
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

/** 源码包：下载、核对 sha256，解到缓存目录；返回包里的仓库根目录。`tarball` 可指定本机已有的包。 */
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

/** 组件库里的区块与组件，按 registry.json 的顺序。 */
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

/** 组件要装进项目的文件（照 `hyperframes add` 的安装位置）；说明文档不装。 */
export const installedFiles = (item) =>
  (item.files ?? []).filter((file) => !file.target.endsWith('.md'))

/** 组件的合成文件（安装位置）。 */
export const compositionTarget = (item) =>
  item.files.find(
    (file) => file.type === 'hyperframes:composition' || file.type === 'hyperframes:snippet',
  )?.target

/** HyperFrames Studio 的组件分类：@hyperframes/core registry/types.ts 的 resolveBlockCategory 原样照抄。 */
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

// 带 overlay 标签的（如手写标题）叠在画面上，一律进包装轨，不当片头片尾。
const OUTRO_TAGS = ['end-card', 'outro', 'close']
const INTRO_TAGS = ['intro', 'title-card']
/** 组件放到成片的哪里（整片设计稿的规则）。 */
export function placement(categoryId, tags) {
  if (categoryId === 'captions') return 'caption'
  if (categoryId === 'transitions') return 'transition'
  const set = new Set(tags)
  if (set.has('overlay')) return 'overlay'
  if (OUTRO_TAGS.some((tag) => set.has(tag))) return 'outro'
  if (INTRO_TAGS.some((tag) => set.has(tag))) return 'intro'
  if (set.has('logo') && (categoryId === 'scenes' || categoryId === 'vfx')) return 'intro'
  return 'overlay'
}

/** 合成根元素上写的固定尺寸与时长（HyperFrames 挂载时按它设宿主大小）。 */
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

/** 安装后要做外链本地化的文件。 */
const isRuntimeText = (path) => /\.(html?|css|m?js|cjs)$/i.test(path)

// ---------------------------------------------------------------- 外链本地化

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
/** 本地化之后不能再出现的外链主机。 */
export const CDN_HOST_PATTERN = new RegExp(
  CDN_HOSTS.map((host) => host.replaceAll('.', '\\.')).join('|'),
)

/** jsDelivr 上不写精确版本的引用，钉到这些版本（升级组件库时复核）。 */
const RANGE_PINS = {
  'd3@7': '7.9.0',
  'us-atlas@3': '3.0.1',
  'world-atlas@2': '2.0.2',
}

/** cdnjs 与 gstatic 上的文件换成 npm 包里的同一文件或目录。 */
const MIRRORS = [
  {
    prefix: 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
    to: { name: 'three', version: '0.128.0', file: 'build/three.min.js' },
  },
  {
    // DRACOLoader.setDecoderPath 的目录；three 包里带同一套解码器。
    prefix: 'https://www.gstatic.com/draco/versioned/decoders/1.5.6/',
    to: {
      name: 'three',
      version: '0.147.0',
      dir: 'examples/js/libs/draco/',
      files: ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js'],
    },
  },
]

/** Google Fonts 字体名 → fontsource 包；可变字体用 fontsource-variable。 */
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

/** 解析 `fonts.googleapis.com/css2?…`：每个字体要的字形（style、weight），以及 font-display。 */
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

/** 本地 CSS 的文件名：同样的字体请求落到同一个文件。 */
const googleFontsCss = (fonts) => `vendor/fonts/${sha256(JSON.stringify(fonts)).slice(0, 12)}.css`

/**
 * 一处外链换成什么：`{ path, needs }`；换不了时 `{ unsupported }`。
 * `path` 是相对组件目录根的路径；`needs` 是要放进 vendor/ 的东西。
 */
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

/** `<script type="module">` 与 import map 里的外链是 ES 模块导入，换成本地文件也解析不了裸模块名。 */
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

/**
 * 把一个文件里的外链换成本地路径。返回改写后的文本、要放进 vendor/ 的东西，以及换不了的外链。
 * 路径写法跟 HyperFrames 运行时挂载子合成时的解析方式走：`<link href>` 相对子合成文件本身；
 * 脚本 src、样式里的 url()、脚本里的地址写成不带 `./` 的相对路径，按组件目录根解析。
 * 预连接的 `<link>` 直接去掉。
 */
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

/**
 * 组件引用的本地文件，按运行时挂载子合成时的解析方式换算成相对组件目录根的路径：
 * `<link href>`、`./` 或 `../` 开头的脚本 src、`../` 开头的其他地址相对子合成文件，其余按组件目录根；
 * .css 文件里的 url() 相对它自己。只看属性与样式里写死的路径，脚本拼出来的不在内。
 */
export function localReferences(text, path) {
  // 注释与脚本正文里的示例路径、拼接代码不算引用：同长度的空白盖掉，位置不变。
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

// ---------------------------------------------------------------- npm 包与字体

/** npm 包的 tgz：按锁文件核对；`expected` 为 null 时再与 npm 给的 sha512 完整性核对（--update-lock）。 */
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

/**
 * 一个字体的 @font-face：只收拉丁与扩展拉丁（组件的英文字体）；中文字体收全部分片，
 * 浏览器按 unicode-range 只下载用到的。`npmBase` 是 CSS 所在目录到 vendor/npm/ 的相对路径。
 */
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
      // 中文分片在 unicode.json 里写作 "[4]"，文件名里是 4；可变字体全轴的文件名用 full。
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

// ---------------------------------------------------------------- 组件字体的整套字形

const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'emoji',
  'math',
  'fangsong',
  'inherit',
  'initial',
  'unset',
  'revert',
  '-apple-system',
  'blinkmacsystemfont',
])
const familyNames = (value) =>
  value
    // var(--x, A, B) 取回退里的字体名。
    .replace(/var\(\s*--[\w-]+\s*,?/g, '')
    .replaceAll(')', '')
    .split(',')
    .map((name) =>
      name
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .trim(),
    )
    .filter(
      (name) =>
        name &&
        !/^ui-/.test(name) &&
        !GENERIC_FAMILIES.has(name.toLowerCase()) &&
        /^[\w][\w .-]*$/.test(name),
    )

/**
 * 组件文件里的字体：`declared` 是 @font-face 定义的（网页字体），`used` 是 font-family 里写的字体名
 * （含 var() 的回退，去掉通用字体族）。
 */
export function fontFamilies(text) {
  const declared = new Set()
  for (const [, block] of text.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const value = /font-family\s*:\s*([^;}]+)/.exec(block)?.[1]
    if (value) for (const name of familyNames(value)) declared.add(name)
  }
  const used = new Set()
  for (const [, value] of text.matchAll(/font-family\s*:\s*([^;}{"`]+)/g)) {
    for (const name of familyNames(value)) used.add(name)
  }
  return { declared, used }
}

/** 字体名 → 这个字体整套字形（西文加中文）的 CSS 路径（相对组件目录根）。 */
export const familyFontCss = (family) =>
  `vendor/fonts/families/${family
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}.css`

// 中文补字覆盖的码位：中日韩部首、标点、假名、注音、带圈字符、汉字（含扩展 A 与兼容汉字）、
// 竖排与全角形式、扩展 B 以后。拉丁字母与常用西文标点不在内，组件自己的字体照常显示它们。
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

/** 把 unicode-range 收窄到中日韩码位；没有交集时返回 null。 */
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

/**
 * 一段 CSS 或 HTML 里每条 @font-face 的字体名、字重与字形描述。字重的 normal、bold 换成数字，
 * 区间等其余写法原样保留；没写时按 CSS 默认取 400、normal。
 */
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

/**
 * 一个组件字体的中文字形：同名的 @font-face，只覆盖中日韩码位，字形取 Noto Sans SC。
 *
 * `descriptors` 是这个字体的西文字形用过的全部字重、字形描述，每一种各出一组描述完全相同的中文字形。
 * 浏览器先按字重、字形在同名的 @font-face 里挑出最接近的一组，再在组里按 unicode-range 取字：
 * 中文字形的描述与西文的不同（比如写成字重区间）时，它会被单独挑中，西文字母因此退到下一个字体。
 * 字重（区间取下限）小于 550 用 Noto 的 400，否则用 700；Noto 只有正体，斜体也用正体字形。
 * `notoDir` 是 Noto Sans SC 的 fontsource 包目录；字体文件路径相对 CSS 所在的 vendor/fonts/families/。
 */
export async function cjkTwinFaces(family, descriptors, notoDir) {
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

/** 列出目录下全部文件（相对路径，正斜杠）。 */
export async function listFiles(root, dir = '') {
  const result = []
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const rel = dir ? posix.join(dir, entry.name) : entry.name
    if (entry.isDirectory()) result.push(...(await listFiles(root, rel)))
    else result.push(rel)
  }
  return result.sort()
}
