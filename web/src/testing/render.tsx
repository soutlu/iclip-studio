import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { act, render, type RenderOptions } from '@testing-library/react'
import { createContext, use, type ReactElement, type ReactNode } from 'react'
import { TranscriptProvider } from '@/shared/transcript/transcript-provider'
import { TooltipProvider } from '@/shared/ui/tooltip'
import {
  ArtifactRegistry,
  WorkbenchOpenRequestProvider,
  WorkbenchRegistryProvider,
} from '@/shared/workbench'
import { FakeSocket, SERVER_HELLO } from './ws'

export const renderWithTooltip = (ui: ReactElement, options: RenderOptions = {}) => {
  const Inner = options.wrapper
  return render(ui, {
    ...options,
    wrapper: ({ children }) => (
      <TooltipProvider>
        {Inner === undefined ? children : <Inner>{children}</Inner>}
      </TooltipProvider>
    ),
  })
}

const SubjectContext = createContext<ReactNode>(null)

const useSubject = () => use(SubjectContext)

export const renderWithProviders = async (
  ui: ReactNode,
  {
    createSocket,
    initialPath = '/',
    registry = new ArtifactRegistry(),
  }: {
    createSocket?: () => WebSocket
    initialPath?: string
    registry?: ArtifactRegistry
  } = {},
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
  await router.load()

  const tree = (subject: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <TranscriptProvider createSocket={createSocket ?? (() => socket as unknown as WebSocket)}>
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
  await act(async () => {})
  if (createSocket === undefined) socket.deliver(SERVER_HELLO)

  return {
    ...result,
    queryClient,
    rerender: (next: ReactNode) => result.rerender(tree(next)),
    router,
    socket,
  }
}
