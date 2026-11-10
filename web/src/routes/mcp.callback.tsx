import { createFileRoute, redirect, useLocation } from '@tanstack/react-router'
import { useState } from 'react'
import { ensureSessionUser } from '@/shared/auth'
import { McpCallbackPage, type McpCallbackParams } from '@/shared/mcp-connections'

export const Route = createFileRoute('/mcp/callback')({
  beforeLoad: async () => {
    if (!(await ensureSessionUser())) {
      throw redirect({ to: '/' })
    }
  },
  component: McpCallbackRoute,
})

function McpCallbackRoute() {
  // 路由默认按 JSON 解析查询参数，纯数字的授权码会变成数字；这里读原始查询串，原样交给后端。
  const searchStr = useLocation({ select: (location) => location.searchStr })
  const [params] = useState((): McpCallbackParams => {
    const query = new URLSearchParams(searchStr)
    return {
      code: query.get('code'),
      error: query.get('error'),
      iss: query.get('iss'),
      state: query.get('state'),
    }
  })
  return <McpCallbackPage params={params} />
}
