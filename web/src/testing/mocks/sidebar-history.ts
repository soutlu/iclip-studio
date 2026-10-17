import { addMockCollection, addMockConversation } from './conversations'

/** 浏览器回归专用的千条大合集；`cue.mock.sidebar-large-collection` 为 true 时才加入。 */
export const seedSidebarHistory = () => {
  const collection = addMockCollection('千条历史任务')
  collection.id = '10000000-0000-4000-8000-000000000000'
  const newestAt = Date.now()
  for (let number = 1; number <= 1000; number += 1) {
    const conversation = addMockConversation(
      `历史任务 ${String(number).padStart(4, '0')}`,
      new Date(newestAt - number * 60_000).toISOString(),
      undefined,
      `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
    )
    conversation.collectionId = collection.id
  }
}
