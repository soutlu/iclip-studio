#!/usr/bin/env node
/**
 * 生成整片的组件目录：src/features/storyboard/whole-film/catalog/catalog.json 与 thumbnails/。
 * 一次性运行、产物入库；升级 HyperFrames 版本或调整收录规则后重跑，再运行 `pnpm hf:registry --update-lock`。
 *
 *   node scripts/hyperframes-catalog.mjs [--tarball <源码包路径>]
 *
 * 需要网络（下载源码包与预览图）与 ffmpeg（预览图缩成 webp）。
 *
 * 归类与放置照 HyperFrames Studio：分类表与归类函数取自 @hyperframes/core 的 registry/types.ts；
 * 放置位置沿用整片设计稿：字幕类换字幕样式、转场类放切点、带片头 / 片尾标签的放两端、其余进包装轨。
 * 中文名、说明、可填项名称与选项见 hyperframes-catalog-zh/；文字类可填项的默认值改成中文占位，
 * 品牌名、标语改由品牌模板填，HyperFrames 自己的品牌字样一并去掉。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import * as prettier from 'prettier'
import {
  CACHE_DIR,
  CATALOG_DIR,
  HF_VERSION,
  PATCHES_DIR,
  RUNTIME,
  WEB_ROOT,
  compositionTarget,
  installedFiles,
  localReferences,
  localize,
  registryItems,
  sha256,
  sourceTree,
} from './hyperframes-shared.mjs'

const run = promisify(execFile)
const ZH_DIR = join(WEB_ROOT, 'scripts', 'hyperframes-catalog-zh')
const THUMBS_DIR = join(CATALOG_DIR, 'thumbnails')
const THUMB = { width: 160, height: 90 }

const args = process.argv.slice(2)
const tarballArg = args.includes('--tarball') ? args[args.indexOf('--tarball') + 1] : undefined

// ---------------------------------------------------------------- 归类与放置

const CATEGORIES = [
  { id: 'captions', label: '字幕' },
  { id: 'code-animation', label: '代码动画' },
  { id: 'vfx', label: '视觉特效' },
  { id: 'transitions', label: '转场' },
  { id: 'effects', label: '效果' },
  { id: 'text-effects', label: '文字效果' },
  { id: 'social', label: '社交' },
  { id: 'data', label: '数据图表' },
  { id: 'scenes', label: '场景' },
]

/** HyperFrames 的 resolveBlockCategory 原样照抄。 */
function category(tags) {
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
function placement(categoryId, tags) {
  if (categoryId === 'captions') return 'caption'
  if (categoryId === 'transitions') return 'transition'
  const set = new Set(tags)
  if (set.has('overlay')) return 'overlay'
  if (OUTRO_TAGS.some((tag) => set.has(tag))) return 'outro'
  if (INTRO_TAGS.some((tag) => set.has(tag))) return 'intro'
  if (set.has('logo') && (categoryId === 'scenes' || categoryId === 'vfx')) return 'intro'
  return 'overlay'
}

// ---------------------------------------------------------------- 字幕与转场

/** 产品自带的默认字幕样式：由 caption-weight-shift 改成读 words 变量，文件在 hyperframes-patches/。 */
const DEFAULT_CAPTION = {
  name: 'default-caption',
  kind: 'component',
  title: '白字黑边',
  description: '白色字，黑色描边，压在画面下方',
  category: 'captions',
  placement: 'caption',
  src: 'compositions/iclip/default-caption.html',
  size: null,
  duration: null,
  variables: [],
  thumbnail: null,
}

/** 改成读 words 变量、能正确排中文的字幕组件（改写在 hyperframes-patches/）。 */
const SUPPORTED_CAPTIONS = new Set(['caption-texture', 'caption-highlight'])

/**
 * 能挂到一个切点上的转场，与它的接法（见 composition/catalog.ts 的 TransitionAttachment）。
 * 组件都按原定时长排时间（HyperFrames 挂载时宿主的 data-duration 不传给组件），转场只能用原定时长。
 * cutAt 取自各组件头注释与时间线：盖满画面、闪白或光斑最亮的位置。
 */
const TRANSITIONS = {
  // 改写成子合成的两个，原定时长取原文件时间线写法的总长。
  'fade-through': {
    duration: 0.9,
    transition: {
      kind: 'layers',
      cutAt: 0.5,
      out: { from: { opacity: 1 }, to: { opacity: 0 }, ease: 'power2.inOut' },
      in: { from: { opacity: 0 }, to: { opacity: 1 }, ease: 'power2.out' },
    },
  },
  'grid-pixelate-wipe': { duration: 1.2, transition: { kind: 'overlay', cutAt: 0.5 } },
  // 2.2 秒，0.85–1.35 秒全盖住。
  'hw-scribble-transition': { transition: { kind: 'overlay', cutAt: 0.5 } },
  // 4 秒；闪白在 0.58 处起、0.04 秒后最亮。
  'editorial-flash-overlay': { transition: { kind: 'overlay', cutAt: 0.59 } },
  // 4 秒；光斑在 0.08–0.32 升到最亮。
  'organic-light-leak-overlay': { transition: { kind: 'overlay', cutAt: 0.32 } },
}

const SLOT = '靠全局插槽取前后两段画面，一部整片里只能用一次，且要另放一份视频'
const DEMO = '自带演示画面，接不到两段视频之间'
const SHADER = '着色器转场的演示：前后画面是它自带的演示场景，接不到两段视频之间'
const TRANSITION_EXCLUSIONS = {
  'curtain-reveal': SLOT,
  'halftone-dissolve': SLOT,
  'iris-reveal': SLOT,
  'morph-swap': SLOT,
  'ordered-dither-pass': SLOT,
  'paper-collage-reveal': SLOT,
  'torn-paper-rip': SLOT,
  'whip-pan-cut': SLOT,
  'cut-the-curve': DEMO,
  'match-cut': DEMO,
  'micro-transitions': DEMO,
  'parallax-device-dive': DEMO,
  'parallax-unzoom': DEMO,
  'parallax-zoom': DEMO,
  'rubber-band-bumper': DEMO,
  'text-match-cut': DEMO,
  'type-match-cut': DEMO,
  'beat-freeze-cut': DEMO,
  'code-slice-hero': DEMO,
  'mk-clone-wall-transition': '墙面文字写死为 HyperFrames，且要前一段画面的静帧',
}

const REASONS = {
  showcase: '转场合集：十几到二十几秒、多种转场串成的演示，放不到一个切点上',
  missing: '组件库源码包里缺少它用到的素材文件',
  module: '依赖的 ES 模块无法换成本地文件',
  broken: '引用的素材不在 HyperFrames 运行时查找的位置，加载会失败',
  english: '只适配英文',
  fragment: '要配合自己写的时间线使用的代码片段，单独放进成片不会动',
}

// ---------------------------------------------------------------- 可填项

/** 品牌模板填的可填项：按 id，或按 HyperFrames 的 portrays 标注。 */
const BRAND_IDS = {
  wordmark: 'name',
  brand: 'name',
  brand_name: 'name',
  brandName: 'name',
  tagline: 'slogan',
  slogan: 'slogan',
}
const BRAND_PORTRAYS = { subject_name: 'name', subject_tagline: 'slogan' }
const BRAND_PLACEHOLDER = { name: '品牌名', slogan: '品牌标语' }

// 组件库里少数参数没有 label，按 组件名.参数 id 补中文名。
const UNLABELED = {
  'caption-texture.texture': '纹理',
  'lower-third-bild.TXT_MAIN_1_Line': '主标题',
  'lower-third-bild.TXT_SUB': '副标题',
}

const HF_BRANDING = /hyper\s*frames|heygen/i
/** 带分隔符或结构的文字默认值，逐项写在 defaults.json 里。 */
const STRUCTURED = /[|,\n;]|^\s*[[{]/

async function translations() {
  const items = {}
  for (const file of (await readdir(ZH_DIR))
    .filter((name) => /^items-\d+\.json$/.test(name))
    .sort()) {
    Object.assign(items, JSON.parse(await readFile(join(ZH_DIR, file), 'utf8')))
  }
  const read = async (file) => JSON.parse(await readFile(join(ZH_DIR, file), 'utf8'))
  return {
    items,
    labels: await read('labels.json'),
    options: await read('options.json'),
    defaults: await read('defaults.json'),
  }
}

function variablesOf(name, raw, zh, problems) {
  return (raw.variables ?? []).map((variable) => {
    const key = `${name}.${variable.id}`
    const label = variable.label ? zh.labels[variable.label] : UNLABELED[key]
    if (!label) problems.push(`缺参数译文：${variable.label ?? key}`)
    const out = { id: variable.id, type: variable.type, label, default: variable.default ?? '' }
    if (variable.options) {
      out.options = variable.options.map((option) => {
        const optionLabel = zh.options[option.label]
        if (!optionLabel) problems.push(`缺选项译文：${option.label}`)
        return { value: option.value, label: optionLabel }
      })
    }
    for (const field of ['min', 'max', 'step', 'unit'])
      if (variable[field] !== undefined) out[field] = variable[field]

    const brand =
      BRAND_IDS[variable.id] ??
      (variable.portrays ?? []).map((tag) => BRAND_PORTRAYS[tag]).find(Boolean)
    if (brand && variable.type === 'string') {
      out.default = BRAND_PLACEHOLDER[brand]
      out.brand = brand
    } else if (key in zh.defaults) {
      out.default = zh.defaults[key]
    } else if (variable.type === 'image' && HF_BRANDING.test(String(out.default))) {
      out.default = ''
    } else if (
      variable.type === 'string' &&
      (variable.role === undefined || variable.role === 'content') &&
      /[A-Za-z]/.test(String(out.default))
    ) {
      if (STRUCTURED.test(String(out.default)))
        problems.push(`缺默认值译文：${key} = ${JSON.stringify(out.default)}`)
      else out.default = label
    }
    if (typeof out.default === 'string' && HF_BRANDING.test(out.default)) {
      problems.push(`默认值仍带 HyperFrames 品牌：${key} = ${JSON.stringify(out.default)}`)
    }
    return out
  })
}

/** 合成根元素上写的固定尺寸与时长（HyperFrames 挂载时按它设宿主大小）。 */
function rootAttributes(html) {
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

/** 预览图缩成小 webp（铺满后居中裁切）；原图取不到时没有缩略图。 */
async function thumbnail(name, url) {
  if (!url) return null
  const poster = join(CACHE_DIR, 'posters', `${name}${url.match(/\.\w+$/)?.[0] ?? '.png'}`)
  if (!existsSync(poster)) {
    const response = await fetch(url)
    if (!response.ok) {
      console.warn(`预览图取不到（${response.status}）：${name}`)
      return null
    }
    await mkdir(join(CACHE_DIR, 'posters'), { recursive: true })
    await writeFile(poster, Buffer.from(await response.arrayBuffer()))
  }
  const file = `${name}.webp`
  const filter = `scale=${THUMB.width}:${THUMB.height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${THUMB.width}:${THUMB.height}`
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    poster,
    '-vf',
    filter,
    '-c:v',
    'libwebp',
    '-quality',
    '55',
    '-frames:v',
    '1',
    join(THUMBS_DIR, file),
  ])
  return file
}

async function pool(list, size, task) {
  const results = new Array(list.length)
  let next = 0
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < list.length) {
        const index = next++
        results[index] = await task(list[index], index)
      }
    }),
  )
  return results
}

