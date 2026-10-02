/**
 * 工具过程展示对话：几轮历史把工具行的各种状态都摆出来——失败后又成功的编辑、读文件、写文件被拒绝、
 * 检索、运行中断与整轮失败。只读历史，不自动起演示运行；文件名对得上 seedMockWorkspace 里的文件。
 */

const numbered = (lines: readonly string[]) =>
  lines.map((line, index) => `${String(index + 1).padStart(6)}\t${line}`).join('\n')

const STORYBOARD_LINES = [
  '## 角色设定',
  '',
  '- [人物「模特」：二十五岁上下，浅金色直发到肩，深蓝色圆领卫衣配高腰阔腿牛仔裤]',
  '- [场景「门厅」：暖木色墙面，长椅靠窗，午后侧光]',
  '',
  '## 剪辑形式',
  '',
  '以硬切为主，第 2 镜叠化转场，其余镜头保持正常播放速度。',
]

const SHOT_BEFORE = [
  '{',
  '  "index": 2,',
  '  "seconds": 11,',
  '  "camera": "近景",',
  '  "prompt": "衬衫袖口"',
  '}',
].join('\n')

const SHOT_AFTER = [
  '{',
  '  "index": 2,',
  '  "seconds": 4,',
  '  "camera": "中景",',
  '  "prompt": "阳光穿过亚麻衬衫的袖口，织物的纹理清楚可见"',
  '}',
].join('\n')

export const TOOL_SHOWCASE_DENIED_INTERACTION = 'appr_showcase'
const DENIED_CALL = 'call_showcase_notes'

type Frame = Record<string, unknown>

const tool = (
  turnId: string,
  id: string,
  operation: 'read' | 'write' | 'edit',
  path: string,
  fields: Frame = {},
): Frame => ({
  display: { kind: 'file_io', operation, path },
  frameId: `${turnId}.1.${id}`,
  kind: 'tool',
  name: `${operation}_file`,
  state: 'done',
  toolCallId: `call_${turnId}_${id}`,
  ...fields,
})

const turn = (
  ordinal: number,
  prompt: string,
  frames: Frame[],
  fields: { error?: string; state?: 'failed' } = {},
): Frame & { turnId: string } => ({
  content: [{ text: prompt, type: 'text' }],
  durationMs: 12_000,
  endedAt: `2026-08-31T0${ordinal}:00:12Z`,
  kind: 'turn',
  ordinal,
  origin: { kind: 'user' },
  startedAt: `2026-08-31T0${ordinal}:00:00Z`,
  state: 'completed',
  steps: [
    {
      endedAt: `2026-08-31T0${ordinal}:00:12Z`,
      frames,
      kind: 'step',
      ordinal: 1,
      startedAt: `2026-08-31T0${ordinal}:00:00Z`,
      state: 'completed',
      stepId: `t${ordinal}.1`,
      turnId: `t${ordinal}`,
    },
  ],
  triggerPromptId: `p_showcase_${ordinal}`,
  ...fields,
  turnId: `t${ordinal}`,
})

