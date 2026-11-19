import { isDetachedAudio, isDubClip, type FilmClip } from './composition/film'
import {
  resolveNearestFreeStart,
  resolveZoneDropPlacement,
} from './vendor/hyperframes-studio/player/components/timelineCollision'

/**
 * 片段所在的区：画面区（视频片段和组件或块的片段）、字幕区（字幕）、声音区（音频片段），时间线上从上往下
 * 就是这个顺序。字幕区只有一行，片段不能在区之间换。
 */
export type Zone = 'visual' | 'audio' | 'caption'

export const zoneOf = (clip: Pick<FilmClip, 'kind'>): Zone =>
  clip.kind === 'audio' ? 'audio' : clip.kind === 'caption' ? 'caption' : 'visual'

/** 一行：哪个区的第几号。各区的行号各算各的。 */
export type RowKey = { zone: Zone; track: number }

export type Row = RowKey & { clips: readonly FilmClip[] }

export const onRow = (clip: FilmClip, row: RowKey): boolean =>
  zoneOf(clip) === row.zone && clip.track === row.track

/**
 * 片段要去的行：已有的一行，或者在时间线上第 `insertAt` 行的位置为 `zone` 新开一行
 * （0 是最上面，等于现有行数是最下面那条空行）。
 */
export type RowTarget = RowKey | { zone: Zone; insertAt: number }

export const sameRow = (left: RowTarget, right: RowTarget): boolean =>
  left.zone === right.zone &&
  ('track' in left && 'track' in right
    ? left.track === right.track
    : 'insertAt' in left && 'insertAt' in right && left.insertAt === right.insertAt)

/**
 * 时间线上按行分好的片段，从上往下：画面区各行、字幕那一行、声音区各行，区里行号小的在上面；行里按开始时间排。
 * 没有片段的区没有行。
 */
export const rowsOf = (clips: readonly FilmClip[]): Row[] =>
  (['visual', 'caption', 'audio'] as const).flatMap((zone) => {
    const rows = new Map<number, FilmClip[]>()
    for (const clip of clips)
      if (zoneOf(clip) === zone) rows.set(clip.track, [...(rows.get(clip.track) ?? []), clip])
    return [...rows.entries()]
      .sort(([left], [right]) => left - right)
      .map(([track, row]) => ({
        zone,
        track,
        clips: row.toSorted((left, right) => left.start - right.start),
      }))
  })

/**
 * 主轨的行号：画面区最上面那一行（行号不一定从 0 开始）；画面区还没有片段时是 0。
 * 波纹编辑补位、没给落点的镜头接在末尾，都认它。
 */
export const topTrack = (clips: readonly FilmClip[]): number => {
  const tracks = clips.filter((clip) => zoneOf(clip) === 'visual').map((clip) => clip.track)
  return tracks.length === 0 ? 0 : Math.min(...tracks)
}

/** `row` 这一行从 `start` 起长 `duration` 毫秒的这段时间里有没有片段。 */
export const rowBusy = (row: Pick<Row, 'clips'>, start: number, duration: number): boolean =>
  row.clips.some((clip) => clip.start < start + duration && start < clip.start + clip.duration)

/** 这一行是不是隐藏着（声音区的行就是静音）：行里有片段，而且每个片段都隐藏了。 */
export const rowHidden = (clips: readonly FilmClip[], row: RowKey): boolean => {
  const members = clips.filter((clip) => onRow(clip, row))
  return members.length > 0 && members.every((clip) => clip.hidden)
}

type RowContent = Pick<Row, 'zone' | 'clips'>

const allAudio = (row: RowContent, kind: (clip: FilmClip) => boolean) =>
  row.zone === 'audio' && row.clips.length > 0 && row.clips.every(kind)

/** 「配音」行：声音区里片段全是配音片段的行。 */
export const isDubRow = (row: RowContent): boolean => allAudio(row, isDubClip)

/** 「原声」行：声音区里片段全是分离出来的原声的行。 */
export const isOriginalRow = (row: RowContent): boolean => allAudio(row, isDetachedAudio)

/** 「配乐」行：声音区里别的行（含几种混在一起的）。 */
export const isMusicRow = (row: RowContent): boolean =>
  row.zone === 'audio' && !isDubRow(row) && !isOriginalRow(row)

/** 行的种类，同种的行一起编号。行名按声音从哪来起，不猜内容。 */
export type RowKind = 'visual' | 'caption' | 'dub' | 'original' | 'music'

/** 各种行在行头上叫什么；`numberedAlone` 为假时，这种行只有一行就不带编号。 */
const ROW_NAMING: Record<RowKind, { label: string; numberedAlone: boolean }> = {
  visual: { label: '画面', numberedAlone: true },
  caption: { label: '字幕', numberedAlone: false },
  dub: { label: '配音', numberedAlone: false },
  original: { label: '原声', numberedAlone: false },
  music: { label: '配乐', numberedAlone: false },
}

const kindOf = (row: Row): RowKind =>
  row.zone !== 'audio'
    ? row.zone
    : isDubRow(row)
      ? 'dub'
      : isOriginalRow(row)
        ? 'original'
        : 'music'

