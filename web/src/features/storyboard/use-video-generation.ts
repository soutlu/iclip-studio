import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import {
  DRAFT_COMPLETION_FAILED,
  storyboardQueryKeys,
  submitVideoDraftCompletion,
  useVideoModels,
} from './storyboard.api'
import {
  choiceOf,
  DEFAULT_GENERATE_AUDIO,
  DEFAULT_VIDEO_RESOLUTION,
  draftSupportOf,
  usableQuality,
  type VideoChoice,
  type VideoGenerationOptions,
  type VideoModelsStatus,
} from './video-generation-options'

const modelsStatus = (query: { isError: boolean; data: unknown }): VideoModelsStatus =>
  query.isError ? 'unavailable' : query.data === undefined ? 'loading' : 'ready'

export const useVideoGeneration = (conversationId: string, fileModel?: string) => {
  const queryClient = useQueryClient()
  const models = useVideoModels()
  const [failure, setFailure] = useState<{ index: number; message: string } | undefined>(undefined)
  const completingRef = useRef(false)
  const [wanted, setWanted] = useState<VideoGenerationOptions>({
    generateAudio: DEFAULT_GENERATE_AUDIO,
    model: undefined,
    quality: DEFAULT_VIDEO_RESOLUTION,
  })
  const items = models.data?.items ?? []
  const draftModels = models.data?.draftModels ?? []
  const allowed = (candidate: string | undefined) =>
    candidate !== undefined && items.includes(candidate) ? candidate : undefined
  const resolveModel = (candidate: string | undefined) =>
    allowed(candidate) ?? allowed(fileModel) ?? models.data?.default
  const model = resolveModel(wanted.model)
  const draftSupport = draftSupportOf(draftModels, model)
  const options: VideoGenerationOptions = {
    ...wanted,
    model,
    quality: usableQuality(wanted.quality, draftSupport),
  }

  const attempt = async (index: number, task: () => Promise<unknown>, fallback: string) => {
    setFailure(undefined)
    try {
      await task()
      return true
    } catch (error) {
      setFailure({ index, message: errorMessageOf(error, fallback) })
      return false
    }
  }
  const refreshJobs = () =>
    queryClient.invalidateQueries({ queryKey: storyboardQueryKeys.videoJobs(conversationId) })

  const submit = async (index: number, send: (choice: VideoChoice) => Promise<unknown>) => {
    if (model === undefined) return false
    const accepted = await attempt(index, () => send(choiceOf(model, options)), '视频提交失败')
    if (accepted) void refreshJobs()
    return accepted
  }

  const completeDraft = async (index: number, draftJobId: string) => {
    if (completingRef.current) return
    completingRef.current = true
    try {
      const accepted = await attempt(
        index,
        () => submitVideoDraftCompletion({ conversationId, draftJobId }),
        DRAFT_COMPLETION_FAILED,
      )
      if (accepted) await refreshJobs()
    } finally {
      completingRef.current = false
    }
  }

  return {
    completeDraft,
    draftSupport,
    errorOf: (index: number) => (failure?.index === index ? failure.message : undefined),
    models: items,
    modelsStatus: modelsStatus(models),
    options,
    reportError: (index: number, message: string) => setFailure({ index, message }),
    setOptions: (next: VideoGenerationOptions) => {
      const nextModel = resolveModel(next.model)
      setWanted({
        ...next,
        quality: usableQuality(next.quality, draftSupportOf(draftModels, nextModel)),
      })
    },
    submit,
  }
}
