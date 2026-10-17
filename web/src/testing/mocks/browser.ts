import { http } from 'msw'
import { setupWorker } from 'msw/browser'
import sampleWideUrl from '../fixtures/sample-video-wide.mp4?no-inline'
import sampleVideoUrl from '../fixtures/sample-video.mp4?no-inline'
import { mockLatestMasterUrls } from './conversations'
import {
  addMockCollection,
  addMockConversation,
  addMockUser,
  handlers,
  mockGovernor,
} from './handlers'
import { seedDemoTasks } from './demo-tasks'
import { seedMockFilm } from './film'
import { backgroundShowcase, multipleBackgroundShowcase } from './background-showcase'
import { toolShowcase } from './tool-showcase'
import { markMockAwaitingApproval, markMockJustFinished, markMockShowcase } from './transcript'
import { seedMockReplicaWorkspace, seedMockWorkspace } from './workspace'
import { seedSidebarHistory } from './sidebar-history'

const DEMO_CONVERSATIONS = [
  '夜景延时素材生成',
  '夏季亚麻系列广告',
  '通勤背包短视频',
  '亚麻衬衫二剪',
  '产品宣传片 · 分镜生成中',
]

const seeded = DEMO_CONVERSATIONS.map((title, index) =>
  addMockConversation(
    title,
    new Date(Date.now() - (DEMO_CONVERSATIONS.length - index) * 3600_000).toISOString(),
    undefined,
    `0d3e5a10-7c4b-4e2f-9a61-00000000000${index + 1}`,
  ),
)

const awaiting = seeded.at(-1)
if (awaiting !== undefined) {
  awaiting.activity = {
    busy: true,
    lastTurnReason: null,
    pendingInteraction: 'approval',
    videoGeneration: 'none',
  }
  markMockAwaitingApproval(awaiting.id)
}

const unseen = seeded[3]
if (unseen !== undefined) {
  unseen.activity = {
    busy: false,
    lastTurnReason: 'completed',
    pendingInteraction: 'none',
    videoGeneration: 'none',
  }
  markMockJustFinished(unseen)
}

const withShots = seeded[0]
if (withShots !== undefined) {
  seedMockWorkspace(withShots.id, { httpFrames: true })
  withShots.activity = { ...withShots.activity, videoGeneration: 'running' }
}

const queuedVideo = seeded[3]
if (queuedVideo !== undefined) {
  queuedVideo.activity = { ...queuedVideo.activity, videoGeneration: 'queued' }
}

const withoutImages = addMockConversation('无图分镜草稿')
seedMockWorkspace(withoutImages.id, { withoutImages: true })

const toolShowcaseConversation = addMockConversation(toolShowcase.title)
seedMockWorkspace(toolShowcaseConversation.id, { httpFrames: true })
markMockShowcase(toolShowcaseConversation.id, toolShowcase)

for (const showcase of [backgroundShowcase, multipleBackgroundShowcase]) {
  markMockShowcase(addMockConversation(showcase.title).id, showcase)
}

const film = addMockConversation('穿搭种草 · 12 秒')
seedMockFilm(film.id, {
  musicDescription: '轻快的电子乐，鼓点渐入，副歌推到高潮，整体明亮有活力',
})

const replica = addMockConversation('乐福鞋 · 完全复刻')
seedMockReplicaWorkspace(replica.id)

const linen = addMockCollection('夏季亚麻系列')
seeded.slice(1, 3).forEach((conversation) => {
  conversation.collectionId = linen.id
})

const governorShots = addMockConversation(
  '治理者 · 秋冬企划样片',
  new Date(Date.now() - 30 * 60_000).toISOString(),
  mockGovernor.id,
)
seedMockWorkspace(governorShots.id, { httpFrames: true })
governorShots.activity = { ...governorShots.activity, videoGeneration: 'running' }
const governorDone = addMockConversation(
  '治理者 · 门店陈列参考',
  new Date(Date.now() - 4 * 3600_000).toISOString(),
  mockGovernor.id,
)
governorDone.activity = { ...governorDone.activity, lastTurnReason: 'completed' }
governorDone.lastRunId = 'run-governor-1'

const wang = addMockUser('小王')
const wangRunning = addMockConversation('小王 · 秋季新品短片', undefined, wang.id)
wangRunning.activity = {
  busy: true,
  lastTurnReason: null,
  pendingInteraction: 'none',
  videoGeneration: 'none',
}
const wangDone = addMockConversation(
  '小王 · 通勤鞋开箱',
  new Date(Date.now() - 2 * 3600_000).toISOString(),
  wang.id,
)
wangDone.activity = {
  busy: false,
  lastTurnReason: 'completed',
  pendingInteraction: 'none',
  videoGeneration: 'none',
}
wangDone.lastRunId = 'run-wang-1'

mockLatestMasterUrls.set(replica.id, sampleVideoUrl)
mockLatestMasterUrls.set(governorDone.id, sampleWideUrl)
mockLatestMasterUrls.set(wangDone.id, sampleVideoUrl)

seedDemoTasks([
  ...seeded,
  withoutImages,
  film,
  replica,
  governorShots,
  governorDone,
  wangRunning,
  wangDone,
])

if (window.localStorage.getItem('cue.mock.sidebar-large-collection') === 'true') {
  seedSidebarHistory()
}

export const worker = setupWorker(...handlers)

const pausedResponses = new Map<string, () => void>()

/**
 * 浏览器用例暂停某个路径的 mock 响应：暂停后到达的请求照常发出，响应等 `release` 后再交给原有 handler。
 * 挂在 `window.cueMockResponses` 上，用例经 `page.evaluate` 调用。
 */
const mockResponseGate = {
  pause(pathname: string) {
    if (pausedResponses.has(pathname)) return
    let release = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    pausedResponses.set(pathname, release)
    // resolver 不返回响应时，MSW 接着交给后面匹配的 handler。
    worker.use(
      http.all(`*${pathname}`, async () => {
        await released
      }),
    )
  },
  release(pathname: string) {
    pausedResponses.get(pathname)?.()
    pausedResponses.delete(pathname)
  },
}
Object.assign(window, { cueMockResponses: mockResponseGate })
