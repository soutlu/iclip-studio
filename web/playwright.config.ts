import { defineConfig, devices } from '@playwright/test'
import { resolveMockPort } from './vite/mock-port'

// 后端响应由浏览器 MSW 提供：本地跑 dev:mock 便于复用已开的服务，CI 用 mock 构建的 preview，
// 避免 dev server 按需编译在并行用例下造成首屏超时。端口按 worktree 区分，复用的只会是本检出
// 自己的服务；服务端口与 baseURL 出自这里同一次计算。
const PORT = resolveMockPort()
const BASE_URL = `http://127.0.0.1:${PORT}`
const CI = Boolean(process.env['CI'])

export default defineConfig({
  forbidOnly: CI,
  fullyParallel: true,
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  reporter: CI ? 'github' : 'list',
  retries: CI ? 1 : 0,
  // CI 机器 4 核；用例之间靠各自的浏览器上下文与 MSW 隔离，可以并行。
  workers: CI ? 3 : undefined,
  testDir: 'e2e',
  // CI 机器负载不稳，断言等待放宽；失败用例保留 trace 供下载排查。
  expect: { timeout: CI ? 10_000 : 5_000 },
  use: { baseURL: BASE_URL, trace: 'retain-on-failure' },
  webServer: {
    command: CI ? 'pnpm build:mock && pnpm preview:mock' : 'pnpm dev:mock',
    env: { PORT: String(PORT) },
    reuseExistingServer: !CI,
    // 构建与启动输出进 CI 日志，起不来时不用下载 trace 就能定位。
    stdout: CI ? 'pipe' : 'ignore',
    timeout: CI ? 180_000 : 60_000,
    url: BASE_URL,
  },
})
