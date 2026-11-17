import { queryOptions, useInfiniteQuery, useQuery, type QueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError, apiFetch, UserFacingError } from '@/shared/api/client'
import type {
  DubbingIn,
  FinalCutPreviewOut,
  FinalCutTranslationsIn,
  FinalCutTranslationsOut,
  MusicIn,
  SubtitleIn,
  WholeFilmExportIn,
} from '@/shared/api/generated/types.gen'
import {
  zCancelWholeFilmExportConversationsConversationIdWholeFilmExportsExportIdDeleteResponse as zExportCancelled,
  zConversationEnvelope,
  zConversationFileEnvelope,
  zConversationFilesOut,
  zFinalCutFileCreatedOut,
  zFinalCutPreviewOut,
  zFinalCutTranslationErrorOut,
  zFinalCutTranslationsOut,
  zGenerationEnvelope,
  zLatestWholeFilmExportConversationsConversationIdWholeFilmExportsLatestGetResponse as zLatestExport,
  zWholeFilmExportStartedOut,
} from '@/shared/api/generated/zod.gen'
import { readConversationUploads } from '@/shared/api/media-upload'
import { referenceAudiosQuery, voicesQuery } from '@/shared/api/reference-audios'
import {
  generationsRefetchInterval,
  readAllGenerations,
  storyboardQueryKeys,
  type GenerationJob,
} from '../storyboard.api'
import { conversationAudio, generatedAudio, type ConversationAudio } from './audio'
import { CAPTIONS_PATH, isCaptionsHost } from './composition/captions'
import type { CatalogItem, ComponentCatalog } from './composition/catalog'
import { PROJECT_MAIN } from './composition/film'
import {
  LOCALES,
  localeOfPath,
  localePath,
  parseLocaleValues,
  type Language,
  type LocaleCode,
} from './locales'

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
  dubbings: (conversationId: string, sourceJobId: string) =>
    [...storyboardQueryKeys.conversation(conversationId), 'dubbing', sourceJobId] as const,
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
 * `locales` 是工程里有的各语言的值表（语言 → 文件），按 `LOCALES` 的先后。
 */
export type StoredProject = {
  main: StoredFile
  captionsPath: string
  captions: StoredFile | null
  hosted: boolean
  locales: ReadonlyMap<LocaleCode, StoredFile>
  /**
   * 主文件里组件或块的宿主挂载的文件（路径相对工程根 → 文件），画面上改里面的层要写它们；工作区里没有的不在里面。
   */
  components: ReadonlyMap<string, StoredFile>
}

/** 工程里有值表的语言：`final-cut/locales/` 下认识的语言的值表，按 `LOCALES` 的先后。 */
const storedLocales = async (conversationId: string, signal?: AbortSignal) => {
  const { files } = await apiFetch(
    `${conversationPath(conversationId)}/workspace/files`,
    zConversationFilesOut,
    { fallbackErrorMessage: READ_FAILED, ...(signal === undefined ? {} : { signal }) },
  )
  const found = new Set(files.map((file) => projectLocaleOf(file.path)))
  return LOCALES.flatMap(({ code }) => (found.has(code) ? [code] : []))
}

/** 工作区里的路径 `path` 是不是工程里哪种语言的值表（见 `localeOfPath`）。 */
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

