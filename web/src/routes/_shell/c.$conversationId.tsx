import { createFileRoute, Link, redirect, useNavigate, useParams } from '@tanstack/react-router'
import { z } from 'zod'
import { ConversationRoute } from '@/features/conversations'
import { shotContentIdSchema } from '@/features/storyboard'
import { ensureSessionUser } from '@/shared/auth'
import { canonicalUuid } from '@/shared/lib/uuid'
import { ARTIFACT_SEARCH_KEY, WORKSPACE_FILE_SEARCH_KEY, WorkbenchHost } from '@/shared/workbench'
import { conversationsReturnSearch } from '../-conversations-return'

const ConversationSearchSchema = z.object({
  [ARTIFACT_SEARCH_KEY]: z.string().optional().catch(undefined),
  [WORKSPACE_FILE_SEARCH_KEY]: z.string().optional().catch(undefined),
  content: shotContentIdSchema.optional().catch(undefined),
  frame: z.int().positive().optional().catch(undefined),
  sheet: z.undefined().optional().catch(undefined),
  shot: z.int().positive().optional().catch(undefined),
  take: z.string().optional().catch(undefined),
  video: z.string().min(1).optional().catch(undefined),
  wholeFilm: z.literal(true).optional().catch(undefined),
})

export const Route = createFileRoute('/_shell/c/$conversationId')({
  beforeLoad: async ({ params, search }) => {
    if (!(await ensureSessionUser())) {
      throw redirect({ to: '/' })
    }
    const canonical = canonicalUuid(params.conversationId)
    if (canonical !== null && canonical !== params.conversationId) {
      throw redirect({ params: { conversationId: canonical }, search, to: '/c/$conversationId' })
    }
  },
  component: ConversationIndexRoute,
  staticData: { rightPanel: ConversationWorkbenchPanel },
  validateSearch: ConversationSearchSchema,
})

function ConversationIndexRoute() {
  const { conversationId } = Route.useParams()
  const navigate = useNavigate()
  return (
    <ConversationRoute
      backLink={
        <Link
          className="shrink-0 rounded-xs text-primary ui-focus hover:underline"
          search={conversationsReturnSearch(conversationId)}
          to="/conversations"
        >
          回到全部任务
        </Link>
      }
      conversationId={conversationId}
      key={conversationId}
      onForked={(forked) => {
        void navigate({ params: { conversationId: forked }, to: '/c/$conversationId' })
      }}
      sourceLink={(sourceId) => (
        <Link
          className="shrink-0 rounded-xs text-primary ui-focus hover:underline"
          params={{ conversationId: sourceId }}
          to="/c/$conversationId"
        >
          查看源任务
        </Link>
      )}
    />
  )
}

function ConversationWorkbenchPanel() {
  const { conversationId } = useParams({ strict: false })
  if (conversationId === undefined) return null
  return <WorkbenchHost conversationId={conversationId} key={conversationId} />
}
