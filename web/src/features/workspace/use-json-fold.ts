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
  canFoldAll: boolean
  foldedAll: boolean
  toggle: (path: JsonPath) => void
  foldAll: () => void
  unfoldAll: () => void
}

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
