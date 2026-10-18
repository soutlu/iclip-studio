/**
 * 用真实的 @hyperframes/producer 渲染：一份 2 秒的草稿（画面、字幕、配乐）经本机上传目标收下，
 * 核对成片的时长、画面尺寸与音轨；另把组件可填项的取值与目录默认值各渲染一遍，比较画面。
 * 需要 chrome-headless-shell、ffmpeg 与同步好的组件库；缺任何一样时整组跳过，跳过原因写在用例名里。
 */
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildComposition } from '../../web/src/features/storyboard/whole-film/composition/build'
import { ExportQueue } from './jobs'
import { createProducerWorker } from './renderer'
import { createExportServer } from './server'
import { catalog, memoryLogger, SOURCE_JOB, SUBTITLE_JOB, MUSIC_JOB } from './testing'

const run = promisify(execFile)
const REGISTRY = join(
  process.env['RENDER_REGISTRY_ROOT'] ?? join(import.meta.dirname, '../../web/public/hyperframes'),
  catalog.version,
)

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
  if (!existsSync(join(REGISTRY, catalog.runtime.hyperframes))) {
    return `组件库没有同步（${REGISTRY}；在 web/ 运行 pnpm hf:registry）`
  }
  return null
}

const reason = skipReason()

const FRAME = { width: 640, height: 360 }

/** 成片在 `at` 秒处的一帧，逐像素 RGB。 */
async function frameAt(file: string, at: number): Promise<Buffer> {
  const { stdout } = await run(
    'ffmpeg',
    [
      '-v',
      'error',
      '-ss',
      String(at),
      '-i',
      file,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: FRAME.width * FRAME.height * 3 * 2 },
  )
  return stdout
}

interface Region {
  x: number
  y: number
  width: number
  height: number
}

function eachPixel(region: Region, visit: (offset: number) => void) {
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) visit((y * FRAME.width + x) * 3)
  }
}

/** 两帧在区域内的平均逐通道差（0–255）。 */
function meanDifference(a: Buffer, b: Buffer, region: Region): number {
  let sum = 0
  eachPixel(region, (offset) => {
    for (let channel = 0; channel < 3; channel += 1) {
      sum += Math.abs((a[offset + channel] ?? 0) - (b[offset + channel] ?? 0))
    }
  })
  return sum / (region.width * region.height * 3)
}

/** 整帧里明显偏蓝的像素数。 */
function bluePixels(frame: Buffer): number {
  let count = 0
  eachPixel({ x: 0, y: 0, ...FRAME }, (offset) => {
    const [r, g, b] = [frame[offset] ?? 0, frame[offset + 1] ?? 0, frame[offset + 2] ?? 0]
    if (b > 150 && b - r > 80 && b - g > 40) count += 1
  })
  return count
}

