import { use, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { writeClipTiming } from '@hyperframes/core/composition-contract'
import { mintLinkId, relinkSplitHalves } from '@hyperframes/core/media-link'
import type { Composition, ElementSnapshot } from '@hyperframes/sdk'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import { TranscriptConnectionContext } from '@/shared/transcript/transcript-context'
import { rippleStarts, withLinkedStarts, type Cut, type Links, type Timing } from './clip-edit'
import type { CatalogItem, ComponentCatalog, VariableValue } from './composition/catalog'
import {
  audioElement,
  clipOf,
  emptyProject,
  hostElement,
  itemFonts,
  itemNamed,
  PROJECT_MAIN,
  videoElement,
  withFontBlock,
  type AudioClip,
  type Canvas,
  type ClipAttribute,
  type FilmClip,
  type VideoClip,
} from './composition/film'
import {
  copyItemFiles,
  createProjectFile,
  holdProjectReads,
  PROJECT_DIR,
  PROJECT_MAIN_PATH,
  readProjectMain,
  writeProjectMain,
  type ProjectMain,
} from './final-cut.api'
import { itemDurationMs } from './items'
import type { AttributeChanges } from './original-sound'
import { onRow, topTrack, voiceRowFor, type Landing, type Renumbering } from './placement'
import { detachedVideoChanges, mergedVideoChanges, type SoundPair } from './sound-pair'
import { newClipZ, restackedZ } from './stacking'
import type { StackingDirection } from './vendor/hyperframes-studio/player/components/timelineStackingSync'

export type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'failed'; message: string }

/** 工程现在的样子：`html` 是当前的主文件（没存的改动也在里面），其余是从它读出来的。 */
export type FilmView = {
  html: string
  canvas: Canvas
  /** 主文件根下所有带时间的元素，按它们在文件里的先后。 */
  clips: readonly FilmClip[]
  /** 带链接（`data-link`）的片段各自的链接名。 */
  links: Links
  durationMs: number
  canUndo: boolean
  canRedo: boolean
}

/** 要放进工程的一段素材；起点由现有内容决定，接在画面那一行的末尾。 */
export type NewVideo = Pick<VideoClip, 'label' | 'src' | 'mediaStart' | 'duration' | 'muted'>

/** 要放进工程的一段音频：一条音频记录从 `mediaStart` 起的 `duration` 毫秒。 */
export type NewAudio = Pick<AudioClip, 'label' | 'src' | 'mediaStart' | 'duration'>

// SDK 的编辑引擎只在打开 final-cut 编辑器时才用得到，单独成块按需加载。
const openComposition = async (html: string): Promise<Composition> =>
  (await import('@hyperframes/sdk')).openComposition(html)

const STALE_NOTICE = 'final-cut 已在别处修改，已切换到最新版本；未保存的改动已放弃'

const NO_RENUMBERING: Renumbering = new Map()
const NO_STARTS: ReadonlyMap<string, number> = new Map()

/** 主文件的根：最外层带 `data-composition-id` 的元素。 */
const rootOf = (engine: Composition): ElementSnapshot | undefined =>
  engine
    .getRootElements()
    .find((element) => element.attributes['data-composition-id'] !== undefined)

/** 根下所有带时间的元素读成的片段，按它们在文件里的先后。不存出文件，一批操作中间也能用。 */
const clipsOf = (engine: Composition, catalog: ComponentCatalog): FilmClip[] => {
  const timings = engine.getElementTimings()
  return (rootOf(engine)?.children ?? []).flatMap((element) => {
    const timing = timings[element.id]
    return timing === undefined ? [] : [clipOf(element, timing, catalog)]
  })
}

/** 工程总长：根以外所有带时间的元素里最晚的结尾（毫秒）。 */
const latestEnd = (engine: Composition): number => {
  const root = rootOf(engine)?.id
  return Math.round(
    Math.max(
      0,
      ...Object.entries(engine.getElementTimings())
        .filter(([id]) => id !== root)
        .map(([, timing]) => timing.exitAt * 1000),
    ),
  )
}

