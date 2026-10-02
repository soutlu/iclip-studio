import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render } from '@testing-library/react'
import { createContext, use, type ReactNode } from 'react'
import { TranscriptProvider } from '@/shared/transcript/transcript-provider'
import { TooltipProvider } from '@/shared/ui/tooltip'
import {
  ArtifactRegistry,
  WorkbenchOpenRequestProvider,
  WorkbenchRegistryProvider,
} from '@/shared/workbench'
import { FakeSocket, SERVER_HELLO } from './ws'

/** 被测组件经它交给路由根组件，rerender 换掉它就能在同一棵 Provider 树里换 props。 */
const SubjectContext = createContext<ReactNode>(null)

const useSubject = () => use(SubjectContext)

/**
 * 使用独立 QueryClient、内存路由、订阅连接和工作台 Provider；/c/$conversationId 仅供参数匹配，socket 已完成握手。
 * 产物登记表缺省为空，需要按路径命中产物的用例传入自己的。返回的 rerender 只换被测组件，Provider 与路由保持不变。
 */
export const renderWithProviders = async (
  ui: ReactNode,
  {
    initialPath = '/',
    registry = new ArtifactRegistry(),
  }: { initialPath?: string; registry?: ArtifactRegistry } = {},
) => {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  })
  const socket = new FakeSocket()
  const rootRoute = createRootRoute({ component: useSubject })
  const conversationRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/c/$conversationId',
  })
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    routeTree: rootRoute.addChildren([conversationRoute]),
  })
  // 先完成路由加载，使首帧即可渲染被测组件。
  await router.load()

  const tree = (subject: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <TranscriptProvider createSocket={() => socket as unknown as WebSocket}>
        <WorkbenchRegistryProvider registry={registry}>
          <WorkbenchOpenRequestProvider>
            <TooltipProvider>
              <SubjectContext value={subject}>
                <RouterProvider router={router} />
              </SubjectContext>
            </TooltipProvider>
          </WorkbenchOpenRequestProvider>
        </WorkbenchRegistryProvider>
      </TranscriptProvider>
    </QueryClientProvider>
  )
  const result = render(tree(ui))
  socket.deliver(SERVER_HELLO)

  return {
    ...result,
    queryClient,
    rerender: (next: ReactNode) => result.rerender(tree(next)),
    router,
    socket,
  }
}
