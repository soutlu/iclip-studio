import { z } from 'zod'
import { ApiError, apiFetch } from '@/shared/api/client'
import { zSsoAuthorizeOut, zUserEnvelope } from '@/shared/api/generated/zod.gen'
import type { CueAuthUser, CueLoginRequest } from './cue-auth.types'

const cueMeResponseSchema = zUserEnvelope.transform((payload) => payload.user)

const ignoredResponseSchema = z.unknown()

const ssoAuthorizeResponseSchema = zSsoAuthorizeOut.refine(
  (payload) => payload.authorization_url.trim().length > 0,
  'SSO authorize 响应缺少 authorization_url',
)

export const loginCueUser = async (request: CueLoginRequest): Promise<void> => {
  await apiFetch('/auth/login', ignoredResponseSchema, {
    body: new URLSearchParams({
      password: request.password,
      username: request.username,
    }),
    fallbackErrorMessage: '登录失败',
    method: 'POST',
    skipUnauthorizedHandler: true,
  })
}

export const getCurrentCueUser = async (): Promise<CueAuthUser> =>
  apiFetch('/users/me', cueMeResponseSchema, {
    cache: 'no-store',
    fallbackErrorMessage: '读取用户失败',
    method: 'GET',
    skipUnauthorizedHandler: true,
  })

export const logoutCueUser = async (): Promise<void> => {
  try {
    await apiFetch('/auth/logout', ignoredResponseSchema, {
      fallbackErrorMessage: '退出登录失败',
      method: 'POST',
      skipUnauthorizedHandler: true,
    })
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) {
      throw error
    }
  }
}

export const fetchSsoAuthorizationUrl = async (): Promise<string> => {
  const payload = await apiFetch('/auth/sso/authorize', ssoAuthorizeResponseSchema, {
    cache: 'no-store',
    fallbackErrorMessage: 'SSO 登录暂不可用',
    method: 'GET',
    skipUnauthorizedHandler: true,
  })

  return payload.authorization_url
}

export const completeSsoCallback = async (jwt: string): Promise<void> => {
  await apiFetch(`/auth/sso/callback?jwt=${encodeURIComponent(jwt)}`, ignoredResponseSchema, {
    cache: 'no-store',
    fallbackErrorMessage: 'SSO 会话无效或已过期',
    method: 'GET',
    skipUnauthorizedHandler: true,
  })
}
