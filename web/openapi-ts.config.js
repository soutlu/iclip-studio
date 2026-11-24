import { defineConfig } from '@hey-api/openapi-ts'

// 从后端合同生成类型与 zod schema，pnpm contract:check 校验生成物。
export default defineConfig({
  input: '../contract/openapi.json',
  output: {
    path: process.env.ICLIP_CONTRACT_OUTPUT ?? 'src/shared/api/generated',
    postProcess: ['prettier'],
  },
  plugins: ['@hey-api/typescript', 'zod'],
  // 合同里 readOnly 只标记服务端派生的只读字段（audit 的比率），本系统没有请求体与响应体
  // 同名不同形的模型，不按读写拆成两套类型。
  parser: {
    // 没开原生工具时线上配置里没有 native_tools 这一项；合同里的空数组默认值会让 zod 读回时补出这个键，
    // 保存时又原样发出去，所以生成时去掉它。
    patch: {
      schemas: {
        AgentModelSettings: (schema) => {
          delete schema.properties.native_tools.default
        },
      },
    },
    transforms: { readWrite: false },
  },
})
