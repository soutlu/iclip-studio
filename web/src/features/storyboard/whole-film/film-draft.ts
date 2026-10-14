/** 整片草稿：成片轨上首尾相接的一串段，每段取自一条成片（素材）的一截；另记改过的字幕文字与手动加的字幕。
 * 段之间没有空隙，整片时间就是各段时长依次相加。纯函数，不持有状态；撤销栈与存放见 use-film-draft。 */

import { z } from 'zod'

/** 整片最长多少秒（ADR-0003：连同片头片尾最长 120 秒；现在还没有片头片尾）。 */
export const MAX_FILM_SECONDS = 120

/** 素材上挑段、成片轨上裁剪，一段至少多长：再短只剩几帧，看不清也剪不动。 */
export const MIN_SEGMENT_SECONDS = 0.2

/** 手动加的一条字幕多长，秒。 */
export const MANUAL_SUBTITLE_SECONDS = 2

/** 秒取整到毫秒：草稿里的时刻一律是毫秒精度，同一时刻处处相等。 */
export const roundToMs = (seconds: number): number => Math.round(seconds * 1000) / 1000

/** 素材上的一截：出自哪条成片，取它自己时间里的 `[start, end)`，秒。 */
export type Pick = { sourceJobId: string; start: number; end: number }

/** 成片轨上的一段。同一截素材可以放进来几次，所以身份是另发的 id，不由内容定。 */
export type FilmSegment = Pick & {
  id: string
  /** 挑进来时的那一截（拆分后各自以拆点为界）：裁剪只能在里面收缩、再放回。 */
  origin: { start: number; end: number }
}

/** 手动加的字幕：钉在一段素材的某一刻上，跟着这段画面走；不能拖，只能改字和删。 */
export type ManualSubtitle = {
  id: string
  segmentId: string
  /** 在这段素材自己时间里从哪一刻起，秒。 */
  at: number
  text: string
}

/** 撤销栈里的一步。 */
export type FilmState = {
  segments: readonly FilmSegment[]
  /** 改过的识别字幕文字，键见 {@link sentenceKey}。 */
  texts: Readonly<Record<string, string>>
  manual: readonly ManualSubtitle[]
}

export const EMPTY_FILM: FilmState = { segments: [], texts: {}, manual: [] }

/** 识别出的一句字幕的身份：哪条字幕记录的第几句（从 0 起）。同一句在几段里出现时共用一份改字。 */
export const sentenceKey = (subtitleJobId: string, index: number): string =>
  `${subtitleJobId}#${index}`

export const segmentDuration = (segment: Pick): number => roundToMs(segment.end - segment.start)

/** 排在整片时间上的一段：`at` 是它的起点。 */
export type PlacedSegment = { segment: FilmSegment; at: number; duration: number }

export const layoutFilm = (segments: readonly FilmSegment[]): PlacedSegment[] => {
  let at = 0
  return segments.map((segment) => {
    const duration = segmentDuration(segment)
    const placed = { segment, at: roundToMs(at), duration }
    at += duration
    return placed
  })
}

export const filmDuration = (segments: readonly FilmSegment[]): number =>
  roundToMs(segments.reduce((sum, segment) => sum + segmentDuration(segment), 0))

/** 整片时刻 `clock` 落在哪一段里（右开）；不在任何一段里（空轨、末尾）时没有。 */
export const segmentAt = (
  segments: readonly FilmSegment[],
  clock: number,
): PlacedSegment | undefined =>
  layoutFilm(segments).find((placed) => clock >= placed.at && clock < placed.at + placed.duration)

// ---------- 插入 ----------

/** 在整片时刻 `clock` 附近插入时插在第几段之前：落在哪段的前一半就插在它前面，后一半就插在它后面。 */
export const insertIndexAt = (segments: readonly FilmSegment[], clock: number): number => {
  const index = layoutFilm(segments).findIndex((placed) => placed.at + placed.duration / 2 > clock)
  return index < 0 ? segments.length : index
}

/** 插在第 `index` 段之前时，插入点在整片的哪一刻。 */
export const insertClockOf = (segments: readonly FilmSegment[], index: number): number =>
  layoutFilm(segments)[index]?.at ?? filmDuration(segments)

/** 再放进 `duration` 秒会不会超过整片上限。 */
export const fitsInFilm = (segments: readonly FilmSegment[], duration: number): boolean =>
  filmDuration(segments) + roundToMs(duration) <= MAX_FILM_SECONDS + 1e-9

