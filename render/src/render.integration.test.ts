import { execFile, spawnSync } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { resolveHeadlessShellPath } from '@hyperframes/engine'
import { openComposition } from '@hyperframes/sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  writeFilm,
  type AudioClip,
  type VideoClip,
} from '../../web/src/features/storyboard/whole-film/composition/film'
import { checkFilm, localizedFilm } from './film'
import { ExportQueue } from './jobs'
import { loadLibrary, type ComponentLibrary } from './library'
import { createProducerWorker } from './renderer'
import { createExportServer } from './server'
import { audio, host, memoryLogger, video } from './testing'

const run = promisify(execFile)
const REGISTRY_ROOT =
  process.env['RENDER_REGISTRY_ROOT'] ?? join(import.meta.dirname, '../../web/public/hyperframes')
const library: ComponentLibrary | null = existsSync(join(REGISTRY_ROOT, 'catalog.json'))
  ? await loadLibrary(REGISTRY_ROOT)
  : null

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
  if (library === null || !existsSync(join(library.dir, library.catalog.runtime.hyperframes))) {
    return `组件库没有组装（${REGISTRY_ROOT}；在 web/ 运行 pnpm hf:registry）`
  }
  return null
}

const reason = skipReason()

const FRAME = { width: 640, height: 360 }
const GRAY_JOB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

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