/**
 * 给时间线上从上往下排的各行带上行名，同种的行从上往下编号：画面区是「画面 1」「画面 2」；字幕那一行叫「字幕」；
 * 声音区里「配音」行（见 `isDubRow`）、「原声」行（见 `isOriginalRow`）和别的「配乐」行，只有一行时不带编号，
 * 不止一行时是「配音 1」「配音 2」这样。`kind` 是行的种类；`ordinal` 是同种的行不止一行时这一行的编号，
 * 只有一行时是 null（行头只在分得清几行时标编号）。
 */
export const namedRows = <T extends Row>(
  rows: readonly T[],
): (T & { name: string; kind: RowKind; ordinal: number | null })[] => {
  const kinds = rows.map(kindOf)
  return rows.map((row, at) => {
    const kind = kinds[at] ?? 'visual'
    const { label, numberedAlone } = ROW_NAMING[kind]
    const count = kinds.filter((other) => other === kind).length
    const number = kinds.slice(0, at + 1).filter((other) => other === kind).length
    return {
      ...row,
      name: count === 1 && !numberedAlone ? label : `${label} ${number}`,
      kind,
      ordinal: count === 1 ? null : number,
    }
  })
}

/** 新开一行时别的片段要换成的行号；行号没变的不列。 */
export type Renumbering = ReadonlyMap<string, number>

/**
 * 在时间线上第 `insertAt` 行的位置为 `zone` 新开一行（0 是最上面，等于现有行数是最下面）：
 * 新的一行在这个区里是几号，这个区里别的片段各自换成几号；别的区不动。
 * 区里的行号从 0 起连着排，原来空着的号顺带补上。
 * `movedId` 是要搬进新行的那个片段：它原来那一行只剩它时，那一行就不再算。
 */
export const rowOpening = (
  clips: readonly FilmClip[],
  zone: Zone,
  insertAt: number,
  movedId?: string,
): { track: number; renumber: Renumbering } => {
  const kept = rowsOf(clips)
    .map((row, at) => ({ ...row, at, clips: row.clips.filter((clip) => clip.id !== movedId) }))
    .filter((row) => row.zone === zone && row.clips.length > 0)
  const track = kept.filter((row) => row.at < insertAt).length
  const renumber = new Map<string, number>()
  kept.forEach((row, index) => {
    const next = index < track ? index : index + 1
    for (const clip of row.clips) if (clip.track !== next) renumber.set(clip.id, next)
  })
  return { track, renumber }
}

/**
 * 时间线只显示 `shown` 的片段时（别的语言的配音片段不显示），在时间线上第 `insertAt` 行的位置为 `zone` 新开一行：
 * 和 `rowOpening` 一样，只是 `clips` 是所有片段，每个片段（含没显示的）都按新的一行重新编号。新的一行插在
 * 这个位置往下第一条显示着的这个区的行前面，往下没有时排在这个区的最后；只有没显示的片段的行按行号跟着排。
 */
export const rowOpeningAmong = (
  clips: readonly FilmClip[],
  shown: (clip: FilmClip) => boolean,
  zone: Zone,
  insertAt: number,
  movedId?: string,
): { track: number; renumber: Renumbering } => {
  const next = rowsOf(clips.filter(shown))
    .slice(insertAt)
    .find((row) => row.zone === zone)
  const rows = rowsOf(clips)
  const at =
    next === undefined
      ? rows.length
      : rows.findIndex((row) => row.zone === zone && row.track === next.track)
  return rowOpening(clips, zone, at, movedId)
}

type Span = { start: number; duration: number }

/** `rows` 里第一条 `kind` 这种、`spans` 这几段时间都空着的行。 */
const freeRow = (rows: readonly Row[], kind: (row: Row) => boolean, spans: readonly Span[]) =>
  rows.find(
    (row) => kind(row) && spans.every(({ start, duration }) => !rowBusy(row, start, duration)),
  )

/**
 * 分离出来的原声放在哪一行（它从 `start` 起长 `duration` 毫秒）：从上往下第一条这段时间空着的「原声」行；
 * 都占着、或者还没有「原声」行时，在配音行下面（没有配音行就是声音区最上面）新开一行，`renumber` 是别的片段要
 * 换成的行号。原声每种语言下都显示，配音行按所有语言的配音片段算。
 */
export const originalRowFor = (
  clips: readonly FilmClip[],
  span: Span,
): { track: number; renumber: Renumbering } => {
  const rows = rowsOf(clips)
  const free = freeRow(rows, isOriginalRow, [span])
  if (free !== undefined) return { track: free.track, renumber: new Map() }
  const lastDub = rows.findLastIndex(isDubRow)
  const firstAudio = rows.findIndex((row) => row.zone === 'audio')
  return rowOpening(
    clips,
    'audio',
    lastDub !== -1 ? lastDub + 1 : firstAudio === -1 ? rows.length : firstAudio,
  )
}

