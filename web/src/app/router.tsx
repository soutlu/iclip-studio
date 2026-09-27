import { createRouter } from '@tanstack/react-router'
import type { ComponentType } from 'react'
import { routeTree } from '@/routeTree.gen'
import { setOnForbidden, setOnUnauthorized } from '@/shared/api/client'
import { refreshSessionUser } from '@/shared/auth'

export const router = createRouter({
  defaultPreload: 'intent',
  routeTree,
  scrollRestoration: true,
  // 换路径时路由会把上一页同一位置元素的滚动值搬到新页，而各页的滚动容器都是同一位置的 <main>；
  // 列入回顶的元素不搬，新页没有记录就回到 0，后退时仍按该页自己的记录复原。
  // 一个文档只有一个 main，这一个选择器覆盖所有页面，不用各页自己挂 data-scroll-restoration-id。
  scrollToTopSelectors: ['main'],
})

// 滚动复位只在换页面时做：只改查询参数的原地导航也复位的话，会把这次渲染里的程序滚动撤回导航前的位置。
// PUSH / REPLACE 都经 commitLocation；前进后退不经这里，照常复原。
const commitLocation = router.commitLocation
router.commitLocation = (next) =>
  commitLocation({
    ...next,
    resetScroll: next.resetScroll ?? next.pathname !== router.state.resolvedLocation?.pathname,
  })

let sessionRecoveryPromise: null | Promise<void> = null

/**
 * 合并并发的 401/403 会话复核，避免同一批失败重复请求身份事实源或重算路由。
 */
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

// 401 后强刷 /users/me 并重算路由；/users/me 自身不触发全局处理，避免递归。
setOnUnauthorized(refreshSessionThenInvalidateRoutes)

// 403 可能表示权限已变更，强刷 /users/me 后重算路由；原请求错误仍由调用方展示。
setOnForbidden(refreshSessionThenInvalidateRoutes)

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }

  // 右面板由当前匹配路由的 staticData 声明，壳负责渲染。
  interface StaticDataRouteOption {
    rightPanel?: ComponentType
  }
}
