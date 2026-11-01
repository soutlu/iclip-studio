/** 右侧此刻打开的配置面板；没开时右侧是空白的占位（测试预览以后放这里）。 */
export type Panel =
  | { type: 'prompt' }
  | { type: 'model' }
  | { type: 'plugins' }
  /** `focus` 是从左侧哪张子 Agent 卡片点进来的，先展开它。 */
  | { type: 'subagents'; focus: string | undefined }
  | { type: 'definition' }
