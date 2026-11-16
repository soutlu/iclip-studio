import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError, apiFetch, UserFacingError } from '@/shared/api/client'
import type { FinalCutPreviewOut, MusicIn, SubtitleIn } from '@/shared/api/generated/types.gen'
import {
  zCancelWholeFilmExportConversationsConversationIdWholeFilmExportsExportIdDeleteResponse as zExportCancelled,
  zConversationEnvelope,
  zConversationFileEnvelope,
  zConversationFilesOut,
  zFinalCutFileCreatedOut,
  zFinalCutPreviewOut,
  zGenerationEnvelope,
  zLatestWholeFilmExportConversationsConversationIdWholeFilmExportsLatestGetResponse as zLatestExport,
  zWholeFilmExportStartedOut,
} from '@/shared/api/generated/zod.gen'
import {
  generationsRefetchInterval,
  readAllGenerations,
  storyboardQueryKeys,
  type GenerationJob,
} from '../storyboard.api'
import { CAPTIONS_PATH, isCaptionsHost } from './composition/captions'
import type { CatalogItem, ComponentCatalog } from './composition/catalog'
import { PROJECT_MAIN } from './composition/film'
import { LOCALES, localeOfPath, localePath, parseLocaleValues, type LocaleCode } from './locales'

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
  subtitles: (conversationId: string, sourceJobId: string) =>
    [...storyboardQueryKeys.conversation(conversationId), 'subtitle', sourceJobId] as const,
  preview: (conversationId: string) => ['whole-film', 'preview', conversationId] as const,
  task: (conversationId: string) => ['whole-film', 'task', conversationId] as const,
}

/** 工作区里的一个工程文件：内容和版本号。 */
export type StoredFile = { content: string; version: number }

const conversationPath = (conversationId: string) =>
  `/conversations/${encodeURIComponent(conversationId)}`

