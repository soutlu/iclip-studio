import { createRouter } from '@tanstack/react-router'
import type { ComponentType } from 'react'
import { routeTree } from '@/routeTree.gen'
import { setOnForbidden, setOnUnauthorized } from '@/shared/api/client'
import { refreshSessionUser } from '@/shared/auth'

export const router = createRouter({
  defaultPreload: 'intent',
  routeTree,
  scrollRestoration: true,
  scrollToTopSelectors: ['main'],
})

const commitLocation = router.commitLocation
router.commitLocation = (next) =>
  commitLocation({
    ...next,
    resetScroll: next.resetScroll ?? next.pathname !== router.state.resolvedLocation?.pathname,
  })

let sessionRecoveryPromise: null | Promise<void> = null

const refreshSessionThenInvalidateRoutes = () => {
  if (sessionRecoveryPromise) {
    return
  }

  sessionRecoveryPromise = refreshSessionUser()
    .then(() => router.invalidate())
    .catch((error: unknown) => {
      console.error('重新确认登录态失败', error)
    })
    .finally(() => {
      sessionRecoveryPromise = null
    })
}

setOnUnauthorized(refreshSessionThenInvalidateRoutes)

setOnForbidden(refreshSessionThenInvalidateRoutes)

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }

  interface StaticDataRouteOption {
    rightPanel?: ComponentType
  }
}
