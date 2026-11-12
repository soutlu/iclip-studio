import path from 'node:path'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { configDefaults, defineConfig } from 'vitest/config'

// 这些目录只验证纯逻辑和构建脚本，不需要 DOM、组件替身或 MSW 状态。
const nodeTests = [
  'scripts/**/*.test.mjs',
  'src/features/audit/overview-*.test.ts',
  'src/features/tasks/task-*.test.ts',
  'src/features/workspace/*.test.ts',
  'src/features/storyboard/{film,video-editor}/!(*.api).test.ts',
  'src/features/storyboard/whole-film/vendor/**/*.test.ts',
  'src/shared/transcript/vendor/**/*.test.ts',
]

// jsdom 画不了 Lottie，场记板动画在用例里只占位。占位模块在解析时换上，不用 vi.mock：
// 同一个模块被两处同时 import 时，vi.mock 的替身会漏掉一处，加载到真模块。
const LOTTIE = 'lottie-web/build/player/lottie_light'
const LOTTIE_PLACEHOLDER = `
const noop = () => {}
const animation = {
  addEventListener: noop,
  destroy: noop,
  goToAndStop: noop,
  play: noop,
  removeEventListener: noop,
}
export default { loadAnimation: () => animation }
`
const lottiePlaceholder: Plugin = {
  name: 'lottie-placeholder',
  enforce: 'pre',
  resolveId: (id) => (id === LOTTIE ? `\0${LOTTIE}` : undefined),
  load: (id) => (id === `\0${LOTTIE}` ? LOTTIE_PLACEHOLDER : undefined),
}

// 单测配置独立于 vite.config.ts：不需要路由生成、tailwind 与代理，只要 JSX 与 @ 别名。
export default defineConfig({
  plugins: [react(), lottiePlaceholder],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  test: {
    passWithNoTests: true,
    restoreMocks: true,
    projects: [
      {
        extends: true,
        test: { name: 'node', environment: 'node', include: nodeTests },
      },
      {
        extends: true,
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: [...configDefaults.exclude, ...nodeTests],
          setupFiles: ['src/testing/setup.ts'],
        },
      },
    ],
  },
})
