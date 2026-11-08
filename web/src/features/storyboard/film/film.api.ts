import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import { use, useEffect } from 'react'
import type { z } from 'zod'
import { apiFetch } from '@/shared/api/client'
import type {
  FilmAspectRatioIn,
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

export const FILM_PATH = 'film.icml'

export const FILM_RUN_PATH = 'film.icrun'

export const filmQueryKey = (conversationId: string) =>
  [...storyboardQueryKeys.conversation(conversationId), 'film'] as const

export const filmViewQuery = (conversationId: string) =>
  queryOptions({
    queryFn: ({ signal }) =>
      apiFetch(`/conversations/${conversationId}/film`, zFilmViewEnvelope, {
        fallbackErrorMessage: '读取分镜失败',
        signal,
      }),
    queryKey: filmQueryKey(conversationId),
  })

export const useFilmView = (conversationId: string) =>
  useQuery({ ...filmViewQuery(conversationId), select: (envelope) => envelope.film })

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

export const editFilmText = async (
  conversationId: string,
  filmVersion: number,
  edits: readonly FilmTextEditIn[],
): Promise<FilmView> => {
  const envelope = await apiFetch(`/conversations/${conversationId}/film/text`, zFilmViewEnvelope, {
    body: { edits, filmVersion },
    fallbackErrorMessage: '分镜保存失败',
    method: 'PATCH',
  })
  return envelope.film
}

export const generateFilmVideo = (conversationId: string, body: FilmVideoGenerationIn) =>
  apiFetch(`/conversations/${conversationId}/film/video-generations`, zFilmJobOut, {
    body,
    fallbackErrorMessage: '视频提交失败',
    method: 'POST',
  })

export const chooseFilmImage = async (
  conversationId: string,
  body: FilmImageChoiceIn,
): Promise<FilmView> => {
  const envelope = await apiFetch(
    `/conversations/${conversationId}/film/image`,
    zFilmViewEnvelope,
    {
      body,
      fallbackErrorMessage: '替换图片失败',
      method: 'PUT',
    },
  )
  return envelope.film
}

export const setFilmAspectRatio = async (
  conversationId: string,
  body: FilmAspectRatioIn,
): Promise<FilmView> => {
  const envelope = await apiFetch(
    `/conversations/${conversationId}/film/aspect-ratio`,
    zFilmViewEnvelope,
    {
      body,
      fallbackErrorMessage: '画幅修改失败',
      method: 'PUT',
    },
  )
  return envelope.film
}

export const generateFilmImage = (conversationId: string, body: FilmImageGenerationIn) =>
  apiFetch(`/conversations/${conversationId}/film/image-generations`, zFilmJobOut, {
    body,
    fallbackErrorMessage: '生成提交失败',
    method: 'POST',
  })
