import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Composition } from '@hyperframes/sdk'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import type { WholeFilmDraftOut } from '@/shared/api/generated/types.gen'
import { rippleStarts, type Timing } from './block-edit'
import type { ComponentCatalog } from './composition/catalog'
import {
  blockFromAttributes,
  blockKindOfTag,
  FILM_ID,
  pictureBlock,
  sourceVariable,
  writeFilm,
  type Canvas,
  type FilmBlock,
  type PictureBlock,
} from './composition/film'
import { topTrack, type Landing, type Renumbering } from './placement'
import { newBlockZ, restackedZ } from './stacking'
import type { StackingDirection } from './vendor/hyperframes-studio/player/components/timelineStackingSync'
import { readWholeFilmDraft, saveWholeFilmDraft } from './whole-film.api'

export type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'failed'; message: string }

/** 成片现在的样子：`html` 是 SDK 存出来的当前文件，其余是从它读出来的。 */
export type FilmView = {
  html: string
  canvas: Canvas
  pictures: readonly PictureBlock[]
  durationMs: number
  canUndo: boolean
  canRedo: boolean
}

/** 要放进成片的一段素材；起点由成片现有内容决定，接在画面那一行的末尾。 */
export type NewPicture = Pick<PictureBlock, 'label' | 'jobId' | 'src' | 'mediaStart' | 'duration'>

// SDK 的编辑引擎只在打开成片编辑器时才用得到，单独成块按需加载。
const openComposition = async (html: string): Promise<Composition> =>
  (await import('@hyperframes/sdk')).openComposition(html)

const STALE_NOTICE = '成片草稿已在别处改过，已换成最新的一版；刚才没保存的改动已放弃'

const NO_RENUMBERING: Renumbering = new Map()
const NO_STARTS: ReadonlyMap<string, number> = new Map()

/** 成片里所有的块，按它们在文件里的先后。只读块，不存出文件，一批操作中间也能用。 */
const blocksOf = (engine: Composition): FilmBlock[] =>
  (engine.getElements().find((element) => element.id === FILM_ID)?.children ?? []).flatMap(
    (element) => {
      const kind = blockKindOfTag(element.tag)
      const block =
        kind === undefined
          ? undefined
          : blockFromAttributes(
              kind,
              element.id,
              element.attributes,
              element.inlineStyles['zIndex'],
            )
      return block === undefined ? [] : [block]
    },
  )

/** 成片里的画面块，按它们在文件里的先后。 */
const picturesOf = (engine: Composition): PictureBlock[] =>
  blocksOf(engine).filter((block) => block.kind === 'picture')

const durationOf = (pictures: readonly PictureBlock[]) =>
  Math.max(0, ...pictures.map((block) => block.start + block.duration))

const viewOf = (engine: Composition): FilmView => {
  const root = engine.getElements().find((element) => element.id === FILM_ID)
  const pictures = picturesOf(engine)
  return {
    html: engine.serialize(),
    canvas: {
      width: Number(root?.attributes['data-width'] ?? 0),
      height: Number(root?.attributes['data-height'] ?? 0),
    },
    pictures,
    durationMs: durationOf(pictures),
    canUndo: engine.canUndo(),
    canRedo: engine.canRedo(),
  }
}

const newBlockId = () => `clip-${crypto.randomUUID().slice(0, 8)}`

type Options = {
  debounceMs?: number
  onNotice: (message: string) => void
}

