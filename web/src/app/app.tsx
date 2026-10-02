import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { IdentityScope } from '@/app/identity-scope'
import { router } from '@/app/router'
import { workbenchRegistry } from '@/app/workbench-registry'
import { queryClient } from '@/shared/api/query-client'
import { TranscriptProvider } from '@/shared/transcript/transcript-provider'
import { Toaster } from '@/shared/ui/toast'
import { TooltipProvider } from '@/shared/ui/tooltip'
import { WorkbenchOpenRequestProvider, WorkbenchRegistryProvider } from '@/shared/workbench'

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <IdentityScope>
        <TranscriptProvider>
          <WorkbenchRegistryProvider registry={workbenchRegistry}>
            <WorkbenchOpenRequestProvider>
              <TooltipProvider>
                <RouterProvider router={router} />
              </TooltipProvider>
            </WorkbenchOpenRequestProvider>
          </WorkbenchRegistryProvider>
        </TranscriptProvider>
      </IdentityScope>
      <Toaster />
    </QueryClientProvider>
  )
}
