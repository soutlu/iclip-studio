import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { IdentityTranscriptProvider } from '@/app/identity-transcript'
import { router } from '@/app/router'
import { workbenchRegistry } from '@/app/workbench-registry'
import { queryClient } from '@/shared/api/query-client'
import { Toaster } from '@/shared/ui/toast'
import { TooltipProvider } from '@/shared/ui/tooltip'
import { WorkbenchOpenRequestProvider, WorkbenchRegistryProvider } from '@/shared/workbench'

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <IdentityTranscriptProvider>
        <WorkbenchRegistryProvider registry={workbenchRegistry}>
          <WorkbenchOpenRequestProvider>
            <TooltipProvider>
              <RouterProvider router={router} />
            </TooltipProvider>
          </WorkbenchOpenRequestProvider>
        </WorkbenchRegistryProvider>
      </IdentityTranscriptProvider>
      <Toaster />
    </QueryClientProvider>
  )
}
