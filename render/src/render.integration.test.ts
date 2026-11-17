import { execFile, spawnSync } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { resolveHeadlessShellPath } from '@hyperframes/engine'
import { openComposition } from '@hyperframes/sdk'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  CAPTIONS_PATH,
  captionsHostElement,
  captionsScene,
  captionVariable,
} from '../../web/src/features/storyboard/final-cut/composition/captions'
import type { ComponentCatalog } from '../../web/src/features/storyboard/final-cut/composition/catalog'
import {
  clipOf,
  itemNamed,
  withFontBlock,
  type AudioClip,
  type Canvas,
  type CaptionClip,
  type FilmClip,
  type VideoClip,
} from '../../web/src/features/storyboard/final-cut/composition/film'
import {
  LOCALE_BINDINGS,
  localeVariable,
  localeVariableId,
} from '../../web/src/features/storyboard/final-cut/composition/locale-text'
import { startBrowserGuard, type BrowserGuard } from './browser'
import { ExportQueue } from './jobs'
import type { ProjectFile } from './project'
import { createProducerWorker } from './renderer'
import { createExportServer } from './server'
import { audio, host, mainFile, memoryLogger, video } from './testing'

const run = promisify(execFile)
const REGISTRY_ROOT =
  process.env['RENDER_REGISTRY_ROOT'] ?? join(import.meta.dirname, '../../web/public/hyperframes')
const VENDOR_DIR = join(REGISTRY_ROOT, 'vendor')
const library: ComponentCatalog | null = existsSync(join(REGISTRY_ROOT, 'catalog.json'))
  ? (JSON.parse(readFileSync(join(REGISTRY_ROOT, 'catalog.json'), 'utf8')) as ComponentCatalog)
  : null
const versionDir = library === null ? '' : join(REGISTRY_ROOT, library.version)

function skipReason(): string | null {
  let chrome: string | undefined
  try {
    chrome = resolveHeadlessShellPath()
  } catch (error) {
    return `chrome-headless-shell 不可用：${error instanceof Error ? error.message : String(error)}`
  }
  if (!chrome) return '找不到 chrome-headless-shell（设置 PRODUCER_HEADLESS_SHELL_PATH）'
  for (const tool of ['ffmpeg', 'ffprobe']) {
    if (spawnSync(tool, ['-version']).status !== 0) return `找不到 ${tool}`
  }
  if (library === null || !existsSync(join(versionDir, library.runtime.hyperframes))) {
    return `组件库没有组装（${REGISTRY_ROOT}；在 web/ 运行 pnpm hf:registry）`
  }
  return null
}

const reason = skipReason()

const FRAME = { width: 640, height: 360 }

interface Area {
  x: number
  y: number
  width: number
  height: number
}

/** 第 `at` 秒那一帧的 RGB；给了 `area` 只取这一块。 */
async function frameAt(file: string, at: number, area?: Area): Promise<Buffer> {
  const size = area ?? FRAME
  const { stdout } = await run(
    'ffmpeg',
    [
      '-v',
      'error',
      '-ss',
      String(at),
      '-i',
      file,
      ...(area ? ['-vf', `crop=${area.width}:${area.height}:${area.x}:${area.y}`] : []),
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: size.width * size.height * 3 * 2 },
  )
  return stdout
}

const solid = (length: number, [r, g, b]: [number, number, number]) => {
  const pixels = Buffer.alloc(length)
  for (let offset = 0; offset < length; offset += 3) pixels.set([r, g, b], offset)
  return pixels
}

/** `css` 里有没有一条这个字体族的 @font-face，它的 unicode-range 盖住 `char`。 */
function declaresGlyph(css: string, family: string, char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return [...css.matchAll(/@font-face\{([^}]*)\}/g)].some(([, rule = '']) => {
    if (!rule.includes(`font-family:'${family}'`)) return false
    const ranges = /unicode-range:([^;}]+)/.exec(rule)?.[1] ?? ''
    return ranges.split(',').some((part) => {
      const [from = '', to = from] = part.trim().replace(/^U\+/i, '').split('-')
      return parseInt(from, 16) <= code && code <= parseInt(to, 16)
    })
  })
}

async function streamsOf(file: string): Promise<string[]> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type',
    '-of',
    'json',
    file,
  ])
  const probe = JSON.parse(stdout) as { streams: { codec_type: string }[] }
  return probe.streams.map((stream) => stream.codec_type).toSorted()
}

async function durationOf(file: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    file,
  ])
  return Number((JSON.parse(stdout) as { format: { duration: string } }).format.duration)
}

function meanDifference(a: Buffer, b: Buffer): number {
  let sum = 0
  for (let offset = 0; offset < a.length; offset += 1) {
    sum += Math.abs((a[offset] ?? 0) - (b[offset] ?? 0))
  }
  return sum / a.length
}

/** 一段声音的平均响度（dB）。 */
async function meanVolume(file: string, from: number, length: number): Promise<number> {
  const { stderr } = await run('ffmpeg', [
    '-v',
    'info',
    '-ss',
    String(from),
    '-t',
    String(length),
    '-i',
    file,
    '-vn',
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ])
  return Number(/mean_volume: (-?[\d.]+) dB/.exec(stderr)?.[1])
}

