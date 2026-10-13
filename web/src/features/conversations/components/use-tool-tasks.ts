/** 后台工具任务（kind 为 tool）：输入框上方的小卡片、完成通知与原卡卡尾共用这一份。 */

import { useState } from 'react'
import type { TranscriptTask } from '@/shared/transcript/vendor'

type Tasks = ReadonlyMap<string, TranscriptTask>

const toolTasksOf = (tasks: Tasks): Tasks =>
  new Map([...tasks].filter(([, task]) => task.kind === 'tool'))

/** transcript 只换变了的任务对象，没变的引用照旧，逐个比引用就知道内容变没变。 */
const sameTasks = (a: Tasks, b: Tasks): boolean =>
  a.size === b.size && [...a].every(([taskId, task]) => b.get(taskId) === task)

/**
 * 从全部任务里挑出后台工具任务，按 taskId 查。只有工具任务变了才换新引用：
 * 各轮按引用 memo，子代理任务开始或结束不该把整段对话重渲一遍。
 */
export function useToolTasks(tasks: Tasks): Tasks {
  const [cache, setCache] = useState(() => ({ source: tasks, value: toolTasksOf(tasks) }))
  if (cache.source === tasks) return cache.value
  const next = toolTasksOf(tasks)
  const value = sameTasks(cache.value, next) ? cache.value : next
  setCache({ source: tasks, value })
  return value
}
