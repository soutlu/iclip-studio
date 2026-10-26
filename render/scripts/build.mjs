// 打包渲染服务：src/ 连同 web 的成片合成构建与后端合同的 zod 生成物打成 dist/main.js；
// npm 依赖（producer、zod 等）不打包，运行时从 node_modules 取。
import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: [join(root, 'src/main.ts')],
  outfile: join(root, 'dist/main.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
})
