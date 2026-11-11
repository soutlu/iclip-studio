import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, vi } from 'vitest'
import {
  resetMockConversations,
  resetMockSession,
  resetMockTasks,
  resetMockUsers,
} from './mocks/handlers'
import { resetMockAgentConfig } from './mocks/agent-config'
import { resetMockAgentPreviews } from './mocks/agent-previews'
import { resetMockEnhancements } from './mocks/enhancements'
import { resetMockFilm } from './mocks/film'
import { resetMockHitCases } from './mocks/hit-cases'
import { resetMockLibraryTags } from './mocks/library-tags'
import { resetMockMcpConnections } from './mocks/mcp-connections'
import { resetMockMcpServers } from './mocks/mcp-servers'
import { resetMockModelProviders } from './mocks/model-providers'
import { resetMockClock } from './mocks/paging'
import { resetMockReferences } from './mocks/references'
import { server } from './mocks/server'
import { resetMockSkills } from './mocks/skills'
import { resetMockTranscript } from './mocks/transcript'
import { resetMockWholeFilm } from './mocks/whole-film'
import { resetMockWorkspace } from './mocks/workspace'

vi.mock('@hyperframes/player', () => import('./hyperframes-player'))

// jsdom 画不了 Lottie：场记板动画在用例里只占位，不下载也不绘制
vi.mock('lottie-web/build/player/lottie_light', () => ({
  default: {
    loadAnimation: () => ({
      addEventListener: () => undefined,
      destroy: () => undefined,
      goToAndStop: () => undefined,
      play: () => undefined,
      removeEventListener: () => undefined,
    }),
  },
}))

// 用例里开的 BroadcastChannel 用例结束就关掉：留着的监听会收到后面用例发的广播，
// 例如前面用例的页面会把后面用例的「已连接」再提示一遍。
const openChannels = new Set<BroadcastChannel>()
class TrackedBroadcastChannel extends BroadcastChannel {
  constructor(name: string) {
    super(name)
    openChannels.add(this)
  }
}
globalThis.BroadcastChannel = TrackedBroadcastChannel

if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })
}

if (typeof window.ResizeObserver === 'undefined') {
  class NoopResizeObserver {
    disconnect() {}
    observe() {}
    unobserve() {}
  }
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    value: NoopResizeObserver,
    writable: true,
  })
}

const noRects = () => ({ length: 0, item: () => null }) as unknown as DOMRectList
const zeroRect = () =>
  ({ bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0 }) as DOMRect
for (const proto of [Range.prototype, Element.prototype]) {
  if (!('getClientRects' in proto))
    Object.defineProperty(proto, 'getClientRects', { value: noRects })
  if (!('getBoundingClientRect' in proto)) {
    Object.defineProperty(proto, 'getBoundingClientRect', { value: zeroRect })
  }
}

if (!('error' in HTMLMediaElement.prototype)) {
  Object.defineProperty(HTMLMediaElement.prototype, 'error', { configurable: true, value: null })
}

if (!('setPointerCapture' in Element.prototype)) {
  for (const [name, value] of [
    ['setPointerCapture', () => undefined],
    ['releasePointerCapture', () => undefined],
    ['hasPointerCapture', () => false],
  ] as const)
    Object.defineProperty(Element.prototype, name, { configurable: true, value, writable: true })
}

if (!('scrollIntoView' in Element.prototype)) {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => {},
    writable: true,
  })
}

if (!('elementFromPoint' in Document.prototype)) {
  Object.defineProperty(Document.prototype, 'elementFromPoint', {
    configurable: true,
    value: () => null,
    writable: true,
  })
}

if (!('animate' in Element.prototype)) {
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: () => ({ cancel: () => {}, finished: Promise.resolve() }),
    writable: true,
  })
}

const unhandledRequests: string[] = []

beforeAll(() => {
  server.listen({
    onUnhandledRequest(request, print) {
      unhandledRequests.push(`${request.method} ${request.url}`)
      print.error()
      throw new Error(`未声明 handler 的请求：${request.method} ${request.url}`)
    },
  })
})

afterEach(() => {
  server.resetHandlers()
  server.events.removeAllListeners()
  resetMockAgentConfig()
  resetMockAgentPreviews()
  resetMockMcpServers()
  resetMockMcpConnections()
  resetMockClock()
  resetMockConversations()
  resetMockEnhancements()
  resetMockFilm()
  resetMockLibraryTags()
  resetMockHitCases()
  resetMockModelProviders()
  resetMockReferences()
  resetMockSession()
  resetMockSkills()
  resetMockTasks()
  resetMockTranscript()
  resetMockUsers()
  resetMockWholeFilm()
  resetMockWorkspace()
  cleanup()
  for (const channel of openChannels) channel.close()
  openChannels.clear()
  if (unhandledRequests.length > 0) {
    const requests = unhandledRequests.splice(0)
    throw new Error(`用例发出了未声明 handler 的请求：\n${requests.join('\n')}`)
  }
})

afterAll(() => {
  server.close()
})
