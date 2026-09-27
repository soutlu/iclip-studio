/** 审计筛选范围与标签页在查询串里的读写：等于默认值的条件不落地址栏，非法取值退回默认。

总览的时间范围（period / from / to）与明细、异常两个标签的筛选范围（range / since / until 与人、需求单）各存一份。 */

import { z } from 'zod'
import { DEFAULT_AUDIT_SCOPE, overviewRangeSearchFields, type AuditScope } from '@/features/audit'
import {
  dateRangeFromSearch,
  dateRangeSearchFields,
  dateRangeToSearch,
} from '@/shared/lib/date-range'

export const auditSearchSchema = z.object({
  ...dateRangeSearchFields,
  ...overviewRangeSearchFields,
  tab: z.enum(['overview', 'conversations', 'anomalies']).optional().catch(undefined),
  taskId: z.string().min(1).optional().catch(undefined),
  userName: z.string().min(1).optional().catch(undefined),
})

export type AuditSearch = z.output<typeof auditSearchSchema>

export function scopeFromSearch(search: AuditSearch): AuditScope {
  return {
    ...dateRangeFromSearch(search, DEFAULT_AUDIT_SCOPE),
    taskId: search.taskId ?? null,
    userName: search.userName ?? null,
  }
}

type ScopeSearch = Pick<AuditSearch, 'range' | 'since' | 'until' | 'taskId' | 'userName'>

export function searchFromScope(scope: AuditScope): ScopeSearch {
  return {
    ...dateRangeToSearch(scope, DEFAULT_AUDIT_SCOPE),
    taskId: scope.taskId ?? undefined,
    userName: scope.userName ?? undefined,
  }
}
