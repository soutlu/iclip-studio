import { imageThumbnailUrl, videoSnapshotUrl } from '@/shared/lib/media-url'
import type { TaskPreview, TaskPreviewState } from '@/shared/lib/task-preview'

const PRODUCT_PROCESS = 'resize,s_160/format,webp'
const FRAME_WIDTH = 256

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