/** 读工程里的一个文件（`path` 相对工程根）；文件不存在时是 null，主文件不存在就是还没有工程。 */
export const readProjectFile = async (
  conversationId: string,
  path: string,
  signal?: AbortSignal,
): Promise<StoredFile | null> => {
  try {
    const { file } = await apiFetch(
      `${conversationPath(conversationId)}/workspace/file?path=${encodeURIComponent(`${PROJECT_DIR}/${path}`)}`,
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

/** 按读到的版本整份写工程里的一个文件（`path` 相对工程根），答复新的版本号；版本对不上时是 409。 */
export const writeProjectFile = async (
  conversationId: string,
  path: string,
  content: string,
  expectedVersion: number,
): Promise<number> =>
  (
    await apiFetch(
      `${conversationPath(conversationId)}/workspace/file`,
      zConversationFileEnvelope,
      {
        body: { path: `${PROJECT_DIR}/${path}`, content, expectedVersion },
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
 * 编辑器卸载时调用：`saving` 结束之前，这段对话的编辑器再打开也先不读工程文件。
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

/**
 * 工作区里存着的工程：主文件，和字幕场景文件（`captions`，不存在时是 null）。`captionsPath` 是字幕场景文件的
 * 路径：主文件里字幕宿主挂载的那个，没有宿主时是编辑器新建它的位置；`hosted` 是主文件里有没有字幕宿主。
 * `locales` 是工程里有的各外语的值表（语言 → 文件），按 `LOCALES` 的先后。
 */
export type StoredProject = {
  main: StoredFile
  captionsPath: string
  captions: StoredFile | null
  hosted: boolean
  locales: ReadonlyMap<LocaleCode, StoredFile>
}

/** 工程里有值表的外语：`final-cut/locales/` 下认识的语言的值表，按 `LOCALES` 的先后。 */
const storedLocales = async (conversationId: string, signal?: AbortSignal) => {
  const { files } = await apiFetch(
    `${conversationPath(conversationId)}/workspace/files`,
    zConversationFilesOut,
    { fallbackErrorMessage: READ_FAILED, ...(signal === undefined ? {} : { signal }) },
  )
  const found = new Set(files.map((file) => projectLocaleOf(file.path)))
  return LOCALES.flatMap(({ code }) => (found.has(code) ? [code] : []))
}

/** 工作区里的路径 `path` 是不是工程里哪种外语的值表（见 `localeOfPath`）。 */
export const projectLocaleOf = (path: string): LocaleCode | undefined =>
  path.startsWith(`${PROJECT_DIR}/`) ? localeOfPath(path.slice(PROJECT_DIR.length + 1)) : undefined

/** 读工程里语言 `code` 的值表，写法不对时说明原因；文件不存在时是 null。 */
export const readLocaleFile = async (
  conversationId: string,
  code: LocaleCode,
  signal?: AbortSignal,
): Promise<StoredFile | null> => {
  const file = await readProjectFile(conversationId, localePath(code), signal)
  if (file !== null) parseLocaleValues(file.content, code)
  return file
}

/** 主文件根下字幕宿主挂载的文件；没有宿主时是 undefined。 */
const captionsSourceOf = (html: string): string | undefined => {
  const page = new DOMParser().parseFromString(html, 'text/html')
  const root = page.querySelector('[data-composition-id]')
  const host = [...(root?.children ?? [])].find((child) =>
    isCaptionsHost(
      Object.fromEntries(
        [...child.attributes].map((attribute) => [attribute.name, attribute.value]),
      ),
    ),
  )
  return host?.getAttribute('data-composition-src') ?? undefined
}

/**
 * 读工作区里的工程，还没有工程（没有主文件）时是 null。字幕场景文件按主文件里字幕宿主挂载的路径读；没有宿主
 * 时也读编辑器新建它的位置（加了又撤销会留下空的场景文件）。语言值表按工作区的文件列表找，不认识的语言不读；
 * 值表写法不对时说明原因。
 */
export const readProject = async (
  conversationId: string,
  signal?: AbortSignal,
): Promise<StoredProject | null> => {
  const main = await readProjectFile(conversationId, PROJECT_MAIN, signal)
  if (main === null) return null
  const source = captionsSourceOf(main.content)
  const captionsPath = source ?? CAPTIONS_PATH
  const locales = new Map<LocaleCode, StoredFile>()
  for (const code of await storedLocales(conversationId, signal)) {
    const file = await readLocaleFile(conversationId, code, signal)
    if (file !== null) locales.set(code, file)
  }
  return {
    main,
    captionsPath,
    captions: await readProjectFile(conversationId, captionsPath, signal),
    hosted: source !== undefined,
    locales,
  }
}

export const useProjectQuery = (conversationId: string) =>
  useQuery({
    queryKey: wholeFilmQueryKeys.project(conversationId),
    queryFn: async ({ signal }) => {
      await closingSaves.get(conversationId)
      return readProject(conversationId, signal)
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

/** 按工作区里现在的 final-cut 发起一次导出，答复导出 id。 */
export const startWholeFilmExport = (conversationId: string) =>
  apiFetch(exportsPath(conversationId), zWholeFilmExportStartedOut, {
    fallbackErrorMessage: '成片导出失败',
    method: 'POST',
  })

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

/** 一条素材片（`sourceJobId`）的字幕识别记录，新的在前；有没识别完的就隔一会儿再读。 */
export const subtitleJobsQuery = (conversationId: string, sourceJobId: string) =>
  queryOptions({
    queryKey: wholeFilmQueryKeys.subtitles(conversationId, sourceJobId),
    queryFn: ({ signal }) =>
      readAllGenerations(
        { conversationId, kind: 'subtitle', sourceJobId },
        signal,
        '读取字幕识别记录失败',
      ),
    refetchInterval: ({ state }) => generationsRefetchInterval(state.data ?? []),
  })

/** 发起识别一条素材片的字幕（付费的上游服务），答复排队中的字幕识别记录。 */
export const submitSubtitles = async (body: SubtitleIn): Promise<GenerationJob> =>
  (
    await apiFetch('/generations/subtitles', zGenerationEnvelope, {
      body,
      fallbackErrorMessage: '字幕识别提交失败',
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
