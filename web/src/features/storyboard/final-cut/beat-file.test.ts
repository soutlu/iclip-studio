import { beatFilePathForSrc } from '@hyperframes/core/beats'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { audio } from '@/testing/final-cut'
import { ApiError } from '@/shared/api/client'
import {
  BEAT_ANALYSIS_VERSION,
  beatFileContent,
  parseBeatFile,
  projectBeats,
  type BeatFileStore,
} from './beat-file'
import { clipBeats, type BeatGrid } from './music-beats'

const SRC = 'https://cdn.test/iclip/agent/generated-music/3f0c.mp3'

// 算出来的节拍带着毫秒以下的零头
const grid: BeatGrid = {
  beats: [0.1234, 0.6234, 1.1234, 1.6234],
  downbeats: [0.1234, 1.6234],
  seconds: 2.00049,
}

describe('节拍文件的写法', () => {
  it('写出来再读回去：每一拍、强拍和总长取到毫秒，强拍照样对得上每一拍', () => {
    const read = parseBeatFile(beatFileContent(SRC, grid))
    expect(read).toEqual({
      beats: [0.123, 0.623, 1.123, 1.623],
      downbeats: [0.123, 1.623],
      seconds: 2,
    })
    if (read === null) throw new Error('读不出来')
    const strong = clipBeats(audio({ duration: 2_000 }), read).filter((beat) => beat.strong)
    expect(strong.map((beat) => beat.ms)).toEqual([123, 1_623])
  })

  it('是引擎的节拍文件格式，audio 写去掉查询参数的地址', () => {
    const data = JSON.parse(beatFileContent(`${SRC}?Expires=1&Signature=x#t`, grid)) as {
      version: number
      audio: string
      beats: { time: number; strength: number }[]
    }
    expect(data.version).toBe(1)
    expect(data.audio).toBe(SRC)
    expect(data.beats[0]).toEqual({ time: 0.123, strength: 0.5 })
  })

  it('算法版本不是现在的、没有强拍和总长（引擎自己写的）时当作没有', () => {
    const stored = JSON.parse(beatFileContent(SRC, grid)) as Record<string, unknown>
    const variant = (changes: Record<string, unknown>) =>
      parseBeatFile(JSON.stringify({ ...stored, ...changes }))
    expect(variant({ analysis: BEAT_ANALYSIS_VERSION + 1 })).toBeNull()
    expect(variant({ version: 2 })).toBeNull()
    const engineOnly = {
      version: stored['version'],
      audio: stored['audio'],
      beats: stored['beats'],
    }
    expect(parseBeatFile(JSON.stringify(engineOnly))).toBeNull()
  })

  it('写法不对、一拍都没有时当作没有', () => {
    expect(parseBeatFile('{"version":1,')).toBeNull()
    expect(parseBeatFile('[]')).toBeNull()
    expect(parseBeatFile(beatFileContent(SRC, { ...grid, beats: [], downbeats: [] }))).toBeNull()
  })
})

describe('节拍文件的名字', () => {
  it('不随地址里的查询参数变', () => {
    const path = beatFilePathForSrc(SRC)
    expect(path).toBe('beats/iclip/agent/generated-music/3f0c.mp3.json')
    expect(beatFilePathForSrc(`${SRC}?Expires=1700000000&Signature=abc`)).toBe(path)
    expect(beatFilePathForSrc(`${SRC}?Expires=1800000000&Signature=def#t=1`)).toBe(path)
  })
})

describe('读或算一首配乐的节拍', () => {
  const PATH = 'beats/iclip/agent/generated-music/3f0c.mp3.json'
  const storeWith = (files: Map<string, { content: string; version: number }>, writable = true) => {
    const store = {
      read: vi.fn((path: string) => Promise.resolve(files.get(path) ?? null)),
      create: vi.fn((path: string, content: string) => {
        if (files.has(path)) return Promise.reject(new ApiError(409, '已经有这个文件'))
        files.set(path, { content, version: 1 })
        return Promise.resolve(1)
      }),
      write: vi.fn((path: string, content: string, version: number) => {
        files.set(path, { content, version: version + 1 })
        return Promise.resolve(version + 1)
      }),
      writable: () => writable,
    } satisfies BeatFileStore
    return store
  }

  afterEach(() => vi.restoreAllMocks())

  it('工程里有能用的节拍文件：直接用，不算', async () => {
    const files = new Map([[PATH, { content: beatFileContent(SRC, grid), version: 3 }]])
    const analyse = vi.fn(() => Promise.resolve(grid))
    const store = storeWith(files)
    expect(await projectBeats(SRC, analyse, store)).toMatchObject({
      beats: [0.123, 0.623, 1.123, 1.623],
    })
    expect(analyse).not.toHaveBeenCalled()
    expect(store.create).not.toHaveBeenCalled()
    expect(store.write).not.toHaveBeenCalled()
  })

  it('没有文件：算出来以后新建节拍文件', async () => {
    const files = new Map<string, { content: string; version: number }>()
    const result = await projectBeats(SRC, () => Promise.resolve(grid), storeWith(files))
    expect(parseBeatFile(files.get(PATH)?.content ?? '')).toEqual(result)
  })

  it('文件读不出来或版本不对：重算，按读到的版本覆盖', async () => {
    const files = new Map([[PATH, { content: '{"version":1,"beats":[{"time":', version: 4 }]])
    const store = storeWith(files)
    await projectBeats(SRC, () => Promise.resolve(grid), store)
    expect(store.write).toHaveBeenCalledWith(PATH, beatFileContent(SRC, grid), 4)
    expect(files.get(PATH)?.version).toBe(5)
  })

  it('没有稳定的节拍时不写文件；工程不能写时也不写', async () => {
    const files = new Map<string, { content: string; version: number }>()
    expect(await projectBeats(SRC, () => Promise.resolve(null), storeWith(files))).toBeNull()
    expect(
      await projectBeats(SRC, () => Promise.resolve(grid), storeWith(files, false)),
    ).not.toBeNull()
    expect(files.size).toBe(0)
  })

  it('写失败只记到控制台，照样用算出来的；别处先建好了（409）不算失败', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const failing = {
      ...storeWith(new Map()),
      create: () => Promise.reject(new ApiError(500, '保存失败')),
    }
    expect(await projectBeats(SRC, () => Promise.resolve(grid), failing)).not.toBeNull()
    expect(logged).toHaveBeenCalledTimes(1)

    const raced = {
      ...storeWith(new Map()),
      create: () => Promise.reject(new ApiError(409, '已有')),
    }
    expect(await projectBeats(SRC, () => Promise.resolve(grid), raced)).not.toBeNull()
    expect(logged).toHaveBeenCalledTimes(1)
  })
})
