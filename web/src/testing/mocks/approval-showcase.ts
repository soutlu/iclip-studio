import type { MockApprovalScenario } from './transcript'

// dev:mock 里等待审批的 MCP 调用：单项、参数带图片（参数是 JSON 字符串）、一批两项。
// 服务是 mcp-servers.ts 里使用自有账户的「用户洞察」，连接账号见 mcp-connections.ts。

const REPORT_ID = 'rpt_7f3c91a2'

const say = (text: string) => ({ kind: 'text', role: 'assistant', text })

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

export const approvalShowcases = (
  origin: string,
): { title: string; scenario: MockApprovalScenario }[] => {
  const frame = (name: string) => new URL(`/mock-frames/${name}.png`, origin).href
  return [
    {
      scenario: {
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
        lead: [say('访谈报告整理好了，确认后发布给内容团队。')],
        prompt: '把这份访谈报告发给内容团队',
        reply: { approved: '报告已发布给内容团队。', rejected: '好，报告先不发布。' },
      },
      title: '访谈报告发布',
    },
    {
      scenario: {
        calls: [
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
        ],
        lead: [say('两版首帧和投票设置整理好了，确认后创建投票。')],
        prompt: '用这两版首帧发起一个投票',
        reply: { approved: '投票已创建。', rejected: '好，投票先不创建。' },
      },
      title: '首帧投票',
    },
    {
      scenario: {
        calls: [
          {
            call: mcpCall(
              'add_samples',
              '追加样本',
              { reportId: REPORT_ID, sampleSize: 100 },
              REPORT_ID,
            ),
            interactionId: 'appr_samples',
            output: '已追加到 100 份',
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
        ],
        lead: [say('接下来要执行 2 项操作，确认后一并运行。')],
        prompt: '把样本追加到 100 份，再检索一下相关访谈',
        reply: { approved: '已按确认结果执行完毕。', rejected: '已取消这两项操作。' },
      },
      title: '样本追加与访谈检索',
    },
  ]
}
