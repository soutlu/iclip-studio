import { useQuery, type QueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError, apiFetch, UserFacingError } from '@/shared/api/client'
import type { FinalCutPreviewOut, MusicIn } from '@/shared/api/generated/types.gen'
import {
  zCancelWholeFilmExportConversationsConversationIdWholeFilmExportsExportIdDeleteResponse as zExportCancelled,
  zConversationEnvelope,
  zConversationFileEnvelope,
  zFinalCutFileCreatedOut,
  zFinalCutPreviewOut,
  zGenerationEnvelope,
  zLatestWholeFilmExportConversationsConversationIdWholeFilmExportsLatestGetResponse as zLatestExport,
} from '@/shared/api/generated/zod.gen'
import {
  generationsRefetchInterval,
  readAllGenerations,
  storyboardQueryKeys,
  type GenerationJob,
} from '../storyboard.api'
import type { CatalogItem, ComponentCatalog } from './composition/catalog'
import { PROJECT_MAIN } from './composition/film'

/** final-cut 工程在对话工作区里的目录。 */
export const PROJECT_DIR = 'final-cut'

/** 主文件在工作区里的路径。 */
export const PROJECT_MAIN_PATH = `${PROJECT_DIR}/${PROJECT_MAIN}`

const READ_FAILED = 'final-cut 读取失败'
const SAVE_FAILED = 'final-cut 保存失败'
const ITEM_FILES_FAILED = '贴片和场景读取失败'

export const wholeFilmQueryKeys = {
  // 不挂在工作区文件下面：工作台宿主每次文件变化都让工作区文件的查询失效，挂在下面的话一存就会重读
  project: (conversationId: string) => ['final-cut', 'project', conversationId] as const,
  latestExport: (conversationId: string) =>
    ['whole-film', 'export', 'latest', conversationId] as const,
  // 挂在对话的生成记录下面：生成记录有变化时跟着刷新
  music: (conversationId: string) =>
    [...storyboardQueryKeys.conversation(conversationId), 'audio'] as const,
  preview: (conversationId: string) => ['whole-film', 'preview', conversationId] as const,
  task: (conversationId: string) => ['whole-film', 'task', conversationId] as const,
}

/** 工程主文件：内容和工作区里的版本号。 */
export type ProjectMain = { content: string; version: number }

const conversationPath = (conversationId: string) =>
  `/conversations/${encodeURIComponent(conversationId)}`

