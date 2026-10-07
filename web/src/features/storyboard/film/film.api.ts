/** 制作页读写 AI 导演的工程：读成镜头组、改字、换图、按描述生图、给一组出片。端点语义见 contract/conventions.md 的「制作页」几条。 */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { use, useEffect } from 'react'
import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import type {
  FilmImageChoiceIn,
  FilmImageGenerationIn,
  FilmTextEditIn,
  FilmVideoGenerationIn,
} from '@/shared/api/generated/types.gen'
import { zFilmJobOut, zFilmViewEnvelope } from '@/shared/api/generated/zod.gen'
import { TranscriptConnectionContext } from '@/shared/transcript/transcript-context'
import { storyboardQueryKeys } from '../storyboard.api'

export type FilmView = z.infer<typeof zFilmViewEnvelope>['film']
export type FilmGroup = FilmView['groups'][number]
export type FilmFrame = FilmGroup['frames'][number]
export type FilmSetting = FilmGroup['settings'][number]
export type FilmShot = FilmGroup['shots'][number]

/** 工程文件，制作页按它出现。 */
export const FILM_PATH = 'film.icml'

/** 运行文件：登记与选用的图片都在它里面，变了也要重读。 */
export const FILM_RUN_PATH = 'film.icrun'

/** 挂在本对话生成记录的前缀下，状态跳转帧到了跟着重拉。 */
export const filmQueryKey = (conversationId: string) =>
  [...storyboardQueryKeys.conversation(conversationId), 'film'] as const

export const useFilmView = (conversationId: string) =>
  useQuery({
    queryFn: ({ signal }) =>
      apiFetch(`/conversations/${conversationId}/film`, zFilmViewEnvelope, {
        fallbackErrorMessage: '读取分镜失败',
        signal,
      }),
    queryKey: filmQueryKey(conversationId),
    select: (envelope) => envelope.film,
  })

/** 工程文件或运行文件一变就重读（AI 导演改了、人在文件页存了）；生成落定由 `useLiveGenerations` 失效前缀带上。 */
export const useFilmFileChanges = (conversationId: string): void => {
  const connection = use(TranscriptConnectionContext)
  const queryClient = useQueryClient()
  useEffect(() => {
    if (connection === null) return undefined
    return connection.watchFs(conversationId, [FILM_PATH, FILM_RUN_PATH], () => {
      void queryClient.invalidateQueries({ queryKey: filmQueryKey(conversationId) })
    })
  }, [connection, conversationId, queryClient])
}

/** 写回几段字，答复改完的整页；版本对不上是 409，不合规矩是 422（`detail` 是给人看的一句话）。 */
export const editFilmText = async (
  conversationId: string,
  filmVersion: number,
  edits: readonly FilmTextEditIn[],
): Promise<FilmView> => {
  const envelope = await apiFetch(`/conversations/${conversationId}/film/text`, zFilmViewEnvelope, {
    body: { edits, filmVersion },
    fallbackErrorMessage: '保存失败',
    method: 'PATCH',
  })
  return envelope.film
}

/** 给一组出片：镜头组与参考图由后端按文件拼，答复 202 与任务号；进度照常看视频记录。 */
export const generateFilmVideo = (conversationId: string, body: FilmVideoGenerationIn) =>
  apiFetch(`/conversations/${conversationId}/film/video-generations`, zFilmJobOut, {
    body,
    fallbackErrorMessage: '视频提交失败',
    method: 'POST',
  })

/** 给一张图换地址，答复换完的整页；`url` 是这段对话的图片或自己刚上传的图，生成图的 `url` 为 null 是取消选用、没图。 */
export const chooseFilmImage = async (
  conversationId: string,
  body: FilmImageChoiceIn,
): Promise<FilmView> => {
  const envelope = await apiFetch(
    `/conversations/${conversationId}/film/image`,
    zFilmViewEnvelope,
    {
      body,
      fallbackErrorMessage: '换图失败',
      method: 'PUT',
    },
  )
  return envelope.film
}

/** 按描述给一张图出一张新的，答复 202 与任务号；结果只进版本，不自动用上，要选用。 */
export const generateFilmImage = (conversationId: string, body: FilmImageGenerationIn) =>
  apiFetch(`/conversations/${conversationId}/film/image-generations`, zFilmJobOut, {
    body,
    fallbackErrorMessage: '生成提交失败',
    method: 'POST',
  })
