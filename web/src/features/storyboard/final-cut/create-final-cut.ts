import type { QueryClient } from '@tanstack/react-query'
import { ApiError } from '@/shared/api/client'
import { catalogQuery } from './component-catalog'
import { DEFAULT_CANVAS, emptyProject, PROJECT_MAIN } from './composition/film'
import { createProjectFile, PROJECT_MAIN_PATH } from './final-cut.api'

// 和读取、保存失败一样只写哪一步失败：服务端给了原因时接在后面
const CREATE_FAILED_TEXT = 'final-cut 新建失败'

/**
 * 工作台「新建 final-cut」：按默认模版（见 `DEFAULT_CANVAS`）在对话工作区里建工程主文件，答复主文件的路径。
 * 组件库目录按 `catalogQuery` 读（已读过就用读过的）。别处刚建好（409）时当已建好；别的失败照样抛出。
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
