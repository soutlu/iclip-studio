import type { QueryClient } from '@tanstack/react-query'
import { ApiError } from '@/shared/api/client'
import { catalogQuery } from './component-catalog'
import { DEFAULT_CANVAS, emptyProject, PROJECT_MAIN } from './composition/film'
import { createProjectFile, PROJECT_MAIN_PATH } from './final-cut.api'

// 与读取、保存报错保持一致，仅说明失败阶段；后端返回具体原因时拼接在后
const CREATE_FAILED_TEXT = 'final-cut 新建失败'

/**
 * 工作台「新建 final-cut」：按默认模板（见 `DEFAULT_CANVAS`）在对话工作区创建工程主文件并返回其工作区路径。
 * 组件库目录经 `catalogQuery` 获取（命中缓存则复用）；若并发创建已存在（409）则视为成功，其余错误照常抛出。
 */
export const createFinalCut = async (
  conversationId: string,
  queryClient: QueryClient,
): Promise<string> => {
  const catalog = await queryClient.fetchQuery(catalogQuery)
  try {
    await createProjectFile(
      conversationId,
      PROJECT_MAIN,
      emptyProject(DEFAULT_CANVAS, catalog),
      CREATE_FAILED_TEXT,
    )
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error
  }
  return PROJECT_MAIN_PATH
}
