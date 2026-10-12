/**
 * 后台任务展示对话：拆解视频转入后台后的各种画面。
 * 「后台任务展示」回看完成通知（原卡写「已转入后台」）、失败通知与被停下后中断的原卡，末轮还有一个拆解在跑；
 * 「多个后台任务」末轮同时拆两条视频，输入框上方是汇总的一行。只回看，不自动起演示运行。
 */

import type { MockShowcase } from './transcript'

type Frame = Record<string, unknown>

/** 进行中的任务按取页时刻倒推开始时间，计时才像真的在走。 */
const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

const at = (day: string, time: string) => `2026-10-${day}T${time}Z`

const RECEIPT = (callId: string) =>
  `Tool 'breakdown_video' is running in background (task ${callId}). This call is pending. Do not repeat or poll it; its result will arrive automatically. Continue independent work, or end your response.`

/** 回执到达就是 done，之后不再变；中断的那张由 fields 改成 error。 */
const breakdown = (frameId: string, callId: string, file: string, fields: Frame = {}): Frame => ({
  display: { detail: file, kind: 'generic', summary: '拆解视频' },
  frameId,
  input: JSON.stringify({ video_url: `https://cdn.example.com/refs/${file}` }),
  kind: 'tool',
  name: 'breakdown_video',
  output: RECEIPT(callId),
  state: 'done',
  toolCallId: callId,
  ...fields,
})

const read = (frameId: string, path: string): Frame => ({
  display: { kind: 'file_io', operation: 'read', path },
  frameId,
  kind: 'tool',
  name: 'read_file',
  output: '已读取',
  state: 'done',
  toolCallId: `call_${frameId}`,
})

const say = (frameId: string, text: string): Frame => ({
  frameId,
  kind: 'text',
  role: 'assistant',
  text,
})

/** 结果到达处插进来的完成通知：role 是 user、带 taskId、没有 promptIds。 */
const notice = (frameId: string, taskId: string, text: string): Frame => ({
  content: [{ text, type: 'text' }],
  frameId,
  kind: 'text',
  role: 'user',
  taskId,
  text,
})

type Turn = Frame & { turnId: string }

const turn = (
  turnId: string,
  ordinal: number,
  prompt: string,
  steps: Frame[][],
  { endedAt, startedAt, state }: { startedAt: string; endedAt?: string; state: string },
): Turn => ({
  content: [{ text: prompt, type: 'text' }],
  kind: 'turn',
  ordinal,
  origin: { kind: 'user' },
  startedAt,
  state,
  steps: steps.map((frames, index) => ({
    frames,
    kind: 'step',
    ordinal: index + 1,
    // 跑着的那一轮只有末步还没结束。
    state: state === 'running' && index === steps.length - 1 ? 'running' : 'completed',
    stepId: `${turnId}.${index + 1}`,
    turnId,
  })),
  triggerPromptId: `p_${turnId}`,
  turnId,
  ...(endedAt === undefined ? {} : { endedAt }),
})

const toolTask = (taskId: string, description: string, fields: Frame): Frame => ({
  description,
  detached: true,
  kind: 'tool',
  outputTail: '',
  taskId,
  ...fields,
})

const SINGLE = {
  done: 'call_bg_ugg',
  failed: 'call_bg_boots',
  killed: 'call_bg_sneaker',
  running: 'call_bg_loafer',
} as const

