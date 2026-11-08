import { useState } from 'react'
import type { TranscriptTask } from '@/shared/transcript/vendor'

type Tasks = ReadonlyMap<string, TranscriptTask>

const toolTasksOf = (tasks: Tasks): Tasks =>
  new Map([...tasks].filter(([, task]) => task.kind === 'tool'))

const sameTasks = (a: Tasks, b: Tasks): boolean =>
  a.size === b.size && [...a].every(([taskId, task]) => b.get(taskId) === task)

export function useToolTasks(tasks: Tasks): Tasks {
  const [cache, setCache] = useState(() => ({ source: tasks, value: toolTasksOf(tasks) }))
  if (cache.source === tasks) return cache.value
  const next = toolTasksOf(tasks)
  const value = sameTasks(cache.value, next) ? cache.value : next
  setCache({ source: tasks, value })
  return value
}
