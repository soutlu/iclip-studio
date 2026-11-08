import type { TaskPreview } from '@/shared/lib/task-preview'
import type { Task } from './tasks.api'

type TaskProduct = Task['inputs']['products'][number]

export function taskCoverOf(
  products: readonly TaskProduct[],
): { product: TaskProduct; url: string } | null {
  for (const product of products) {
    const url = product.image_oss_urls[0]
    if (url !== undefined) return { product, url }
  }
  return null
}

export function taskPreviewOf(task: Task): TaskPreview {
  return {
    title: task.title,
    requirement: task.inputs.creative_requirement,
    imageUrl: taskCoverOf(task.inputs.products)?.url ?? null,
  }
}