/** 素材和上传用的测试服务器；`requests` 按先后记下收到的每个请求。 */
async function startServer(
  dir: string,
): Promise<{ server: Server; origin: string; requests: string[] }> {
  const requests: string[] = []
  const server = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`)
    const path = join(dir, new URL(req.url ?? '/', 'http://x').pathname)
    if (req.method === 'PUT') {
      await pipeline(req, createWriteStream(join(dir, 'received.mp4')))
      res.writeHead(200).end()
      return
    }
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) {
      res.writeHead(404).end()
      return
    }
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
    if (range?.[1]) {
      const start = Number(range[1])
      const end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${info.size}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
      })
      createReadStream(path, { start, end }).pipe(res)
      return
    }
    res.writeHead(200, { 'Content-Length': info.size, 'Accept-Ranges': 'bytes' })
    createReadStream(path).pipe(res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
  }
}

/** 和编辑器加条目时一样：条目的 `files` 从组件库版本目录按原路径原样拷进工程。 */
function itemFiles(clips: readonly FilmClip[]): ProjectFile[] {
  const catalog = library as ComponentCatalog
  const paths = new Set(
    clips.flatMap((clip) =>
      clip.kind === 'host' ? (itemNamed(catalog, clip.item)?.files ?? []) : [],
    ),
  )
  return [...paths].map((path) => ({
    path,
    content: readFileSync(join(versionDir, path), 'utf8'),
  }))
}

/** 一份工程：主文件按 `clips` 写（用真的组件库目录），加上用到的条目文件。 */
function project(clips: FilmClip[], canvas: Canvas = FRAME): ProjectFile[] {
  return [
    { path: 'index.html', content: mainFile(clips, canvas, library as ComponentCatalog) },
    ...itemFiles(clips),
  ]
}

/** 主文件里写的素材地址就是测试服务器上的地址，下载地址和它一样。 */
const mediaOf = (urls: readonly string[]) => new Map(urls.map((url) => [url, url]))

describe.skipIf(reason !== null)(`真实渲染${reason ? `（跳过：${reason}）` : ''}`, () => {
  let dir: string
  let server: Server
  let origin: string
  let requests: string[]
  // 和服务启动时一样：浏览器经启动脚本启动，连不了回环以外的地址
  let guard: BrowserGuard
  const guardLog = memoryLogger()

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'render-integration-'))
    guard = await startBrowserGuard(
      resolveHeadlessShellPath() as string,
      join(dir, 'browser'),
      guardLog.logger,
    )
    await run('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=640x360:r=30:d=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330:duration=3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      join(dir, 'clip.mp4'),
    ])
    await run('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x202020:s=640x360:r=30:d=7',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=550:duration=7',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      join(dir, 'gray.mp4'),
    ])
    await run('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1.5',
      '-c:a',
      'aac',
      join(dir, 'tone.m4a'),
    ])
    // 6 秒：0–2 秒红、2–4 秒绿、4–6 秒蓝，看画面是素材的第几秒
    await run('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=640x360:r=30:d=2',
      '-f',
      'lavfi',
      '-i',
      'color=c=lime:s=640x360:r=30:d=2',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=640x360:r=30:d=2',
      '-filter_complex',
      '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
      '-map',
      '[v]',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      join(dir, 'steps.mp4'),
    ])
    ;({ server, origin, requests } = await startServer(dir))
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    await guard?.close()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  const workerIn = (workDir: string, logger = memoryLogger().logger) =>
    createProducerWorker({ workDir, chromePath: guard.chromePath, gpuEncode: false, logger })

  /** 渲染一份工程；`media` 是主文件里的素材地址，下载地址和它一样。 */
  const renderProject = (
    id: string,
    files: ProjectFile[],
    media: readonly string[] = [],
    logger = memoryLogger().logger,
  ) =>
    workerIn(join(dir, 'work'), logger).render(
      { id, files, media: mediaOf(media), variables: null, vendorDir: VENDOR_DIR },
      { signal: new AbortController().signal, onProgress: () => {} },
    )

  const blockedHosts = () =>
    guardLog.lines
      .filter((line) => line['event'] === '拦截了渲染页面的外部请求')
      .map((line) => line['host'])

  it('经接口导出一份 2 秒的工程并上传：时长 2 秒、画布尺寸、有音轨', async () => {
    const { logger } = memoryLogger()
    const queue = new ExportQueue({
      worker: workerIn(join(dir, 'work'), logger),
      logger,
      timeoutMs: 5 * 60_000,
    })
    const service = createExportServer({
      queue,
      vendorDir: VENDOR_DIR,
      allowedHosts: new Set([new URL(origin).host]),
      logger,
      health: () => ({ gpu: 'software', chrome: 'test' }),
    })
    await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve))
    const api = `http://127.0.0.1:${(service.address() as AddressInfo).port}`
    const exportId = '33333333-2222-4333-8444-555555555555'
    const clip = `${origin}/clip.mp4`
    const body = {
      id: exportId,
      conversationId: '99999999-8888-4777-8666-555555555555',
      files: project([video({ src: clip, duration: 2000, mediaStart: 500 })]),
      media: { [clip]: { url: clip } },
      upload: { url: `${origin}/upload.mp4`, headers: { 'Content-Type': 'video/mp4' } },
    }
    try {
      const posted = await fetch(`${api}/exports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(posted.status).toBe(202)
      let view: { status: string; error: unknown; progress: number } | undefined
      for (let attempt = 0; attempt < 600; attempt += 1) {
        view = (await (await fetch(`${api}/exports/${exportId}`)).json()) as typeof view
        if (view && ['done', 'failed', 'cancelled'].includes(view.status)) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      expect(view?.error).toBeNull()
      expect(view?.status).toBe('done')
    } finally {
      await new Promise<void>((resolve) => service.close(() => resolve()))
    }

    const { stdout } = await run('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type,width,height',
      '-of',
      'json',
      join(dir, 'received.mp4'),
    ])
    const probe = JSON.parse(stdout) as {
      format: { duration: string }
      streams: { codec_type: string; width?: number; height?: number }[]
    }
    expect(Number(probe.format.duration)).toBeGreaterThan(1.9)
    expect(Number(probe.format.duration)).toBeLessThan(2.15)
    const videoStream = probe.streams.find((stream) => stream.codec_type === 'video')
    expect(videoStream).toMatchObject({ width: 640, height: 360 })
    expect(probe.streams.some((stream) => stream.codec_type === 'audio')).toBe(true)
  }, 300_000)

  it('渲染完、失败了都删掉临时目录', async () => {
    const workDir = join(dir, 'work-cleanup')
    const worker = workerIn(workDir)
    const clip = `${origin}/clip.mp4`
    const rendered = await worker.render(
      {
        id: 'cleanup-ok',
        files: project([video({ src: clip, duration: 1000 })]),
        media: mediaOf([clip]),
        variables: null,
        vendorDir: VENDOR_DIR,
      },
      { signal: new AbortController().signal, onProgress: () => {} },
    )
    expect(await readdir(workDir)).toHaveLength(1)
    await rendered.cleanup()
    expect(await readdir(workDir)).toEqual([])
    await expect(
      worker.render(
        {
          id: 'cleanup-failed',
          files: project([video({ src: `${origin}/missing.mp4`, duration: 1000 })]),
          media: mediaOf([`${origin}/missing.mp4`]),
          variables: null,
          vendorDir: VENDOR_DIR,
        },
        { signal: new AbortController().signal, onProgress: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'media-unreachable' })
    expect(await readdir(workDir)).toEqual([])
  }, 300_000)

  it('工程文件的路径跳出工程目录时不写、不渲染', async () => {
    const workDir = join(dir, 'work-escape')
    await expect(
      workerIn(workDir).render(
        {
          id: 'escape',
          files: [
            { path: 'index.html', content: mainFile([], FRAME, library as ComponentCatalog) },
            { path: '../escape.html', content: 'x' },
          ],
          media: new Map(),
          variables: null,
          vendorDir: VENDOR_DIR,
        },
        { signal: new AbortController().signal, onProgress: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'render-failed' })
    expect(existsSync(join(workDir, 'escape.html'))).toBe(false)
    expect(await readdir(workDir)).toEqual([])
  }, 60_000)

  it('两个视频片段首尾相接：各在自己的时间段里上画面，音量按片段上写的生效', async () => {
    const [clip, gray] = [`${origin}/clip.mp4`, `${origin}/gray.mp4`]
    const render = async (id: string, grayVolume: number) => {
      const rendered = await renderProject(
        id,
        project([
          video({ src: clip, duration: 2000 }),
          video({
            id: 'clip-2',
            src: gray,
            start: 2000,
            duration: 3000,
            mediaStart: 1000,
            volume: grayVolume,
          }),
        ]),
        [clip, gray],
      )
      try {
        return {
          duration: await durationOf(rendered.file),
          first: await frameAt(rendered.file, 1),
          second: await frameAt(rendered.file, 3.5),
          loudness: await meanVolume(rendered.file, 2.5, 2),
        }
      } finally {
        await rendered.cleanup()
      }
    }
    const full = await render('two-clips', 1)
    const quiet = await render('two-clips-quiet', 0.25)

    expect(full.duration).toBeGreaterThan(4.9)
    expect(full.duration).toBeLessThan(5.15)
    const grayFrame = Buffer.alloc(full.second.length, 0x20)
    expect(meanDifference(full.second, grayFrame)).toBeLessThan(6)
    expect(meanDifference(full.first, grayFrame)).toBeGreaterThan(30)
    expect(full.loudness - quiet.loudness).toBeGreaterThan(9)
    expect(full.loudness - quiet.loudness).toBeLessThan(15)
  }, 600_000)

  it('两个视频片段同时出现在两行上：叠放顺序大的在上面，一样大时文件里写在后面的在上面', async () => {
    const [clip, gray] = [`${origin}/clip.mp4`, `${origin}/gray.mp4`]
    /** 彩色那条写在前面、放第一行，灰色那条写在后面、放第二行，两条都占 0–2 秒。 */
    const frameWith = async (id: string, clipZ: number, grayZ: number) => {
      const rendered = await renderProject(
        id,
        project([
          video({ src: clip, duration: 2000, z: clipZ }),
          video({ id: 'clip-2', src: gray, duration: 2000, track: 1, z: grayZ }),
        ]),
        [clip, gray],
      )
      try {
        return await frameAt(rendered.file, 1)
      } finally {
        await rendered.cleanup()
      }
    }
    const clipOnTop = await frameWith('stack-clip', 2, 1)
    const grayOnTop = await frameWith('stack-gray', 1, 2)
    const sameOrder = await frameWith('stack-same', 0, 0)

    const grayFrame = Buffer.alloc(clipOnTop.length, 0x20)
    expect(meanDifference(clipOnTop, grayFrame)).toBeGreaterThan(30)
    expect(meanDifference(grayOnTop, grayFrame)).toBeLessThan(6)
    expect(meanDifference(sameOrder, grayFrame)).toBeLessThan(6)
  }, 900_000)

  it('隐藏的视频片段：导出里不出现也不出声，它占的时间照算', async () => {
    const [clip, gray] = [`${origin}/clip.mp4`, `${origin}/gray.mp4`]
    /** 彩色那条占 0–2 秒，灰色那条接在后面占 2–4 秒。 */
    const render = async (id: string, clipHidden: boolean) => {
      const rendered = await renderProject(
        id,
        project([
          video({ src: clip, duration: 2000, hidden: clipHidden }),
          video({ id: 'clip-2', src: gray, start: 2000, duration: 2000 }),
        ]),
        [clip, gray],
      )
      try {
        return {
          first: await frameAt(rendered.file, 1),
          second: await frameAt(rendered.file, 3),
          loudness: await meanVolume(rendered.file, 0.3, 1.4),
        }
      } finally {
        await rendered.cleanup()
      }
    }
    const shown = await render('hidden-off', false)
    const hidden = await render('hidden-on', true)

    const black = Buffer.alloc(shown.first.length, 0)
    const grayFrame = Buffer.alloc(shown.first.length, 0x20)
    expect(meanDifference(shown.first, black)).toBeGreaterThan(30)
    expect(meanDifference(hidden.first, black)).toBeLessThan(6)
    expect(meanDifference(hidden.second, grayFrame)).toBeLessThan(6)
    expect(shown.loudness - hidden.loudness).toBeGreaterThan(30)
  }, 600_000)

  it('组件或块的片段：组件按可填项画出来，组件文字用到的中文字形在字体块里声明了', async () => {
    const catalog = library as ComponentCatalog
    // 测试组件按 1920×1080 设计：左下角 x 120–1020、y 720–940 一块色底，色底里左边一行字
    const canvas = { width: 1920, height: 1080 }
    const title = '成片标题'
    let main = ''
    const render = async (id: string, hidden: boolean) => {
      const files = project([host({ values: { text: title, accent: '#ff0000' }, hidden })], canvas)
      main = files[0]?.content ?? ''
      const rendered = await renderProject(id, files)
      try {
        return {
          panel: await frameAt(rendered.file, 1, { x: 700, y: 740, width: 300, height: 180 }),
          words: await frameAt(rendered.file, 1, { x: 170, y: 760, width: 380, height: 140 }),
          outside: await frameAt(rendered.file, 1, { x: 1200, y: 100, width: 600, height: 500 }),
        }
      } finally {
        await rendered.cleanup()
      }
    }
    const shown = await render('component', false)
    for (const char of title) expect(declaresGlyph(main, catalog.cjk.family, char)).toBe(true)
    const hidden = await render('component-hidden', true)

    const red = solid(shown.panel.length, [255, 0, 0])
    expect(meanDifference(shown.panel, red)).toBeLessThan(10)
    expect(meanDifference(shown.words, solid(shown.words.length, [255, 0, 0]))).toBeGreaterThan(20)
    expect(meanDifference(shown.outside, Buffer.alloc(shown.outside.length, 0))).toBeLessThan(6)
    expect(meanDifference(hidden.panel, Buffer.alloc(hidden.panel.length, 0))).toBeLessThan(6)
  }, 600_000)

  it('组件文件从工程里取：工程里那一份改过就画改过的样子；工程里没有这个文件时检查不通过，不去组件库找', async () => {
    const canvas = { width: 1920, height: 1080 }
    const clips = [host({ values: { text: '', accent: '#ff0000' } })]
    const files = project(clips, canvas)
    const edited = files.map((file) =>
      file.path === 'index.html'
        ? file
        : // 工程里的这一份把色底的默认位置挪到右上角：可填项给的底色照旧
          { ...file, content: file.content.replace('top: 720px;', 'top: 60px;') },
    )
    expect(edited[1]?.content).not.toBe(files[1]?.content)
    const rendered = await renderProject('component-from-project', edited)
    try {
      const moved = await frameAt(rendered.file, 1, { x: 700, y: 80, width: 300, height: 180 })
      const left = await frameAt(rendered.file, 1, { x: 700, y: 740, width: 300, height: 180 })
      expect(meanDifference(moved, solid(moved.length, [255, 0, 0]))).toBeLessThan(10)
      expect(meanDifference(left, Buffer.alloc(left.length, 0))).toBeLessThan(6)
    } finally {
      await rendered.cleanup()
    }

    const workDir = join(dir, 'work-missing')
    await expect(
      workerIn(workDir).render(
        {
          id: 'component-missing',
          files: files.slice(0, 1),
          media: new Map(),
          variables: null,
          vendorDir: VENDOR_DIR,
        },
        { signal: new AbortController().signal, onProgress: () => {} },
      ),
    ).rejects.toMatchObject({
      code: 'lint-failed',
      message: expect.stringContaining('index.html：missing_or_empty_sub_composition') as unknown,
    })
    expect(await readdir(workDir)).toEqual([])
  }, 600_000)

  it('带旁挂文件的条目：工程里有它的专有目录，照常导出', async () => {
    const canvas = { width: 1920, height: 1080 }
    const sidecar = host({
      id: 'sidecar-1',
      label: '测试旁挂',
      item: 'fixture-sidecar',
      src: 'compositions/fixture-sidecar/fixture-sidecar.html',
      duration: 2000,
    })
    const files = project([sidecar], canvas)
    expect(files.map((file) => file.path)).toEqual([
      'index.html',
      'compositions/fixture-sidecar/fixture-sidecar.html',
      'compositions/fixture-sidecar/assets/fixture-sidecar.json',
    ])
    const rendered = await renderProject('sidecar', files)
    try {
      expect(await durationOf(rendered.file)).toBeGreaterThan(1.9)
      const frame = await frameAt(rendered.file, 1, { x: 0, y: 0, width: 1920, height: 1080 })
      expect(meanDifference(frame, Buffer.alloc(frame.length, 0))).toBeGreaterThan(5)
    } finally {
      await rendered.cleanup()
    }
  }, 600_000)

  it('固定尺寸的组件放进竖版画面：按原比例缩小、居中，不铺满也不出画', async () => {
    // 测试组件按 1920×1080 设计，色底在 x 120–1020、y 720–940。放进 720×1280：缩成 0.375 倍、
    // 上下居中（顶边 437.5），色底落在 x 45–382.5、y 707.5–790
    const canvas = { width: 720, height: 1280 }
    const rendered = await renderProject(
      'component-fit',
      project([host({ values: { text: '', accent: '#ff0000' } })], canvas),
    )
    try {
      // 缩小后的色底左段：不缩时这里在色底左边（x 120 以左），是黑的
      const left = await frameAt(rendered.file, 1, { x: 55, y: 715, width: 50, height: 60 })
      // 不缩时色底会盖到这里；缩小后在色底右边、下边，是黑的
      const beyond = await frameAt(rendered.file, 1, { x: 420, y: 800, width: 260, height: 120 })
      expect(meanDifference(left, solid(left.length, [255, 0, 0]))).toBeLessThan(10)
      expect(meanDifference(beyond, Buffer.alloc(beyond.length, 0))).toBeLessThan(6)
    } finally {
      await rendered.cleanup()
    }
  }, 600_000)

  it('组件的字体可填项换成组件库里的字体：字体变量生效，字的样子跟着变', async () => {
    const canvas = { width: 1920, height: 1080 }
    const words = async (id: string, values: Record<string, string>) => {
      const rendered = await renderProject(
        id,
        project([host({ values: { text: 'Sample', accent: '#ff0000', ...values } })], canvas),
      )
      try {
        return await frameAt(rendered.file, 1, { x: 170, y: 760, width: 380, height: 140 })
      } finally {
        await rendered.cleanup()
      }
    }
    const plain = await words('component-font-plain', {})
    const chosen = await words('component-font-chosen', { font: 'Playfair Display' })
    const again = await words('component-font-again', { font: 'Playfair Display' })
    expect(meanDifference(chosen, again)).toBeLessThan(2)
    expect(meanDifference(plain, chosen)).toBeGreaterThan(8)
  }, 600_000)

  it('在编辑器里改了组件的文字可填项：导出里画的是新的文字，和默认文字时不一样', async () => {
    const catalog = library as ComponentCatalog
    const canvas = { width: 1920, height: 1080 }
    const files = project([host({ values: { accent: '#ff0000' } })], canvas)
    const stored = files[0]?.content ?? ''
    // 和编辑器右侧栏改值一样：用 SDK 把片段上的取值整串换掉，存出时重算字体块
    const session = await openComposition(stored)
    session.setAttribute(
      'title-1',
      'data-variable-values',
      JSON.stringify({ accent: '#ff0000', text: '新的标题' }),
    )
    const timings = session.getElementTimings()
    const clips = session
      .getElements()
      .filter((element) => element.id === 'title-1')
      .flatMap((element) => {
        const timing = timings[element.id]
        return timing === undefined ? [] : [clipOf(element, timing, catalog)]
      })
    const edited = withFontBlock(session.serialize(), clips, catalog)
    const words = async (id: string, html: string) => {
      const rendered = await renderProject(id, [
        { path: 'index.html', content: html },
        ...files.slice(1),
      ])
      try {
        return await frameAt(rendered.file, 1, { x: 170, y: 760, width: 380, height: 140 })
      } finally {
        await rendered.cleanup()
      }
    }
    const plain = await words('component-text-default', stored)
    const changed = await words('component-text-edited', edited)
    expect(edited).toContain('&quot;text&quot;:&quot;新的标题&quot;')
    for (const char of '新的标题')
      expect(declaresGlyph(edited, catalog.cjk.family, char)).toBe(true)
    expect(meanDifference(plain, changed)).toBeGreaterThan(8)
  }, 600_000)

  it('字幕：场景里的字读主文件根上的变量，那一秒画面底部有白字黑边；工程检查没有错误和警告，不去外网取字体', async () => {
    const catalog = library as ComponentCatalog
    const steps = `${origin}/steps.mp4`
    // 照编辑器的写法：视频片段带叠放顺序，字幕宿主写在根下最后、叠在最上面
    const clips = [video({ src: steps, duration: 2000, muted: true, z: 1 })]
    const caption: CaptionClip = {
      kind: 'caption',
      id: 'cap-a1',
      label: '字幕',
      start: 0,
      duration: 2000,
      track: 0,
      hidden: false,
      link: null,
      text: '字幕第一行\nSecond line',
      variable: 'cap_a1',
      owner: null,
    }
    /** 有字幕时：场景里的元素不写字，字只在主文件根上的变量里；读不到变量就画不出字。 */
    const files = async (captioned: boolean): Promise<ProjectFile[]> => {
      const [main, ...others] = project(clips)
      const session = await openComposition(main?.content ?? '')
      session.addElement('film', 99, captionsHostElement(FRAME, 2000))
      if (captioned) session.declareVariable(captionVariable(caption))
      const lines = captioned ? [{ ...caption, text: '' }] : []
      return [
        {
          path: 'index.html',
          content: withFontBlock(
            session.serialize(),
            captioned ? [...clips, caption] : clips,
            catalog,
          ),
        },
        { path: CAPTIONS_PATH, content: captionsScene(FRAME, catalog, lines) },
        ...others,
      ]
    }
    // 字幕在画面 86.5% 高处、两行：这块里数接近白色和接近黑色的像素，底色是红的
    const area = { x: 64, y: 256, width: 512, height: 100 }
    const count = (pixels: Buffer, test: (r: number, g: number, b: number) => boolean) => {
      let found = 0
      for (let offset = 0; offset < pixels.length; offset += 3)
        if (test(pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0)) found += 1
      return found
    }
    const render = async (id: string, captioned: boolean) => {
      const { logger, lines } = memoryLogger()
      const rendered = await renderProject(id, await files(captioned), [steps], logger)
      try {
        const pixels = await frameAt(rendered.file, 1, area)
        return {
          white: count(pixels, (r, g, b) => r > 220 && g > 220 && b > 220),
          black: count(pixels, (r, g, b) => r < 40 && g < 40 && b < 40),
          warnings: lines.filter((line) => line['event'] === '工程检查有警告'),
          log: JSON.stringify(lines),
        }
      } finally {
        await rendered.cleanup()
      }
    }
    // 渲染服务这边（编译工程时取字体等）发出的请求：除了取素材的回环地址，一个都不该有
    const requests = vi.spyOn(globalThis, 'fetch')
    let shown: Awaited<ReturnType<typeof render>>
    let bare: Awaited<ReturnType<typeof render>>
    let urls: URL[]
    try {
      shown = await render('captions', true)
      bare = await render('captions-bare', false)
    } finally {
      // 先取出调用记录：还原会连记录一起清掉
      urls = requests.mock.calls.map(
        ([input]) => new URL(input instanceof Request ? input.url : String(input)),
      )
      requests.mockRestore()
    }
    // 取素材走的就是这个 fetch：看得到它，说明外网请求也看得到
    expect(urls.some((url) => url.hostname === '127.0.0.1')).toBe(true)
    const outside = urls.filter((url) => url.hostname !== '127.0.0.1').map((url) => url.href)

    expect(shown.white).toBeGreaterThan(300)
    expect(shown.black).toBeGreaterThan(300)
    expect(bare.white).toBeLessThan(5)
    expect(bare.black).toBeLessThan(5)
    expect(shown.warnings).toEqual([])
    expect(outside).toEqual([])
    expect(shown.log).not.toMatch(/fonts\.(googleapis|gstatic)\.com/)
    expect(blockedHosts().filter((host) => /fonts\./.test(String(host)))).toEqual([])
  }, 600_000)

  it('按语言导出：同一个工程（原文是中文）经接口导原文和 English，字幕和贴片里随语言的字换成英文；没有错误和警告，不去外网取字体', async () => {
    const catalog = library as ComponentCatalog
    const steps = `${origin}/steps.mp4`
    const title = '成片标题'
    const titleVariable = localeVariableId('title-1', 'text')
    // 贴片在前 1 秒、字幕在后 1 秒，各取各的那一帧
    const clips: FilmClip[] = [
      video({ src: steps, duration: 2000, muted: true, z: 1 }),
      host({ duration: 1000, values: { text: title, accent: '#2756ff' }, z: 2 }),
    ]
    const caption: CaptionClip = {
      kind: 'caption',
      id: 'cap-a1',
      label: '字幕',
      start: 1000,
      duration: 1000,
      track: 0,
      hidden: false,
      link: null,
      text: '字幕第一行',
      variable: 'cap_a1',
      owner: null,
    }
    // 照编辑器的写法：字幕的字只在根上的变量里；贴片的「文字」随语言，宿主记着根变量，根上声明它、默认值是原文
    const [main, ...others] = project(clips)
    const session = await openComposition(main?.content ?? '')
    session.addElement('film', 99, captionsHostElement(FRAME, 2000))
    session.declareVariable(captionVariable(caption))
    session.declareVariable(localeVariable(titleVariable, '文字', title))
    session.setAttribute('title-1', LOCALE_BINDINGS, JSON.stringify({ text: titleVariable }))
    const files: ProjectFile[] = [
      {
        path: 'index.html',
        content: withFontBlock(session.serialize(), [...clips, caption], catalog),
      },
      { path: CAPTIONS_PATH, content: captionsScene(FRAME, catalog, [{ ...caption, text: '' }]) },
      {
        path: 'locales/en.json',
        content: JSON.stringify({ cap_a1: 'Hello there', [titleVariable]: 'Big Title' }),
      },
      ...others,
    ]
    const titleArea = { x: 40, y: 240, width: 300, height: 74 }
    const captionArea = { x: 64, y: 256, width: 512, height: 100 }

    /** 经接口导出一次（两次的 `files` 一样，只差 `locale`），取上传的成片里贴片和字幕那两帧。 */
    const exportIn = async (id: string, locale: 'en' | null) => {
      const { logger, lines } = memoryLogger()
      const queue = new ExportQueue({
        worker: workerIn(join(dir, 'work'), logger),
        logger,
        timeoutMs: 5 * 60_000,
      })
      const service = createExportServer({
        queue,
        vendorDir: VENDOR_DIR,
        allowedHosts: new Set([new URL(origin).host]),
        logger,
        health: () => ({ gpu: 'software', chrome: 'test' }),
      })
      await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve))
      const api = `http://127.0.0.1:${(service.address() as AddressInfo).port}`
      try {
        const posted = await fetch(`${api}/exports`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id,
            conversationId: '99999999-8888-4777-8666-555555555555',
            files,
            media: { [steps]: { url: steps } },
            locale,
            upload: { url: `${origin}/upload.mp4`, headers: { 'Content-Type': 'video/mp4' } },
          }),
        })
        expect(posted.status).toBe(202)
        let view: { status: string; error: unknown } | undefined
        for (let attempt = 0; attempt < 600; attempt += 1) {
          view = (await (await fetch(`${api}/exports/${id}`)).json()) as typeof view
          if (view && ['done', 'failed', 'cancelled'].includes(view.status)) break
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        expect(view?.error).toBeNull()
        expect(view?.status).toBe('done')
      } finally {
        await new Promise<void>((resolve) => service.close(() => resolve()))
      }
      const received = join(dir, 'received.mp4')
      return {
        title: await frameAt(received, 0.5, titleArea),
        caption: await frameAt(received, 1.5, captionArea),
        warnings: lines.filter((line) => line['event'] === '工程检查有警告'),
        log: JSON.stringify(lines),
      }
    }

    // 渲染服务这边发出的请求：除了回环地址，一个都不该有
    const requests = vi.spyOn(globalThis, 'fetch')
    let source: Awaited<ReturnType<typeof exportIn>>
    let english: Awaited<ReturnType<typeof exportIn>>
    let urls: URL[]
    try {
      source = await exportIn('44444444-2222-4333-8444-555555555555', null)
      english = await exportIn('55555555-2222-4333-8444-555555555555', 'en')
    } finally {
      urls = requests.mock.calls.map(
        ([input]) => new URL(input instanceof Request ? input.url : String(input)),
      )
      requests.mockRestore()
    }

    // 同一份工程渲两次的差别在 2 以下；字换了之后两块都在 10 上下
    expect(meanDifference(source.title, english.title)).toBeGreaterThan(5)
    expect(meanDifference(source.caption, english.caption)).toBeGreaterThan(5)
    expect(source.warnings).toEqual([])
    expect(english.warnings).toEqual([])
    expect(urls.filter((url) => url.hostname !== '127.0.0.1').map((url) => url.href)).toEqual([])
    expect(english.log).not.toMatch(/fonts\.(googleapis|gstatic)\.com/)
    expect(blockedHosts().filter((host) => /fonts\./.test(String(host)))).toEqual([])
  }, 600_000)

  it('音频片段：有声音，音量调低后更轻，循环时音频比片段短也一直有声，隐藏后没有声音', async () => {
    const tone = `${origin}/tone.m4a`
    /** 1.5 秒的音频放进 0–3 秒的片段；隐藏的音频片段原样留在主文件里，交给渲染引擎。 */
    const render = async (id: string, overrides: Partial<AudioClip>) => {
      const files = project([audio({ src: tone, duration: 3000, ...overrides })])
      if (overrides.hidden === true) expect(files[0]?.content).toMatch(/<audio data-hidden /)
      const rendered = await renderProject(id, files, [tone])
      try {
        const duration = await durationOf(rendered.file)
        const streams = await streamsOf(rendered.file)
        if (!streams.includes('audio')) return { duration, streams, early: NaN, late: NaN }
        return {
          duration,
          streams,
          early: await meanVolume(rendered.file, 0.3, 0.9),
          late: await meanVolume(rendered.file, 1.8, 1),
        }
      } finally {
        await rendered.cleanup()
      }
    }
    const full = await render('audio-full', {})
    const half = await render('audio-half', { volume: 0.5 })
    const looped = await render('audio-loop', { loop: true })
    // 编辑器里片段不会比素材长，循环只在把放满的片段调快以后才用得上
    const loopedFast = await render('audio-loop-fast', { loop: true, playbackRate: 2 })
    const hidden = await render('audio-hidden', { hidden: true })

    expect(full.streams).toEqual(['audio', 'video'])
    expect(full.early).toBeGreaterThan(-30)
    expect(full.early - half.early).toBeGreaterThan(4)
    expect(full.early - half.early).toBeLessThan(8)
    expect(looped.late - full.late).toBeGreaterThan(30)
    expect(loopedFast.late - full.late).toBeGreaterThan(30)
    expect(hidden.streams).toEqual(['video'])
    expect(hidden.duration).toBeGreaterThan(2.9)
    expect(hidden.duration).toBeLessThan(3.15)
  }, 600_000)

  it('视频片段的声音：增益大于 0 dB 更响，淡入淡出时头尾更轻，静音后没有声音', async () => {
    const gray = `${origin}/gray.mp4`
    /** 7 秒的灰片放进 0–6 秒的片段；量开头、中间、结尾各 0.8 秒的响度，没有音轨时是 null。 */
    const render = async (id: string, overrides: Partial<VideoClip>) => {
      const rendered = await renderProject(
        id,
        project([video({ src: gray, duration: 6000, ...overrides })]),
        [gray],
      )
      try {
        if (!(await streamsOf(rendered.file)).includes('audio')) return null
        return {
          head: await meanVolume(rendered.file, 0.1, 0.8),
          middle: await meanVolume(rendered.file, 2.6, 0.8),
          tail: await meanVolume(rendered.file, 5.1, 0.8),
        }
      } finally {
        await rendered.cleanup()
      }
    }
    const plain = await render('picture-sound', {})
    const boosted = await render('picture-boost', { volume: 1.995262 })
    const faded = await render('picture-fade', { fadeIn: 2000, fadeOut: 2000 })
    const muted = await render('picture-muted', { muted: true })

    if (plain === null || boosted === null || faded === null) throw new Error('导出里没有声音')
    expect(plain.middle).toBeGreaterThan(-30)
    expect(boosted.middle - plain.middle).toBeGreaterThan(4)
    expect(boosted.middle - plain.middle).toBeLessThan(8)
    expect(Math.abs(faded.middle - plain.middle)).toBeLessThan(1.5)
    expect(plain.head - faded.head).toBeGreaterThan(6)
    expect(plain.tail - faded.tail).toBeGreaterThan(6)
    // 静音后整段没有声音，导出可能就不带音轨
    expect(muted === null ? Infinity : plain.middle - muted.middle).toBeGreaterThan(30)
  }, 900_000)

  it('速度：2 倍的视频片段放的是素材后面的画面，2 倍的音频片段提前放完', async () => {
    const [steps, tone] = [`${origin}/steps.mp4`, `${origin}/tone.m4a`]
    /** 6 秒的色块片放进 0–3 秒的视频片段，1.5 秒的音频放进 0–3 秒的音频片段，两个片段用同一个速度。 */
    const render = async (id: string, playbackRate: number) => {
      const rendered = await renderProject(
        id,
        project([
          video({ src: steps, duration: 3000, muted: true, playbackRate }),
          audio({ src: tone, duration: 3000, playbackRate }),
        ]),
        [steps, tone],
      )
      try {
        return {
          frame: await frameAt(rendered.file, 2.5),
          early: await meanVolume(rendered.file, 0.1, 0.5),
          late: await meanVolume(rendered.file, 0.95, 0.4),
        }
      } finally {
        await rendered.cleanup()
      }
    }
    const normal = await render('speed-normal', 1)
    const fast = await render('speed-double', 2)

    // 第 2.5 秒：1 倍放到素材的 2.5 秒（绿），2 倍放到素材的 5 秒（蓝）
    expect(meanDifference(normal.frame, solid(normal.frame.length, [0, 255, 0]))).toBeLessThan(20)
    expect(meanDifference(fast.frame, solid(fast.frame.length, [0, 0, 255]))).toBeLessThan(20)
    // 1.5 秒的音频：1 倍时 0.95–1.35 秒还在响，2 倍时 0.75 秒就放完了
    expect(fast.early).toBeGreaterThan(-30)
    expect(normal.late).toBeGreaterThan(-30)
    expect(normal.late - fast.late).toBeGreaterThan(30)
  }, 600_000)

  it('素材没有音轨：视频片段写成静音照常导出、画面正常；标成有声音时导出失败，说清哪里不对', async () => {
    // 色块片生成时就没有音轨
    const steps = `${origin}/steps.mp4`
    const render = (id: string, muted: boolean) =>
      renderProject(id, project([video({ src: steps, duration: 3000, muted })]), [steps])

    const rendered = await render('silent-muted', true)
    try {
      // 第 1 秒放的是素材的第 1 秒（红）
      const frame = await frameAt(rendered.file, 1)
      expect(meanDifference(frame, solid(frame.length, [255, 0, 0]))).toBeLessThan(20)
    } finally {
      await rendered.cleanup()
    }
    await expect(render('silent-sounding', false)).rejects.toMatchObject({
      code: 'media-mismatch',
      message:
        '有视频片段标记为有声音，但素材文件没有声音，无法导出；请将该视频片段设为静音后重新导出',
    })
  }, 600_000)

  it('工程里的片段全隐藏了：照样导出，是一段同样长的黑片，没有音轨', async () => {
    const clip = `${origin}/clip.mp4`
    const rendered = await renderProject(
      'all-hidden',
      project([video({ src: clip, duration: 2000, hidden: true })]),
      [clip],
    )
    try {
      expect(await streamsOf(rendered.file)).toEqual(['video'])
      const duration = await durationOf(rendered.file)
      expect(duration).toBeGreaterThan(1.9)
      expect(duration).toBeLessThan(2.15)
      const frame = await frameAt(rendered.file, 1)
      expect(meanDifference(frame, Buffer.alloc(frame.length, 0))).toBeLessThan(6)
    } finally {
      await rendered.cleanup()
    }
  }, 300_000)

  it('工程里的脚本往回环以外的地址发请求：都被拦下、记进日志，WebRTC 发不出 UDP，导出照常完成', async () => {
    const clip = `${origin}/clip.mp4`
    // WebRTC 的 UDP 不看代理：STUN 服务器放在回环地址上，收不到包说明 UDP 整个没有发
    const stun = createSocket('udp4')
    let datagrams = 0
    stun.on('message', () => (datagrams += 1))
    await new Promise<void>((resolve) => stun.bind(0, '127.0.0.1', resolve))
    const [main, ...others] = project([video({ src: clip, duration: 2000 })])
    const script = `<script>
fetch('https://outside.invalid/fetch').catch(() => {})
fetch('https://192.0.2.1/fetch').catch(() => {})
fetch('http://169.254.169.254/latest/meta-data').catch(() => {})
new WebSocket('wss://socket.outside.invalid/live')
const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${stun.address().port}' }] })
peer.createDataChannel('probe')
peer.createOffer().then((offer) => peer.setLocalDescription(offer)).catch(() => {})
</script>
</body>`
    const files = [
      { path: 'index.html', content: (main?.content ?? '').replace('</body>', script) },
    ]
    expect(files[0]?.content).toContain('socket.outside.invalid')
    try {
      const rendered = await renderProject('outside-requests', [...files, ...others], [clip])
      try {
        expect(await durationOf(rendered.file)).toBeGreaterThan(1.9)
        const frame = await frameAt(rendered.file, 0.5)
        expect(meanDifference(frame, Buffer.alloc(frame.length, 0))).toBeGreaterThan(30)
      } finally {
        await rendered.cleanup()
      }
      expect(datagrams).toBe(0)
    } finally {
      stun.close()
    }
    await expect
      .poll(blockedHosts)
      .toEqual(
        expect.arrayContaining([
          'outside.invalid',
          '192.0.2.1',
          '169.254.169.254',
          'socket.outside.invalid',
        ]),
      )
  }, 300_000)

  it('工程检查有错误：以 lint-failed 失败，不下载任何素材', async () => {
    const workDir = join(dir, 'work-lint')
    const clip = `${origin}/clip.mp4`
    // 第一个片段写的是工程里没有的相对路径；两个素材都给了能下载的地址
    const files = project([
      video({ src: 'media/absent.mp4', duration: 1000 }),
      video({ id: 'clip-2', src: clip, start: 1000, duration: 1000 }),
    ])
    const media = new Map([
      ['media/absent.mp4', `${clip}?absent`],
      [clip, clip],
    ])
    const before = requests.length
    await expect(
      workerIn(workDir).render(
        { id: 'lint-error', files, media, variables: null, vendorDir: VENDOR_DIR },
        { signal: new AbortController().signal, onProgress: () => {} },
      ),
    ).rejects.toMatchObject({
      code: 'lint-failed',
      message: expect.stringContaining('index.html：missing_local_asset') as unknown,
    })
    expect(requests.slice(before)).toEqual([])
    expect(await readdir(workDir)).toEqual([])
  }, 60_000)

  it('工程里用了没有声明的字体：以 font-missing 失败，带上字体名，不下载任何素材', async () => {
    const workDir = join(dir, 'work-font')
    const clip = `${origin}/clip.mp4`
    const files = project([video({ src: clip, duration: 1000 })]).map((file) =>
      file.path === 'index.html'
        ? {
            ...file,
            content: file.content.replace(
              '</head>',
              '<style>.note { font-family: "Comic Sans MS", Papyrus, sans-serif; }</style></head>',
            ),
          }
        : file,
    )
    const before = requests.length
    await expect(
      workerIn(workDir).render(
        {
          id: 'font-missing',
          files,
          media: new Map([[clip, clip]]),
          variables: null,
          vendorDir: VENDOR_DIR,
        },
        { signal: new AbortController().signal, onProgress: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'font-missing', message: 'Comic Sans MS、Papyrus' })
    expect(requests.slice(before)).toEqual([])
    expect(await readdir(workDir)).toEqual([])
  }, 60_000)

  it('工程检查只有警告时照常导出，警告记进日志；没有警告的工程不记', async () => {
    const [clip, tone] = [`${origin}/clip.mp4`, `${origin}/tone.m4a`]
    const render = async (id: string, files: ProjectFile[], media: string[]) => {
      const { logger, lines } = memoryLogger()
      const rendered = await renderProject(id, files, media, logger)
      try {
        return {
          duration: await durationOf(rendered.file),
          warnings: lines.filter((line) => line['event'] === '工程检查有警告'),
        }
      } finally {
        await rendered.cleanup()
      }
    }
    const clean = await render('lint-clean', project([video({ src: clip, duration: 1000 })]), [
      clip,
    ])
    // 同一行上有声音的视频片段和音频片段时间重叠：检查给 duplicate_audio_track 警告
    const warned = await render(
      'lint-warning',
      project([video({ src: clip, duration: 1000 }), audio({ src: tone, duration: 1000 })]),
      [clip, tone],
    )

    expect(clean.duration).toBeGreaterThan(0.9)
    expect(clean.warnings).toEqual([])
    expect(warned.duration).toBeGreaterThan(0.9)
    expect(warned.warnings).toEqual([
      expect.objectContaining({
        level: 'warn',
        count: 1,
        codes: ['duplicate_audio_track'],
      }),
    ])
  }, 300_000)
})