export function useFilmSession(
  conversationId: string,
  initial: WholeFilmDraftOut,
  catalog: ComponentCatalog,
  { debounceMs = 800, onNotice }: Options,
) {
  const [film, setFilm] = useState<FilmView | null>(null)
  const [opening, setOpening] = useState(initial.html !== null)
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const engineRef = useRef<Composition | null>(null)
  const creatingRef = useRef<Promise<Composition | null> | null>(null)
  const revisionRef = useRef(initial.revision)
  const savedRef = useRef<string | null>(null)
  const presentRef = useRef<string | null>(null)
  const inFlightRef = useRef<Promise<void> | null>(null)
  const noticeRef = useRef(onNotice)
  useLayoutEffect(() => {
    noticeRef.current = onNotice
  })

  /** 改动都从这里发出，改完读一遍现在的样子。 */
  const show = useCallback((engine: Composition | null) => {
    const view = engine === null ? null : viewOf(engine)
    presentRef.current = view?.html ?? null
    setFilm(view)
  }, [])

  /** 换上一份成片文件（null 是还没有成片）；`saved` 为真时它就是服务端存着的那一份。 */
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
    if (initial.html === null) return
    let cancelled = false
    void openComposition(initial.html).then((engine) => {
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
  }, [initial.html, show])

  const reloadServerCopy = useCallback(async () => {
    const server = await readWholeFilmDraft(conversationId)
    revisionRef.current = server.revision
    await adopt(server.html, true)
    noticeRef.current(STALE_NOTICE)
  }, [adopt, conversationId])

  const saveNow = useCallback(async (): Promise<'saved' | 'clean' | 'reloaded' | 'failed'> => {
    while (inFlightRef.current !== null) await inFlightRef.current
    const html = presentRef.current
    if (html === null || html === savedRef.current) return 'clean'
    const run = (async () => {
      setSave({ kind: 'saving' })
      try {
        const saved = await saveWholeFilmDraft(conversationId, {
          revision: revisionRef.current,
          html,
        })
        revisionRef.current = saved.revision
        savedRef.current = html
        setSave({ kind: 'idle' })
        return 'saved' as const
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          try {
            await reloadServerCopy()
            setSave({ kind: 'idle' })
            return 'reloaded' as const
          } catch (reloadError) {
            setSave({ kind: 'failed', message: errorMessageOf(reloadError, '成片草稿读取失败') })
            return 'failed' as const
          }
        }
        setSave({ kind: 'failed', message: errorMessageOf(error, '成片草稿保存失败') })
        return 'failed' as const
      }
    })()
    inFlightRef.current = run.then(() => undefined)
    try {
      return await run
    } finally {
      inFlightRef.current = null
    }
  }, [conversationId, reloadServerCopy])

  const html = film?.html ?? null
  useEffect(() => {
    if (html === null || html === savedRef.current) return
    const timer = setTimeout(() => void saveNow(), debounceMs)
    return () => clearTimeout(timer)
  }, [html, debounceMs, saveNow])

  useEffect(
    () => () => {
      if (presentRef.current !== null && presentRef.current !== savedRef.current) void saveNow()
    },
    [saveNow],
  )

  useEffect(() => () => engineRef.current?.dispose(), [])

  /** 还没有成片时按 `canvas` 建一份；连着加两次素材也只建一份，后一次等前一次建好。 */
  const engineFor = useCallback(
    async (canvas: Canvas): Promise<Composition | null> => {
      if (engineRef.current !== null) return engineRef.current
      creatingRef.current ??= adopt(writeFilm({ canvas, blocks: [] }, catalog), false).finally(
        () => {
          creatingRef.current = null
        },
      )
      return creatingRef.current
    },
    [adopt, catalog],
  )

  /**
   * 把几段素材一段接一段放进成片：给了 `at` 就从那一行的那个时间放起（调用方保证那里空着），
   * 没给就接在第一行的末尾。`renumber` 是为它新开一行时别的块要换成的行号。
   * 每段都叠在最上面，写在根下第一个。还没有成片时先按 `canvas` 建一份。放不下时不动成片。
   */
  const addPictures = useCallback(
    async (
      canvas: Canvas,
      pictures: readonly NewPicture[],
      at?: Landing,
      renumber: Renumbering = NO_RENUMBERING,
    ): Promise<boolean> => {
      const engine = await engineFor(canvas)
      if (engine === null) return false
      const current = viewOf(engine)
      // 别的块先换成新的行号，后面都按换完的样子算
      const others = current.pictures.map((block) => ({
        ...block,
        track: renumber.get(block.id) ?? block.track,
      }))
      const track = at?.track ?? topTrack(others)
      const row = others.filter((block) => block.track === track)
      let end = at?.start ?? Math.max(0, ...row.map((block) => block.start + block.duration))
      const declared = new Set(engine.listVariables().map((variable) => variable.id))
      const existing = blocksOf(engine)
      engine.batch(() => {
        for (const [id, next] of renumber) engine.setTiming(id, { trackIndex: next })
        for (const [placed, picture] of pictures.entries()) {
          const variable = sourceVariable(picture.jobId, picture.src)
          if (!declared.has(variable.id)) {
            engine.declareVariable(variable)
            declared.add(variable.id)
          }
          const block = {
            ...picture,
            kind: 'picture' as const,
            id: newBlockId(),
            start: end,
            track,
            volume: 1,
            z: newBlockZ(existing, placed),
            hidden: false,
          }
          engine.addElement(FILM_ID, 0, pictureBlock(block))
          end += picture.duration
        }
        engine.dispatch({
          type: 'setCompositionMetadata',
          duration: Math.max(current.durationMs, end) / 1000,
        })
      })
      show(engine)
      return true
    },
    [engineFor, show],
  )

  /** 改成片里已有的东西：`change` 里的几步和成片总长一起算一步撤销。 */
  const edit = useCallback(
    (change: (engine: Composition) => void) => {
      const engine = engineRef.current
      if (engine === null) return
      engine.batch(() => {
        change(engine)
        engine.dispatch({
          type: 'setCompositionMetadata',
          duration: durationOf(picturesOf(engine)) / 1000,
        })
      })
      show(engine)
    },
    [show],
  )

  /** 改几个块各自的起止和入点，一起算一步撤销。 */
  const retime = useCallback(
    (timings: ReadonlyMap<string, Timing>) =>
      edit((engine) => {
        for (const [id, timing] of timings) {
          engine.setTiming(id, { start: timing.start / 1000, duration: timing.duration / 1000 })
          engine.setAttribute(id, 'data-media-start', String(timing.mediaStart / 1000))
        }
      }),
    [edit],
  )

  /**
   * 把一个块换到另一行的某个时间。`direction` 是它往上还是往下挪（null 时不调叠放顺序）：
   * 只重排它自己，别的块的叠放顺序和文件里的先后都不动。
   * `renumber` 是为它新开一行时别的块要换成的行号；`starts` 是和它一起挪的块各自的新起点，
   * 它们留在原来的行。都和它算一步撤销。
   */
  const moveBlock = useCallback(
    (
      id: string,
      at: Landing,
      direction: StackingDirection | null,
      renumber: Renumbering = NO_RENUMBERING,
      starts: ReadonlyMap<string, number> = NO_STARTS,
    ) =>
      edit((engine) => {
        for (const [other, next] of renumber) engine.setTiming(other, { trackIndex: next })
        for (const [other, start] of starts) engine.setTiming(other, { start: start / 1000 })
        engine.setTiming(id, { start: at.start / 1000, trackIndex: at.track })
        if (direction === null) return
        // 按挪完的样子算：一起挪的块的新起点、别的块的新行号都已写进去
        const z = restackedZ(blocksOf(engine), id, direction)
        if (z !== undefined) engine.setStyle(id, { zIndex: z > 0 ? String(z) : null })
      }),
    [edit],
  )

  /** 把几个块各自挪到新的起点，一起算一步撤销。 */
  const restart = useCallback(
    (starts: ReadonlyMap<string, number>) =>
      edit((engine) => {
        for (const [id, start] of starts) engine.setTiming(id, { start: start / 1000 })
      }),
    [edit],
  )

  /** 把几个块一起隐藏或显示回来，算一步撤销。 */
  const setHidden = useCallback(
    (ids: readonly string[], hidden: boolean) =>
      edit((engine) => {
        for (const id of ids) engine.setAttribute(id, 'data-hidden', hidden ? '' : null)
      }),
    [edit],
  )

  /** 删掉几个块；`ripple` 为真时第一行里后面的块往前补上。没有块再用的素材变量一起去掉。 */
  const removeBlocks = useCallback(
    (ids: readonly string[], ripple: boolean) =>
      edit((engine) => {
        const before = picturesOf(engine)
        const gone = new Set(ids)
        for (const id of gone) engine.removeElement(id)
        if (ripple)
          for (const [id, start] of rippleStarts(before, gone))
            engine.setTiming(id, { start: start / 1000 })
        // 文件里别的块（比如音频块）也绑着素材变量，按剩下的所有块算
        const used = new Set(
          engine.getElements().flatMap((element) => element.attributes['data-var-src'] ?? []),
        )
        for (const variable of engine.listVariables())
          if (!used.has(variable.id)) engine.removeVariableDeclaration(variable.id)
      }),
    [edit],
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
    addPictures,
    retime,
    moveBlock,
    restart,
    setHidden,
    removeBlocks,
    undo: () => step('undo'),
    redo: () => step('redo'),
    save,
    flush: () => void saveNow(),
    settle: async (): Promise<number | undefined> => {
      const outcome = await saveNow()
      return outcome === 'saved' || outcome === 'clean' ? revisionRef.current : undefined
    },
  }
}