/** 把素材上的一截插在第 `index` 段之前，后面的段顺延；放不下（超过整片上限）或太短时不插，返回 `undefined`。 */
export const insertSegment = (
  state: FilmState,
  pick: Pick,
  index: number,
  id: string,
): FilmState | undefined => {
  const start = roundToMs(pick.start)
  const end = roundToMs(pick.end)
  if (end - start < MIN_SEGMENT_SECONDS - 1e-9 || !fitsInFilm(state.segments, end - start))
    return undefined
  const segment: FilmSegment = {
    id,
    sourceJobId: pick.sourceJobId,
    start,
    end,
    origin: { start, end },
  }
  const at = Math.max(0, Math.min(state.segments.length, index))
  return { ...state, segments: state.segments.toSpliced(at, 0, segment) }
}

// ---------- 成片轨上的剪辑 ----------

/** 把一段挪到第 `before` 段之前（`before` 是挪之前的位置，等于段数就是挪到最后）；挪回原处等于没挪，返回 `undefined`。 */
export const moveSegment = (
  state: FilmState,
  id: string,
  before: number,
): FilmState | undefined => {
  const from = state.segments.findIndex((segment) => segment.id === id)
  const moving = state.segments[from]
  if (moving === undefined || before === from || before === from + 1) return undefined
  const rest = state.segments.toSpliced(from, 1)
  const at = before > from ? before - 1 : before
  return { ...state, segments: rest.toSpliced(at, 0, moving) }
}

/** 一段的一端最远能拖到哪：不超出挑进来时的那一截，不短于 {@link MIN_SEGMENT_SECONDS}（本来就更短的只能拉长），
 * 拉长也不让整片超过上限。 */
export const trimBounds = (
  segments: readonly FilmSegment[],
  segment: FilmSegment,
  edge: 'start' | 'end',
): { min: number; max: number } => {
  const slack = Math.max(0, MAX_FILM_SECONDS - filmDuration(segments))
  return edge === 'start'
    ? {
        min: roundToMs(Math.max(segment.origin.start, segment.start - slack)),
        max: Math.max(segment.start, roundToMs(segment.end - MIN_SEGMENT_SECONDS)),
      }
    : {
        min: Math.min(segment.end, roundToMs(segment.start + MIN_SEGMENT_SECONDS)),
        max: roundToMs(Math.min(segment.origin.end, segment.end + slack)),
      }
}

/** 把一段的一端拖到 `value`（这段素材自己的时间，秒），夹在 {@link trimBounds} 里；后面的段跟着前后移。 */
export const trimSegment = (
  state: FilmState,
  id: string,
  edge: 'start' | 'end',
  value: number,
): FilmState => {
  const at = state.segments.findIndex((segment) => segment.id === id)
  const segment = state.segments[at]
  if (segment === undefined) return state
  const { min, max } = trimBounds(state.segments, segment, edge)
  const bounded = roundToMs(Math.min(max, Math.max(min, value)))
  if (bounded === segment[edge]) return state
  return { ...state, segments: state.segments.with(at, { ...segment, [edge]: bounded }) }
}

/** 整片时刻 `clock` 处能不能拆：落在一段里面，两边都不短于 {@link MIN_SEGMENT_SECONDS}。 */
const splitPoint = (segments: readonly FilmSegment[], clock: number) => {
  const placed = segmentAt(segments, clock)
  if (placed === undefined) return undefined
  const { segment } = placed
  const time = roundToMs(segment.start + (clock - placed.at))
  if (
    time - segment.start < MIN_SEGMENT_SECONDS - 1e-9 ||
    segment.end - time < MIN_SEGMENT_SECONDS - 1e-9
  )
    return undefined
  return { segment, time }
}

export const canSplitAt = (segments: readonly FilmSegment[], clock: number): boolean =>
  splitPoint(segments, clock) !== undefined

/** 在整片时刻 `clock` 处把所在的那段一分为二：前一半留原来的 id，后一半用 `rightId`；两半各自以拆点为界。
 * 钉在后一半上的手动字幕跟过去。拆不了时返回 `undefined`。 */
export const splitAt = (
  state: FilmState,
  clock: number,
  rightId: string,
): FilmState | undefined => {
  const point = splitPoint(state.segments, clock)
  if (point === undefined) return undefined
  const { segment, time } = point
  const left: FilmSegment = {
    ...segment,
    end: time,
    origin: { start: segment.origin.start, end: time },
  }
  const right: FilmSegment = {
    ...segment,
    id: rightId,
    start: time,
    origin: { start: time, end: segment.origin.end },
  }
  const at = state.segments.indexOf(segment)
  return {
    ...state,
    segments: state.segments.toSpliced(at, 1, left, right),
    manual: state.manual.map((item) =>
      item.segmentId === segment.id && item.at >= time ? { ...item, segmentId: rightId } : item,
    ),
  }
}

