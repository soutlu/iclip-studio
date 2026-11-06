import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { AgentConfigPage } from '@/features/agent-config'
import { ensureSessionUser, hasPermission, PERMISSION } from '@/shared/auth'
import { AgentPreviewConversation } from '../-agent-preview-conversation'

const agentsSearchSchema = z.object({
  agent: z.string().min(1).optional().catch(undefined),
})

export const Route = createFileRoute('/_shell/agents')({
  beforeLoad: async () => {
    if (!hasPermission(await ensureSessionUser(), PERMISSION.agentManage)) {
      throw redirect({ to: '/' })
    }
  },
  component: AgentsPage,
  validateSearch: agentsSearchSchema,
})

function AgentsPage() {
  const { agent } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <AgentConfigPage
      agentId={agent}
      onAgentChange={(id) => void navigate({ replace: true, search: { agent: id } })}
      PreviewConversation={AgentPreviewConversation}
    />
  )
}
