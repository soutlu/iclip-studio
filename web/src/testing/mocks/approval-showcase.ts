import type { MockApprovalCall, MockApprovalScenario } from './transcript'

// dev:mock 里等待审批的 MCP 调用，挂在已有的演示对话上：单项一轮，另有几项并进写入文件那一批。
// 服务是 mcp-servers.ts 里使用自有账户的「用户洞察」，连接账号见 mcp-connections.ts。

const REPORT_ID = 'rpt_7f3c91a2'

const mcpCall = (
  tool: string,
  title: string,
  input: Record<string, unknown> | string,
  detail: string,
) => ({
  display: { detail, kind: 'generic', summary: `用户洞察 · ${title}` },
  input,
  name: `mcp_user-insights_${tool}`,
  toolCallId: `call_${tool}`,
})

export const publishApproval: MockApprovalScenario = {
  calls: [
    {
      call: mcpCall(
        'publish_report',
        '发布报告',
        { audience: '内容团队', notify: true, reportId: REPORT_ID },
        REPORT_ID,
      ),
      interactionId: 'appr_publish',
      output: '报告已发布',
    },
  ],
  lead: [{ kind: 'text', role: 'assistant', text: '访谈报告整理好了，确认后发布给内容团队。' }],
  prompt: '把这份访谈报告发给内容团队',
  reply: { approved: '报告已发布给内容团队。', rejected: '好，报告先不发布。' },
}

export const mcpApprovalCalls = (origin: string): MockApprovalCall[] => {
  const frame = (name: string) => new URL(`/mock-frames/${name}.png`, origin).href
  return [
    {
      call: mcpCall(
        'create_poll',
        '新建投票',
        JSON.stringify({
          title: '首帧 A/B 对比',
          sampleSize: 50,
          randomize: true,
          options: [
            { label: '方案 A · 袖口特写', imageUrl: frame('a') },
            { label: '方案 B · 户外全景', imageUrl: frame('b') },
          ],
        }),
        '首帧 A/B 对比',
      ),
      interactionId: 'appr_poll',
      output: '投票已创建',
    },
    {
      call: mcpCall(
        'search_interviews',
        '检索访谈',
        {
          query: '亚麻衬衫 通勤',
          limit: 5,
          filters: { region: '华东', tags: ['透气', '易打理'] },
        },
        '亚麻衬衫 通勤',
      ),
      interactionId: 'appr_interviews',
      output: '找到 5 条访谈',
    },
  ]
}