/** 读工程主文件；还没有工程（文件不存在）时是 null。 */
export const readProjectMain = async (
  conversationId: string,
  signal?: AbortSignal,
): Promise<ProjectMain | null> => {
  try {
    const { file } = await apiFetch(
      `${conversationPath(conversationId)}/workspace/file?path=${encodeURIComponent(PROJECT_MAIN_PATH)}`,
      zConversationFileEnvelope,
      { fallbackErrorMessage: READ_FAILED, ...(signal === undefined ? {} : { signal }) },
    )
    return { content: file.content, version: file.version }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

/** 在工程里新建一个文件（`path` 相对工程根），答复工作区里的版本号；已经有这个文件时是 409。 */
export const createProjectFile = async (
  conversationId: string,
  path: string,
  content: string,
): Promise<number> =>
  (
    await apiFetch(`${conversationPath(conversationId)}/final-cut/files`, zFinalCutFileCreatedOut, {
      body: { path, content },
      fallbackErrorMessage: SAVE_FAILED,
      method: 'POST',
    })
  ).version

/** 按读到的版本整份写工程主文件，答复新的版本号；版本对不上时是 409。 */
export const writeProjectMain = async (
  conversationId: string,
  content: string,
  expectedVersion: number,
): Promise<number> =>
  (
    await apiFetch(
      `${conversationPath(conversationId)}/workspace/file`,
      zConversationFileEnvelope,
      {
        body: { path: PROJECT_MAIN_PATH, content, expectedVersion },
        fallbackErrorMessage: SAVE_FAILED,
        method: 'PUT',
      },
    )
  ).file.version

/**
 * 把组件库条目的文件按原路径拷进工程（`files` 见目录），逐个新建；工程里已经有的（409）跳过，
 * 已经拷进来的就属于这个工程，不再跟着组件库变。
 */
export const copyItemFiles = async (
  conversationId: string,
  catalog: ComponentCatalog,
  item: CatalogItem,
): Promise<void> => {
  for (const path of item.files) {
    const response = await fetch(`/hyperframes/${catalog.version}/${path}`)
    if (!response.ok) throw new UserFacingError(ITEM_FILES_FAILED)
    const content = await response.text()
    try {
      await createProjectFile(conversationId, path, content)
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error
    }
  }
}

// 编辑器卸载时还没存完的保存，按对话记着，存完就去掉
const closingSaves = new Map<string, Promise<void>>()

/**
 * 编辑器卸载时调用：`saving` 结束之前，这段对话的编辑器再打开也先不读工程主文件。
 * 不等的话会读到存之前的一版，随后的保存因版本号过期被拒，刚才的改动跟着丢掉。
 */
export const holdProjectReads = (conversationId: string, saving: Promise<unknown>) => {
  const previous = closingSaves.get(conversationId)
  const settled = Promise.allSettled([previous, saving]).then(() => undefined)
  closingSaves.set(conversationId, settled)
  void settled.then(() => {
    if (closingSaves.get(conversationId) === settled) closingSaves.delete(conversationId)
  })
}

export const useProjectMainQuery = (conversationId: string) =>
  useQuery({
    queryKey: wholeFilmQueryKeys.project(conversationId),
    queryFn: async ({ signal }) => {
      await closingSaves.get(conversationId)
      return readProjectMain(conversationId, signal)
    },
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })

/** 预览令牌 1 小时过期：每 50 分钟取一张新的。 */
export const PREVIEW_TOKEN_REFRESH_MS = 50 * 60_000

/**
 * 预览令牌：预览页在预览域名 `origin` 下，凭令牌运行。
 *
 * `page` 是编辑器打开后取到的第一张：预览页的地址固定用它（预览页按这个地址认身份，换了就要重新加载）。
 * `latest` 是最新取到的一张，只用来取工程文件；令牌隔一段时间换一张，换令牌不重新加载预览页。
 */
export const useFinalCutPreviewTokens = (conversationId: string) => {
  const query = useQuery({
    queryKey: wholeFilmQueryKeys.preview(conversationId),
    queryFn: ({ signal }) =>
      apiFetch(`${conversationPath(conversationId)}/final-cut/preview`, zFinalCutPreviewOut, {
        fallbackErrorMessage: '预览加载失败',
        method: 'POST',
        signal,
      }),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchInterval: PREVIEW_TOKEN_REFRESH_MS,
    refetchIntervalInBackground: true,
  })
  const [page, setPage] = useState<FinalCutPreviewOut | null>(null)
  if (page === null && query.data !== undefined) setPage(query.data)
  return { query, page: page ?? query.data, latest: query.data }
}

/** 预览里取工程文件的基准地址：凭令牌取工作区里的 `final-cut/` 目录。 */
export const projectFilesBase = (origin: string, token: string): string =>
  `${origin}/api/final-cut/preview/${encodeURIComponent(token)}/files/`

const exportsPath = (conversationId: string) =>
  `${conversationPath(conversationId)}/whole-film/exports`

export const readLatestWholeFilmExport = async (conversationId: string, signal: AbortSignal) =>
  (
    await apiFetch(`${exportsPath(conversationId)}/latest`, zLatestExport, {
      fallbackErrorMessage: '读取导出进度失败',
      signal,
    })
  ).export

export const cancelWholeFilmExport = (conversationId: string, exportId: string) =>
  apiFetch(`${exportsPath(conversationId)}/${encodeURIComponent(exportId)}`, zExportCancelled, {
    fallbackErrorMessage: '取消导出失败',
    method: 'DELETE',
  })

/** 这段对话的音频记录（生成的音乐和上传的音频），新的在前；有没生成完的就隔一会儿再读。 */
export const useConversationMusic = (conversationId: string) =>
  useQuery({
    queryKey: wholeFilmQueryKeys.music(conversationId),
    queryFn: ({ signal }) =>
      readAllGenerations({ conversationId, kind: 'audio' }, signal, '读取音频失败'),
    refetchInterval: ({ state }) => generationsRefetchInterval(state.data ?? []),
  })

export const useConversationTaskId = (conversationId: string) =>
  useQuery({
    queryKey: wholeFilmQueryKeys.task(conversationId),
    queryFn: async ({ signal }) =>
      (
        await apiFetch(`${conversationPath(conversationId)}`, zConversationEnvelope, {
          fallbackErrorMessage: '读取对话失败',
          signal,
        })
      ).conversation.taskId,
    staleTime: Infinity,
  })

export const submitMusic = async (body: MusicIn): Promise<GenerationJob> =>
  (
    await apiFetch('/generations/music', zGenerationEnvelope, {
      body,
      fallbackErrorMessage: '音乐生成提交失败',
      method: 'POST',
    })
  ).generation

/** 重新读这段对话的音频；给了 `job` 先把它放到列表最前面，不用等读回来就看得到。 */
export const refreshConversationMusic = (
  queryClient: QueryClient,
  conversationId: string,
  job?: GenerationJob,
) => {
  const key = wholeFilmQueryKeys.music(conversationId)
  if (job !== undefined)
    queryClient.setQueryData<GenerationJob[]>(key, (previous) => [
      job,
      ...(previous ?? []).filter((item) => item.id !== job.id),
    ])
  return queryClient.invalidateQueries({ queryKey: key })
}