const viewOf = (engine: Composition, catalog: ComponentCatalog): FilmView => {
  const root = rootOf(engine)
  const clips = clipsOf(engine, catalog)
  return {
    // SDK 改不了 <head>：存出时只重算字体块
    html: withFontBlock(engine.serialize(), clips, catalog),
    canvas: {
      width: Number(root?.attributes['data-width'] ?? 0),
      height: Number(root?.attributes['data-height'] ?? 0),
    },
    clips,
    links: new Map(clips.flatMap((clip) => (clip.link === null ? [] : [[clip.id, clip.link]]))),
    durationMs: latestEnd(engine),
    canUndo: engine.canUndo(),
    canRedo: engine.canRedo(),
  }
}

/** 在一批操作里做完 `change`，再按改完的样子写根上的总长：一起算一步撤销。 */
const applyTo = (engine: Composition, change: () => void) =>
  engine.batch(() => {
    change()
    engine.dispatch({ type: 'setCompositionMetadata', duration: latestEnd(engine) / 1000 })
  })

const newClipId = () => `clip-${crypto.randomUUID().slice(0, 8)}`

const LINK = 'data-link'

/**
 * 新的链接名（也用作分离出来的原声的出处）：照引擎的取法，不和文件里任何元素的编号、链接名、出处重名。
 */
const newLinkName = (engine: Composition) =>
  mintLinkId(
    engine
      .getElements()
      .flatMap((element) => [
        element.id,
        element.attributes['id'] ?? '',
        element.attributes[LINK] ?? '',
        element.attributes['data-sync-origin'] ?? '',
      ]),
  )

/** 编辑器按算好的样子写一个片段的起止或行：联动的伙伴由调用方一起算进去，不让引擎再带着挪一次。 */
const setOwnTiming = (
  engine: Composition,
  id: string,
  timing: { start?: number; duration?: number; trackIndex?: number },
) => engine.setTiming(id, timing, { linked: false })

/**
 * 做完 `change`（里面用 `setOwnTiming` 写时间）以后，把做之前根下各元素的链接名原样写回去：
 * 引擎只改一个片段时会解除它和伙伴的链接，联动不该因为挪了、裁了就断掉。
 */
const keepingLinks = (engine: Composition, change: () => void) => {
  const before = (rootOf(engine)?.children ?? []).flatMap((element) => {
    const link = element.attributes[LINK]
    return link === undefined ? [] : [[element.id, link] as const]
  })
  change()
  for (const [id, link] of before) {
    const element = engine.getElement(id)
    if (element !== null && element.attributes[LINK] !== link) engine.setAttribute(id, LINK, link)
  }
}

const HF_ID = 'data-hf-id'

/** 要加进根下的一个后半段：它的编号，写在根下第几个，元素的整段 HTML。 */
type SplitHalf = { id: string; index: number; html: string }

const SPLIT_FAILED_TEXT = '片段里带有无法复制的内容，无法切开'

/** 有一个后半段没能原样加进去（引擎不收这段 HTML）：整次切开退回去。 */
class HalfRejected extends Error {}

/**
 * 切开以后的各个后半段：在当前主文件的一份副本里把原元素整个复制一份（属性、样式、子元素都带上），
 * 换上新的编号、后半段的起止和入点，紧跟在原元素后面；链接名照引擎的规则重新取。按在根下的先后排，
 * 依次加进去时前面加的不会挪动后面要加的位置。找不到根或片段时是 null。
 */
