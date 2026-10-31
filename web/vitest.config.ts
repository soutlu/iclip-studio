import path from 'node:path'
import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

// 这些目录只验证纯逻辑和构建脚本，不需要 DOM、组件替身或 MSW 状态。
const nodeTests = [
  'scripts/**/*.test.mjs',
  'src/features/audit/overview-*.test.ts',
  'src/features/tasks/task-*.test.ts',
  'src/features/workspace/*.test.ts',
  'src/features/storyboard/whole-film/{editing,vendor}/**/*.test.ts',
  'src/shared/transcript/vendor/**/*.test.ts',
]

// 单测配置独立于 vite.config.ts：不需要路由生成、tailwind 与代理，只要 JSX 与 @ 别名。
export default defineConfig({
  plugins: [react()],
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
