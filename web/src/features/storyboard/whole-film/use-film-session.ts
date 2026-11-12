import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Composition } from '@hyperframes/sdk'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import type { WholeFilmDraftOut } from '@/shared/api/generated/types.gen'
import type { ComponentCatalog } from './composition/catalog'
import {
  FILM_ID,
  MAX_FILM_MS,
  pictureBlock,
  pictureFromAttributes,
  sourceVariable,
  writeFilm,
  type Canvas,
  type PictureBlock,
} from './composition/film'
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
export const FILM_LIMIT_TEXT = '成片最长 2 分钟，这段放不下了'

const PICTURE_TRACK = 0

const viewOf = (engine: Composition): FilmView => {
  const elements = engine.getElements()
  const root = elements.find((element) => element.id === FILM_ID)
  const pictures = elements.flatMap((element) => {
    if (!element.classNames.includes('picture')) return []
    const block = pictureFromAttributes(element.id, element.attributes)
    return block === undefined ? [] : [block]
  })
  return {
    html: engine.serialize(),
    canvas: {
      width: Number(root?.attributes['data-width'] ?? 0),
      height: Number(root?.attributes['data-height'] ?? 0),
    },
    pictures,
    durationMs: Math.max(0, ...pictures.map((block) => block.start + block.duration)),
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

  /** 把几段素材接在画面那一行的末尾；还没有成片时先按 `canvas` 建一份。放不下时不动成片。 */
  const addPictures = useCallback(
    async (canvas: Canvas, pictures: readonly NewPicture[]): Promise<boolean> => {
      const engine = await engineFor(canvas)
      if (engine === null) return false
      const current = viewOf(engine)
      const row = current.pictures.filter((block) => block.track === PICTURE_TRACK)
      let end = Math.max(0, ...row.map((block) => block.start + block.duration))
      const total = pictures.reduce((sum, picture) => sum + picture.duration, end)
      if (total > MAX_FILM_MS) {
        noticeRef.current(FILM_LIMIT_TEXT)
        return false
      }
      const declared = new Set(engine.listVariables().map((variable) => variable.id))
      engine.batch(() => {
        pictures.forEach((picture, offset) => {
          const variable = sourceVariable(picture.jobId, picture.src)
          if (!declared.has(variable.id)) {
            engine.declareVariable(variable)
            declared.add(variable.id)
          }
          const block = {
            ...picture,
            id: newBlockId(),
            start: end,
            track: PICTURE_TRACK,
            volume: 1,
          }
          engine.addElement(FILM_ID, current.pictures.length + offset, pictureBlock(block))
          end += picture.duration
        })
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
