import type { z } from 'zod'
import type {
  zCollectionOut,
  zConversationOut,
  zConversationsAuditItemOut,
} from '@/shared/api/generated/zod.gen'
import { mockAuthUser } from './auth-user'
import { mockCreatedAt } from './paging'

export type MockConversation = z.output<typeof zConversationOut>

export const mockSessionEnvelope = (conversationId: string) => ({
  owner_user_id: mockConversationOwner(conversationId),
  timestamp: new Date().toISOString(),
})

export const mockConversations: MockConversation[] = []

export const mockLatestMasterUrls = new Map<string, string>()

export const mockVideoProgress = new Map<string, 'queued' | 'running'>()

export const mockAuditRow = (
  conversation: MockConversation,
): z.output<typeof zConversationsAuditItemOut> => ({
  ...conversation,
  latestMasterUrl: mockLatestMasterUrls.get(conversation.id) ?? null,
})

export const liveMockConversation = (conversationId: string) =>
  mockConversations.find((item) => item.id === conversationId && item.deletedAt === null)

export const addMockConversation = (
  title: string,
  createdAt = mockCreatedAt(),
  ownerUserId = mockAuthUser.id,
  id: string = crypto.randomUUID(),
) => {
  const conversation: MockConversation = {
    activity: {
      busy: false,
      lastTurnReason: null,
      pendingInteraction: 'none',
    },
    agentId: 'storyboard',
    collectionId: null,
    completedAt: null,
    createdAt,
    deletedAt: null,
    forkTurn: null,
    forkedFrom: null,
    id,
    lastRunId: null,
    ownerUserId,
    taskId: null,
    title,
    updatedAt: createdAt,
  }
  mockConversations.push(conversation)
  return conversation
}

export const mockConversationOwner = (conversationId: string): string =>
  mockConversations.find((item) => item.id === conversationId)?.ownerUserId ?? mockAuthUser.id

export const resetMockConversations = () => {
  mockConversations.length = 0
  mockLatestMasterUrls.clear()
  mockVideoProgress.clear()
  mockCollections.length = 0
}

type MockCollection = z.output<typeof zCollectionOut>

export const mockCollections: MockCollection[] = []

export const addMockCollection = (name: string) => {
  const now = mockCreatedAt()
  const collection: MockCollection = {
    createdAt: now,
    id: crypto.randomUUID(),
    name,
    ownerUserId: mockAuthUser.id,
    updatedAt: now,
  }
  mockCollections.push(collection)
  return collection
}
