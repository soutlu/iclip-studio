/** 全部对话一行的封面取哪张图。 */

import { imageThumbnailUrl, videoSnapshotUrl } from '@/shared/lib/media-url'
import type { TaskPreview, TaskPreviewState } from '@/shared/lib/task-preview'

// 只按单边缩放、不在 OSS 裁图，铺满方框的裁切交给 CSS；两边都够 2x 屏的 64px 框。
const PRODUCT_PROCESS = 'resize,s_160/format,webp'
const FRAME_WIDTH = 256

/**
 * 需求单商品图优先，其次这段对话自己最新一条成片的首帧；都没有返回 null，由行画空态。
 * 首帧只有 OSS 地址截得出来，别的来源按没有封面算。
 *
 * 挂了需求单、预览还在读时也返回 null：先放首帧的话，预览一到又换成商品图，首屏每行都会闪一下。
 * 预览读不到（无权限、失败、没找到）才退到首帧。
 */
export const auditCoverUrl = (
  row: { taskId: string | null; latestMasterUrl: string | null },
  preview: TaskPreview | undefined,
  previewState: TaskPreviewState,
): string | null => {
  const productImage = preview?.imageUrl ?? null
  if (productImage !== null) return imageThumbnailUrl(productImage, PRODUCT_PROCESS)
  if (row.taskId !== null && preview === undefined && previewState === 'loading') return null
  if (row.latestMasterUrl === null) return null
  return videoSnapshotUrl(row.latestMasterUrl, FRAME_WIDTH) ?? null
}
