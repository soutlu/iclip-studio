import { createFileRoute } from '@tanstack/react-router'
import { ConversationsRoute, useAuditConversations } from '@/features/conversations'
import { rememberReturn } from '../-conversations-return'
import {
  conversationsSearchSchema,
  filtersFromSearch,
  searchFromFilters,
} from '../-conversations-search'
import { requireGovernor } from '../-require-governor'
import { useAuditTaskPreviews } from '../-use-audit-task-previews'
import { useTaskPickerSource } from '../-use-task-picker-source'

export const Route = createFileRoute('/_shell/conversations')({
  beforeLoad: requireGovernor,
  component: ConversationsPage,
  validateSearch: conversationsSearchSchema,
})

function ConversationsPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const tasks = useTaskPickerSource()
  const filters = filtersFromSearch(search)
  const conversations = useAuditConversations(filters, true)
  const taskIdGroups =
    conversations.data?.pages.map((page) =>
      page.items.flatMap((row) => (row.taskId ? [row.taskId] : [])),
    ) ?? []
  const { taskPreviews, taskPreviewState, taskPreviewRetry } = useAuditTaskPreviews(taskIdGroups)

  return (
    <ConversationsRoute
      filters={filters}
      onFiltersChange={(next) => void navigate({ replace: true, search: searchFromFilters(next) })}
      onOpen={(conversationId) => rememberReturn(conversationId, search)}
      tasks={tasks}
      taskPreviews={taskPreviews}
      taskPreviewState={taskPreviewState}
      taskPreviewRetry={taskPreviewRetry}
    />
  )
}
