import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import type { zTaskCreateIn, zTaskIn } from '@/shared/api/generated/zod.gen'
import { zTaskEnvelope, zTasksPageOut } from '@/shared/api/generated/zod.gen'

export type Task = z.output<typeof zTaskEnvelope>['task']
export type TasksPage = z.output<typeof zTasksPageOut>
export type TaskIn = z.input<typeof zTaskIn>
export type TaskCreateIn = z.input<typeof zTaskCreateIn>

export type TaskListScope = 'all' | 'mine'

const taskEnvelopeSchema = zTaskEnvelope.transform((payload) => payload.task)

const PAGE_LIMIT = 100

export const tasksQueryKeys = {
  all: ['tasks'] as const,
  list: (scope: TaskListScope) => ['tasks', 'list', scope] as const,
  options: ['tasks', 'options'] as const,
  byIds: (ids: readonly string[]) => ['tasks', 'by-ids', ids] as const,
  detail: (taskId: string) => ['tasks', 'detail', taskId] as const,
}

const listParams = (scope: TaskListScope, cursor: string | null): URLSearchParams => {
  const params = new URLSearchParams({ limit: String(PAGE_LIMIT) })
  if (scope === 'mine') params.set('claimedBy', 'me')
  if (cursor !== null) params.set('cursor', cursor)
  return params
}

export const fetchTasksPage = async (
  scope: TaskListScope,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<TasksPage> =>
  apiFetch(`/tasks?${listParams(scope, cursor).toString()}`, zTasksPageOut, {
    cache: 'no-store',
    fallbackErrorMessage: scope === 'mine' ? '读取我的需求单失败' : '读取需求单列表失败',
    signal: signal ?? null,
  })

export const useTasksPages = (scope: TaskListScope, enabled: boolean) =>
  useInfiniteQuery({
    enabled,
    queryFn: ({ pageParam, signal }) => fetchTasksPage(scope, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last: TasksPage) => last.nextCursor,
    queryKey: tasksQueryKeys.list(scope),
  })

export const useTaskOptions = (enabled: boolean) =>
  useQuery({
    enabled,
    queryFn: ({ signal }) => fetchTasksPage('all', null, signal),
    queryKey: tasksQueryKeys.options,
    select: (page) => page.items.map((task) => ({ id: task.id, label: task.title })),
  })

export const listTasksByIds = async (
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<Task[]> => {
  const params = new URLSearchParams({ limit: String(ids.length) })
  for (const id of ids) params.append('ids', id)
  const page = await apiFetch(`/tasks?${params.toString()}`, zTasksPageOut, {
    cache: 'no-store',
    fallbackErrorMessage: '读取需求单失败',
    signal: signal ?? null,
  })
  return page.items
}

export const getTask = async (taskId: string, signal?: AbortSignal): Promise<Task> =>
  apiFetch(`/tasks/${taskId}`, taskEnvelopeSchema, {
    cache: 'no-store',
    fallbackErrorMessage: '读取需求单失败',
    signal: signal ?? null,
  })

export const createTask = async (body: TaskCreateIn): Promise<Task> =>
  apiFetch('/tasks', taskEnvelopeSchema, {
    body,
    fallbackErrorMessage: '新建需求单失败',
    method: 'POST',
  })

export const saveTask = async (taskId: string, body: TaskIn): Promise<Task> =>
  apiFetch(`/tasks/${taskId}`, taskEnvelopeSchema, {
    body,
    fallbackErrorMessage: '保存需求单失败',
    method: 'PUT',
  })

export const publishTask = async (taskId: string): Promise<Task> =>
  apiFetch(`/tasks/${taskId}/publish`, taskEnvelopeSchema, {
    fallbackErrorMessage: '发布失败',
    method: 'POST',
  })

export const claimTask = async (taskId: string): Promise<Task> =>
  apiFetch(`/tasks/${taskId}/confirm`, taskEnvelopeSchema, {
    fallbackErrorMessage: '认领失败',
    method: 'POST',
  })

export const withdrawTask = async (taskId: string): Promise<Task> =>
  apiFetch(`/tasks/${taskId}/withdraw`, taskEnvelopeSchema, {
    fallbackErrorMessage: '撤回失败',
    method: 'POST',
  })
