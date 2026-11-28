import { useCallback, useRef } from 'react'
import type { Composition } from '@hyperframes/sdk'
import { ApiError, errorMessageOf } from '@/shared/api/client'
import type { NewCaption } from './caption-edit'
import {
  captionElement,
  captionsHostElement,
  captionsScene,
  captionStyleOf,
  captionStyleRule,
  captionStyleRuleIn,
  captionStyles,
  captionVariable,
  clearedCaptionStyles,
  ownCaptionStyles,
  ownsStyle,
  type CaptionStyle,
} from './composition/captions'
import type { ComponentCatalog } from './composition/catalog'
import type { FilmClip } from './composition/film'
import type { NewDub } from './dubbing'
import { docOps, mainOf, openDoc, sceneOf, sheetOf, tablesOf, type Project } from './film-files'
import { allClipsOf, canvasOf, captionsById, captionsHostOf, declares, rootOf } from './film-view'
import { addDubElements } from './film-writes'
import { createProjectFile, readProjectFile, type StoredFile } from './final-cut.api'
import { SOURCE_LOCALE, translationOf, type Language } from './locales'
import type { ProjectSession } from './use-film-project'

/**
 * 字幕编辑（见 `useFilmSession`）：加字幕（还没有字幕场景时先建）、改某种语言里的字、单句样式、字幕样式和
 * 「单独设置」，编辑都算一步撤销。
 */
