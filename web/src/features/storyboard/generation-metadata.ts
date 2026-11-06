import { z } from 'zod'

const storyboardMetadataSchema = z.object({
  shot: z.int().positive(),
  frame: z.int().positive().optional(),
})

export type StoryboardMetadata = z.infer<typeof storyboardMetadataSchema>

export const storyboardMetadata = (shot: number, frame: number): StoryboardMetadata => ({
  frame,
  shot,
})

export const readStoryboardMetadata = (job: {
  metadata: Record<string, unknown> | null
}): StoryboardMetadata | undefined => {
  const parsed = storyboardMetadataSchema.safeParse(job.metadata)
  return parsed.success ? parsed.data : undefined
}

export const filmMetadata = (node: string) => ({ film_node: node })

export const metadataFilterParam = (filter: Record<string, unknown>): string =>
  JSON.stringify(filter)
