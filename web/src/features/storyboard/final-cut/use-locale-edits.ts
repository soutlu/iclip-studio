import { useCallback } from 'react'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import type { ComponentCatalog, VariableValue } from './composition/catalog'
import { itemFonts, itemNamed, type HostClip } from './composition/film'
import { fieldText } from './composition/locale-text'
import { docOps, mainOf, openDoc, sceneOf, tablesOf } from './film-files'
import { allClipsOf, bindingsOf, clipsOf, hostBindingsOf } from './film-view'
import { followingByDefault, followLocale, pinField, writeDefault } from './film-writes'
import { createProjectFile, readLocaleFile, type StoredFile } from './final-cut.api'
import {
  localePath,
  localeValuesFile,
  SOURCE_LOCALE,
  translationOf,
  type Language,
  type LocaleCode,
} from './locales'
import type { TranslationSource } from './translation'
import type { ProjectSession } from './use-film-project'

/**
 * 元素和模板的取值、文字和多语言（见 `useFilmSession`）：改取值、改某种语言里的字、字段随语言还是固定、
 * 往语言值表里写翻译、加语言，编辑都算一步撤销。
 */
export function useLocaleEdits(
  conversationId: string,
  catalog: ComponentCatalog,
  { projectRef, noticeRef, addingLocaleRef, collect, perform, edit, setLocale }: ProjectSession,
) {
  /** 组件或块的片段 `id`；不在工程里时是 undefined。 */
  const hostClip = useCallback(
    (id: string): HostClip | undefined => {
      const project = projectRef.current
      const clip =
        project === null ? undefined : clipsOf(mainOf(project), catalog).find((c) => c.id === id)
      return clip?.kind === 'host' ? clip : undefined
    },
    [catalog, projectRef],
  )

  /**
   * 把组件或块的片段 `id` 的可填项取值整个换成 `values`（原文），宿主上的字体变量跟着重算，随语言的字段的根变量
   * 默认值跟着改成新的字，算一步撤销。片段已经不在工程里（比如改完还没提交就删掉了）时不动工程。
   */
  const setValues = useCallback(
    (id: string, values: Readonly<Record<string, VariableValue>>) => {
      const clip = hostClip(id)
      if (clip === undefined) return
      const item = itemNamed(catalog, clip.item)
      edit((current) => {
        current.setAttribute(id, 'data-variable-values', JSON.stringify(values))
        if (item !== undefined) current.setStyle(id, itemFonts(item, values, catalog))
        for (const [fieldId, variable] of Object.entries(bindingsOf(current, id))) {
          const field = item?.variables.find((candidate) => candidate.id === fieldId)
          if (field !== undefined)
            writeDefault(current, variable, field.label, fieldText(values, field))
        }
      })
    },
    [catalog, edit, hostClip],
  )

  /**
   * 把片段 `id` 的文字字段 `fieldId` 在语言 `locale` 里的字改成 `text`，算一步撤销。原文改的是宿主的取值
   * （见 `setValues`）；其它语言下随语言的字段改的是那种语言值表里它的根变量的值（`text` 是空的时去掉，回到用
   * 原文），固定的字段不改。字没变、片段不在了时不动工程。
   */
  const setItemText = useCallback(
    (id: string, fieldId: string, text: string, locale: Language) => {
      const project = projectRef.current
      const clip = hostClip(id)
      const field = itemNamed(catalog, clip?.item ?? '')?.variables.find((v) => v.id === fieldId)
      if (project === null || clip === undefined || field === undefined) return
      if (locale === SOURCE_LOCALE) {
        if (fieldText(clip.values, field) !== text)
          setValues(id, { ...clip.values, [fieldId]: text })
        return
      }
      const variable = bindingsOf(mainOf(project), id)[fieldId]
      const table = tablesOf(project).get(locale)
      const value = text === '' ? null : text
      if (variable === undefined || table === undefined) return
      if (translationOf(table.values(), variable) === value) return
      edit(() => table.set(variable, value))
    },
    [catalog, edit, hostClip, setValues, projectRef],
  )

  /**
   * 片段 `id` 的文字字段 `fieldId` 改成随语言（`follow`，见 `followLocale`）或固定（见 `pinField`），算一步撤销。
   * 已经是这样、片段不在了时不动工程。
   */
  const setFollowsLocale = useCallback(
    (id: string, fieldId: string, follow: boolean) => {
      const project = projectRef.current
      const clip = hostClip(id)
      const field = itemNamed(catalog, clip?.item ?? '')?.variables.find((v) => v.id === fieldId)
      if (project === null || clip === undefined || field === undefined) return
      if ((bindingsOf(mainOf(project), id)[fieldId] !== undefined) === follow) return
      edit((main, _scene, tables) => {
        if (follow) followLocale(main, clip, field)
        else pinField(main, tables.values(), id, fieldId)
      })
    },
    [catalog, edit, hostClip, projectRef],
  )

  /**
   * 往语言 `locale` 的值表里一次写进几条（变量 → 字），算一步撤销。`pick` 拿到这一刻的片段、随语言的字段和这种
   * 语言的值表，答复要写的。答复写了几条；工程里没有这种语言、一条都不写时不动工程，答 0。
   */
  const fillLocale = useCallback(
    (locale: LocaleCode, pick: (now: TranslationSource) => ReadonlyMap<string, string>): number => {
      const project = projectRef.current
      const table = project === null ? undefined : tablesOf(project).get(locale)
      if (project === null || table === undefined) return 0
      const main = mainOf(project)
      const clips = allClipsOf(main, sceneOf(project), catalog)
      const writes = pick({ clips, bindings: hostBindingsOf(main, clips), values: table.values() })
      // 一条都不写时不记一步（写总长也会报改动）
      if (writes.size === 0) return 0
      edit(() => {
        for (const [variable, text] of writes) table.set(variable, text)
      })
      return writes.size
    },
    [catalog, edit, projectRef],
  )

  /**
   * 加一种语言并切过去：在工作区里建一份空的值表（不进撤销）；建的时候已经有了（409）就用工作区里的那一份。
   * 这是工程里加的第一种语言时，接着把所有组件或块的片段的文字字段都改成随语言（见 `followingByDefault`），
   * 这一步单独算一步撤销（撤销后值表还在，字段都是固定的）。工程里已经有这种语言时直接切过去。建不了时提示原因，
   * 不切。
   */
  const addLocale = useCallback(
    async (locale: LocaleCode) => {
      const project = projectRef.current
      if (project === null) return
      const path = localePath(locale)
      if (!project.files.has(path)) {
        const first = tablesOf(project).size === 0
        const adding = (async () => {
          const content = localeValuesFile({})
          let stored: StoredFile | null
          try {
            stored = { content, version: await createProjectFile(conversationId, path, content) }
          } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 409) throw error
            stored = await readLocaleFile(conversationId, locale)
            if (stored === null) throw error
          }
          const doc = await openDoc(path, stored.content, collect, false)
          // 工程在这期间换过了（比如别处改了）：换上来的那一份里有没有这种语言由它自己说了算
          if (projectRef.current !== project) return
          project.files.set(path, { doc, version: stored.version, saved: docOps(doc).serialize() })
          if (!first) return
          const main = mainOf(project)
          const following = clipsOf(main, catalog).flatMap((clip) => {
            const item = clip.kind === 'host' ? itemNamed(catalog, clip.item) : undefined
            return clip.kind !== 'host' || item === undefined
              ? []
              : followingByDefault(main, clip, item).map((field) => ({ clip, field }))
          })
          // 一个要改的字段都没有时不记一步（写总长也会报改动）
          if (following.length > 0)
            perform(project, () => {
              for (const { clip, field } of following) followLocale(main, clip, field)
            })
        })()
        addingLocaleRef.current = adding.catch(() => undefined)
        try {
          await adding
        } catch (error) {
          noticeRef.current(errorMessageOf(error, '语言添加失败，请重试'))
          return
        } finally {
          addingLocaleRef.current = null
        }
      }
      setLocale(locale)
    },
    [catalog, collect, conversationId, perform, setLocale, addingLocaleRef, noticeRef, projectRef],
  )

  return { setValues, setItemText, setFollowsLocale, fillLocale, addLocale }
}
