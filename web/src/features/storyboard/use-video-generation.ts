/** 出片的生成选项（模型、分辨率、音频，只记在本次会话）、提交与失败原因。防重复点击归调用方的
 * 出片闸门（useGenerationGate）；202 后由任务列表轮询进度，同组可继续生成新版本。
 *
 * 出片失败的原因留在这里按镜头组记着，由工作台渲染在底部出片栏里：全局 toast 弹在视口
 * 底部、压着聊天输入区，离按下的按钮太远。 */

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

/** 出片栏这次选定的三项。 */
export type VideoChoice = { model: string; resolution: VideoResolution; generateAudio: boolean }

const modelsStatus = (query: { isError: boolean; data: unknown }): VideoModelsStatus =>
  query.isError ? 'unavailable' : query.data === undefined ? 'loading' : 'ready'

/** `fileModel` 是制作页上工程文件里这一组写的模型，出片栏默认选它；分镜页不传。 */
export const useVideoGeneration = (conversationId: string, fileModel?: string) => {
  const queryClient = useQueryClient()
  const models = useVideoModels()
  // 只留最近一次失败：提示挨着出片按钮，同时只看得见当前这一组。
  const [failure, setFailure] = useState<{ index: number; message: string } | undefined>(undefined)
  const [wanted, setWanted] = useState<VideoGenerationOptions>({
    generateAudio: DEFAULT_GENERATE_AUDIO,
    model: undefined,
    resolution: DEFAULT_VIDEO_RESOLUTION,
  })
  // 先看这次会话里选过的，再看工程文件里这一组写的；不在允许表里（配置改了、文件写了别的）
  // 就往下退，最后是服务端的默认。不用副作用改 state。
  const items = models.data?.items ?? []
  const allowed = (candidate: string | undefined) =>
    candidate !== undefined && items.includes(candidate) ? candidate : undefined
  const model = allowed(wanted.model) ?? allowed(fileModel) ?? models.data?.default
  const options: VideoGenerationOptions = { ...wanted, model }

  /** 给第 `index` 组出片：`send` 按出片栏这次选的模型、分辨率、音频发请求，分镜页与制作页各发各的。 */
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
    /** 这一组上次出片失败的原因；换组就不显示，不用清。 */
    errorOf: (index: number) => (failure?.index === index ? failure.message : undefined),
    models: items,
    modelsStatus: modelsStatus(models),
    options,
    /** 出片路上、提交之前就失败的（例如取不到已保存的镜头组），走同一条提示通道。 */
    reportError: (index: number, message: string) => setFailure({ index, message }),
    setOptions: setWanted,
    submit,
  }
}