export function useCaptionEdits(
  conversationId: string,
  catalog: ComponentCatalog,
  { projectRef, noticeRef, collect, perform, edit, show }: ProjectSession,
) {
  const creatingCaptionsRef = useRef<Promise<Composition | undefined> | null>(null)

  /**
   * 工程里的字幕场景文件，还没有时先在工作区里建一份空的（不进撤销）；建的时候已经有了（409，比如加了又撤销
   * 留下的空文件）就用工作区里的那一份。连着加两句也只建一次。工程在这期间换过了时答复 undefined。
   */
  const captionsFile = useCallback(
    async (project: Project): Promise<Composition | undefined> => {
      const opened = sceneOf(project)
      if (opened !== undefined) return opened
      creatingCaptionsRef.current ??= (async () => {
        const path = project.captionsPath
        const content = captionsScene(canvasOf(mainOf(project)), catalog)
        let stored: StoredFile | null
        try {
          stored = { content, version: await createProjectFile(conversationId, path, content) }
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 409) throw error
          stored = await readProjectFile(conversationId, path)
          if (stored === null) throw error
        }
        const doc = await openDoc(path, stored.content, collect, true)
        const ops = docOps(doc)
        if (projectRef.current !== project || doc.kind !== 'composition') {
          ops.dispose()
          return undefined
        }
        // 打开后 SDK 存出的样子当作已存的那一份，不然一打开就算有改动
        project.files.set(path, { doc, version: stored.version, saved: ops.serialize() })
        return doc.engine
      })().finally(() => {
        creatingCaptionsRef.current = null
      })
      return creatingCaptionsRef.current
    },
    [catalog, collect, conversationId, projectRef],
  )

  /**
   * 批量添加字幕并记为一步撤销：按需预先创建空字幕场景文件，再基于当前全部片段调用 `captionsFor` 生成字幕项，
   * 按起始时间插入场景节点并在主文件根节点声明对应变量（尚无字幕宿主时追加至根节点末尾）。
   * 传入 `narration` 时同步为每句在「配音」行创建对齐的旁白音频片段（见 `addDubElements`，带着合成时的记录），
   * 同属一步撤销。
   * 返回新建字幕 ID 列表（无新增项时返回空数组且不修改工程）；工程未就绪或字幕场景文件创建失败（已提示原因）时返回 `undefined`。
   */
  const addCaptions = useCallback(
    async (
      captionsFor: (clips: readonly FilmClip[]) => readonly NewCaption[],
      narration?: Pick<NewDub, 'src' | 'label' | 'text' | 'voice' | 'speed' | 'trimmed'>,
    ): Promise<string[] | undefined> => {
      const project = projectRef.current
      if (project === null) return undefined
      let scene: Composition | undefined
      try {
        scene = await captionsFile(project)
      } catch (error) {
        noticeRef.current(errorMessageOf(error, '字幕文件新建失败，请重试'))
        return undefined
      }
      const main = mainOf(project)
      const root = rootOf(main)
      const sceneRoot = scene === undefined ? undefined : rootOf(scene)
      if (scene === undefined || root === undefined || sceneRoot === undefined) return undefined
      const captions = captionsFor(allClipsOf(main, scene, catalog)).map((caption) => {
        const key = crypto.randomUUID().slice(0, 8)
        return { ...caption, id: `cap-${key}`, variable: `cap_${key}` }
      })
      if (captions.length === 0) return []
      perform(project, () => {
        if (captionsHostOf(main) === undefined)
          main.addElement(root.id, root.children.length, captionsHostElement(canvasOf(main), 0))
        for (const caption of captions) {
          // 按加过前面几句的样子找位置
          const timings = scene.getElementTimings()
          const children = rootOf(scene)?.children ?? []
          const later = children.findIndex(
            (child) => (timings[child.id]?.enterAt ?? -Infinity) * 1000 > caption.start,
          )
          scene.addElement(
            sceneRoot.id,
            later === -1 ? children.length : later,
            captionElement(caption),
          )
          main.declareVariable(captionVariable(caption))
        }
        if (narration !== undefined)
          addDubElements(
            main,
            catalog,
            root.id,
            SOURCE_LOCALE,
            captions.map(({ id, start, duration }) => ({
              ...narration,
              caption: id,
              start,
              duration,
              mediaStart: 0,
              playbackRate: 1,
            })),
          )
      })
      show()
      return captions.map((caption) => caption.id)
    },
    [captionsFile, catalog, perform, show, noticeRef, projectRef],
  )

  /**
   * 把字幕 `id` 在语言 `locale` 里的字改成 `text`，算一步撤销。原文改的是主文件根上它的变量的默认值（还没声明时
   * 声明上），场景里那个元素的字也改成一样的。其它语言改的是那种语言的值表里这个变量的值，`text` 是空的时从
   * 值表里去掉（回到用原文），原文不动。字没变、字幕已经不在了、没有这种语言时不动工程。
   */
  const setCaptionText = useCallback(
    (id: string, text: string, locale: Language) => {
      const project = projectRef.current
      const scene = project === null ? undefined : sceneOf(project)
      const caption = project === null ? undefined : captionsById(mainOf(project), scene).get(id)
      if (project === null || scene === undefined || caption === undefined) return
      if (locale !== SOURCE_LOCALE) {
        const table = tablesOf(project).get(locale)
        const value = text === '' ? null : text
        if (table === undefined || caption.variable === '') return
        if (translationOf(table.values(), caption.variable) === value) return
        edit(() => table.set(caption.variable, value))
        return
      }
      if (caption.text === text) return
      edit((main) => {
        if (caption.variable !== '') {
          if (declares(main, caption.variable)) main.setVariableValue(caption.variable, text)
          else main.declareVariable(captionVariable({ variable: caption.variable, text }))
        }
        scene.setText(id, text)
      })
    },
    [edit, projectRef],
  )

  /**
   * 改字幕 `id` 单独设置的字体、字色、字号（`changes` 里给了的那几样，null 是去掉这一样，写法见 `captionStyles`），
   * 所有语言共用，算一步撤销。和现在一样、字幕已经不在了时不动工程。
   *
   * @throws Error 字体不在组件库里，字色不是 `#rrggbb`，或字号不在范围里
   */
  const setCaptionStyle = useCallback(
    (id: string, changes: Partial<CaptionStyle>) => {
      const project = projectRef.current
      const scene = project === null ? undefined : sceneOf(project)
      const caption = project === null ? undefined : captionsById(mainOf(project), scene).get(id)
      if (project === null || scene === undefined || caption === undefined) return
      const styles = captionStyles(changes, catalog, canvasOf(mainOf(project)))
      const changed =
        (changes.font !== undefined && changes.font !== caption.font) ||
        (changes.color !== undefined && changes.color !== caption.color) ||
        (changes.fontSize !== undefined && changes.fontSize !== caption.fontSize)
      if (changed) edit(() => scene.setStyle(id, styles))
    },
    [catalog, edit, projectRef],
  )

  /**
   * 改字幕样式（`changes` 里给了的那几样，null 是去掉这一样、回到默认规则，写法见 `captionStyleRule`），没开单独
   * 设置的句子一起变，所有语言共用，算一步撤销。和现在一样、还没有字幕场景时不动工程。
   *
   * @throws Error 字体不在组件库里，字色不是 `#rrggbb`，字号不在范围里，或字幕场景里没有能写规则的 `<style>`
   */
  const setCaptionTrackStyle = useCallback(
    (changes: Partial<CaptionStyle>) => {
      const project = projectRef.current
      const sheet = project === null ? undefined : sheetOf(project)
      const file = project?.files.get(project.captionsPath)
      if (project === null || sheet === undefined || file === undefined) return
      const before = sheet.rule()
      const rule = captionStyleRule(
        captionStyleOf(before ?? ''),
        changes,
        catalog,
        canvasOf(mainOf(project)),
      )
      if (rule === before) return
      edit(() => {
        sheet.set(rule)
        // 手写的场景可能没有 <style>：写不进去时整步退回，不当成改好了
        if (captionStyleRuleIn(docOps(file.doc).serialize()) !== rule)
          throw new Error('字幕文件里没有样式表，无法设置字幕样式')
      })
    },
    [catalog, edit, projectRef],
  )

  /**
   * 打开或关闭字幕 `id` 的「单独设置」，算一步撤销。打开时把这一刻显示的字体、字色、字号都写到这一句上（见
   * `ownCaptionStyles`），画面不变，之后改字幕样式它不跟着变；关闭时去掉这一句自己的这几样（见
   * `clearedCaptionStyles`），回到跟着字幕样式。已经是这样、字幕已经不在了时不动工程。
   */
  const setCaptionOwnStyle = useCallback(
    (id: string, own: boolean) => {
      const project = projectRef.current
      const scene = project === null ? undefined : sceneOf(project)
      const caption = project === null ? undefined : captionsById(mainOf(project), scene).get(id)
      if (project === null || scene === undefined || caption === undefined) return
      if (ownsStyle(caption) === own) return
      const styles = own
        ? ownCaptionStyles(
            captionStyleOf(sheetOf(project)?.rule() ?? ''),
            catalog,
            canvasOf(mainOf(project)),
          )
        : clearedCaptionStyles(catalog)
      edit(() => scene.setStyle(id, styles))
    },
    [catalog, edit, projectRef],
  )

  return {
    addCaptions,
    setCaptionText,
    setCaptionStyle,
    setCaptionTrackStyle,
    setCaptionOwnStyle,
  }
}