async function startServer(dir: string): Promise<{ server: Server; origin: string }> {
  const server = createServer(async (req, res) => {
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
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

describe.skipIf(reason !== null)(`真实渲染${reason ? `（跳过：${reason}）` : ''}`, () => {
  let dir: string
  let server: Server
  let origin: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'render-integration-'))
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
    ;({ server, origin } = await startServer(dir))
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('渲染 2 秒的成片并上传：时长 2 秒、画布尺寸、有音轨', async () => {
    const { logger } = memoryLogger()
    const queue = new ExportQueue({
      worker: createProducerWorker({
        workDir: join(dir, 'work'),
        gpuEncode: false,
        logger,
      }),
      logger,
      timeoutMs: 5 * 60_000,
    })
    const service = createExportServer({
      queue,
      library: () => loadLibrary(REGISTRY_ROOT),
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
      film: writeFilm(
        { canvas: FRAME, clips: [video({ src: clip, duration: 2000, mediaStart: 500 })] },
        (library as ComponentLibrary).catalog,
      ),
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

  it('两个视频片段首尾相接：各在自己的时间段里上画面，音量按片段上写的生效', async () => {
    const { logger } = memoryLogger()
    const worker = createProducerWorker({ workDir: join(dir, 'work'), gpuEncode: false, logger })
    const [clip, gray] = [`${origin}/clip.mp4`, `${origin}/gray.mp4`]
    const film = (paths: Readonly<Record<string, string>>, grayVolume: number) =>
      writeFilm(
        {
          canvas: FRAME,
          clips: [
            video({ src: paths[clip] ?? clip, duration: 2000 }),
            video({
              id: 'clip-2',
              jobId: GRAY_JOB,
              src: paths[gray] ?? gray,
              start: 2000,
              duration: 3000,
              mediaStart: 1000,
              volume: grayVolume,
            }),
          ],
        },
        (library as ComponentLibrary).catalog,
      )
    const render = async (id: string, grayVolume: number) => {
      const rendered = await worker.render(
        {
          id,
          registryDir: (library as ComponentLibrary).dir,
          mediaUrls: [clip, gray],
          compose: (paths) => film(paths, grayVolume),
        },
        { signal: new AbortController().signal, onProgress: () => {} },
      )
      try {
        const { stdout } = await run('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'json',
          rendered.file,
        ])
        return {
          duration: Number(
            (JSON.parse(stdout) as { format: { duration: string } }).format.duration,
          ),
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
    const { logger } = memoryLogger()
    const worker = createProducerWorker({ workDir: join(dir, 'work'), gpuEncode: false, logger })
    const [clip, gray] = [`${origin}/clip.mp4`, `${origin}/gray.mp4`]
    /** 彩色那条写在前面、放第一行，灰色那条写在后面、放第二行，两条都占 0–2 秒。 */
    const frameWith = async (id: string, clipZ: number, grayZ: number) => {
      const rendered = await worker.render(
        {
          id,
          registryDir: (library as ComponentLibrary).dir,
          mediaUrls: [clip, gray],
          compose: (paths) =>
            writeFilm(
              {
                canvas: FRAME,
                clips: [
                  video({ src: paths[clip] ?? clip, duration: 2000, z: clipZ }),
                  video({
                    id: 'clip-2',
                    jobId: GRAY_JOB,
                    src: paths[gray] ?? gray,
                    duration: 2000,
                    track: 1,
                    z: grayZ,
                  }),
                ],
              },
              (library as ComponentLibrary).catalog,
            ),
        },
        { signal: new AbortController().signal, onProgress: () => {} },
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
    const { logger } = memoryLogger()
    const worker = createProducerWorker({ workDir: join(dir, 'work'), gpuEncode: false, logger })
    const [clip, gray] = [`${origin}/clip.mp4`, `${origin}/gray.mp4`]
    /** 彩色那条占 0–2 秒，灰色那条接在后面占 2–4 秒。 */
    const render = async (id: string, clipHidden: boolean) => {
      const rendered = await worker.render(
        {
          id,
          registryDir: (library as ComponentLibrary).dir,
          mediaUrls: [clip, gray],
          compose: (paths) =>
            writeFilm(
              {
                canvas: FRAME,
                clips: [
                  video({ src: paths[clip] ?? clip, duration: 2000, hidden: clipHidden }),
                  video({
                    id: 'clip-2',
                    jobId: GRAY_JOB,
                    src: paths[gray] ?? gray,
                    start: 2000,
                    duration: 2000,
                  }),
                ],
              },
              (library as ComponentLibrary).catalog,
            ),
        },
        { signal: new AbortController().signal, onProgress: () => {} },
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

  it('组件或块的片段：组件按可填项画出来，组件文字用到的中文字形在 <head> 里声明了', async () => {
    const { logger } = memoryLogger()
    const worker = createProducerWorker({ workDir: join(dir, 'work'), gpuEncode: false, logger })
    const catalog = (library as ComponentLibrary).catalog
    // 测试组件按 1920×1080 设计：左下角 x 120–1020、y 720–940 一块色底，色底里左边一行字
    const canvas = { width: 1920, height: 1080 }
    const title = '成片标题'
    let composed = ''
    const render = async (id: string, hidden: boolean) => {
      const rendered = await worker.render(
        {
          id,
          registryDir: (library as ComponentLibrary).dir,
          mediaUrls: [],
          compose: () => {
            const values = { text: title, accent: '#ff0000' }
            composed = writeFilm({ canvas, clips: [host({ values, hidden })] }, catalog)
            return composed
          },
        },
        { signal: new AbortController().signal, onProgress: () => {} },
      )
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
    for (const char of title) expect(declaresGlyph(composed, catalog.cjk.family, char)).toBe(true)
    const hidden = await render('component-hidden', true)

    const red = solid(shown.panel.length, [255, 0, 0])
    expect(meanDifference(shown.panel, red)).toBeLessThan(10)
    expect(meanDifference(shown.words, solid(shown.words.length, [255, 0, 0]))).toBeGreaterThan(20)
    expect(meanDifference(shown.outside, Buffer.alloc(shown.outside.length, 0))).toBeLessThan(6)
    expect(meanDifference(hidden.panel, Buffer.alloc(hidden.panel.length, 0))).toBeLessThan(6)
  }, 600_000)

  it('固定尺寸的组件放进竖版画面：按原比例缩小、居中，不铺满也不出画', async () => {
    const { logger } = memoryLogger()
    const worker = createProducerWorker({ workDir: join(dir, 'work'), gpuEncode: false, logger })
    const catalog = (library as ComponentLibrary).catalog
    // 测试组件按 1920×1080 设计，色底在 x 120–1020、y 720–940。放进 720×1280：缩成 0.375 倍、
    // 上下居中（顶边 437.5），色底落在 x 45–382.5、y 707.5–790
    const canvas = { width: 720, height: 1280 }
    const rendered = await worker.render(
      {
        id: 'component-fit',
        registryDir: (library as ComponentLibrary).dir,
        mediaUrls: [],
        compose: () =>
          writeFilm(
            { canvas, clips: [host({ values: { text: '', accent: '#ff0000' } })] },
            catalog,
          ),
      },
      { signal: new AbortController().signal, onProgress: () => {} },
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
    const { logger } = memoryLogger()
    const worker = createProducerWorker({ workDir: join(dir, 'work'), gpuEncode: false, logger })
    const catalog = (library as ComponentLibrary).catalog
    const canvas = { width: 1920, height: 1080 }
    const words = async (id: string, values: Record<string, string>) => {
      const rendered = await worker.render(
        {
          id,
          registryDir: (library as ComponentLibrary).dir,
          mediaUrls: [],
          compose: () =>
            writeFilm(
              {
                canvas,
                clips: [host({ values: { text: 'Sample', accent: '#ff0000', ...values } })],
              },
              catalog,
            ),
        },
        { signal: new AbortController().signal, onProgress: () => {} },
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
    const { logger } = memoryLogger()
    const worker = createProducerWorker({ workDir: join(dir, 'work'), gpuEncode: false, logger })
    const catalog = (library as ComponentLibrary).catalog
    const canvas = { width: 1920, height: 1080 }
    const stored = writeFilm({ canvas, clips: [host({ values: { accent: '#ff0000' } })] }, catalog)
    // 和编辑器右侧栏改值一样：用 SDK 把片段上的取值整串换掉，存出来的文件再过渲染前的检查
    const session = await openComposition(stored)
    session.setAttribute(
      'title-1',
      'data-variable-values',
      JSON.stringify({ accent: '#ff0000', text: '新的标题' }),
    )
    const edited = (await checkFilm(session.serialize(), catalog)).html
    const words = async (id: string, html: string) => {
      const rendered = await worker.render(
        {
          id,
          registryDir: (library as ComponentLibrary).dir,
          mediaUrls: [],
          compose: () => html,
        },
        { signal: new AbortController().signal, onProgress: () => {} },
      )
      try {
        return await frameAt(rendered.file, 1, { x: 170, y: 760, width: 380, height: 140 })
      } finally {
        await rendered.cleanup()
      }
    }
    const plain = await words('component-text-default', stored)
    const changed = await words('component-text-edited', edited)
    expect(edited).toContain('&quot;text&quot;:&quot;新的标题&quot;')
    expect(meanDifference(plain, changed)).toBeGreaterThan(8)
  }, 600_000)

  it('音频片段：有声音，音量调低后更轻，循环时音频比片段短也一直有声，隐藏后没有声音', async () => {
    const { logger } = memoryLogger()
    const worker = createProducerWorker({ workDir: join(dir, 'work'), gpuEncode: false, logger })
    const tone = `${origin}/tone.m4a`
    /** 1.5 秒的音频放进 0–3 秒的片段；和导出时一样，交给渲染的是 `localizedFilm` 那一份。 */
    const render = async (id: string, overrides: Partial<AudioClip>) => {
      const rendered = await worker.render(
        {
          id,
          registryDir: (library as ComponentLibrary).dir,
          mediaUrls: [tone],
          compose: (paths) =>
            localizedFilm(
              { canvas: FRAME, clips: [audio({ src: tone, duration: 3000, ...overrides })] },
              paths,
              (library as ComponentLibrary).catalog,
            ),
        },
        { signal: new AbortController().signal, onProgress: () => {} },
      )
      try {
        const { stdout } = await run('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'json',
          rendered.file,
        ])
        const duration = Number(
          (JSON.parse(stdout) as { format: { duration: string } }).format.duration,
        )
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
    const { logger } = memoryLogger()
    const worker = createProducerWorker({ workDir: join(dir, 'work'), gpuEncode: false, logger })
    const gray = `${origin}/gray.mp4`
    /** 7 秒的灰片放进 0–6 秒的片段；量开头、中间、结尾各 0.8 秒的响度，没有音轨时是 null。 */
    const render = async (id: string, overrides: Partial<VideoClip>) => {
      const rendered = await worker.render(
        {
          id,
          registryDir: (library as ComponentLibrary).dir,
          mediaUrls: [gray],
          compose: (paths) =>
            localizedFilm(
              {
                canvas: FRAME,
                clips: [video({ jobId: GRAY_JOB, src: gray, duration: 6000, ...overrides })],
              },
              paths,
              (library as ComponentLibrary).catalog,
            ),
        },
        { signal: new AbortController().signal, onProgress: () => {} },
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
    const { logger } = memoryLogger()
    const worker = createProducerWorker({ workDir: join(dir, 'work'), gpuEncode: false, logger })
    const [steps, tone] = [`${origin}/steps.mp4`, `${origin}/tone.m4a`]
    /** 6 秒的色块片放进 0–3 秒的视频片段，1.5 秒的音频放进 0–3 秒的音频片段，两个片段用同一个速度。 */
    const render = async (id: string, playbackRate: number) => {
      const rendered = await worker.render(
        {
          id,
          registryDir: (library as ComponentLibrary).dir,
          mediaUrls: [steps, tone],
          compose: (paths) =>
            localizedFilm(
              {
                canvas: FRAME,
                clips: [
                  video({ src: steps, duration: 3000, muted: true, playbackRate }),
                  audio({ src: tone, duration: 3000, playbackRate }),
                ],
              },
              paths,
              (library as ComponentLibrary).catalog,
            ),
        },
        { signal: new AbortController().signal, onProgress: () => {} },
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
    const { logger } = memoryLogger()
    const worker = createProducerWorker({ workDir: join(dir, 'work'), gpuEncode: false, logger })
    // 色块片生成时就没有音轨
    const steps = `${origin}/steps.mp4`
    const render = (id: string, muted: boolean) =>
      worker.render(
        {
          id,
          registryDir: (library as ComponentLibrary).dir,
          mediaUrls: [steps],
          compose: (paths) =>
            localizedFilm(
              { canvas: FRAME, clips: [video({ src: steps, duration: 3000, muted })] },
              paths,
              (library as ComponentLibrary).catalog,
            ),
        },
        { signal: new AbortController().signal, onProgress: () => {} },
      )

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

  it('成片里的片段全隐藏了：照样导出，是一段同样长的黑片，没有音轨', async () => {
    const { logger } = memoryLogger()
    const worker = createProducerWorker({ workDir: join(dir, 'work'), gpuEncode: false, logger })
    const clip = `${origin}/clip.mp4`
    const rendered = await worker.render(
      {
        id: 'all-hidden',
        registryDir: (library as ComponentLibrary).dir,
        mediaUrls: [clip],
        compose: (paths) =>
          writeFilm(
            {
              canvas: FRAME,
              clips: [video({ src: paths[clip] ?? clip, duration: 2000, hidden: true })],
            },
            (library as ComponentLibrary).catalog,
          ),
      },
      { signal: new AbortController().signal, onProgress: () => {} },
    )
    try {
      const { stdout } = await run('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration:stream=codec_type',
        '-of',
        'json',
        rendered.file,
      ])
      const probe = JSON.parse(stdout) as {
        format: { duration: string }
        streams: { codec_type: string }[]
      }
      expect(probe.streams.map((stream) => stream.codec_type).toSorted()).toEqual(['video'])
      expect(Number(probe.format.duration)).toBeGreaterThan(1.9)
      expect(Number(probe.format.duration)).toBeLessThan(2.15)
      const frame = await frameAt(rendered.file, 1)
      expect(meanDifference(frame, Buffer.alloc(frame.length, 0))).toBeLessThan(6)
    } finally {
      await rendered.cleanup()
    }
  }, 300_000)
})