export const backgroundShowcase: MockShowcase = {
  activity: 'turn',
  tasks: () => [
    toolTask(SINGLE.done, '拆解视频 ugg-ref.mp4', {
      endedAt: at('10', '08:03:32'),
      resultSummary: '视频拆解完毕，文档在 references/ugg-ref.md。',
      startedAt: at('10', '08:00:20'),
      state: 'completed',
    }),
    toolTask(SINGLE.failed, '拆解视频 boots-2.mp4', {
      endedAt: at('10', '09:04:00'),
      error: '视频无法解码',
      startedAt: at('10', '09:00:20'),
      state: 'failed',
    }),
    toolTask(SINGLE.killed, '拆解视频 sneaker.mp4', {
      endedAt: at('10', '10:01:00'),
      startedAt: at('10', '10:00:20'),
      state: 'killed',
    }),
    toolTask(SINGLE.running, '拆解视频 loafer.mp4', {
      startedAt: secondsAgo(80),
      state: 'running',
    }),
  ],
  title: '后台任务展示',
  turns: () => [
    turn(
      'bg1',
      1,
      '参考 ugg-ref.mp4，给这款拖鞋做一条 15 秒的种草视频',
      [
        [
          breakdown('bg1.1.f1', SINGLE.done, 'ugg-ref.mp4'),
          read('bg1.1.f2', 'product-1.jpg'),
          read('bg1.1.f3', 'model.jpg'),
          say(
            'bg1.1.f4',
            '看完素材了，Brief 已写好。4 张产品图是同一款低帮绒面保暖拖鞋的 4 个配色。参考视频正在拆解中，拿到逐镜时间线后再写新片执行方案。',
          ),
        ],
        [
          notice('bg1.2.f1', SINGLE.done, '已拆解视频 ugg-ref.mp4'),
          read('bg1.2.f2', 'references/ugg-ref.md'),
          say(
            'bg1.2.f3',
            '拆解回来了。参考片是 13.2 秒、10 个镜头、4 个段落：滑板场扛板造型、上下分屏走路、三分屏多色、踩板收尾弹品牌字。',
          ),
        ],
      ],
      { endedAt: at('10', '08:04:10'), startedAt: at('10', '08:00:00'), state: 'completed' },
    ),
    turn(
      'bg2',
      2,
      '再拆一条 boots-2.mp4 当参考',
      [
        [
          breakdown('bg2.1.f1', SINGLE.failed, 'boots-2.mp4'),
          say('bg2.1.f2', '参考视频正在拆解中，先把产品卖点整理出来。'),
        ],
        [
          notice('bg2.2.f1', SINGLE.failed, '拆解视频 boots-2.mp4 失败'),
          say('bg2.2.f2', '这条视频无法打开，请换一条参考视频再试。'),
        ],
      ],
      { endedAt: at('10', '09:04:20'), startedAt: at('10', '09:00:00'), state: 'completed' },
    ),
    turn(
      'bg3',
      3,
      '拆一下 sneaker.mp4',
      [
        [
          breakdown('bg3.1.f1', SINGLE.killed, 'sneaker.mp4', {
            error: '运行中断，这次调用没有结果',
            output: undefined,
            state: 'error',
          }),
          say('bg3.1.f2', '参考视频正在拆解中，拿到结果后再继续。'),
        ],
      ],
      { endedAt: at('10', '10:01:00'), startedAt: at('10', '10:00:00'), state: 'cancelled' },
    ),
    turn(
      'bg4',
      4,
      '参考 loafer.mp4 再出一版',
      [
        [
          breakdown('bg4.1.f1', SINGLE.running, 'loafer.mp4'),
          read('bg4.1.f2', 'brief.md'),
          say('bg4.1.f3', '参考视频正在拆解中，先按 Brief 调整卖点顺序。'),
        ],
      ],
      { startedAt: secondsAgo(90), state: 'running' },
    ),
  ],
}

const MULTIPLE = ['call_bg_multi_ugg', 'call_bg_multi_boots'] as const

export const multipleBackgroundShowcase: MockShowcase = {
  activity: 'turn',
  tasks: () => [
    toolTask(MULTIPLE[0], '拆解视频 ugg-ref.mp4', { startedAt: secondsAgo(80), state: 'running' }),
    toolTask(MULTIPLE[1], '拆解视频 boots-2.mp4', { startedAt: secondsAgo(42), state: 'running' }),
  ],
  title: '多个后台任务',
  turns: () => [
    turn(
      'bgm1',
      1,
      '两条参考视频都拆一下，再整理产品卖点',
      [
        [
          breakdown('bgm1.1.f1', MULTIPLE[0], 'ugg-ref.mp4'),
          breakdown('bgm1.1.f2', MULTIPLE[1], 'boots-2.mp4'),
          say('bgm1.1.f3', '两条参考视频都在拆解，先把产品卖点整理出来。'),
        ],
      ],
      { startedAt: secondsAgo(90), state: 'running' },
    ),
  ],
}