export const toolShowcaseTurns = (): (Frame & { turnId: string })[] => [
  turn(1, '把拍摄需求里的 6 个镜头整理成分镜，总时长控制在 30 秒。', [
    {
      frameId: 't1.1.f1',
      kind: 'thinking',
      text: '先看拍摄需求里的硬性要求，再按 30 秒给 6 个镜头分配时长，最后写进分镜表。',
    },
    tool('t1', 'f2', 'read', 'storyboard.md', {
      metadata: { lines: STORYBOARD_LINES.length, path: 'storyboard.md', truncated: true },
      output: `${numbered(STORYBOARD_LINES)}\n[还有 9 行没读，用 offset=9 接着读]`,
      view: 'file_content',
    }),
    tool('t1', 'f3', 'edit', 'video_shot.json', {
      display: {
        after: SHOT_AFTER.replace('4,', '"4s",'),
        before: SHOT_BEFORE,
        kind: 'file_io',
        operation: 'edit',
        path: 'video_shot.json',
      },
      error: '参数校验失败：shots[2].duration 需要数字，收到 "4s"',
      state: 'error',
    }),
    tool('t1', 'f4', 'edit', 'video_shot.json', {
      display: {
        after: SHOT_AFTER,
        before: SHOT_BEFORE,
        kind: 'file_io',
        operation: 'edit',
        path: 'video_shot.json',
      },
      metadata: { added: 3, removed: 3 },
      output: '已改 video_shot.json',
    }),
    {
      frameId: 't1.1.f5',
      kind: 'text',
      role: 'assistant',
      text: '分镜整理好了，6 个镜头合计 30 秒。\n\n- 镜头 2、3 压到 3–4 秒，给第 4 个户外镜头留出 6 秒；\n- 收尾 8 秒，品牌字样在最后 2 秒入画。',
    },
  ]),
  turn(2, '把剪辑说明也写一份，再看看哪些镜头写了运镜。', [
    tool('t2', 'f1', 'read', 'video_shot.json', {
      metadata: { lines: 6, path: 'video_shot.json', truncated: false },
      output: numbered(SHOT_AFTER.split('\n')),
      view: 'file_content',
    }),
    tool('t2', 'f2', 'write', 'notes/剪辑说明.md', {
      approvalId: TOOL_SHOWCASE_DENIED_INTERACTION,
      display: {
        content: '# 剪辑说明\n\n按分镜顺序粗剪，总长 30 秒。',
        kind: 'file_io',
        operation: 'write',
        path: 'notes/剪辑说明.md',
      },
      error: '用户拒绝了这次调用',
      state: 'error',
      toolCallId: DENIED_CALL,
    }),
    {
      display: { kind: 'search', query: '运镜' },
      frameId: 't2.1.f3',
      kind: 'tool',
      metadata: {
        matches: [
          { file: 'storyboard.md', line: 8, text: '以硬切为主，第 2 镜叠化转场' },
          {
            file: 'video/night-city-timelapse-9a3f2c1d.md',
            line: 2,
            text: '全程以固定机位与慢速摇移呈现车流与灯光',
          },
        ],
        query: '运镜',
        truncated: false,
      },
      name: 'search_files',
      output: 'storyboard.md:8\t以硬切为主\nvideo/night-city-timelapse-9a3f2c1d.md:2\t固定机位',
      state: 'done',
      toolCallId: 'call_t2_search',
      view: 'search_results',
    },
    {
      frameId: 't2.1.f4',
      kind: 'text',
      role: 'assistant',
      text: '剪辑说明这次没写。写了运镜的是拉片表和夜景素材说明。',
    },
  ]),
  turn(
    3,
    '第 3 个镜头改成 4 秒，顺便把画面重新生成一下。',
    [
      tool('t3', 'f1', 'read', 'video_shot.json', {
        metadata: { lines: 6, path: 'video_shot.json', truncated: false },
        output: numbered(SHOT_AFTER.split('\n')),
        view: 'file_content',
      }),
      tool('t3', 'f2', 'edit', 'video_shot.json', {
        display: {
          after: SHOT_AFTER,
          before: SHOT_BEFORE,
          kind: 'file_io',
          operation: 'edit',
          path: 'video_shot.json',
        },
        error: '运行中断，这次调用没有结果',
        state: 'error',
      }),
    ],
    {
      error: 'RunAborted: tool_error_unrecoverable\nrun_8f3a1c27 · step 7 · 2026-10-01 14:22:10',
      state: 'failed',
    },
  ),
]

export const toolShowcaseInteractions = [
  {
    interactionId: TOOL_SHOWCASE_DENIED_INTERACTION,
    interactionKind: 'approval',
    state: 'rejected',
    toolCallId: DENIED_CALL,
  },
]
