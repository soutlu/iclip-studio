import type { z } from 'zod'
import type {
  zCollectionOut,
  zConversationOut,
  zConversationsAuditItemOut,
} from '@/shared/api/generated/zod.gen'
import { mockAuthUser } from './auth-user'
import { mockCreatedAt } from './paging'

// 内存对话与合集遵循 ConversationOut / CollectionOut；单独成模块，transcript mock 才能按 id 查属主而不成环。

export type MockConversation = z.output<typeof zConversationOut>

/** 原型环境的会话事件时钟：一个进程标识，按对话从 1 连续发号（合同 §5「全局帧」）。 */
export const MOCK_EVENT_EPOCH = 'mock-events'

const mockEventSeqs = new Map<string, number>()

/** 给这段对话的下一帧全局帧发号，返回信封上的属主与水位。 */
export const mockSessionEnvelope = (conversationId: string) => {
  const seq = (mockEventSeqs.get(conversationId) ?? 0) + 1
  mockEventSeqs.set(conversationId, seq)
  return {
    epoch: MOCK_EVENT_EPOCH,
    owner_user_id: mockConversationOwner(conversationId),
    seq,
  }
}

/** 删除只写 deletedAt（合同 §6 墓碑）；墓碑只有审计列表列得出来。 */
export const mockConversations: MockConversation[] = []

/** 按对话 id 记它自己最新一条成片的地址；只有审计列表带这一项，没记的为 null。 */
export const mockLatestMasterUrls = new Map<string, string>()

/** 审计列表里的一行：对话本身加上它最新一条成片的地址。 */
export const mockAuditRow = (
  conversation: MockConversation,
): z.output<typeof zConversationsAuditItemOut> => ({
  ...conversation,
  latestMasterUrl: mockLatestMasterUrls.get(conversation.id) ?? null,
})

/** 还活着的那一段；墓碑对改名、换归属、再删、发消息一律按不存在答复。 */
export const liveMockConversation = (conversationId: string) =>
  mockConversations.find((item) => item.id === conversationId && item.deletedAt === null)

export const addMockConversation = (
  title: string,
  createdAt = mockCreatedAt(),
  ownerUserId = mockAuthUser.id,
) => {
  const conversation: MockConversation = {
    activity: {
      busy: false,
      lastTurnReason: null,
      pendingInteraction: 'none',
      videoGeneration: 'none',
    },
    agentId: 'storyboard',
    collectionId: null,
    completedAt: null,
    createdAt,
    deletedAt: null,
    eventEpoch: MOCK_EVENT_EPOCH,
    forkTurn: null,
    forkedFrom: null,
    id: crypto.randomUUID(),
    lastRunId: null,
    lastSeq: 0,
    ownerUserId,
    taskId: null,
    title,
    updatedAt: createdAt,
  }
  // 行上的 lastSeq 是读这一行时这段对话已发出的最大序号；取值时现读，展开或序列化那一刻就是读库时刻。
  Object.defineProperty(conversation, 'lastSeq', {
    enumerable: true,
    get: () => mockEventSeqs.get(conversation.id) ?? 0,
  })
  mockConversations.push(conversation)
  return conversation
}

/** 缺省属主是登录的测试用户；找不到那段对话时也按它算，历史用例不带对话行也能读 transcript。 */
export const mockConversationOwner = (conversationId: string): string =>
  mockConversations.find((item) => item.id === conversationId)?.ownerUserId ?? mockAuthUser.id

export const resetMockConversations = () => {
  mockConversations.length = 0
  mockLatestMasterUrls.clear()
  mockEventSeqs.clear()
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
