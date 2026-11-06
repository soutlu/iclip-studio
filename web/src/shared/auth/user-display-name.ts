import type { CueAuthUser } from './cue-auth.types'

export const userDisplayName = (
  user: Pick<CueAuthUser, 'displayName' | 'username'> | null | undefined,
): string => user?.displayName || user?.username || '用户'
