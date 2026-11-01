/**
 * 测试预览的 mock：开预览交回新 id，那段 transcript 从空的开始，发消息跑一段三步的演示运行
 * （读参考素材、理解视频、回复），每步带起止时刻，运行过程里有耗时；删预览照合同只回 204。形状照合同 §19「测试预览」。
 */

import { http, HttpResponse } from 'msw'
import type { AgentPreviewOut } from '@/shared/api/generated/types.gen'
import { markMockScript, markMockShowcase, type MockScript } from './transcript'

const PREVIEW_TITLE = '测试预览'

const REPLY =
  '可以。保留参考片的轻快节奏，把重点放在网面细节与上脚后的轻盈感。\n\n' +
  '### 这条片子，我建议这样拍\n\n' +
  '1. **让透气看得见**：近景掠过网面纹理，自然光从鞋面透进来。\n' +
  '2. **让轻盈动起来**：跟随穿鞋与起步，低机位捕捉鞋底轻快离地。\n' +
  '3. **留下一个记忆点**：脚步停在阳光里，产品特写收尾。\n\n' +
  '补充产品图后，就可以继续细化每个镜头。'

/** 一步工具调用：开始一批（步骤开跑、工具在跑），结束一批（工具完成、步骤收尾带起止时刻）；中间可以多等几拍。 */
const toolStep = (
  turnId: string,
  ordinal: number,
  tool: { callId: string; summary: string; detail: string; output: string },
  waitBeats = 0,
) => {
  const stepId = `${turnId}.${ordinal}`
  let startedAt = ''
  const frame = (state: 'running' | 'done') => ({
    frame: {
      display: { detail: tool.detail, kind: 'generic', summary: tool.summary },
      frameId: `${stepId}.call`,
      kind: 'tool',
      name: tool.callId,
      state,
      toolCallId: `${turnId}-${tool.callId}`,
      ...(state === 'done' ? { output: tool.output } : {}),
    },
    op: 'frame.upsert',
    stepId,
    turnId,
  })
  const step = (state: 'running' | 'completed') => ({
    op: 'step.upsert',
    step: {
      kind: 'step',
      ordinal,
      startedAt,
      state,
      stepId,
      turnId,
      ...(state === 'completed' ? { endedAt: new Date().toISOString() } : {}),
    },
    turnId,
  })
  return [
    () => {
      startedAt = new Date().toISOString()
      return [step('running'), frame('running')]
    },
    ...Array.from({ length: waitBeats }, () => () => [frame('running')]),
    () => [frame('done'), step('completed')],
  ]
}

const previewRun: MockScript = ({ turnId }) => {
  const stepId = `${turnId}.3`
  let startedAt = ''
  const reply = (state: 'running' | 'completed') => ({
    op: 'step.upsert',
    step: {
      kind: 'step',
      ordinal: 3,
      startedAt,
      state,
      stepId,
      turnId,
      ...(state === 'completed' ? { endedAt: new Date().toISOString() } : {}),
    },
    turnId,
  })
  return [
    ...toolStep(turnId, 1, {
      callId: 'read_reference',
      detail: '跑道试穿.mp4',
      output: '已读取',
      summary: '读取参考素材',
    }),
    ...toolStep(
      turnId,
      2,
      {
        callId: 'understand_video',
        detail: '识别镜头顺序、运镜与视觉风格',
        output: '已理解',
        summary: '理解视频',
      },
      2,
    ),
    () => {
      startedAt = new Date().toISOString()
      return [
        reply('running'),
        {
          frame: { frameId: `${stepId}.f1`, kind: 'text', role: 'assistant', text: REPLY },
          op: 'frame.upsert',
          stepId,
          turnId,
        },
      ]
    },
    () => [reply('completed')],
  ]
}

export const agentPreviewHandlers = [
  http.post('*/api/agents/:agentId/previews', async ({ params, request }) => {
    const raw = await request.text()
    const body = (raw === '' ? {} : JSON.parse(raw)) as { versionId?: string | null }
    const preview: AgentPreviewOut = {
      agentId: String(params['agentId']),
      createdAt: new Date().toISOString(),
      id: crypto.randomUUID(),
      versionId: body.versionId ?? null,
    }
    markMockShowcase(preview.id, { title: PREVIEW_TITLE, turns: () => [] })
    markMockScript(preview.id, previewRun)
    return HttpResponse.json(preview, { status: 201 })
  }),
  http.delete(
    '*/api/agents/:agentId/previews/:previewId',
    () => new HttpResponse(null, { status: 204 }),
  ),
]
