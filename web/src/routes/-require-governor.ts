import { redirect } from '@tanstack/react-router'
import { canAuditAll, ensureSessionUser } from '@/shared/auth'

export async function requireGovernor(): Promise<void> {
  if (!canAuditAll(await ensureSessionUser())) {
    throw redirect({ to: '/' })
  }
}
