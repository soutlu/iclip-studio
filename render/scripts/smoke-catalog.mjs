#!/usr/bin/env node
/**
 * 组件目录的冒烟筛选（一次性、本机运行，结果入库；升级 HyperFrames 版本后重跑）。
 *
 *   pnpm smoke                    跑完所有候选（已有结果的跳过，可中断后续跑）
 *   pnpm smoke --only a,b         只跑这几个
 *   pnpm smoke --fresh            清掉已有结果与冒烟用的组件库，重新同步后重跑
 *
 * 候选：组件目录收录的全部组件，加上因「引用的素材不在运行时查找的位置」被静态排除的组件
 * （静态判断要靠实际渲染确认或推翻）。每个候选用真实的合成构建放进一个最小草稿：
 *   1. 浏览器（Playwright + HyperFrames 播放器，与预览同一条路径）加载并跳到几个时间点：
 *      页面报错、控制台报错、请求本机以外的地址、本地文件取不到，任一项即不通过；
 *   2. 用真实的 @hyperframes/producer 渲染：渲染失败不通过；与不放这个组件的同一草稿逐帧比较，
 *      画面没有差别（片头片尾没有底片，看画面是否一片纯色）即「画面是空的」，不通过；
 *   3. 通过的从渲染结果取组件时长一半处的一帧做缩略图（组件目录没有上游预览图时用它）。
 * 逐项结果写在 .cache/smoke/results/，全部跑完汇总到 web/scripts/hyperframes-smoke/
 * （results.json 与 thumbnails/），由 web/scripts/hyperframes-catalog.mjs 读取。
 *
 * 需要：web 已 pnpm install（同步脚本取运行时）、ffmpeg、chrome-headless-shell（producer 用）、
 * Playwright Chromium（pnpm exec playwright install chromium）。
 */
import { execFile, spawnSync } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { chromium } from '@playwright/test'
import { build } from 'esbuild'

const run = promisify(execFile)
const RENDER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WEB_ROOT = join(RENDER_ROOT, '..', 'web')
const CACHE = join(RENDER_ROOT, '.cache', 'smoke')
const REGISTRY = join(RENDER_ROOT, '.cache', 'smoke-registry')
const OUTPUT = join(WEB_ROOT, 'scripts', 'hyperframes-smoke')
const CATALOG_PATH = join(WEB_ROOT, 'src/features/storyboard/whole-film/catalog/catalog.json')
const PORT = Number(process.env.SMOKE_PORT ?? 8814)
const ORIGIN = `http://127.0.0.1:${PORT}`
const CANVAS = { width: 1280, height: 720 }
const FPS = 6
const THUMB = { width: 160, height: 90 }
/** 静态判断「引用的素材不在运行时查找的位置」的排除原因，要靠渲染确认或推翻。 */
const BROKEN_REASON = '引用的素材不在 HyperFrames 运行时查找的位置，加载会失败'
/** 组件目录给渲染检查不通过的组件写的排除原因前缀（web/scripts/hyperframes-catalog.mjs）。 */
const SMOKE_REASON_PREFIX = '渲染检查不通过：'

const args = process.argv.slice(2)
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null
const fresh = args.includes('--fresh')

const shared = await import(join(WEB_ROOT, 'scripts', 'hyperframes-shared.mjs'))

// ------------------------------------------------------------------ 准备

async function ensureRegistry() {
  if (existsSync(join(REGISTRY, 'vendor'))) return
  const result = spawnSync(
    process.execPath,
    [join(WEB_ROOT, 'scripts', 'hyperframes-registry.mjs'), '--smoke', REGISTRY],
    { stdio: 'inherit' },
  )
  if (result.status !== 0) throw new Error('冒烟用组件库同步失败')
}

