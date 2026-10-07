import { useMemo, useState } from 'react'
import {
  collapsedBelowRoot,
  defaultCollapsed,
  layoutJson,
  type JsonLine,
  type JsonPath,
  type JsonValue,
} from './json-format'

const NO_PATHS: ReadonlySet<JsonPath> = new Set()

export type JsonFold = {
  lines: JsonLine[]
  /** 根下面还有可收起的层级时，页头才给「全部收起 / 全部展开」。 */
  canFoldAll: boolean
  /** 第一层起的容器是否都已收起；决定页头按钮是「全部展开」还是「全部收起」。 */
  foldedAll: boolean
  toggle: (path: JsonPath) => void
  foldAll: () => void
  unfoldAll: () => void
}

/**
 * 收起状态只存在组件里。用户动手之前跟着内容走默认规则（见 defaultCollapsed）；动过之后按路径记住，
 * 文件被改写后同一路径的收起状态保留。
 */
export const useJsonFold = (value: JsonValue | undefined): JsonFold => {
  const [chosen, setChosen] = useState<ReadonlySet<JsonPath> | null>(null)
  const initial = useMemo(() => (value === undefined ? NO_PATHS : defaultCollapsed(value)), [value])
  const belowRoot = useMemo(
    () => (value === undefined ? NO_PATHS : collapsedBelowRoot(value)),
    [value],
  )
  const collapsed = chosen ?? initial
  const lines = useMemo(
    () => (value === undefined ? [] : layoutJson(value, collapsed)),
    [value, collapsed],
  )
  return {
    canFoldAll: belowRoot.size > 0,
    foldAll: () => setChosen(belowRoot),
    foldedAll: belowRoot.size > 0 && [...belowRoot].every((path) => collapsed.has(path)),
    lines,
    toggle: (path) => {
      const next = new Set(collapsed)
      if (!next.delete(path)) next.add(path)
      setChosen(next)
    },
    unfoldAll: () => setChosen(NO_PATHS),
  }
}
