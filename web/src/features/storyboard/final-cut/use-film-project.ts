import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { HF_AUDIO_AUTOMATION_ATTR } from '@hyperframes/core/audio-automation'
import type { Composition } from '@hyperframes/sdk'
import { CAPTION_FOLLOW_REFUSAL_TEXT } from './caption-edit'
import { curvesFollowing } from './clip-automation'
import type { ComponentCatalog } from './composition/catalog'
import { PROJECT_MAIN } from './composition/film'
import {
  disposeAll,
  docOps,
  mainOf,
  openDoc,
  sceneOf,
  storedFilesOf,
  tablesOf,
  type OpenFile,
  type Project,
} from './film-files'
import { allClipsOf, clipsOf, viewOf } from './film-view'
import { CaptionsBlocked, followClips, writeTotal } from './film-writes'
import type { StoredProject } from './final-cut.api'
import { SOURCE_LOCALE, type Language, type LocaleCode, type ValueTable } from './locales'
import { createUndoHistory, type PatchChange, type UndoStep } from './undo-history'
import type { FilmView } from './use-film-session'

const STALE_NOTICE = 'final-cut 已在别处修改，已切换到最新版本；未保存的改动已放弃'
const CAPTIONS_MISSING_TEXT = '字幕文件不存在，已按没有字幕打开 final-cut'

const STEP_FAILED_TEXT = {
  undo: '撤销失败，已清空撤销记录',
  redo: '重做失败，已清空撤销记录',
} as const

/** `useFilmProject` 给保存和各组编辑动作用的：工程、现在的样子，和改工程、换工程的入口。 */
export type ProjectSession = ReturnType<typeof useFilmProject>

/**
 * final-cut 编辑会话里打开着的工程（见 `useFilmSession`）：打开 `initial`、换成别处改的那一份（`adoptStored`），
 * 编辑动作经 `perform` / `edit` 改它并记撤销，`show` 读出现在的样子（`film`），撤销重做（`step`），切换显示的语言。
 * 保存不在这里（见 `useFilmSaving`）。
 */
