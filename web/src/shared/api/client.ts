import type { z } from 'zod'

const API_BASE_PATH = '/api'

export class UserFacingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'UserFacingError'
  }
}

export class ApiError extends UserFacingError {
  readonly status: number
  readonly body: unknown

  constructor(status: number, message: string, options?: ErrorOptions & { body?: unknown }) {
    super(message, options)
    this.name = 'ApiError'
    this.status = status
    this.body = options?.body
  }
}

export const errorMessageOf = (error: unknown, fallback: string): string =>
  error instanceof UserFacingError ? error.message : fallback

let onUnauthorized: (() => void) | null = null

export const setOnUnauthorized = (handler: (() => void) | null) => {
  onUnauthorized = handler
}

let onForbidden: (() => void) | null = null

export const setOnForbidden = (handler: (() => void) | null) => {
  onForbidden = handler
}

type ApiFetchOptions = Omit<RequestInit, 'body'> & {
  body?: unknown
  fallbackErrorMessage?: string
  skipUnauthorizedHandler?: boolean
}

export interface ApiFetchResult<T> {
  data: T
  response: Response
}

const readApiError = async (response: Response, fallbackMessage: string) => {
  const responseText = await response.text().catch(() => '')
  let body: unknown
  try {
    body = JSON.parse(responseText) as unknown
  } catch {
    body = undefined
  }
  const detail =
    typeof body === 'object' && body !== null ? (body as { detail?: unknown }).detail : undefined
  const message = typeof detail === 'string' ? detail.trim() : ''
  return new ApiError(
    response.status,
    message ? `${fallbackMessage}：${message}` : fallbackMessage,
    { body },
  )
}

export const NETWORK_FAILURE = '网络连接失败，请检查网络后重试'
const MALFORMED_RESPONSE = '服务返回的数据格式不正确'

// 跨 realm 的 DOMException 无法通过 instanceof 可靠判定，故按 error.name 识别 AbortError。
const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'

const asClientFailure = (error: unknown, message: string): unknown =>
  isAbortError(error) ? error : new ApiError(0, message, { cause: error })

export const apiFetchWithResponse = async <T>(
  path: string,
  schema: z.ZodType<T>,
  options: ApiFetchOptions = {},
): Promise<ApiFetchResult<T>> => {
  const {
    body,
    fallbackErrorMessage = '请求失败',
    headers,
    skipUnauthorizedHandler = false,
    ...rest
  } = options
  const requestInit: RequestInit = {
    credentials: 'same-origin',
    ...rest,
  }

  if (body instanceof URLSearchParams) {
    requestInit.body = body
    if (headers) {
      requestInit.headers = headers
    }
  } else if (body !== undefined) {
    requestInit.body = JSON.stringify(body)
    requestInit.headers = { 'Content-Type': 'application/json', ...headers }
  } else if (headers) {
    requestInit.headers = headers
  }

  let response: Response
  try {
    response = await fetch(`${API_BASE_PATH}${path}`, requestInit)
  } catch (error) {
    throw asClientFailure(error, `${fallbackErrorMessage}：${NETWORK_FAILURE}`)
  }

  if (!response.ok) {
    if (response.status === 401 && !skipUnauthorizedHandler) {
      onUnauthorized?.()
    }

    if (response.status === 403) {
      onForbidden?.()
    }

    throw await readApiError(response, fallbackErrorMessage)
  }

  let responseText: string
  try {
    responseText = await response.text()
  } catch (error) {
    throw asClientFailure(error, `${fallbackErrorMessage}：${NETWORK_FAILURE}`)
  }
  let payload: unknown
  try {
    payload = responseText.length > 0 ? JSON.parse(responseText) : undefined
  } catch (error) {
    throw new ApiError(0, `${fallbackErrorMessage}：${MALFORMED_RESPONSE}`, { cause: error })
  }
  const parsed = schema.safeParse(payload)

  if (!parsed.success) {
    throw new ApiError(0, `${fallbackErrorMessage}：${MALFORMED_RESPONSE}`, {
      cause: parsed.error,
    })
  }

  return {
    data: parsed.data,
    response,
  }
}

export const apiFetch = async <T>(
  path: string,
  schema: z.ZodType<T>,
  options: ApiFetchOptions = {},
): Promise<T> => (await apiFetchWithResponse(path, schema, options)).data
