/**
 * 用真实的 @hyperframes/producer 渲染一份 2 秒的草稿（画面、字幕、配乐），经本机上传目标收下，
 * 核对成片的时长、画面尺寸与音轨。需要 chrome-headless-shell、ffmpeg 与同步好的组件库；
 * 缺任何一样时整组跳过，跳过原因写在用例名里。
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
        transitions: [],
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
})
