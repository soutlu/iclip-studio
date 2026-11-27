import { queryOptions, useInfiniteQuery, useQuery, type QueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError, apiFetch, UserFacingError } from '@/shared/api/client'
import type {
  DubbingIn,
  FinalCutPreviewOut,
  FinalCutTranslationsIn,
  FinalCutTranslationsOut,
  MusicIn,
  SpeechIn,
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
import {
  AUDIO_KIND_FILTERS,
  referenceAudiosQuery,
  traitQuery,
  voicesQuery,
  type AudioTraitFilter,
  type ReferenceAudioFilter,
} from '@/shared/api/reference-audios'
import {
  generationsRefetchInterval,
  readAllGenerations,
  storyboardQueryKeys,
  type GenerationJob,
} from '../storyboard.api'
import { conversationAudio, generatedAudio, type ConversationAudio } from './audio'
import { CAPTIONS_PATH, isCaptionsHost } from './composition/captions'
import type { CatalogItem, ComponentCatalog } from './composition/catalog'
import type { ExportTier } from './composition/export-resolution'
import { PROJECT_MAIN } from './composition/film'
import {
  LOCALES,
  localeOfPath,
  localePath,
  parseLocaleValues,
  type Language,
  type LocaleCode,
} from './locales'

/** final-cut 工程在对话工作区中的根目录。 */
export const PROJECT_DIR = 'final-cut'

/** 主文件在对话工作区中的相对路径。 */
export const PROJECT_MAIN_PATH = `${PROJECT_DIR}/${PROJECT_MAIN}`

const READ_FAILED = 'final-cut 读取失败'
const SAVE_FAILED = 'final-cut 保存失败'
const ITEM_FILES_FAILED = '元素和模板读取失败'

export const wholeFilmQueryKeys = {
  // 独立于工作区文件查询键：工作台宿主在任意文件变更时均会使工作区文件查询失效，挂在其下会导致每次保存后触发重读
  project: (conversationId: string) => ['final-cut', 'project', conversationId] as const,
  latestExport: (conversationId: string) =>
    ['whole-film', 'export', 'latest', conversationId] as const,
  // 归属对话生成记录键树：生成记录变更时自动联动刷新
  music: (conversationId: string) =>
    [...storyboardQueryKeys.conversation(conversationId), 'audio'] as const,
  subtitles: (conversationId: string, sourceJobId: string) =>
    [...storyboardQueryKeys.conversation(conversationId), 'subtitle', sourceJobId] as const,
  dubbings: (conversationId: string, sourceJobId: string) =>
    [...storyboardQueryKeys.conversation(conversationId), 'dubbing', sourceJobId] as const,
  speeches: (conversationId: string) =>
    [...storyboardQueryKeys.conversation(conversationId), 'speech'] as const,
  preview: (conversationId: string) => ['whole-film', 'preview', conversationId] as const,
  task: (conversationId: string) => ['whole-film', 'task', conversationId] as const,
}

/** 工作区中的单个工程文件：文本内容与版本号。 */
export type StoredFile = { content: string; version: number }

const conversationPath = (conversationId: string) =>
  `/conversations/${encodeURIComponent(conversationId)}`

/** 读取工程内单个文件（`path` 相对工程根目录）；文件不存在时返回 `null`（主文件缺失即表示尚无工程）。 */
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

/**
 * 在工程内新建文件（`path` 相对工程根目录），返回工作区版本号；文件已存在时抛出 409。
 * `failureText` 用作错误兜底前缀（服务端返回具体原因时拼接在后），默认为保存失败。
 */
export const createProjectFile = async (
  conversationId: string,
  path: string,
  content: string,
  failureText = SAVE_FAILED,
): Promise<number> =>
  (
    await apiFetch(`${conversationPath(conversationId)}/final-cut/files`, zFinalCutFileCreatedOut, {
      body: { path, content },
      fallbackErrorMessage: failureText,
      method: 'POST',
    })
  ).version

/** 按乐观锁版本号整份覆写工程文件（`path` 相对工程根目录），返回新版本号；版本冲突时抛出 409。 */
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
 * 将组件库条目声明的依赖文件按原相对路径逐一拷贝至工程（工程内已存在时跳过 409）；
 * 拷贝后文件归属当前工程所有，不再随组件库更新而变动。
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

// 记录编辑器卸载时尚未落盘的保存任务（按对话索引），完成后自动清理
const closingSaves = new Map<string, Promise<void>>()

/**
 * 在编辑器卸载时登记在途保存：`saving` 结束前阻塞该对话后续重新打开时的工程读取，
 * 避免读到落盘前的旧版本导致后续保存因版本冲突被拒而丢失改动。
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
 * 工作区中已持久化的工程快照：主文件、字幕场景文件（`captions`，不存在时为 `null`）及语言值表集合。
 * `captionsPath` 取主文件字幕宿主挂载路径（无宿主时回退至默认创建路径）；`hosted` 标识主文件是否存在字幕宿主；
 * `locales` 按 `LOCALES` 顺序收录工程内已存在的各语言值表文件。
 */
export type StoredProject = {
  main: StoredFile
  captionsPath: string
  captions: StoredFile | null
  hosted: boolean
  locales: ReadonlyMap<LocaleCode, StoredFile>
}

/** 扫描 `final-cut/locales/` 下受支持的语言值表列表，按 `LOCALES` 顺序返回语言代码。 */
const storedLocales = async (conversationId: string, signal?: AbortSignal) => {
  const { files } = await apiFetch(
    `${conversationPath(conversationId)}/workspace/files`,
    zConversationFilesOut,
    { fallbackErrorMessage: READ_FAILED, ...(signal === undefined ? {} : { signal }) },
  )
  const found = new Set(files.map((file) => projectLocaleOf(file.path)))
  return LOCALES.flatMap(({ code }) => (found.has(code) ? [code] : []))
}

/** 判断工作区路径 `path` 是否对应受支持的工程语言值表（见 `localeOfPath`）。 */
export const projectLocaleOf = (path: string): LocaleCode | undefined =>
  path.startsWith(`${PROJECT_DIR}/`) ? localeOfPath(path.slice(PROJECT_DIR.length + 1)) : undefined

/** 读取工程内指定语言 `code` 的值表并校验 JSON 结构；文件不存在时返回 `null`。 */
export const readLocaleFile = async (
  conversationId: string,
  code: LocaleCode,
  signal?: AbortSignal,
): Promise<StoredFile | null> => {
  const file = await readProjectFile(conversationId, localePath(code), signal)
  if (file !== null) parseLocaleValues(file.content, code)
  return file
}

/** 提取主文件根下首个字幕宿主挂载的文件路径；无字幕宿主时返回 `undefined`。 */
const captionsSource = (html: string): string | undefined => {
  const page = new DOMParser().parseFromString(html, 'text/html')
  const root = page.querySelector('[data-composition-id]')
  for (const child of root?.children ?? []) {
    const src = child.getAttribute('data-composition-src')
    const attributes = Object.fromEntries(
      [...child.attributes].map((attribute) => [attribute.name, attribute.value]),
    )
    if (src !== null && isCaptionsHost(attributes)) return src
  }
  return undefined
}

/**
 * 读取工作区中的完整工程，主文件缺失时返回 `null`。
 * 字幕场景文件按主文件字幕宿主路径读取（无宿主时仍尝试读取默认路径，以兼容新增字幕后撤销遗留的空场景文件）；
 * 语言值表根据工作区文件列表按需读取并校验格式，忽略未登记的语言文件。
 */
export const readProject = async (
  conversationId: string,
  signal?: AbortSignal,
): Promise<StoredProject | null> => {
  const main = await readProjectFile(conversationId, PROJECT_MAIN, signal)
  if (main === null) return null
  const source = captionsSource(main.content)
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

/** 预览令牌有效期 1 小时，每 50 分钟轮换一次。 */
export const PREVIEW_TOKEN_REFRESH_MS = 50 * 60_000

/**
 * 获取并定时刷新预览令牌：预览页在独立预览域名 `origin` 下凭令牌运行。
 *
 * `page` 锁定编辑器打开后获取的首张令牌以固定预览页 iframe URL（变更 URL 会导致重载并重验身份）；
 * `latest` 为最新轮换令牌，专用于拉取工程资源，刷新令牌时不重载预览页。
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

/** 预览页拉取工作区 `final-cut/` 工程资源的基准 URL。 */
export const projectFilesBase = (origin: string, token: string): string =>
  `${origin}/api/final-cut/preview/${encodeURIComponent(token)}/files/`

const exportsPath = (conversationId: string) =>
  `${conversationPath(conversationId)}/whole-film/exports`

/**
 * 基于工作区当前 final-cut 工程发起指定语言 `locale`（原文传 `null`）的成片导出，返回导出任务 ID。
 * `resolution` 为导出分辨率档位，按画布原尺寸导出时传 `null`（请求体省略该字段）。
 */
export const startWholeFilmExport = (
  conversationId: string,
  locale: Language,
  resolution: ExportTier | null,
) => {
  const body: WholeFilmExportIn = resolution === null ? { locale } : { locale, resolution }
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

/** 查询本对话音频列表（生成音乐与上传音频，按创建时间倒序）；存在进行中任务时自动轮询。 */
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

/**
 * 查询参考音频库全部音色（按创建时间倒序）：「字幕」页签按它找音色的名字、属性，算常用音色；`enabled` 为假时不发起请求。
 */
export const useLibraryVoices = (enabled: boolean) => useQuery({ ...voicesQuery(), enabled })

/** 选音面板的音色列表：按 `filter`（见 `voicePickerFilter`）一页一页读，建立晚的在前。 */
export const useVoiceOptions = (filter: ReferenceAudioFilter) =>
  useInfiniteQuery(referenceAudiosQuery(filter))

/**
 * 分页查询参考音频库配乐或音效（按 `q` 匹配标题与备注、按 `traits` 筛属性，供「配乐」页签音频库使用）。
 * `traits` 里只有这个子类能筛的几项（见 `AUDIO_KIND_FILTERS`）会带上。
 */
export const useLibraryAudios = (audioKind: 'bgm' | 'sfx', q: string, traits: AudioTraitFilter) =>
  useInfiniteQuery(
    referenceAudiosQuery({
      audioKind,
      q: q.trim(),
      ...traitQuery(AUDIO_KIND_FILTERS[audioKind], traits),
    }),
  )

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

/** 查询单条素材片（`sourceJobId`）的字幕识别记录（按时间倒序）；存在进行中任务时自动轮询。 */
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

/** 提交单条素材片的字幕识别任务（付费上游服务），返回排队中的任务记录。 */
export const submitSubtitles = async (body: SubtitleIn): Promise<GenerationJob> =>
  (
    await apiFetch('/generations/subtitles', zGenerationEnvelope, {
      body,
      fallbackErrorMessage: '字幕识别提交失败',
      method: 'POST',
    })
  ).generation

/** 查询单条素材片（`sourceJobId`）的配音任务记录（按时间倒序）；存在进行中任务时自动轮询。 */
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

/** 提交单条素材片的指定语言配音任务（付费上游服务），返回排队中的任务记录。 */
export const submitDubbing = async (body: DubbingIn): Promise<GenerationJob> =>
  (
    await apiFetch('/generations/dubbings', zGenerationEnvelope, {
      body,
      fallbackErrorMessage: '配音生成提交失败',
      method: 'POST',
    })
  ).generation

/** 查询本对话文本转语音（旁白配音）任务记录（按时间倒序）；存在进行中任务时自动轮询。 */
export const speechJobsQuery = (conversationId: string) =>
  queryOptions({
    queryKey: wholeFilmQueryKeys.speeches(conversationId),
    queryFn: ({ signal }) =>
      readAllGenerations({ conversationId, kind: 'speech' }, signal, '读取配音记录失败'),
    refetchInterval: ({ state }) => generationsRefetchInterval(state.data ?? []),
  })

/** 提交文本转语音任务（付费上游服务），返回排队中的任务记录。 */
export const submitSpeech = async (body: SpeechIn): Promise<GenerationJob> =>
  (
    await apiFetch('/generations/speeches', zGenerationEnvelope, {
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
 * 批量将原文翻译为目标语言（付费上游服务，单次请求触发一次模型调用），返回各条译文。
 * 失败时按接口返回的 `code` 映射面向用户的提示，不透出服务端原始报错细节。
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
    // status === 0 表示网络或响应格式异常，客户端已封装可读文案，直接透传
    if (!(error instanceof ApiError) || error.status === 0) throw error
    const failure = zFinalCutTranslationErrorOut.safeParse(error.body)
    throw new UserFacingError(
      failure.success ? TRANSLATE_FAILED_TEXT[failure.data.code] : '翻译失败，请重试',
      { cause: error },
    )
  }
}

/** 刷新本对话音频列表；传入新提交的 `job` 时先行乐观插入列表首位。 */
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