/** 合成构建与渲染服务用同一份源码：现打包成 ESM 再导入。 */
async function loadBuilder() {
  const outfile = join(CACHE, 'composition.mjs')
  await build({
    entryPoints: [join(WEB_ROOT, 'src/features/storyboard/whole-film/composition/build.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'warning',
  })
  return import(`${outfile}?${Date.now()}`)
}

/** 纯色样片带一段正弦声：灰色垫底，蓝、红两段给转场。 */
async function ensureMedia() {
  const dir = join(CACHE, 'media')
  await mkdir(dir, { recursive: true })
  const clips = { gray: '0x3a3a3a', blue: '0x1d3b6e', red: '0x6e1d2a' }
  for (const [name, color] of Object.entries(clips)) {
    const path = join(dir, `${name}.mp4`)
    if (existsSync(path)) continue
    await run('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=${CANVAS.width}x${CANVAS.height}:r=30:d=12`,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=12',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '30',
      '-c:a',
      'aac',
      '-shortest',
      path,
    ])
  }
  return dir
}

// ------------------------------------------------------------------ 候选与草稿

async function candidates() {
  const catalog = JSON.parse(await readFile(CATALOG_PATH, 'utf8'))
  const list = catalog.items.map((item) => ({ item, catalogged: true }))
  const src = await shared.sourceTree()
  const raw = new Map((await shared.registryItems(src)).map((entry) => [entry.name, entry]))
  // 候选不随上一次的结果变：目录收录的，加上静态判断素材取不到的、以及之前渲染检查不通过而被排除的。
  const smokeable = (entry) =>
    entry.reason === BROKEN_REASON || entry.reason.startsWith(SMOKE_REASON_PREFIX)
  for (const excluded of catalog.excluded.filter(smokeable)) {
    const entry = raw.get(excluded.name)
    const categoryId = shared.category(entry.item.tags)
    const place = shared.placement(categoryId, entry.item.tags ?? [])
    // 静态排除的转场另有「自带演示画面」的原因，不在冒烟范围内。
    if (place === 'transition') continue
    const target = shared.compositionTarget(entry.item)
    const html = await readFile(join(REGISTRY, target), 'utf8')
    const root = shared.rootAttributes(html)
    const size =
      root.width && root.height
        ? { width: root.width, height: root.height }
        : entry.item.dimensions
          ? { width: entry.item.dimensions.width, height: entry.item.dimensions.height }
          : null
    list.push({
      catalogged: false,
      item: {
        name: entry.name,
        kind: entry.kind,
        title: excluded.title,
        description: '',
        category: categoryId,
        placement: place,
        src: target,
        size,
        duration: entry.item.duration ?? root.duration ?? null,
        variables: (entry.item.variables ?? []).map((variable) => ({
          id: variable.id,
          type: variable.type,
          label: variable.id,
          default: variable.default ?? '',
        })),
        thumbnail: null,
        fonts: [],
      },
    })
  }
  return { catalog, list }
}

const seconds = (value) => Math.round(value * 1000)
const video = (id, start, duration, sourceJobId) => ({
  id,
  type: 'video',
  start,
  duration,
  playbackStart: 0,
  sourceJobId,
  volume: 1,
})

/** 一个组件的最小草稿，以及不放这个组件的对照草稿（片头片尾没有对照）。返回组件所在的时段。 */
function drafts(item) {
  const base = {
    canvas: CANVAS,
    transitions: [],
    captions: { component: 'default-caption', edits: [] },
    music: null,
    overlays: [],
  }
  if (item.placement === 'transition') {
    const duration = seconds(item.duration)
    const lead = item.transition.cutAt * duration
    const first = Math.round(lead) + 500
    const second = Math.round(duration - lead) + 500
    const layer0 = [video('a', 0, first, 'blue'), video('b', first, second, 'red')]
    return {
      window: [first - lead, first - lead + duration],
      // 闪白一类的转场只在切点附近一两帧有画面，切点前后各取一帧。
      extraTimes: [first - Math.round(1000 / FPS), first, first + Math.round(1000 / FPS)],
      draft: {
        ...base,
        layer0,
        transitions: [{ id: 't', afterClipId: 'a', component: item.name, duration, variables: {} }],
      },
      baseline: { ...base, layer0 },
    }
  }
  const duration = seconds(Math.min(6, Math.max(1.5, item.duration ?? 4)))
  if (item.placement === 'intro' || item.placement === 'outro') {
    const clip = {
      id: 'c',
      type: 'component',
      role: item.placement,
      start: 0,
      duration,
      component: item.name,
      variables: {},
    }
    return { window: [0, duration], draft: { ...base, layer0: [clip] }, baseline: null }
  }
  const layer0 = [video('a', 0, duration, 'gray')]
  if (item.placement === 'caption') {
    // 对照是同一草稿但没有字幕记录（合成里就没有字幕层）。
    return {
      window: [0, duration],
      draft: { ...base, layer0, captions: { component: item.name, edits: [] } },
      baseline: { ...base, layer0 },
      withSubtitles: true,
    }
  }
  return {
    window: [0, duration],
    draft: {
      ...base,
      layer0,
      overlays: [{ id: 'o', component: item.name, start: 0, duration, variables: {} }],
    },
    baseline: { ...base, layer0 },
  }
}

/** 字幕样片：一句中文，逐词时间铺满组件时段。 */
function subtitles(durationMs) {
  const words = ['今天', '带你', '看看', '这双', '新款', '短靴，', '走一整天', '也不累脚。']
  const step = Math.floor((durationMs - 400) / words.length)
  return {
    gray: {
      subtitleJobId: 'sub-gray',
      sentences: [
        {
          startMs: 200,
          endMs: 200 + step * words.length,
          text: words.join(''),
          speaker: null,
          words: words.map((text, index) => ({
            startMs: 200 + step * index,
            endMs: 200 + step * (index + 1),
            text: text.replace(/[，。]$/, ''),
            punctuation: /[，。]$/.test(text) ? text.at(-1) : '',
          })),
        },
      ],
    },
  }
}

// ------------------------------------------------------------------ 浏览器检查

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
}