async function main() {
  const src = await sourceTree(tarballArg)
  const zh = await translations()
  const patches = JSON.parse(await readFile(join(PATCHES_DIR, 'manifest.json'), 'utf8')).files
  const problems = []
  await rm(THUMBS_DIR, { recursive: true, force: true })
  await mkdir(THUMBS_DIR, { recursive: true })

  const classified = await pool(await registryItems(src), 8, async ({ name, kind, dir, item }) => {
    const categoryId = category(item.tags)
    const place = placement(categoryId, item.tags ?? [])
    const tags = new Set(item.tags ?? [])
    const title = zh.items[name]?.title
    if (!title) problems.push(`缺组件译文：${name}`)
    const exclude = (reason) => ({ excluded: { name, title, reason } })

    if (categoryId === 'transitions' && tags.has('showcase')) return exclude(REASONS.showcase)
    const files = installedFiles(item)
    if (files.some((file) => !existsSync(join(dir, file.path)))) return exclude(REASONS.missing)
    let unsupported = false
    const broken = []
    const targets = new Set(files.map((file) => file.target))
    for (const file of files) {
      const original = await readFile(join(dir, file.path), 'utf8')
      const localized = localize(original, file.target)
      if (localized.unsupported.length > 0) unsupported = true
      if (!/\.(html?|css)$/i.test(file.target)) continue
      const text = patches[file.target]
        ? await readFile(join(PATCHES_DIR, file.target), 'utf8')
        : localized.text
      for (const { resolved } of localReferences(text, file.target)) {
        if (!resolved.startsWith('vendor/') && !targets.has(resolved)) broken.push(resolved)
      }
    }
    if (unsupported) return exclude(REASONS.module)
    if (broken.length > 0) return exclude(REASONS.broken)
    const target = compositionTarget(item)
    if (place === 'caption' && !SUPPORTED_CAPTIONS.has(name)) return exclude(REASONS.english)
    if (place === 'transition' && !TRANSITIONS[name]) {
      const reason = TRANSITION_EXCLUSIONS[name] ?? (tags.has('shader') ? SHADER : null)
      if (!reason) problems.push(`转场没有接法也没有排除原因：${name}`)
      return exclude(reason ?? '')
    }
    const html = await readFile(
      join(dir, files.find((file) => file.target === target).path),
      'utf8',
    )
    const patched = patches[target] ? await readFile(join(PATCHES_DIR, target), 'utf8') : null
    if (place === 'caption' && !patched) problems.push(`字幕组件 ${name} 需要改写成读 words 变量`)
    if (place === 'transition' && !patched && !/data-composition-id/.test(html)) {
      problems.push(`转场 ${name} 需要改写成子合成`)
    }
    if (!patched && !/data-composition-id/.test(html)) return exclude(REASONS.fragment)

    const root = rootAttributes(patched ?? html)
    const size =
      root.width && root.height
        ? { width: root.width, height: root.height }
        : item.dimensions && !patched
          ? { width: item.dimensions.width, height: item.dimensions.height }
          : null
    const entry = {
      name,
      kind,
      title,
      description: zh.items[name]?.desc ?? '',
      category: categoryId,
      placement: place,
      src: target,
      size,
      duration: TRANSITIONS[name]?.duration ?? item.duration ?? root.duration ?? null,
      variables: variablesOf(name, item, zh, problems),
      thumbnail: await thumbnail(name, item.preview?.poster),
    }
    if (TRANSITIONS[name]) entry.transition = TRANSITIONS[name].transition
    return { entry }
  })

  for (const name of SUPPORTED_CAPTIONS) {
    if (!classified.some((result) => result.entry?.name === name))
      problems.push(`支持的字幕组件没有收录：${name}`)
  }
  for (const name of Object.keys(TRANSITIONS)) {
    if (!classified.some((result) => result.entry?.name === name))
      problems.push(`支持的转场没有收录：${name}`)
  }
  if (problems.length > 0) {
    console.error([...new Set(problems)].join('\n'))
    throw new Error(`${new Set(problems).size} 处问题`)
  }

  const order = (id) => CATEGORIES.findIndex((entry) => entry.id === id)
  const items = [
    DEFAULT_CAPTION,
    ...classified.flatMap((result) => (result.entry ? [result.entry] : [])),
  ]
  items.sort((a, b) => order(a.category) - order(b.category))
  const catalog = {
    version: HF_VERSION,
    runtime: RUNTIME,
    categories: CATEGORIES,
    items,
    excluded: classified.flatMap((result) => (result.excluded ? [result.excluded] : [])),
  }
  const json = JSON.stringify(catalog)
  if (/https?:\/\//.test(json)) throw new Error('组件目录里不能有外部地址')
  const path = join(CATALOG_DIR, 'catalog.json')
  const options = await prettier.resolveConfig(path)
  await writeFile(path, await prettier.format(json, { ...options, filepath: path }))

  const count = (key) => items.filter((entry) => entry.placement === key).length
  const thumbs = await readdir(THUMBS_DIR)
  let thumbBytes = 0
  for (const file of thumbs) thumbBytes += (await readFile(join(THUMBS_DIR, file))).length
  console.log(
    `收录 ${items.length} 个（字幕 ${count('caption')}、转场 ${count('transition')}、片头 ${count('intro')}、片尾 ${count('outro')}、包装 ${count('overlay')}），排除 ${catalog.excluded.length} 个；`,
    `缩略图 ${thumbs.length} 张 ${(thumbBytes / 1024).toFixed(0)} KB；目录 ${sha256(json).slice(0, 12)}`,
  )
}

await main()
