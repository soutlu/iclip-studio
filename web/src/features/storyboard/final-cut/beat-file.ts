import { beatFilePathForSrc, parseBeats, serializeBeats } from '@hyperframes/core/beats'
import { z } from 'zod'
import { ApiError } from '@/shared/api/client'
import type { StoredFile } from './final-cut.api'
import type { BeatGrid } from './music-beats'

/** 节拍文件在工程里的目录：一首音频一个文件，路径见引擎的 `beatFilePathForSrc`。 */
export const BEATS_DIR = 'beats'

/** 节拍分析的算法版本：算法改了就加 1，存着的老文件认不出来，重算后覆盖。 */
export const BEAT_ANALYSIS_VERSION = 1

// 引擎的节拍文件只有每一拍；强拍、总长和算法版本是加在后面的字段，引擎读的时候不管它们
const zExtras = z.object({
  analysis: z.literal(BEAT_ANALYSIS_VERSION),
  downbeats: z.array(z.number()),
  seconds: z.number().positive(),
})

// 和引擎写节拍文件一样取到毫秒：强拍按时间和每一拍对上，两边要取得一样
const toMs = (seconds: number) => Math.round(seconds * 1000) / 1000

/** 取到毫秒的节拍：算出来的和从文件里读回来的一样。 */
const rounded = (grid: BeatGrid): BeatGrid => ({
  beats: grid.beats.map(toMs),
  downbeats: grid.downbeats.map(toMs),
  seconds: toMs(grid.seconds),
})

/**
 * 音频 `src` 的节拍写成节拍文件：引擎的格式（每一拍的时间，没有量响度，强度都写 0.5），加上强拍、总长和算法版本。
 * `audio` 写去掉查询参数的地址。
 */
export const beatFileContent = (src: string, grid: BeatGrid): string => {
  const { beats, downbeats, seconds } = rounded(grid)
  const audio = src.split(/[?#]/, 1)[0] ?? src
  const base = JSON.parse(serializeBeats([...beats], [], audio)) as Record<string, unknown>
  const extras: z.infer<typeof zExtras> = {
    analysis: BEAT_ANALYSIS_VERSION,
    downbeats: [...downbeats],
    seconds,
  }
  return `${JSON.stringify({ ...base, ...extras }, null, 2)}\n`
}

/** 读节拍文件；写法不对、算法版本不是现在的、一拍都没有时是 null（当作没有，重算）。 */
export const parseBeatFile = (content: string): BeatGrid | null => {
  const parsed = parseBeats(content)
  if (parsed === null || parsed.times.length === 0) return null
  const extras = zExtras.safeParse(JSON.parse(content))
  return extras.success
    ? { beats: parsed.times, downbeats: extras.data.downbeats, seconds: extras.data.seconds }
    : null
}

/** 读写工程里的节拍文件（路径相对工程根）。 */
export type BeatFileStore = {
  /** 读一个文件，不存在时是 null。 */
  read: (path: string) => Promise<StoredFile | null>
  /** 新建一个文件；已经有了时抛 409。 */
  create: (path: string, content: string) => Promise<unknown>
  /** 按读到的版本覆盖一个文件。 */
  write: (path: string, content: string, version: number) => Promise<unknown>
}

/**
 * 音频 `src` 的节拍：工程里有能用的节拍文件就直接用它，不读声音；没有（或读不出、版本不对）时用 `analyse` 算，
 * 算出来了就写成节拍文件（新建，或覆盖读不出的那一份）。没有稳定的节拍时是 null，不写文件。
 * 读文件、写文件失败只记到控制台，照样用算出来的；别处先建好了这个文件（409）不算失败。
 */
export async function projectBeats(
  src: string,
  analyse: (src: string) => Promise<BeatGrid | null>,
  store: BeatFileStore,
): Promise<BeatGrid | null> {
  const path = beatFilePathForSrc(src)
  let stored: StoredFile | null = null
  if (path !== null) {
    try {
      stored = await store.read(path)
    } catch (error) {
      console.error('final-cut 节拍文件读取失败', error)
    }
    const saved = stored === null ? null : parseBeatFile(stored.content)
    if (saved !== null) return saved
  }
  const found = await analyse(src)
  if (found === null) return null
  const grid = rounded(found)
  if (path === null) return grid
  const content = beatFileContent(src, grid)
  try {
    if (stored === null) await store.create(path, content)
    else await store.write(path, content, stored.version)
  } catch (error) {
    if (!(stored === null && error instanceof ApiError && error.status === 409))
      console.error('final-cut 节拍文件保存失败', error)
  }
  return grid
}
