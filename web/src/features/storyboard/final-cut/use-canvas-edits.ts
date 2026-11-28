import { useCallback } from 'react'
import type { Canvas } from './composition/film'
import { engineAt, mainOf } from './film-files'
import { canvasOf, rootOf } from './film-view'
import { resizeCanvas } from './film-writes'
import type { ProjectSession } from './use-film-project'
import type { LayerEdit } from './use-film-session'

/** 画面上的编辑（见 `useFilmSession`）：挪、缩放、转图层，改画布尺寸和底色，每次都算一步撤销。 */
export function useCanvasEdits({ projectRef, edit }: ProjectSession) {
  /**
   * 在画面上挪、缩放、转了几层：各自写进它所在的文件（写法见 layer-edits.ts），算一步撤销。文件没打开着时那一层
   * 不写。
   */
  const editLayers = useCallback(
    (writes: readonly LayerEdit[]) => {
      const project = projectRef.current
      if (project === null) return
      edit(() => {
        for (const { file, element, move, styles } of writes) {
          const engine = engineAt(project, file)
          if (engine === undefined) continue
          if (move !== undefined)
            engine.dispatch({ type: 'moveElement', target: element, x: move.x, y: move.y })
          if (styles !== undefined) engine.setStyle(element, styles)
        }
      })
    },
    [edit, projectRef],
  )

  /** 修改工程画布尺寸为 `canvas` 并记为一步撤销（仅改画布本身，见 `resizeCanvas`）；尺寸未变或工程未就绪时忽略。 */
  const resize = useCallback(
    (canvas: Canvas) => {
      const project = projectRef.current
      if (project === null) return
      const before = canvasOf(mainOf(project))
      if (before.width === canvas.width && before.height === canvas.height) return
      edit((main, scene) => resizeCanvas(main, scene, canvas))
    },
    [edit, projectRef],
  )

  /**
   * 修改画布底色为 `color` 并记为一步撤销：写入主文件根节点行内样式以覆盖 `<head>` 模板底色（预览与导出均读取该主文件）。
   * 始终显式写入而不移除属性：移除行内样式在撤销重放时会被追加至样式末尾，导致序列化文本无法还原原貌。
   * 当前行内底色相同或工程未就绪时忽略。
   */
  const setBackground = useCallback(
    (color: string) => {
      const project = projectRef.current
      const root = project === null ? undefined : rootOf(mainOf(project))
      if (root === undefined || root.inlineStyles['backgroundColor'] === color) return
      edit((main) => main.setStyle(root.id, { backgroundColor: color }))
    },
    [edit, projectRef],
  )

  return { editLayers, resize, setBackground }
}
