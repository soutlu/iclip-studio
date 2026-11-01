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
import { resetMockEnhancements } from './mocks/enhancements'
import { resetMockFilm } from './mocks/film'
import { resetMockHitCases } from './mocks/hit-cases'
import { resetMockLibraryTags } from './mocks/library-tags'
import { resetMockMcpServers } from './mocks/mcp-servers'
import { resetMockClock } from './mocks/paging'
import { resetMockReferences } from './mocks/references'
import { server } from './mocks/server'
import { resetMockSkills } from './mocks/skills'
import { resetMockTranscript } from './mocks/transcript'
import { resetMockWholeFilm } from './mocks/whole-film'
import { resetMockWorkspace } from './mocks/workspace'

// jsdom 跑不了 HyperFrames 播放器（iframe 里的合成运行时），换成只保留接口与事件的替身。
vi.mock('@hyperframes/player', () => import('./hyperframes-player'))

// matchMedia 恒为 false，模拟紧凑屏。
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

// jsdom 没有 ResizeObserver；图表容器靠它量尺寸，这里给一个不回调的空实现，图表按初始尺寸画。
if (typeof window.ResizeObserver === 'undefined') {
  class NoopResizeObserver {
    disconnect() {}
    observe() {}
    unobserve() {}
  }
  // 可改写：个别测试会用 vi.stubGlobal 换成自己的实现。
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    value: NoopResizeObserver,
    writable: true,
  })
}

// 提供空几何结果，满足 ProseMirror 选区 API；jsdom 不执行真实滚动。
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

// jsdom 没有指针捕获；按下可拖的元素（时间线上的块、组件卡片）时会调用。
if (!('setPointerCapture' in Element.prototype)) {
  for (const [name, value] of [
    ['setPointerCapture', () => undefined],
    ['releasePointerCapture', () => undefined],
    ['hasPointerCapture', () => false],
  ] as const)
    Object.defineProperty(Element.prototype, name, { configurable: true, value, writable: true })
}

// jsdom 不实现滚动；SearchList 与 TaskSpecPicker 移动活动项时调用。
if (!('scrollIntoView' in Element.prototype)) {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => {},
    writable: true,
  })
}

// jsdom 不排版，没有 elementFromPoint；按坐标找元素一律找不到。需要指针下有元素的用例自己 spy。
if (!('elementFromPoint' in Document.prototype)) {
  Object.defineProperty(Document.prototype, 'elementFromPoint', {
    configurable: true,
    value: () => null,
    writable: true,
  })
}

// jsdom 没有 Web Animations；变形动画直接算作播完，元素停在终态。
if (!('animate' in Element.prototype)) {
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: () => ({ cancel: () => {}, finished: Promise.resolve() }),
    writable: true,
  })
}

const unhandledRequests: string[] = []

// 未声明 handler 的请求一律拦下并让当前用例失败，避免访问真实网络。不用字符串 'error'：它放行
// 看着像静态资源的地址（.mp4、.png、.json 等）去真实网络；回调里的 print.error() 也只打印、
// 照样放行，所以要自己抛错（请求不出进程，MSW 回 500），再在 afterEach 里按记下的地址判失败，
// 免得页面吞掉 500 后用例照样通过。
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
  resetMockMcpServers()
  resetMockClock()
  resetMockConversations()
  resetMockEnhancements()
  resetMockFilm()
  // 先放回预置的树，演示行的标签按名字取 id。
  resetMockLibraryTags()
  resetMockHitCases()
  resetMockReferences()
  resetMockSession()
  resetMockSkills()
  resetMockTasks()
  resetMockTranscript()
  resetMockUsers()
  resetMockWholeFilm()
  resetMockWorkspace()
  cleanup()
  // 放在 cleanup 之后，卸载时发出的请求也算在本用例上。
  if (unhandledRequests.length > 0) {
    const requests = unhandledRequests.splice(0)
    throw new Error(`用例发出了未声明 handler 的请求：\n${requests.join('\n')}`)
  }
})

afterAll(() => {
  server.close()
})