function startServer(mediaDir) {
  const pages = new Map()
  const roots = [
    ['/registry/media/', mediaDir],
    ['/registry/', REGISTRY],
    ['/player/', join(RENDER_ROOT, 'node_modules/@hyperframes/player/dist')],
  ]
  const server = createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, ORIGIN).pathname)
    if (pages.has(pathname)) {
      res.writeHead(200, { 'Content-Type': TYPES['.html'] }).end(pages.get(pathname))
      return
    }
    const match = roots.find(([prefix]) => pathname.startsWith(prefix))
    const path = match && normalize(join(match[1], pathname.slice(match[0].length)))
    const info =
      path && (path === match[1] || path.startsWith(match[1] + sep))
        ? await stat(path).catch(() => null)
        : null
    if (!info?.isFile()) {
      res.writeHead(404).end()
      return
    }
    const type = TYPES[extname(path)] ?? 'application/octet-stream'
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]))
      const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1
      res.writeHead(206, {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${info.size}`,
        'Content-Length': end - start + 1,
      })
      createReadStream(path, { start, end }).pipe(res)
      return
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': info.size,
      'Accept-Ranges': 'bytes',
    })
    createReadStream(path).pipe(res)
  })
  return new Promise((resolve) =>
    server.listen(PORT, '127.0.0.1', () => resolve({ server, pages })),
  )
}

function playerPage(html) {
  const srcdoc = html.replace('<head>', `<head>\n<base href="${ORIGIN}/registry/">`)
  return `<!doctype html><html><head><meta charset="utf-8">
<script src="/player/hyperframes-player.global.js"></script></head>
<body style="margin:0;background:#000">
<script>
const player = document.createElement('hyperframes-player')
player.setAttribute('width', '${CANVAS.width}')
player.setAttribute('height', '${CANVAS.height}')
player.setAttribute('assets-loading-ui', 'none')
player.setAttribute('disable-click-to-play', '')
player.style.cssText = 'display:block;width:${CANVAS.width}px;height:${CANVAS.height}px'
window.__ready = new Promise((resolve) => player.addEventListener('ready', resolve, { once: true }))
document.body.appendChild(player)
player.setAttribute('srcdoc', ${JSON.stringify(srcdoc).replaceAll('</', '<\\/')})
window.__player = player
</script></body></html>`
}

// 运行时会探测可选的 caption-overrides.json（不存在时 404，无害）。
const optionalProbe = (text) => text.includes('caption-overrides.json')

async function browserCheck(browser, pages, name, html, times) {
  const path = `/smoke/${encodeURIComponent(name)}.html`
  pages.set(path, playerPage(html))
  const page = await browser.newPage({ viewport: { width: CANVAS.width, height: CANVAS.height } })
  const problems = { pageErrors: [], consoleErrors: [], external: [], missing: [] }
  page.on('pageerror', (error) => problems.pageErrors.push(error.message))
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      !optionalProbe(`${message.text()} ${message.location()?.url ?? ''}`)
    ) {
      problems.consoleErrors.push(message.text())
    }
  })
  page.on('request', (request) => {
    const url = request.url()
    if (!url.startsWith(ORIGIN) && !/^(data|blob|about):/.test(url)) problems.external.push(url)
  })
  page.on('response', (response) => {
    if (response.status() >= 400 && !optionalProbe(response.url()))
      problems.missing.push(response.url())
  })
  try {
    await page.goto(`${ORIGIN}${path}`)
    await page.waitForFunction(() => window.__ready, null, { timeout: 30_000 })
    await page.evaluate(() => window.__ready)
    for (const time of times) {
      await page.evaluate((t) => window.__player.seek(t), time / 1000)
      await page.waitForTimeout(300)
    }
  } catch (error) {
    problems.pageErrors.push(`加载超时或失败：${error.message.split('\n')[0]}`)
  } finally {
    await page.close()
    pages.delete(path)
  }
  return problems
}

// ------------------------------------------------------------------ 渲染与比较

let producer
async function render(name, html, mediaDir) {
  producer ??= await import('@hyperframes/producer')
  const project = join(CACHE, 'projects', name)
  await rm(project, { recursive: true, force: true })
  await mkdir(project, { recursive: true })
  for (const entry of await readdir(REGISTRY))
    await symlink(join(REGISTRY, entry), join(project, entry))
  await symlink(mediaDir, join(project, 'media'))
  await writeFile(join(project, 'index.html'), html)
  const output = join(project, 'out.mp4')
  const job = producer.createRenderJob({
    fps: FPS,
    quality: 'draft',
    format: 'mp4',
    logger: { error() {}, warn() {}, info() {}, debug() {} },
  })
  await producer.executeRenderJob(job, project, output)
  return output
}

/** 取一帧缩成 320×180 灰度原始像素（星点、细线这类小东西缩得太小会被抹掉）。 */
async function grayFrame(file, ms) {
  const { stdout } = await run(
    'ffmpeg',
    [
      '-v',
      'error',
      '-ss',
      String(ms / 1000),
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      'scale=320:180,format=gray',
      '-f',
      'rawvideo',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 1 << 24 },
  )
  return stdout
}

/**
 * 与对照帧相比变了（灰度差超过 3，高于纯色底片的编码噪声）的像素占比；
 * 暗色小字压在深灰底片上也能分辨出来。
 */
const changedShare = (a, b) => {
  let changed = 0
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - (b[i] ?? 0)) > 3) changed += 1
  return changed / a.length
}
const spread = (frame) => Math.max(...frame) - Math.min(...frame)

async function thumbnail(name, file, ms) {
  const dir = join(CACHE, 'thumbnails')
  await mkdir(dir, { recursive: true })
  const filter = `scale=${THUMB.width}:${THUMB.height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${THUMB.width}:${THUMB.height}`
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-ss',
    String(ms / 1000),
    '-i',
    file,
    '-vf',
    filter,
    '-c:v',
    'libwebp',
    '-quality',
    '55',
    '-frames:v',
    '1',
    join(dir, `${name}.webp`),
  ])
}

// ------------------------------------------------------------------ 主流程

async function smokeOne(
  { item, catalogged },
  { catalog, builder, browser, pages, mediaDir, baselines },
) {
  const started = Date.now()
  const plan = drafts(item)
  const [from, to] = plan.window
  // 组件时段里均匀取 12 帧（短暂出现的画面也能看到），转场另加切点前后。
  const times = [
    ...Array.from({ length: 12 }, (_, index) =>
      Math.round(from + ((to - from) * (index + 0.5)) / 12),
    ),
    ...(plan.extraTimes ?? []),
  ]
  const testCatalog = catalogged ? catalog : { ...catalog, items: [...catalog.items, item] }
  const videos = Object.fromEntries(
    ['gray', 'blue', 'red'].map((id) => [id, { url: `media/${id}.mp4` }]),
  )
  const media = { videos, music: null, subtitles: plan.withSubtitles ? subtitles(to - from) : {} }
  const baselineMedia = { videos, music: null, subtitles: {} }
  const result = { name: item.name, catalogged, placement: item.placement }
  const fail = (reason, detail) => ({
    ...result,
    ok: false,
    reason,
    detail,
    ms: Date.now() - started,
  })

  let html
  try {
    html = builder.buildComposition({ draft: plan.draft, media, catalog: testCatalog }).html
  } catch (error) {
    return fail('合成失败', error.message)
  }
  const problems = await browserCheck(browser, pages, item.name, html, times)
  if (problems.external.length) return fail('请求了本机以外的地址', problems.external.slice(0, 5))
  if (problems.missing.length) return fail('用到的文件取不到', problems.missing.slice(0, 5))
  if (problems.pageErrors.length) return fail('页面报错', problems.pageErrors.slice(0, 5))
  if (problems.consoleErrors.length) return fail('控制台报错', problems.consoleErrors.slice(0, 5))

  let output
  try {
    output = await render(item.name, html, mediaDir)
  } catch (error) {
    return fail('渲染失败', String(error?.message ?? error).split('\n')[0])
  }
  const frames = await Promise.all(times.map((ms) => grayFrame(output, ms)))
  let visible
  if (plan.baseline) {
    const key = JSON.stringify(plan.baseline)
    if (!baselines.has(key)) {
      const baseHtml = builder.buildComposition({
        draft: plan.baseline,
        media: baselineMedia,
        catalog: testCatalog,
      }).html
      const baseOut = await render(`baseline-${baselines.size}`, baseHtml, mediaDir)
      baselines.set(key, await Promise.all(times.map((ms) => grayFrame(baseOut, ms))))
    }
    const reference = baselines.get(key)
    visible = Math.max(...frames.map((frame, index) => changedShare(frame, reference[index])))
    // 320×180 里不到 0.03%（约 17 个像素）有变化，当作没有画面。
    if (visible < 0.0003) return fail('画面是空的', { changedShare: visible })
  } else {
    visible = Math.max(...frames.map(spread))
    if (visible < 10) return fail('画面是空的', { spread: visible })
  }
  // 每个通过的都出缩略图：组件目录有上游预览图时用预览图，没有时用这张（见 hyperframes-catalog.mjs）。
  // 不按目录里现有的缩略图决定，否则上次冒烟出的缩略图会一直沿用，反映不了这次的渲染。
  await thumbnail(item.name, output, Math.round((from + to) / 2))
  await rm(join(CACHE, 'projects', item.name), { recursive: true, force: true })
  return {
    ...result,
    ok: true,
    visible: Math.round(visible * 1000) / 1000,
    thumbnail: true,
    ms: Date.now() - started,
  }
}

async function main() {
  await mkdir(join(CACHE, 'results'), { recursive: true })
  if (fresh) {
    await rm(join(CACHE, 'results'), { recursive: true, force: true })
    // 同步脚本或字体 CSS 改过之后要重跑：冒烟用的组件库也重新同步。
    await rm(REGISTRY, { recursive: true, force: true })
  }
  await mkdir(join(CACHE, 'results'), { recursive: true })
  await ensureRegistry()
  const mediaDir = await ensureMedia()
  const builder = await loadBuilder()
  const { catalog, list } = await candidates()
  const todo = list.filter(({ item }) => !only || only.has(item.name))
  const { server, pages } = await startServer(mediaDir)
  const browser = await chromium.launch()
  const context = { catalog, builder, browser, pages, mediaDir, baselines: new Map() }
  let index = 0
  try {
    for (const candidate of todo) {
      index += 1
      const resultPath = join(CACHE, 'results', `${candidate.item.name}.json`)
      if (!only && existsSync(resultPath)) continue
      const result = await smokeOne(candidate, context)
      await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`)
      console.log(
        `[${index}/${todo.length}] ${result.ok ? '通过' : `不通过（${result.reason}）`} ${candidate.item.name} ${result.ms} ms`,
      )
    }
  } finally {
    await browser.close()
    server.close()
  }
  await summarize(list)
}

