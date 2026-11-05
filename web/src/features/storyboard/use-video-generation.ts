import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { errorMessageOf } from '@/shared/api/client'
import { storyboardQueryKeys, useVideoModels } from './storyboard.api'
import {
  DEFAULT_GENERATE_AUDIO,
  DEFAULT_VIDEO_RESOLUTION,
  type VideoGenerationOptions,
  type VideoModelsStatus,
  type VideoResolution,
} from './video-generation-options'

export type VideoChoice = { model: string; resolution: VideoResolution; generateAudio: boolean }

const modelsStatus = (query: { isError: boolean; data: unknown }): VideoModelsStatus =>
  query.isError ? 'unavailable' : query.data === undefined ? 'loading' : 'ready'

export const useVideoGeneration = (conversationId: string, fileModel?: string) => {
  const queryClient = useQueryClient()
  const models = useVideoModels()
  const [failure, setFailure] = useState<{ index: number; message: string } | undefined>(undefined)
  const [wanted, setWanted] = useState<VideoGenerationOptions>({
    generateAudio: DEFAULT_GENERATE_AUDIO,
    model: undefined,
    resolution: DEFAULT_VIDEO_RESOLUTION,
  })
  const items = models.data?.items ?? []
  const allowed = (candidate: string | undefined) =>
    candidate !== undefined && items.includes(candidate) ? candidate : undefined
  const model = allowed(wanted.model) ?? allowed(fileModel) ?? models.data?.default
  const options: VideoGenerationOptions = { ...wanted, model }

  const submit = async (index: number, send: (choice: VideoChoice) => Promise<unknown>) => {
    if (model === undefined) return
    setFailure(undefined)
    try {
      await send({ generateAudio: options.generateAudio, model, resolution: options.resolution })
      void queryClient.invalidateQueries({
        queryKey: storyboardQueryKeys.videoJobs(conversationId),
      })
    } catch (error) {
      setFailure({ index, message: errorMessageOf(error, '视频提交失败') })
    }
  }

  return {
    errorOf: (index: number) => (failure?.index === index ? failure.message : undefined),
    models: items,
    modelsStatus: modelsStatus(models),
    options,
    reportError: (index: number, message: string) => setFailure({ index, message }),
    setOptions: setWanted,
    submit,
  }
}
