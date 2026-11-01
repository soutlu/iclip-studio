import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { AgentConfigPage } from '@/features/agent-config'
import { ensureSessionUser, hasPermission, PERMISSION } from '@/shared/auth'

/** 选中的 agent 记在地址里，刷新与分享链接都回到同一个 agent。 */
const agentsSearchSchema = z.object({
  agent: z.string().min(1).optional().catch(undefined),
})

// Agent 配置只给持 agent:manage 的人，没登录或没这个权限都回首页。
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
    />
  )
}
