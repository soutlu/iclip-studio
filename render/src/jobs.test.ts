import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExportFailure, ExportQueue, type ExportInput } from './jobs'
import { flush, manualWorker, memoryLogger } from './testing'

const input = (id: string): ExportInput => ({
  id,
  conversationId: `conv-${id}`,
  registryDir: '/registry/test',
  compose: () => '<html></html>',
  mediaUrls: ['https://oss.example.com/a.mp4'],
  upload: { url: 'https://upload.example.com/a.mp4', headers: {} },
})

function setup(options: { timeoutMs?: number; now?: () => number } = {}) {
  const fake = manualWorker()
  const { logger, lines } = memoryLogger()
  const queue = new ExportQueue({
    worker: fake.worker,
    logger,
    timeoutMs: options.timeoutMs ?? 60_000,
    ...(options.now ? { now: options.now } : {}),
  })
  return { queue, lines, ...fake }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ExportQueue', () => {
  it('先进先出、一次一个；排队中的报告前面还有几个', async () => {
    const { queue, renders } = setup()
    queue.submit(input('a'))
    queue.submit(input('b'))
    queue.submit(input('c'))
    await flush()
    expect(renders.map((render) => render.id)).toEqual(['a'])
    expect(queue.get('a')).toMatchObject({ status: 'rendering', queuePosition: null })
    expect(queue.get('b')).toMatchObject({ status: 'queued', queuePosition: 0 })
    expect(queue.get('c')).toMatchObject({ status: 'queued', queuePosition: 1 })
    expect(queue.stats()).toEqual({ running: 1, waiting: 2 })
  })

  it('渲染 → 上传 → 完成；进度只在渲染中变化，取 0–1，只增不减', async () => {
    const { queue, renders, uploads, cleaned, rendered } = setup()
    queue.submit(input('a'))
    await flush()
    renders[0]!.onProgress(0.4)
    renders[0]!.onProgress(0.2)
    expect(queue.get('a')).toMatchObject({ status: 'rendering', progress: 0.4 })
    renders[0]!.pending.resolve(rendered('a'))
    await flush()
    expect(queue.get('a')?.status).toBe('uploading')
    expect(uploads[0]?.file).toBe('/tmp/a.mp4')
    renders[0]!.onProgress(0.9)
    expect(queue.get('a')?.progress).toBe(0.4)
    uploads[0]!.pending.resolve()
    await queue.settled()
    expect(queue.get('a')).toEqual({
      id: 'a',
      conversationId: 'conv-a',
      status: 'done',
      progress: 0.4,
      queuePosition: null,
      error: null,
    })
    expect(cleaned).toEqual(['a'])
  })

  it('同一 id 还在时不再收', () => {
    const { queue } = setup()
    expect(queue.submit(input('a'))).toBe(true)
    expect(queue.submit(input('a'))).toBe(false)
  })

  it.each<[string, (fake: ReturnType<typeof setup>) => void, string]>([
    [
      '素材取不到',
      (fake) => fake.renders[0]!.pending.reject(new ExportFailure('media-unreachable', '取不到')),
      'media-unreachable',
    ],
    [
      '渲染器抛出其他错误',
      (fake) => fake.renders[0]!.pending.reject(new Error('boom')),
      'render-failed',
    ],
  ])('%s → failed（%s）', async (_, act, code) => {
    const fake = setup()
    fake.queue.submit(input('a'))
    await flush()
    act(fake)
    await fake.queue.settled()
    expect(fake.queue.get('a')).toMatchObject({ status: 'failed', error: { code } })
  })

  it('上传失败 → failed（upload-failed），临时文件照样删掉', async () => {
    const { queue, renders, uploads, cleaned, rendered } = setup()
    queue.submit(input('a'))
    await flush()
    renders[0]!.pending.resolve(rendered('a'))
    await flush()
    uploads[0]!.pending.reject(new ExportFailure('upload-failed', '上传返回 403'))
    await queue.settled()
    expect(queue.get('a')).toMatchObject({
      status: 'failed',
      error: { code: 'upload-failed', message: '上传返回 403' },
    })
    expect(cleaned).toEqual(['a'])
  })

  it('超时：中止渲染 → failed（timeout），然后接着处理下一个', async () => {
    vi.useFakeTimers()
    const { queue, renders } = setup({ timeoutMs: 1000 })
    queue.submit(input('a'))
    queue.submit(input('b'))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(renders[0]!.signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(queue.get('a')).toMatchObject({ status: 'failed', error: { code: 'timeout' } })
    expect(queue.get('b')?.status).toBe('rendering')
  })

  it('取消排队中的：移出队列，不会开始渲染', async () => {
    const { queue, renders } = setup()
    queue.submit(input('a'))
    queue.submit(input('b'))
    await flush()
    expect(queue.cancel('b')).toBe(true)
    expect(queue.get('b')).toMatchObject({ status: 'cancelled', queuePosition: null })
    renders[0]!.pending.reject(new Error('stop'))
    await queue.settled()
    await flush()
    expect(renders.map((render) => render.id)).toEqual(['a'])
  })

  it('取消渲染中与上传中的：中止进行中的操作，状态是 cancelled，不会再变成失败', async () => {
    const { queue, renders, uploads, rendered } = setup()
    queue.submit(input('a'))
    queue.submit(input('b'))
    await flush()
    queue.cancel('a')
    expect(renders[0]!.signal.aborted).toBe(true)
    await queue.settled()
    expect(queue.get('a')?.status).toBe('cancelled')

    await flush()
    renders[1]!.pending.resolve(rendered('b'))
    await flush()
    expect(queue.get('b')?.status).toBe('uploading')
    queue.cancel('b')
    expect(uploads[0]!.signal.aborted).toBe(true)
    await queue.settled()
    expect(queue.get('b')?.status).toBe('cancelled')
  })

  it('已是终态的取消不改状态；不存在的返回 false', async () => {
    const { queue, renders } = setup()
    queue.submit(input('a'))
    await flush()
    renders[0]!.pending.reject(new Error('boom'))
    await queue.settled()
    expect(queue.cancel('a')).toBe(true)
    expect(queue.get('a')?.status).toBe('failed')
    expect(queue.cancel('missing')).toBe(false)
  })

  it('终态后保留 1 小时再删除，删除后同一 id 可以再提交；进行中的不过期', async () => {
    let now = 0
    const { queue, renders } = setup({ now: () => now })
    queue.submit(input('a'))
    queue.submit(input('b'))
    await flush()
    renders[0]!.pending.reject(new Error('boom'))
    await queue.settled()
    now = 60 * 60 * 1000 - 1
    expect(queue.get('a')?.status).toBe('failed')
    now = 2 * 60 * 60 * 1000
    expect(queue.get('a')).toBeUndefined()
    expect(queue.get('b')?.status).toBe('rendering')
    expect(queue.submit(input('a'))).toBe(true)
  })
})