/** 全部候选都有结果时，汇总进 web/scripts/hyperframes-smoke/。 */
async function summarize(list) {
  const results = []
  for (const { item } of list) {
    const path = join(CACHE, 'results', `${item.name}.json`)
    if (!existsSync(path)) {
      console.log(`还有候选没有结果（${item.name} 等），先不汇总`)
      return
    }
    results.push(JSON.parse(await readFile(path, 'utf8')))
  }
  results.sort((a, b) => a.name.localeCompare(b.name))
  const summary = {
    note: '由 render/scripts/smoke-catalog.mjs 生成，web/scripts/hyperframes-catalog.mjs 读取',
    canvas: CANVAS,
    fps: FPS,
    results: Object.fromEntries(
      results.map(({ name, ok, reason, detail, thumbnail: thumb }) => [
        name,
        ok ? { ok, thumbnail: Boolean(thumb) } : { ok, reason, detail },
      ]),
    ),
  }
  // 结果入 web/ 的库，按 web 的 Prettier 与配置排版（web 的格式检查覆盖它）。
  const resultsPath = join(OUTPUT, 'results.json')
  // require.resolve 给的是 Prettier 的 CommonJS 入口，导入后 API 在 default 上。
  const { default: prettier } = await import(
    pathToFileURL(createRequire(join(WEB_ROOT, 'package.json')).resolve('prettier')).href
  )
  // web 配置里的 Tailwind 插件按当前目录解析，这里找不到；排 JSON 也用不到它。
  const options = await prettier.resolveConfig(resultsPath)
  const text = await prettier.format(JSON.stringify(summary), {
    ...options,
    plugins: [],
    filepath: resultsPath,
  })
  await rm(OUTPUT, { recursive: true, force: true })
  await mkdir(join(OUTPUT, 'thumbnails'), { recursive: true })
  for (const result of results.filter((entry) => entry.ok && entry.thumbnail)) {
    await copyFile(
      join(CACHE, 'thumbnails', `${result.name}.webp`),
      join(OUTPUT, 'thumbnails', `${result.name}.webp`),
    )
  }
  await writeFile(resultsPath, text)
  const passed = results.filter((entry) => entry.ok).length
  console.log(
    `冒烟筛选：${results.length} 个候选，通过 ${passed}，不通过 ${results.length - passed}；结果在 ${OUTPUT}`,
  )
}

await main()