function splitHalves(
  engine: Composition,
  cuts: readonly Cut[],
  clips: readonly FilmClip[],
): readonly SplitHalf[] | null {
  const rootId = rootOf(engine)?.id
  const copy = new DOMParser().parseFromString(engine.serialize(), 'text/html')
  const root = [...copy.querySelectorAll(`[${HF_ID}]`)].find(
    (element) => element.getAttribute(HF_ID) === rootId,
  )
  if (root === undefined) return null
  const kinds = new Map(clips.map((clip) => [clip.id, clip.kind]))
  const halves: Element[] = []
  for (const cut of cuts) {
    const original = [...root.children].find((child) => child.getAttribute(HF_ID) === cut.id)
    if (original === undefined) return null
    const half = original.cloneNode(true) as Element
    const id = newClipId()
    half.id = id
    half.setAttribute(HF_ID, id)
    // 子元素的编号交给引擎重新取，免得和原元素里的重复
    for (const child of half.querySelectorAll(`[${HF_ID}]`)) child.removeAttribute(HF_ID)
    writeClipTiming(half, { start: cut.second.start / 1000, duration: cut.second.duration / 1000 })
    const inPoint = String(cut.second.mediaStart / 1000)
    if (kinds.get(cut.id) === 'host') half.setAttribute('data-playback-start', inPoint)
    else half.setAttribute('data-media-start', inPoint)
    original.after(half)
    halves.push(half)
  }
  relinkSplitHalves(
    copy,
    halves.map((half) => half.id),
  )
  return halves
    .map((half) => ({
      id: half.id,
      index: [...root.children].indexOf(half),
      html: half.outerHTML,
    }))
    .toSorted((left, right) => left.index - right.index)
}

type Options = {
  debounceMs?: number
  onNotice: (message: string) => void
}

/**
 * 编辑对话工作区里的 final-cut 工程：打开主文件 `final-cut/index.html`（`initial` 是 null 时还没有工程），
 * 改动停下 `debounceMs` 毫秒后整份保存（第一次新建、之后按版本号写）。主文件在别处被改了时换上那一份、
 * 放弃本地没存的改动；工程里别的文件变了时 `filesRevision` 加 1，预览据此重新加载。
 */
