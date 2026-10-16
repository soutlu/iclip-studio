import { delay } from 'msw'
import { addMockCollection, addMockConversation } from './conversations'

const HISTORY_COLLECTION_ID = '10000000-0000-4000-8000-000000000000'

/** 回归用例先确立下方阅读位置，再放开上方的续页；仅影响 opt-in 的固定大合集。 */
export const waitForSidebarHistoryPage = async (collectionId: string) => {
  if (collectionId !== HISTORY_COLLECTION_ID || typeof window === 'undefined') return
  while (window.localStorage.getItem('cue.mock.sidebar-pause-history') === 'true') {
    await delay(10)
  }
}

/** 浏览器回归专用的大合集；仅 opt-in 时加入，默认原型数据保持精简。 */
export const seedSidebarHistory = () => {
  const collection = addMockCollection('千条历史任务')
  collection.id = HISTORY_COLLECTION_ID
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