/**
 * 一批配音片段放在哪一行（`spans` 是各段的起止，毫秒）：从上往下第一条这几段时间都空着的「配音」行；都占着、
 * 或者还没有配音行时，在声音区最上面（紧挨着字幕）新开一行，`renumber` 是别的片段要换成的行号。配音行和占没
 * 占着只看 `shown` 的片段（配音片段只算显示着的那种语言的），新开一行时所有片段都重新编号。
 */
export const dubRowFor = (
  clips: readonly FilmClip[],
  spans: readonly Span[],
  shown: (clip: FilmClip) => boolean,
): { track: number; renumber: Renumbering } => {
  const free = freeRow(rowsOf(clips.filter(shown)), isDubRow, spans)
  if (free !== undefined) return { track: free.track, renumber: new Map() }
  const rows = rowsOf(clips)
  const firstAudio = rows.findIndex((row) => row.zone === 'audio')
  return rowOpening(clips, 'audio', firstAudio === -1 ? rows.length : firstAudio)
}

/**
 * 配乐拖进声音区时落在哪一行（`rows` 是时间线上从上往下的各行）：配乐不进「配音」行和「原声」行，对着它们、
 * 或者要在它们之间、上面新开一行时，改成在它们最后一条下面新开一行；别的照原样。
 */
export const musicRowTarget = (rows: readonly Row[], target: RowTarget): RowTarget => {
  const lastSound = rows.findLastIndex((row) => row.zone === 'audio' && !isMusicRow(row))
  if (target.zone !== 'audio' || lastSound === -1) return target
  const intoSound =
    'track' in target
      ? rows.some((row) => row.zone === 'audio' && row.track === target.track && !isMusicRow(row))
      : target.insertAt <= lastSound
  return intoSound ? { zone: 'audio', insertAt: lastSound + 1 } : target
}

/**
 * 指针对着的地方：时间线上第 `at` 行（从上往下数，0 起），或者第 `insertAt` 行的位置
 * （0 是最上面，等于现有行数是最下面那条空行）。
 */
export type Aim = { at: number } | { insertAt: number }

/**
 * `zone` 区的片段对着 `aim` 时落在哪一行：片段只待在自己的区里。
 * 对着别的区的行（含字幕那一行）、或者在别的区里新开一行时，落在自己的区里挨着的那一行；
 * 对着最上面、最下面而那里不归自己的区时，在自己的区的边上新开一行。字幕只有一行，对着哪里都留在那一行。
 */
export const targetIn = (rows: readonly RowKey[], aim: Aim, zone: Zone): RowTarget => {
  if (zone === 'caption')
    return { zone, track: rows.find((row) => row.zone === 'caption')?.track ?? 0 }
  // 参照的算法认不出还没有行的声音区，会让音频在画面行之间新开一行：声音区的第一行总在最下面
  if (zone === 'audio' && rows.every((row) => row.zone !== 'audio'))
    return { zone, insertAt: rows.length }
  // 参照的算法只认一串行号：这里用的是时间线上的第几行，各区的行号不进去
  const order = rows.map((_, at) => at)
  // 参照的算法只分音频和别的：字幕那一行夹在两区之间，算作拖着的片段对面的区，片段就进不去、也不在它两边
  // 都新开行（画面区的片段在它上面、音频片段在它下面才新开）
  const audioRows = new Set(
    order.filter((at) => {
      const rowZone = rows[at]?.zone
      return rowZone === 'audio' || (rowZone === 'caption' && zone === 'visual')
    }),
  )
  const placed = resolveZoneDropPlacement({
    order,
    audioTracks: audioRows,
    elements: [],
    // 对着最上面、最下面那条空行时，和参照的做法一样给一个在各行之外的号
    desiredTrack: 'at' in aim ? aim.at : aim.insertAt === 0 ? -1 : aim.insertAt,
    deliberateInsertRow: 'insertAt' in aim ? aim.insertAt : null,
    start: 0,
    duration: 0,
    dragKey: '',
    isAudio: zone === 'audio',
  })
  const row = rows[placed.track]
  return placed.insertRow !== null || row === undefined
    ? { zone, insertAt: placed.insertRow ?? rows.length }
    : { zone: row.zone, track: row.track }
}

export type Landing = { track: number; start: number }

/**
 * 一段长 `duration` 毫秒的片段拖到 `row` 这一行、指针在 `timeMs` 时放在哪：
 * 同一行的片段不能重叠，放在离指针最近的空位；没有够长的空位时接在这一行最后一个片段后面。
 */
export const landingOn = (
  clips: readonly FilmClip[],
  row: RowKey,
  timeMs: number,
  duration: number,
): Landing => {
  const start = resolveNearestFreeStart(
    clips
      .filter((clip) => onRow(clip, row))
      .map((clip) => ({
        id: clip.id,
        start: clip.start / 1000,
        duration: clip.duration / 1000,
        track: clip.track,
      })),
    row.track,
    Math.max(0, timeMs) / 1000,
    duration / 1000,
    null,
  )
  return { track: row.track, start: Math.round(start * 1000) }
}