/** 主文件根下挂载着文件的宿主：挂载的文件，是不是字幕宿主。 */
const mountedSources = (html: string) => {
  const page = new DOMParser().parseFromString(html, 'text/html')
  const root = page.querySelector('[data-composition-id]')
  return [...(root?.children ?? [])].flatMap((child) => {
    const src = child.getAttribute('data-composition-src')
    const attributes = Object.fromEntries(
      [...child.attributes].map((attribute) => [attribute.name, attribute.value]),
    )
    return src === null ? [] : [{ src, captions: isCaptionsHost(attributes) }]
  })
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
  const mounted = mountedSources(main.content)
  const source = mounted.find((mount) => mount.captions)?.src
  const captionsPath = source ?? CAPTIONS_PATH
  const locales = new Map<LocaleCode, StoredFile>()
  for (const code of await storedLocales(conversationId, signal)) {
    const file = await readLocaleFile(conversationId, code, signal)
    if (file !== null) locales.set(code, file)
  }
  const components = new Map<string, StoredFile>()
  for (const { src } of mounted.filter((mount) => !mount.captions)) {
    if (components.has(src)) continue
    const file = await readProjectFile(conversationId, src, signal)
    if (file !== null) components.set(src, file)
  }
  return {
    main,
    captionsPath,
    captions: await readProjectFile(conversationId, captionsPath, signal),
    hosted: source !== undefined,
    locales,
    components,
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

/** 按工作区里现在的 final-cut 发起一次导出，导出 `locale` 这种语言（原文是 null）的版本，答复导出 id。 */
export const startWholeFilmExport = (conversationId: string, locale: Language) => {
  const body: WholeFilmExportIn = { locale }
  return apiFetch(exportsPath(conversationId), zWholeFilmExportStartedOut, {
    body,
    fallbackErrorMessage: '成片导出失败',
    method: 'POST',
  })
}

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

/** 这段对话的音频（生成的音乐和挂在这段对话上的音频上传），新的在前；有没生成完的就隔一会儿再读。 */
export const useConversationMusic = (conversationId: string) =>
  useQuery({
    queryKey: wholeFilmQueryKeys.music(conversationId),
    queryFn: async ({ signal }) => {
      const [jobs, uploads] = await Promise.all([
        readAllGenerations({ conversationId, kind: 'audio' }, signal, '读取音频失败'),
        readConversationUploads(conversationId, 'audio', signal, '读取音频失败'),
      ])
      return conversationAudio(jobs, uploads)
    },
    refetchInterval: ({ state }) => generationsRefetchInterval(state.data ?? []),
  })

/** 参考音频库里的全部音色，建立晚的在前：「字幕·配音」里选配音的音色用；`enabled` 为假时不读。 */
export const useLibraryVoices = (enabled: boolean) => useQuery({ ...voicesQuery(), enabled })

/** 参考音频库里的配乐或音效，按 `q` 搜（匹配标题、备注），一页一页读：「配乐」页签的「音频库」用。 */
export const useLibraryAudios = (audioKind: 'bgm' | 'sfx', q: string) =>
  useInfiniteQuery(referenceAudiosQuery({ audioKind, q: q.trim() }))

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

/** 一条素材片（`sourceJobId`）的配音记录，新的在前；有没配完的就隔一会儿再读。 */
export const dubbingJobsQuery = (conversationId: string, sourceJobId: string) =>
  queryOptions({
    queryKey: wholeFilmQueryKeys.dubbings(conversationId, sourceJobId),
    queryFn: ({ signal }) =>
      readAllGenerations(
        { conversationId, kind: 'dubbing', sourceJobId },
        signal,
        '读取配音记录失败',
      ),
    refetchInterval: ({ state }) => generationsRefetchInterval(state.data ?? []),
  })

/** 发起给一条素材片配一种语言（付费的上游服务），答复排队中的配音记录。 */
export const submitDubbing = async (body: DubbingIn): Promise<GenerationJob> =>
  (
    await apiFetch('/generations/dubbings', zGenerationEnvelope, {
      body,
      fallbackErrorMessage: '配音生成提交失败',
      method: 'POST',
    })
  ).generation

const TRANSLATE_FAILED_TEXT = {
  model_unavailable: '翻译服务暂不可用，请稍后再试',
  model_call_failed: '翻译失败，请点击「翻译」重试',
  model_failed: '翻译失败，请稍后再试',
} as const

/**
 * 把一批原文翻成一种语言（付费的上游服务，一次请求一次模型调用），答复每条的译文。失败时按接口答的 `code`
 * 说明能不能重试；别的失败不把服务端的说明给用户看。
 */
export const translateTexts = async (
  conversationId: string,
  body: FinalCutTranslationsIn,
  signal?: AbortSignal,
): Promise<FinalCutTranslationsOut> => {
  try {
    return await apiFetch(
      `${conversationPath(conversationId)}/final-cut/translations`,
      zFinalCutTranslationsOut,
      {
        body,
        fallbackErrorMessage: '翻译失败',
        method: 'POST',
        ...(signal === undefined ? {} : { signal }),
      },
    )
  } catch (error) {
    // 状态 0 是没连上、答复不对，说明是客户端写的，照原样
    if (!(error instanceof ApiError) || error.status === 0) throw error
    const failure = zFinalCutTranslationErrorOut.safeParse(error.body)
    throw new UserFacingError(
      failure.success ? TRANSLATE_FAILED_TEXT[failure.data.code] : '翻译失败，请重试',
      { cause: error },
    )
  }
}

/** 重新读这段对话的音频；给了 `job` 先把它放到列表最前面，不用等读回来就看得到。 */
export const refreshConversationMusic = (
  queryClient: QueryClient,
  conversationId: string,
  job?: GenerationJob,
) => {
  const key = wholeFilmQueryKeys.music(conversationId)
  if (job !== undefined)
    queryClient.setQueryData<ConversationAudio[]>(key, (previous) => [
      generatedAudio(job),
      ...(previous ?? []).filter((item) => item.id !== job.id),
    ])
  return queryClient.invalidateQueries({ queryKey: key })
}