/** 本机素材与上传目标：GET 带 Range 读 dir 下的文件，PUT 存进 dir/received.mp4。 */
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
      'sine=frequency=550:duration=4',
      join(dir, 'music.mp3'),
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
      'anullsrc=r=44100:cl=stereo',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      join(dir, 'gray.mp4'),
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
        registryDir: REGISTRY,
        workDir: join(dir, 'work'),
        gpuEncode: false,
        logger,
      }),
      logger,
      timeoutMs: 5 * 60_000,
    })
    const service = createExportServer({
      queue,
      catalog,
      allowedHosts: new Set([new URL(origin).host]),
      logger,
      health: () => ({ gpu: 'software', chrome: 'test' }),
    })
    await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve))
    const api = `http://127.0.0.1:${(service.address() as AddressInfo).port}`
    const exportId = '33333333-2222-4333-8444-555555555555'
    const body = {
      id: exportId,
      conversationId: '99999999-8888-4777-8666-555555555555',
      document: {
        canvas: { width: 640, height: 360 },
        layer0: [
          {
            id: 'a',
            type: 'video',
            start: 0,
            duration: 2000,
            playbackStart: 500,
            sourceJobId: SOURCE_JOB,
            volume: 1,
          },
        ],
        captions: { component: 'default-caption', edits: [] },
        music: { jobId: MUSIC_JOB, offset: 0, volume: 0.5 },
        overlays: [],
      },
      media: {
        videos: { [SOURCE_JOB]: { url: `${origin}/clip.mp4` } },
        // 本机 http 素材：producer 只肯取 https 公网地址，渲染服务自己先取到本地。
        music: { url: `${origin}/music.mp3` },
        subtitles: {
          [SOURCE_JOB]: {
            subtitleJobId: SUBTITLE_JOB,
            sentences: [
              {
                startMs: 600,
                endMs: 2000,
                text: '渲染测试。',
                speaker: null,
                words: [
                  { startMs: 600, endMs: 1200, text: '渲染', punctuation: '' },
                  { startMs: 1200, endMs: 2000, text: '测试', punctuation: '。' },
                ],
              },
            ],
          },
        },
      },
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
    const video = probe.streams.find((stream) => stream.codec_type === 'video')
    expect(video).toMatchObject({ width: 640, height: 360 })
    expect(probe.streams.some((stream) => stream.codec_type === 'audio')).toBe(true)
  }, 300_000)

  it('组件可填项在画面上生效：同一组件两处各显示自己的文字，强调色经 CSS 变量生效', async () => {
    const { logger } = memoryLogger()
    const worker = createProducerWorker({
      registryDir: REGISTRY,
      workDir: join(dir, 'work'),
      gpuEncode: false,
      logger,
    })
    const gray = `${origin}/gray.mp4`
    // 姓名条只改文字：它的强调色走脚本，不改就只剩文字一处不同。
    const film = (values: boolean, video: string) =>
      buildComposition({
        draft: {
          canvas: FRAME,
          layer0: [
            {
              id: 'g',
              type: 'video',
              start: 0,
              duration: 6000,
              playbackStart: 0,
              sourceJobId: SOURCE_JOB,
              volume: 1,
            },
          ],
          captions: { component: 'default-caption', edits: [] },
          music: null,
          overlays: [
            {
              id: 'h',
              component: 'headline-slam',
              start: 0,
              duration: 2000,
              playbackStart: 0,
              track: 0,
              zIndex: 1,
              variables: values ? { text: 'Ship it today', accent: 'blue' } : {},
            },
            {
              id: 'n1',
              component: 'lt-neon-border',
              start: 2000,
              duration: 2000,
              playbackStart: 0,
              track: 0,
              zIndex: 2,
              variables: values ? { name: '拾步 · 秋冬新款', role: '品牌主理人' } : {},
            },
            {
              id: 'n2',
              component: 'lt-neon-border',
              start: 4000,
              duration: 2000,
              playbackStart: 0,
              track: 0,
              zIndex: 3,
              variables: values ? { name: '第二条姓名', role: '第二个职位' } : {},
            },
          ],
        },
        media: { videos: { [SOURCE_JOB]: { url: video } }, music: null, subtitles: {} },
        catalog,
      }).html
    // 取帧：标题在 1 秒；两处姓名条在各自时段里的同一进度（开始后 1.3 秒）。
    const frames = async (values: boolean) => {
      const rendered = await worker.render(
        {
          id: values ? 'values' : 'defaults',
          mediaUrls: [gray],
          compose: (paths) => film(values, paths[gray] ?? gray),
        },
        { signal: new AbortController().signal, onProgress: () => {} },
      )
      try {
        return {
          headline: await frameAt(rendered.file, 1),
          first: await frameAt(rendered.file, 3.3),
          second: await frameAt(rendered.file, 5.3),
        }
      } finally {
        await rendered.cleanup()
      }
    }
    const withValues = await frames(true)
    const withDefaults = await frames(false)

    // 姓名条的文字区：1920×1080 的设计稿缩到 640×360 后在左下。
    const nameArea = { x: 70, y: 225, width: 260, height: 60 }
    // 默认值的两处姓名条一模一样，差别只是编码噪声；填了取值的两处与默认值、彼此都不同。
    expect(meanDifference(withDefaults.first, withDefaults.second, nameArea)).toBeLessThan(3)
    expect(meanDifference(withValues.first, withDefaults.first, nameArea)).toBeGreaterThan(6)
    expect(meanDifference(withValues.second, withDefaults.second, nameArea)).toBeGreaterThan(6)
    expect(meanDifference(withValues.first, withValues.second, nameArea)).toBeGreaterThan(6)
    // 标题的强调色选蓝色（默认绿色）。
    expect(bluePixels(withValues.headline)).toBeGreaterThan(100)
    expect(bluePixels(withDefaults.headline)).toBeLessThan(10)
  }, 600_000)

  it('两段视频中间夹一个组件段，加一个超出成片轨结尾的特效块与字幕：组件段、特效块都上画面，整片随特效块变长', async () => {
    const { logger } = memoryLogger()
    const worker = createProducerWorker({
      registryDir: REGISTRY,
      workDir: join(dir, 'work'),
      gpuEncode: false,
      logger,
    })
    const clip = `${origin}/clip.mp4`
    const gray = `${origin}/gray.mp4`
    const GRAY_JOB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    // 成片轨：测试图 0–2 秒、组件段（标志片尾）2–4 秒、灰底 4–6 秒；特效块（姓名条）4.5–7 秒，
    // 比成片轨多出 1 秒；测试图那段带一句字幕。
    const rendered = await worker.render(
      {
        id: 'model-b',
        mediaUrls: [clip, gray],
        compose: (paths) =>
          buildComposition({
            draft: modelBDraft(GRAY_JOB),
            media: {
              videos: {
                [SOURCE_JOB]: { url: paths[clip] ?? clip },
                [GRAY_JOB]: { url: paths[gray] ?? gray },
              },
              music: null,
              subtitles: {
                [SOURCE_JOB]: {
                  subtitleJobId: SUBTITLE_JOB,
                  sentences: [
                    {
                      startMs: 200,
                      endMs: 1800,
                      text: '组件段在中间。',
                      speaker: null,
                      words: [
                        { startMs: 200, endMs: 1000, text: '组件段', punctuation: '' },
                        { startMs: 1000, endMs: 1800, text: '在中间', punctuation: '。' },
                      ],
                    },
                  ],
                },
              },
            },
            catalog,
          }).html,
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
      expect(duration).toBeGreaterThan(6.9)
      expect(duration).toBeLessThan(7.15)

      const whole = { x: 0, y: 0, ...FRAME }
      const [testCard, segment, grayBefore, overlayOnGray, overlayPastEnd] = await Promise.all(
        [1, 3, 4.3, 5.8, 6.6].map((at) => frameAt(rendered.file, at)),
      )
      // 组件段有自己的画面：与前后两段视频都明显不同，也不是一片黑。
      expect(meanDifference(segment!, testCard!, whole)).toBeGreaterThan(10)
      expect(meanDifference(segment!, grayBefore!, whole)).toBeGreaterThan(3)
      expect(meanDifference(segment!, Buffer.alloc(segment!.length), whole)).toBeGreaterThan(3)
      // 姓名条叠在灰底上；过了成片轨的结尾仍在空画面（黑底）上。
      const nameArea = { x: 70, y: 225, width: 260, height: 60 }
      expect(meanDifference(overlayOnGray!, grayBefore!, nameArea)).toBeGreaterThan(6)
      expect(
        meanDifference(overlayPastEnd!, Buffer.alloc(overlayPastEnd!.length), nameArea),
      ).toBeGreaterThan(6)
    } finally {
      await rendered.cleanup()
    }
  }, 600_000)
})

/** 「两段视频夹一个组件段 + 一个特效块 + 字幕」的草稿，第二段视频出自 `grayJob`。 */
function modelBDraft(grayJob: string) {
  return {
    canvas: FRAME,
    layer0: [
      {
        id: 'a',
        type: 'video' as const,
        start: 0,
        duration: 2000,
        playbackStart: 0,
        sourceJobId: SOURCE_JOB,
        volume: 1,
      },
      {
        id: 'c',
        type: 'component' as const,
        start: 2000,
        duration: 2000,
        playbackStart: 0,
        component: 'logo-outro',
        variables: {},
      },
      {
        id: 'b',
        type: 'video' as const,
        start: 4000,
        duration: 2000,
        playbackStart: 0,
        sourceJobId: grayJob,
        volume: 1,
      },
    ],
    captions: { component: 'default-caption', edits: [] },
    music: null,
    overlays: [
      {
        id: 'o',
        component: 'lt-neon-border',
        start: 4500,
        duration: 2500,
        playbackStart: 0,
        track: 0,
        zIndex: 1,
        variables: { name: '拾步 · 秋冬新款', role: '品牌主理人' },
      },
    ],
  }
}
