import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { defineConfig } from 'vitest/config'

const require = createRequire(import.meta.url)

export default defineConfig({
  resolve: {
    // 后端合同的 zod 生成物在 web/ 下，它引用的 zod 用本包装的那份（web 的依赖不一定装了）。
    alias: { zod: dirname(require.resolve('zod/package.json')) },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
})