export function useFilmSession(
  conversationId: string,
  initial: ProjectMain | null,
  catalog: ComponentCatalog,
  { debounceMs = 800, onNotice }: Options,
) {
  const [film, setFilm] = useState<FilmView | null>(null)
  const [opening, setOpening] = useState(initial !== null)
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const [filesRevision, setFilesRevision] = useState(0)
  const engineRef = useRef<Composition | null>(null)
  const creatingRef = useRef<Promise<Composition | null> | null>(null)
  // 工作区里主文件的版本号；还没有这个文件时是 null，第一次保存走新建
  const versionRef = useRef(initial?.version ?? null)
  const savedRef = useRef<string | null>(null)
  const presentRef = useRef<string | null>(null)
  const inFlightRef = useRef<Promise<void> | null>(null)
  const noticeRef = useRef(onNotice)
  useLayoutEffect(() => {
    noticeRef.current = onNotice
  })
  const initialHtml = initial?.content ?? null

  /** 改动都从这里发出，改完读一遍现在的样子。 */
  const show = useCallback(
    (engine: Composition | null) => {
      const view = engine === null ? null : viewOf(engine, catalog)
      presentRef.current = view?.html ?? null
      setFilm(view)
    },
    [catalog],
  )

  /** 换上一份主文件（null 是还没有工程）；`saved` 为真时它就是工作区里存着的那一份。 */
  const adopt = useCallback(
    async (html: string | null, saved: boolean) => {
      engineRef.current?.dispose()
      const engine = html === null ? null : await openComposition(html)
      engineRef.current = engine
      show(engine)
      if (saved) savedRef.current = presentRef.current
      return engine
    },
    [show],
  )

  useEffect(() => {
    if (initialHtml === null) return
    let cancelled = false
    void openComposition(initialHtml).then((engine) => {
      if (cancelled) {
        engine.dispose()
        return
      }
      engineRef.current = engine
      show(engine)
      savedRef.current = presentRef.current
      setOpening(false)
    })
    return () => {
      cancelled = true
    }
  }, [initialHtml, show])

  /** 在途的保存都结束。 */
  const settled = useCallback(async () => {
    while (inFlightRef.current !== null) await inFlightRef.current
  }, [])

  /** 换上工作区里现在的那一份，放弃本地没存的改动并提示。 */
  const adoptStored = useCallback(
    async (stored: ProjectMain | null) => {
      versionRef.current = stored?.version ?? null
      await adopt(stored?.content ?? null, true)
      noticeRef.current(STALE_NOTICE)
    },
    [adopt],
  )

  const saveNow = useCallback(async (): Promise<'saved' | 'clean' | 'reloaded' | 'failed'> => {
    await settled()
    const html = presentRef.current
    if (html === null || html === savedRef.current) return 'clean'
    const run = (async () => {
      setSave({ kind: 'saving' })
      try {
        const known = versionRef.current
        versionRef.current =
          known === null
            ? await createProjectFile(conversationId, PROJECT_MAIN, html)
            : await writeProjectMain(conversationId, html, known)
        savedRef.current = html
        setSave({ kind: 'idle' })
        return 'saved' as const
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          try {
            await adoptStored(await readProjectMain(conversationId))
            setSave({ kind: 'idle' })
            return 'reloaded' as const
          } catch (reloadError) {
            setSave({ kind: 'failed', message: errorMessageOf(reloadError, 'final-cut 读取失败') })
            return 'failed' as const
          }
        }
        setSave({ kind: 'failed', message: errorMessageOf(error, 'final-cut 保存失败') })
        return 'failed' as const
      }
    })()
    inFlightRef.current = run.then(() => undefined)
    try {
      return await run
    } finally {
      inFlightRef.current = null
    }
  }, [adoptStored, conversationId, settled])

  /**
   * 主文件变了：通知不带版本号，自己的保存也会通知。等在途的保存结束再读，读回来以后再等一次
   * （读的时候可能又存了一版），只有工作区里的版本比自己知道的新（或文件出现、消失了）才算别处改的。
   */
  const checkStored = useCallback(async () => {
    try {
      await settled()
      const stored = await readProjectMain(conversationId)
      await settled()
      const known = versionRef.current
      const external = stored === null ? known !== null : known === null || stored.version > known
      if (external) await adoptStored(stored)
    } catch (error) {
      setSave({ kind: 'failed', message: errorMessageOf(error, 'final-cut 读取失败') })
    }
  }, [adoptStored, conversationId, settled])

  const connection = use(TranscriptConnectionContext)
  useEffect(() => {
    if (connection === null) return undefined
    const unwatchFiles = connection.watchFs(
      conversationId,
      [PROJECT_DIR],
      (changes) => {
        if (changes.some((change) => change.path === PROJECT_MAIN_PATH)) void checkStored()
        if (changes.some((change) => change.path !== PROJECT_MAIN_PATH))
          setFilesRevision((revision) => revision + 1)
      },
      { recursive: true },
    )
    // 断线期间的通知收不到：重连后按主文件变了、别的文件也变了处理
    const unwatchSessions = connection.watchSessions((update) => {
      if (update.kind !== 'reconnected') return
      void checkStored()
      setFilesRevision((revision) => revision + 1)
    })
    return () => {
      unwatchFiles()
      unwatchSessions()
    }
  }, [checkStored, connection, conversationId])

  const html = film?.html ?? null
  useEffect(() => {
    if (html === null || html === savedRef.current) return
    const timer = setTimeout(() => void saveNow(), debounceMs)
    return () => clearTimeout(timer)
  }, [html, debounceMs, saveNow])

  // 卸载时把没存的存掉；连同还在途的那次一起交给主文件的读取，再打开时等它们存完再读
  useEffect(
    () => () => {
      const dirty = presentRef.current !== null && presentRef.current !== savedRef.current
      if (dirty || inFlightRef.current !== null) holdProjectReads(conversationId, saveNow())
    },
    [conversationId, saveNow],
  )

  useEffect(() => () => engineRef.current?.dispose(), [])

  /** 还没有工程时按 `canvas` 用模板建一份；连着加两次也只建一份，后一次等前一次建好。 */
  const engineFor = useCallback(
    async (canvas: Canvas): Promise<Composition | null> => {
      if (engineRef.current !== null) return engineRef.current
      creatingRef.current ??= adopt(emptyProject(canvas, catalog), false).finally(() => {
        creatingRef.current = null
      })
      return creatingRef.current
    },
    [adopt, catalog],
  )

  /**
   * 把几段素材一段接一段放进画面区：给了 `at` 就从那一行的那个时间放起（调用方保证那里空着），
   * 没给就接在主轨（画面区最上面那一行）的末尾。`renumber` 是为它新开一行时别的片段要换成的行号。
   * 每段都叠在最上面，写在根下第一个。还没有工程时先按 `canvas` 建一份。放不下时不动工程。
   */
  const addVideos = useCallback(
    async (
      canvas: Canvas,
      videos: readonly NewVideo[],
      at?: Landing,
      renumber: Renumbering = NO_RENUMBERING,
    ): Promise<boolean> => {
      const engine = await engineFor(canvas)
      const root = engine === null ? undefined : rootOf(engine)
      if (engine === null || root === undefined) return false
      const existing = clipsOf(engine, catalog)
      // 别的片段先换成新的行号，后面都按换完的样子算
      const others = existing.map((clip) => ({
        ...clip,
        track: renumber.get(clip.id) ?? clip.track,
      }))
      const track = at?.track ?? topTrack(others)
      const row = others.filter((clip) => onRow(clip, { zone: 'visual', track }))
      let end = at?.start ?? Math.max(0, ...row.map((clip) => clip.start + clip.duration))
      applyTo(engine, () => {
        for (const [id, next] of renumber) engine.setTiming(id, { trackIndex: next })
        for (const [placed, video] of videos.entries()) {
          const element = videoElement({
            ...video,
            id: newClipId(),
            start: end,
            track,
            volume: 1,
            playbackRate: 1,
            fadeIn: 0,
            fadeOut: 0,
            z: newClipZ(existing, placed),
            hidden: false,
            link: null,
            syncOrigin: null,
          })
          engine.addElement(root.id, 0, element)
          end += video.duration
        }
      })
      show(engine)
      return true
    },
    [catalog, engineFor, show],
  )

  /**
   * 把组件库的一个条目放进工程：先把条目的文件拷进工程，再从 `at` 那一行的那个时间放起（调用方保证那里空着），
   * 可填项取 `values`，时长取条目的时长。`renumber` 同 `addVideos`。
   * 叠在最上面，写在根下第一个。还没有工程时先按 `canvas` 建一份。文件拷不进来时提示原因，不动工程。
   */
  const addItem = useCallback(
    async (
      canvas: Canvas,
      item: CatalogItem,
      values: Readonly<Record<string, VariableValue>>,
      at: Landing,
      renumber: Renumbering = NO_RENUMBERING,
    ): Promise<boolean> => {
      try {
        await copyItemFiles(conversationId, catalog, item)
      } catch (error) {
        noticeRef.current(errorMessageOf(error, '贴片和场景读取失败'))
        return false
      }
      const engine = await engineFor(canvas)
      const root = engine === null ? undefined : rootOf(engine)
      if (engine === null || root === undefined) return false
      const existing = clipsOf(engine, catalog)
      const duration = itemDurationMs(item, existing)
      const size = {
        width: Number(root.attributes['data-width'] ?? canvas.width),
        height: Number(root.attributes['data-height'] ?? canvas.height),
      }
      applyTo(engine, () => {
        for (const [id, next] of renumber) engine.setTiming(id, { trackIndex: next })
        const element = hostElement(
          {
            id: newClipId(),
            label: item.title,
            item: item.name,
            src: item.src,
            start: at.start,
            duration,
            playbackStart: 0,
            track: at.track,
            values: { ...values },
            z: newClipZ(existing, 0),
            hidden: false,
            link: null,
          },
          item,
          size,
          catalog,
        )
        engine.addElement(root.id, 0, element)
      })
      show(engine)
      return true
    },
    [catalog, conversationId, engineFor, show],
  )

  /**
   * 把一段音频放进声音区：从 `at` 那一行的那个时间放起（调用方保证那里空着）。
   * 写在根下第一个，不带叠放顺序。`renumber` 同 `addVideos`。还没有工程时先按 `canvas` 建一份。
   */
  const addAudio = useCallback(
    async (
      canvas: Canvas,
      audio: NewAudio,
      at: Landing,
      renumber: Renumbering = NO_RENUMBERING,
    ): Promise<boolean> => {
      const engine = await engineFor(canvas)
      const root = engine === null ? undefined : rootOf(engine)
      if (engine === null || root === undefined) return false
      applyTo(engine, () => {
        for (const [id, next] of renumber) engine.setTiming(id, { trackIndex: next })
        const element = audioElement({
          ...audio,
          id: newClipId(),
          start: at.start,
          track: at.track,
          volume: 1,
          playbackRate: 1,
          fadeIn: 0,
          fadeOut: 0,
          loop: false,
          hidden: false,
          link: null,
          syncOrigin: null,
        })
        engine.addElement(root.id, 0, element)
      })
      show(engine)
      return true
    },
    [engineFor, show],
  )

  /** 改工程里已有的东西：`change` 里的几步和工程总长一起算一步撤销。 */
  const edit = useCallback(
    (change: (engine: Composition) => void) => {
      const engine = engineRef.current
      if (engine === null) return
      applyTo(engine, () => change(engine))
      show(engine)
    },
    [show],
  )

  /**
   * 改几个片段各自的起止和入点，一起算一步撤销。组件或块的片段的入点写成从第几秒开始播，是 0 时去掉
   * 这个属性；「其他」片段没有入点，只改起止。联动的伙伴要跟着动时由调用方算进 `timings`。
   */
  const retime = useCallback(
    (timings: ReadonlyMap<string, Timing>) =>
      edit((engine) => {
        const kinds = new Map(clipsOf(engine, catalog).map((clip) => [clip.id, clip.kind]))
        keepingLinks(engine, () => {
          for (const [id, timing] of timings) {
            setOwnTiming(engine, id, {
              start: timing.start / 1000,
              duration: timing.duration / 1000,
            })
            const kind = kinds.get(id)
            const inPoint = String(timing.mediaStart / 1000)
            if (kind === 'host')
              engine.setAttribute(id, 'data-playback-start', timing.mediaStart > 0 ? inPoint : null)
            else if (kind === 'video' || kind === 'audio')
              engine.setAttribute(id, 'data-media-start', inPoint)
          }
        })
      }),
    [catalog, edit],
  )

  /**
   * 把一个片段换到另一行的某个时间。`direction` 是它往上还是往下挪（null 时不调叠放顺序）：
   * 只重排它自己，别的片段的叠放顺序和文件里的先后都不动。
   * `renumber` 是为它新开一行时别的片段要换成的行号；`starts` 是和它一起挪的片段（含联动的伙伴）
   * 各自的新起点，它们留在原来的行。都和它算一步撤销。
   */
  const moveClip = useCallback(
    (
      id: string,
      at: Landing,
      direction: StackingDirection | null,
      renumber: Renumbering = NO_RENUMBERING,
      starts: ReadonlyMap<string, number> = NO_STARTS,
    ) =>
      edit((engine) => {
        for (const [other, next] of renumber) engine.setTiming(other, { trackIndex: next })
        keepingLinks(engine, () => {
          for (const [other, start] of starts) setOwnTiming(engine, other, { start: start / 1000 })
          setOwnTiming(engine, id, { start: at.start / 1000, trackIndex: at.track })
        })
        if (direction === null) return
        // 按挪完的样子算：一起挪的片段的新起点、别的片段的新行号都已写进去
        const z = restackedZ(clipsOf(engine, catalog), id, direction)
        if (z !== undefined) engine.setStyle(id, { zIndex: z > 0 ? String(z) : null })
      }),
    [catalog, edit],
  )

  /** 把几个片段各自挪到新的起点（合拢空档），联动的伙伴挪同样的时间差，一起算一步撤销。 */
  const restart = useCallback(
    (starts: ReadonlyMap<string, number>) =>
      edit((engine) => {
        const all = withLinkedStarts(starts, clipsOf(engine, catalog))
        keepingLinks(engine, () => {
          for (const [id, start] of all) setOwnTiming(engine, id, { start: start / 1000 })
        })
      }),
    [catalog, edit],
  )

  /** 把几个片段一起隐藏或显示回来，算一步撤销。 */
  const setHidden = useCallback(
    (ids: readonly string[], hidden: boolean) =>
      edit((engine) => {
        for (const id of ids) engine.setAttribute(id, 'data-hidden', hidden ? '' : null)
      }),
    [edit],
  )

  /**
   * 把组件或块的片段 `id` 的可填项取值整个换成 `values`，宿主上的字体变量跟着重算，算一步撤销。
   * 片段已经不在工程里（比如改完还没提交就删掉了）时不动工程。
   */
  const setValues = useCallback(
    (id: string, values: Readonly<Record<string, VariableValue>>) => {
      const engine = engineRef.current
      const clip = engine === null ? undefined : clipsOf(engine, catalog).find((c) => c.id === id)
      if (clip?.kind !== 'host') return
      const item = itemNamed(catalog, clip.item)
      edit((current) => {
        current.setAttribute(id, 'data-variable-values', JSON.stringify(values))
        if (item !== undefined) current.setStyle(id, itemFonts(item, values, catalog))
      })
    },
    [catalog, edit],
  )

  /**
   * 在几个片段上都改同样的几个属性（null 是去掉），算一步撤销。不在工程里的片段跳过；
   * 属性都已经是这些值时不动工程。
   */
  const setAttributes = useCallback(
    (ids: readonly string[], changes: Readonly<Partial<Record<ClipAttribute, string | null>>>) => {
      const engine = engineRef.current
      if (engine === null) return
      const changed = ids.flatMap((id) => {
        const element = engine.getElement(id)
        if (element === null) return []
        return Object.entries(changes)
          .filter(([name, value]) => (element.attributes[name] ?? null) !== value)
          .map(([name, value]) => ({ id, name, value: value ?? null }))
      })
      if (changed.length === 0) return
      edit((current) => {
        for (const { id, name, value } of changed) current.setAttribute(id, name, value)
      })
    },
    [edit],
  )

  /** 删掉几个片段；`ripple` 为真时主轨里后面的片段往前补上，联动的伙伴挪同样的时间差。 */
  const removeClips = useCallback(
    (ids: readonly string[], ripple: boolean) =>
      edit((engine) => {
        const before = clipsOf(engine, catalog)
        const gone = new Set(ids)
        const starts = ripple ? withLinkedStarts(rippleStarts(before, gone), before) : NO_STARTS
        for (const id of gone) engine.removeElement(id)
        keepingLinks(engine, () => {
          for (const [id, start] of starts)
            if (!gone.has(id)) setOwnTiming(engine, id, { start: start / 1000 })
        })
      }),
    [catalog, edit],
  )

  /**
   * 把视频片段 `videoId` 的原声分离成一个音频片段，算一步撤销：视频片段关掉原声、声音属性搬走，原声片段
   * 和它同一个地址、同样的起止、入点、速度，写在文件里紧挨着它前面，放进「人声」行（见 `voiceRowFor`）；
   * 两段写上同一个新的链接名，也当出处，联动着。返回原声片段的编号；片段不是视频片段时不动工程。
   */
  const detach = useCallback(
    (videoId: string): string | undefined => {
      const engine = engineRef.current
      const root = engine === null ? undefined : rootOf(engine)
      if (engine === null || root === undefined) return undefined
      const clips = clipsOf(engine, catalog)
      const video = clips.find((clip) => clip.id === videoId)
      if (video?.kind !== 'video') return undefined
      const name = newLinkName(engine)
      const { track, renumber } = voiceRowFor(clips, video.start, video.duration)
      const index = root.children.findIndex((child) => child.id === videoId)
      let added: string | undefined
      edit((current) => {
        for (const [id, next] of renumber) current.setTiming(id, { trackIndex: next })
        added = current.addElement(
          root.id,
          index,
          audioElement({
            id: newClipId(),
            label: `${video.label} · 原声`,
            src: video.src,
            start: video.start,
            duration: video.duration,
            mediaStart: video.mediaStart,
            playbackRate: video.playbackRate,
            volume: video.volume,
            fadeIn: video.fadeIn,
            fadeOut: video.fadeOut,
            track,
            loop: false,
            hidden: video.hidden,
            link: name,
            syncOrigin: name,
          }),
        )
        for (const [attribute, value] of Object.entries(detachedVideoChanges(name)))
          current.setAttribute(videoId, attribute, value ?? null)
      })
      return added
    },
    [catalog, edit],
  )

  /**
   * 把分离出来的原声合并回视频片段，算一步撤销：原声上的声音属性写回视频片段，视频片段打开原声、去掉链接名
   * 和出处，原声片段删掉。能不能合并由调用方按 `mergeBlocked` 先查。
   */
  const merge = useCallback(
    ({ video, audio }: SoundPair) => {
      const engine = engineRef.current
      const element = engine?.getElement(audio.id) ?? null
      if (element === null) return
      const changes: AttributeChanges = mergedVideoChanges(element.attributes)
      edit((current) => {
        for (const [attribute, value] of Object.entries(changes))
          current.setAttribute(video.id, attribute, value ?? null)
        current.removeElement(audio.id)
      })
    },
    [edit],
  )

  /** 打开（两段写上一个新的链接名）或关掉（两段去掉链接名）一对的联动，算一步撤销。 */
  const setLinked = useCallback(
    ({ video, audio }: SoundPair, linked: boolean) =>
      edit((engine) => {
        const name = linked ? newLinkName(engine) : null
        for (const id of [video.id, audio.id]) engine.setAttribute(id, LINK, name)
      }),
    [edit],
  )

  /** 对齐口型：只把原声片段 `audioId` 挪到 `startMs`（由 `resyncPlan` 算好），联动不变，算一步撤销。 */
  const resync = useCallback(
    (audioId: string, startMs: number) =>
      edit((engine) =>
        keepingLinks(engine, () => setOwnTiming(engine, audioId, { start: startMs / 1000 })),
      ),
    [edit],
  )

  /**
   * 切开几个片段（`cuts` 由 `clip-edit.ts` 里的切开函数算好），算一步撤销：前半段还是原来的片段、只改时长，
   * 后半段是它的整份复制、紧跟在它后面。有一个后半段写不进去（比如元素里带着脚本）时都不切，提示原因。
   */
  const split = useCallback(
    (cuts: readonly Cut[]) => {
      const engine = engineRef.current
      const root = engine === null ? undefined : rootOf(engine)
      if (engine === null || root === undefined || cuts.length === 0) return
      const halves = splitHalves(engine, cuts, clipsOf(engine, catalog))
      if (halves === null) return
      try {
        edit((current) => {
          for (const half of halves)
            if (current.addElement(root.id, half.index, half.html) !== half.id)
              throw new HalfRejected()
          // 链接的片段切在同一处：SDK 把时长带给结尾对齐的链接片段时，带过去的也正好是切点
          for (const cut of cuts) current.setTiming(cut.id, { duration: cut.first.duration / 1000 })
        })
      } catch (error) {
        // 一批操作里抛出时引擎已经整批退回
        if (!(error instanceof HalfRejected)) throw error
        noticeRef.current(SPLIT_FAILED_TEXT)
      }
    },
    [catalog, edit],
  )

  const step = (direction: 'undo' | 'redo') => {
    const engine = engineRef.current
    if (engine === null) return
    engine[direction]()
    show(engine)
  }

  return {
    film,
    opening,
    filesRevision,
    addVideos,
    addItem,
    addAudio,
    retime,
    moveClip,
    restart,
    setHidden,
    setValues,
    setAttributes,
    removeClips,
    split,
    detach,
    merge,
    setLinked,
    resync,
    undo: () => step('undo'),
    redo: () => step('redo'),
    save,
    flush: () => void saveNow(),
    /** 等没存的改动存完；存好了（或本来就没有要存的）答 true，存失败或换成了别处改的那一份答 false。 */
    settle: async () => {
      const outcome = await saveNow()
      return outcome === 'saved' || outcome === 'clean'
    },
  }
}