/** 删掉一段，后面的段前移；钉在它上面的手动字幕一起删。 */
export const removeSegment = (state: FilmState, id: string): FilmState => ({
  ...state,
  segments: state.segments.filter((segment) => segment.id !== id),
  manual: state.manual.filter((item) => item.segmentId !== id),
})

// ---------- 字幕 ----------

/** 改一句识别字幕的字。 */
export const setSentenceText = (state: FilmState, key: string, text: string): FilmState => ({
  ...state,
  texts: { ...state.texts, [key]: text },
})

/** 在整片时刻 `clock` 处加一条空的手动字幕，钉在那一刻所在的段上；那里没有段时加不了，返回 `undefined`。 */
export const addManualSubtitle = (
  state: FilmState,
  clock: number,
  id: string,
): FilmState | undefined => {
  const placed = segmentAt(state.segments, clock)
  if (placed === undefined) return undefined
  const at = roundToMs(placed.segment.start + (clock - placed.at))
  return {
    ...state,
    manual: [...state.manual, { id, segmentId: placed.segment.id, at, text: '' }],
  }
}

export const setManualText = (state: FilmState, id: string, text: string): FilmState => ({
  ...state,
  manual: state.manual.map((item) => (item.id === id ? { ...item, text } : item)),
})

export const removeManualSubtitle = (state: FilmState, id: string): FilmState => ({
  ...state,
  manual: state.manual.filter((item) => item.id !== id),
})

// ---------- 素材轨 ----------

/** 素材区的一条轨：哪个版本组，此刻挑段用它的哪一版。同一组只有一条。 */
export type MaterialLane = { groupId: string; jobId: string }

/** 放进一条成片：这一组已有轨就换成这一版，没有就在最后加一条。 */
export const putLane = (
  lanes: readonly MaterialLane[],
  lane: MaterialLane,
): readonly MaterialLane[] => {
  const at = lanes.findIndex((item) => item.groupId === lane.groupId)
  return at < 0 ? [...lanes, lane] : lanes.with(at, lane)
}

// ---------- 存放 ----------

/** 存进浏览器的格式版本；格式一改就加一，旧的读不出来按空草稿处理。 */
const STORAGE_VERSION = 1

const zSpan = z.tuple([z.number().nonnegative(), z.number().positive()])

const zStoredSegment = z
  .object({
    id: z.string().min(1),
    sourceJobId: z.string().min(1),
    start: z.number().nonnegative(),
    end: z.number().positive(),
    origin: zSpan,
  })
  .refine(
    (segment) =>
      segment.end > segment.start &&
      segment.origin[0] <= segment.start &&
      segment.end <= segment.origin[1],
  )

const zStoredFilm = z.object({
  version: z.literal(STORAGE_VERSION),
  segments: z.array(zStoredSegment),
  texts: z.record(z.string(), z.string()),
  manual: z.array(
    z.object({
      id: z.string().min(1),
      segmentId: z.string().min(1),
      at: z.number().nonnegative(),
      text: z.string(),
    }),
  ),
  lanes: z.array(z.object({ groupId: z.string().min(1), jobId: z.string().min(1) })),
})

/** 整片草稿在浏览器里存的那一份：此刻的草稿与素材轨。撤销栈不存。 */
export type StoredFilm = { film: FilmState; lanes: readonly MaterialLane[] }

/** 读存着的整片草稿；不是 JSON、格式版本不对、形状不对都返回 `undefined`。 */
export const parseStoredFilm = (raw: string): StoredFilm | undefined => {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return undefined
  }
  const parsed = zStoredFilm.safeParse(json)
  if (!parsed.success) return undefined
  const { segments, texts, manual, lanes } = parsed.data
  return {
    film: {
      segments: segments.map(({ origin, ...segment }) => ({
        ...segment,
        origin: { start: origin[0], end: origin[1] },
      })),
      texts,
      manual,
    },
    lanes,
  }
}

export const serializeStoredFilm = ({ film, lanes }: StoredFilm): string =>
  JSON.stringify({
    version: STORAGE_VERSION,
    segments: film.segments.map(({ origin, ...segment }) => ({
      ...segment,
      origin: [origin.start, origin.end],
    })),
    texts: film.texts,
    manual: film.manual,
    lanes,
  })

/** 只留来源还读得到的段与素材轨：来源不在 `known` 里的段连同钉在它上面的手动字幕去掉，返回去掉了几段。 */
export const keepKnownSources = (
  stored: StoredFilm,
  known: ReadonlySet<string>,
): { stored: StoredFilm; dropped: number } => {
  const lost = stored.film.segments.filter((segment) => !known.has(segment.sourceJobId))
  const film = lost.reduce((state, segment) => removeSegment(state, segment.id), stored.film)
  return {
    stored: { film, lanes: stored.lanes.filter((lane) => known.has(lane.jobId)) },
    dropped: lost.length,
  }
}
