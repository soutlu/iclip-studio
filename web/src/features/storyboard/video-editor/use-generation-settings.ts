import { useMemo, useState } from 'react'
import type { VideoClipModelOut, VideoModelsOut } from '@/shared/api/generated/types.gen'
import type { ClipGenerationMode } from './clip-generation'
import { pickGenerationModel } from './video-editor.api'

type GenerationSettings = {
  mode: ClipGenerationMode
  setMode: (mode: ClipGenerationMode) => void
  models: readonly VideoClipModelOut[]
  chosen: { model: VideoClipModelOut; imageSeconds: number } | undefined
  setModel: (modelId: string) => void
  setImageSeconds: (seconds: number) => void
}

export const useGenerationSettings = (
  available: VideoModelsOut | undefined,
): GenerationSettings => {
  const [mode, setMode] = useState<ClipGenerationMode>('edit')
  const [wantedModel, setWantedModel] = useState<string>()
  const [wantedSeconds, setWantedSeconds] = useState<number>()
  const models = useMemo(
    () => (available?.clipModels ?? []).filter((item) => mode === 'image' || item.edit !== null),
    [available, mode],
  )
  const modelId = pickGenerationModel(
    models.map((item) => item.id),
    wantedModel,
    available?.default,
  )
  const model = models.find((item) => item.id === modelId)
  return {
    mode,
    setMode,
    models,
    chosen:
      model === undefined
        ? undefined
        : { model, imageSeconds: wantedSeconds ?? model.image.defaultSeconds },
    setModel: setWantedModel,
    setImageSeconds: setWantedSeconds,
  }
}
