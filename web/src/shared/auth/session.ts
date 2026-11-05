import { useRouter } from '@tanstack/react-router'
import type { QueryFilters } from '@tanstack/react-query'
import { useCallback } from 'react'
import { configureAuth } from 'react-query-auth'
import { ApiError } from '@/shared/api/client'
import { queryClient } from '@/shared/api/query-client'
import {
  completeSsoCallback,
  fetchSsoAuthorizationUrl,
  getCurrentCueUser,
  loginCueUser,
  logoutCueUser,
} from './cue-auth.api'
import type { CueAuthUser, CueLoginRequest } from './cue-auth.types'

export const AUTH_QUERY_KEY_ROOT = 'auth'

export const USER_QUERY_KEY = [AUTH_QUERY_KEY_ROOT, 'current-user'] as const

const SSO_NEXT_STORAGE_KEY = 'cue_sso_next'

const BUSINESS_QUERIES: QueryFilters = {
  predicate: (query) => query.queryKey[0] !== AUTH_QUERY_KEY_ROOT,
}

const clearBusinessQueries = async (): Promise<void> => {
  await queryClient.cancelQueries(BUSINESS_QUERIES)
  queryClient.removeQueries(BUSINESS_QUERIES)
}

const fetchCurrentUser = async (context?: { signal: AbortSignal }): Promise<null | CueAuthUser> => {
  let user: null | CueAuthUser
  try {
    user = await getCurrentCueUser()
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) throw error
    user = null
  }

  context?.signal.throwIfAborted()
  const previous = queryClient.getQueryData<null | CueAuthUser>(USER_QUERY_KEY)
  if ((previous?.id ?? null) !== (user?.id ?? null)) {
    await clearBusinessQueries()
  }
  context?.signal.throwIfAborted()
  return user
}

const loginWithPassword = async (request: CueLoginRequest): Promise<CueAuthUser> => {
  await loginCueUser(request)
  await queryClient.cancelQueries({ queryKey: USER_QUERY_KEY, exact: true })

  const user = await fetchCurrentUser()

  if (!user) {
    throw new ApiError(401, '登录会话未生效，请重试')
  }

  return user
}

const logout = async (): Promise<void> => {
  await logoutCueUser()
  await queryClient.cancelQueries({ queryKey: USER_QUERY_KEY, exact: true })
  await clearBusinessQueries()
}

const auth = configureAuth<null | CueAuthUser, ApiError, CueLoginRequest, CueLoginRequest>({
  loginFn: loginWithPassword,
  logoutFn: logout,
  registerFn: () => Promise.reject(new Error('iClip 不提供自助注册')),
  userFn: fetchCurrentUser,
  userKey: [...USER_QUERY_KEY],
})

export const useUser = auth.useUser

export const ensureSessionUser = () =>
  queryClient.ensureQueryData({ queryFn: fetchCurrentUser, queryKey: [...USER_QUERY_KEY] })

const useSessionInvalidation = () => {
  const router = useRouter()

  return useCallback(() => {
    void router.invalidate()
  }, [router])
}

type LoginOptions = Parameters<typeof auth.useLogin>[0]
type LogoutOptions = Parameters<typeof auth.useLogout>[0]

export const useLogin = (options?: LoginOptions) => {
  const invalidateSession = useSessionInvalidation()

  return auth.useLogin({
    ...options,
    onSuccess: (...args) => {
      invalidateSession()
      void options?.onSuccess?.(...args)
    },
  })
}

export const useLogout = (options?: LogoutOptions) => {
  const invalidateSession = useSessionInvalidation()

  return auth.useLogout({
    ...options,
    onSettled: (...args) => {
      invalidateSession()
      void options?.onSettled?.(...args)
    },
  })
}

export const refreshSessionUser = (): Promise<null | CueAuthUser> =>
  queryClient.fetchQuery({
    queryFn: fetchCurrentUser,
    queryKey: USER_QUERY_KEY,
    staleTime: 0,
  })

export const probeSsoLoginEnabled = async (): Promise<boolean> => {
  try {
    await fetchSsoAuthorizationUrl()
    return true
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return false
    throw error
  }
}

export const startSsoLogin = async (nextPath: string): Promise<void> => {
  const authorizationUrl = await fetchSsoAuthorizationUrl()

  try {
    sessionStorage.setItem(SSO_NEXT_STORAGE_KEY, nextPath)
  } catch {
    // 忽略浏览器禁用或写满 Web Storage 时抛出的异常。
  }

  window.location.assign(authorizationUrl)
}

export const consumeSsoNextPath = (): null | string => {
  try {
    const nextPath = sessionStorage.getItem(SSO_NEXT_STORAGE_KEY)

    sessionStorage.removeItem(SSO_NEXT_STORAGE_KEY)

    return nextPath
  } catch {
    return null
  }
}

const completeSsoLogin = async (jwt: string): Promise<CueAuthUser> => {
  await completeSsoCallback(jwt)
  await queryClient.cancelQueries({ queryKey: USER_QUERY_KEY, exact: true })

  const user = await fetchCurrentUser()

  if (!user) {
    throw new ApiError(401, 'SSO 会话未生效，请重试')
  }

  queryClient.setQueryData(USER_QUERY_KEY, user)

  return user
}

export const useCompleteSsoLogin = (): ((jwt: string) => Promise<CueAuthUser>) => {
  const invalidateSession = useSessionInvalidation()

  return useCallback(
    async (jwt: string) => {
      const user = await completeSsoLogin(jwt)

      invalidateSession()

      return user
    },
    [invalidateSession],
  )
}