export function useFilmProject(
  initial: StoredProject,
  catalog: ComponentCatalog,
  onNotice: (message: string) => void,
  onMissing: () => void,
) {
  const [film, setFilm] = useState<FilmView | null>(null)
  const projectRef = useRef<Project | null>(null)
  const [history] = useState(createUndoHistory)
  // 正在做的编辑动作里引擎报的改动，做完记成一步撤销
  const stepRef = useRef<PatchChange[] | null>(null)
  // 正在加的语言：建好值表文件、放进工程之前，检查别处的改动要等它
  const addingLocaleRef = useRef<Promise<void> | null>(null)
  // 当前显示的语言：编辑器自己的状态，不存进文件
  const localeRef = useRef<Language>(SOURCE_LOCALE)
  // 各文件现在的内容（路径 → 内容），和 `saved` 不一样的就是没存的
  const presentRef = useRef<ReadonlyMap<string, string>>(new Map())
  const noticeRef = useRef(onNotice)
  const missingRef = useRef(onMissing)
  useLayoutEffect(() => {
    noticeRef.current = onNotice
    missingRef.current = onMissing
  })
  const revisionRef = useRef(0)
  // 上次读过以后做完的编辑（编辑动作、撤销、重做）里的改动，下次读的那一份带着（见 `FilmView.step`）
  const doneRef = useRef<UndoStep | null>(null)

  /** 改动都从这里发出，改完读一遍现在的样子。 */
  const show = useCallback(() => {
    const project = projectRef.current
    const change = { revision: (revisionRef.current += 1), step: doneRef.current }
    doneRef.current = null
    const shown =
      project === null ? null : viewOf(project, catalog, history, localeRef.current, change)
    presentRef.current = shown?.present ?? new Map()
    setFilm(shown?.view ?? null)
  }, [catalog, history])

  /** 记下做完的一步编辑，交给下次读的那一份；读之前又做了几步时接在后面。 */
  const done = useCallback((step: UndoStep) => {
    doneRef.current = [...(doneRef.current ?? []), ...step]
  }, [])

  const collect = useCallback((change: PatchChange) => {
    stepRef.current?.push(change)
  }, [])

  /**
   * 编辑动作都从这里改工程：`change` 和工程总长在一批操作里做完（每个打开着的文件各一批，里面抛出时都退回），
   * 引擎报的改动不管改了几个文件都记成一步撤销。
   */
  const perform = useCallback(
    (project: Project, change: () => void) => {
      const main = mainOf(project)
      const others = [...project.files]
        .filter(([path]) => path !== PROJECT_MAIN)
        .map(([, file]) => docOps(file.doc))
      const step: PatchChange[] = []
      stepRef.current = step
      try {
        main.batch(() => {
          others.reduce<() => void>((inner, doc) => () => doc.batch(inner), change)()
          writeTotal(main, sceneOf(project))
        })
      } finally {
        stepRef.current = null
      }
      history.record(step)
      done(step)
    },
    [history, done],
  )

  /**
   * 切换当前会话持有的工程实例并清空撤销栈；`stored` 为真时将各文件当前序列化内容标记为已同步基线。
   * 若当前展示语言在新工程中无对应值表，自动回退至原文。
   */
  const install = useCallback(
    (project: Project, stored: boolean) => {
      disposeAll(projectRef.current)
      history.clear()
      doneRef.current = null
      projectRef.current = project
      const locale = localeRef.current
      if (locale !== SOURCE_LOCALE && !tablesOf(project).has(locale))
        localeRef.current = SOURCE_LOCALE
      show()
      if (stored)
        for (const [path, file] of project.files) file.saved = presentRef.current.get(path) ?? null
    },
    [history, show],
  )

  /**
   * 打开工作区已落盘的工程快照 `stored`（见 `readProject`）：依次加载主文件、字幕场景文件与各语言值表；
   * 若主文件存在字幕宿主但场景文件缺失，则按无字幕状态打开并给出提示。
   */
  const openStored = useCallback(
    async (stored: StoredProject): Promise<Project> => {
      if (stored.captions === null && stored.hosted) noticeRef.current(CAPTIONS_MISSING_TEXT)
      const files = new Map<string, OpenFile>()
      for (const [path, file] of storedFilesOf(stored))
        if (file !== null)
          files.set(path, {
            doc: await openDoc(path, file.content, collect, path === stored.captionsPath),
            version: file.version,
            saved: null,
          })
      return { files, captionsPath: stored.captionsPath }
    },
    [collect],
  )

  const [initialProject] = useState(initial)
  useEffect(() => {
    let cancelled = false
    void openStored(initialProject).then((project) => {
      if (cancelled) {
        disposeAll(project)
        return
      }
      install(project, true)
    })
    return () => {
      cancelled = true
    }
  }, [initialProject, install, openStored])

  /**
   * 采纳工作区最新快照 `stored`，放弃本地未保存改动并提示用户。
   * 若主文件已被删除（`stored === null`），则彻底卸载工程（停止后续及卸载补存）并回调 `onMissing`。
   */
  const adoptStored = useCallback(
    async (stored: StoredProject | null) => {
      if (stored === null) {
        disposeAll(projectRef.current)
        projectRef.current = null
        history.clear()
        missingRef.current()
        return
      }
      install(await openStored(stored), true)
      noticeRef.current(STALE_NOTICE)
    },
    [history, install, openStored],
  )

  /**
   * 执行工程编辑事务：`change` 接收主文件、字幕场景（可能为 `undefined`）与各语言值表，所有变更连同总时长重算合并为一步撤销。
   * 关联字幕随视频或配音片段同步位移（见 `followClips`，无法跟随时回滚整步并提示原因）；
   * 发生位移、裁切起点、调整入点或变速的有声片段同步修正音量曲线（见 `curvesFollowing`）。
   * 返回本次事务是否成功生效（工程未就绪或整步回滚时返回 `false`）。
   */
  const edit = useCallback(
    (
      change: (
        main: Composition,
        scene: Composition | undefined,
        tables: ReadonlyMap<LocaleCode, ValueTable>,
      ) => void,
    ): boolean => {
      const project = projectRef.current
      if (project === null) return false
      const main = mainOf(project)
      const tables = tablesOf(project)
      let applied = true
      try {
        perform(project, () => {
          const scene = sceneOf(project)
          const before = allClipsOf(main, scene, catalog)
          change(main, scene, tables)
          if (scene !== undefined) followClips(main, scene, tables.values(), before, catalog)
          for (const [id, automation] of curvesFollowing(before, clipsOf(main, catalog)))
            main.setAttribute(id, HF_AUDIO_AUTOMATION_ATTR, automation)
        })
      } catch (error) {
        // 一批操作里抛出时引擎已经整批退回
        if (!(error instanceof CaptionsBlocked)) throw error
        noticeRef.current(CAPTION_FOLLOW_REFUSAL_TEXT[error.reason])
        applied = false
      }
      show()
      return applied
    },
    [catalog, perform, show],
  )

  /** 工程里文件 `path`（相对工程根）现在的内容（没存的改动也在里面）；没打开着时是 undefined。 */
  const contentOf = useCallback((path: string) => presentRef.current.get(path), [])

  /** 切换显示的语言（不进撤销、不改文件）；工程里没有这种语言的值表时不切。 */
  const setLocale = useCallback(
    (locale: Language) => {
      const project = projectRef.current
      if (project === null || (locale !== SOURCE_LOCALE && !tablesOf(project).has(locale))) return
      localeRef.current = locale
      doneRef.current = null
      show()
    },
    [show],
  )

  const step = (direction: 'undo' | 'redo') => {
    const project = projectRef.current
    const changes = project === null ? undefined : history[direction]()
    if (project === null || changes === undefined) return
    const before = presentRef.current
    try {
      for (const change of changes) {
        const file = project.files.get(change.file)
        if (file === undefined) throw new Error(`撤销记录里的文件没有打开：${change.file}`)
        docOps(file.doc).applyPatches(change.patches)
      }
    } catch (error) {
      console.error('final-cut 撤销重做失败', error)
      noticeRef.current(STEP_FAILED_TEXT[direction])
      // 补丁可能只应用了一半：各文件都换回应用之前的那一份，撤销记录跟着清空
      void restore(project, before)
      return
    }
    done(changes)
    show()
  }

  /** 把工程的各文件换成 `contents` 里的内容（路径 → 内容），版本号和已存的那一份不变，撤销记录清空。 */
  const restore = async (project: Project, contents: ReadonlyMap<string, string>) => {
    const files = await Promise.all(
      [...project.files].map(
        async ([path, file]) =>
          [
            path,
            {
              ...file,
              doc: await openDoc(
                path,
                contents.get(path) ?? docOps(file.doc).serialize(),
                collect,
                path === project.captionsPath,
              ),
            },
          ] as const,
      ),
    )
    install({ files: new Map(files), captionsPath: project.captionsPath }, false)
  }

  return {
    film,
    projectRef,
    presentRef,
    addingLocaleRef,
    noticeRef,
    collect,
    perform,
    edit,
    show,
    adoptStored,
    contentOf,
    setLocale,
    step,
  }
}
