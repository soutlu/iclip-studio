import { beatFilePathForSrc, parseBeats, serializeBeats } from '@hyperframes/core/beats'
import { z } from 'zod'
import { ApiError } from '@/shared/api/client'
import type { StoredFile } from './final-cut.api'
import type { BeatGrid } from './music-beats'

/** 节拍文件在工程内的目录（每首音频对应一个文件，路径规则见引擎 `beatFilePathForSrc`）。 */
export const BEATS_DIR = 'beats'

/** 节拍分析算法版本号：算法变更时递增，既有旧版文件无法通过校验时会重新分析并覆盖。 */
export const BEAT_ANALYSIS_VERSION = 1

// 引擎节拍格式仅含各拍时刻；强拍、总时长与算法版本为扩展字段，引擎读取时忽略
const zExtras = z.object({
  analysis: z.literal(BEAT_ANALYSIS_VERSION),
  downbeats: z.array(z.number()),
  seconds: z.number().positive(),
})

// 与引擎节拍文件保持一致，统一四舍五入至毫秒，确保强拍时间戳与各拍精确对齐
const toMs = (seconds: number) => Math.round(seconds * 1000) / 1000

/** 统一精度至毫秒的节拍网格，保证实时分析结果与落盘反序列化结果一致。 */
const rounded = (grid: BeatGrid): BeatGrid => ({
  beats: grid.beats.map(toMs),
  downbeats: grid.downbeats.map(toMs),
  seconds: toMs(grid.seconds),
})

/**
 * 序列化音频 `src` 的节拍文件：沿用引擎格式（各拍时刻，未测响度故强度统一记为 0.5），附加强拍、总时长与算法版本。
 * `audio` 字段去除查询参数与哈希片段。
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

/** 解析节拍文件；格式无效、算法版本不匹配或无任何节拍时返回 `null`（触发重算）。 */
export const parseBeatFile = (content: string): BeatGrid | null => {
  const parsed = parseBeats(content)
  if (parsed === null || parsed.times.length === 0) return null
  const extras = zExtras.safeParse(JSON.parse(content))
  return extras.success
    ? { beats: parsed.times, downbeats: extras.data.downbeats, seconds: extras.data.seconds }
    : null
}

/** 工程节拍文件读写接口（路径相对工程根目录）。 */
export type BeatFileStore = {
  /** 读取指定路径文件，不存在时返回 `null`。 */
  read: (path: string) => Promise<StoredFile | null>
  /** 新建文件；文件已存在时抛出 409。 */
  create: (path: string, content: string) => Promise<unknown>
  /** 按当前读取版本覆盖既有文件。 */
  write: (path: string, content: string, version: number) => Promise<unknown>
}

/**
 * 获取音频 `src` 的节拍网格：工程内存在有效节拍文件时直接复用，跳过音频解码；
 * 否则调用 `analyse` 计算并落盘（新建或覆盖失效文件）；无稳定节拍时返回 `null` 且不写文件。
 * 读写失败仅记录至控制台，不阻断返回分析结果；并发新建冲突（409）视为正常。
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
