/** 右侧此刻打开的配置面板；没开时右侧是测试预览。 */
export type Panel =
  | { type: 'prompt' }
  | { type: 'model' }
  | { type: 'plugins' }
  /** `focus` 是从左侧哪张子 Agent 卡片点进来的，先展开它。 */
  | { type: 'subagents'; focus: string | undefined }
  | { type: 'definition' }
  | { type: 'skills'; view: SkillView }
  /** MCP 服务库（顶部导航）：搜索、添加服务，点一行进它的配置。 */
  | { type: 'mcp-library' }
  /** 给当前 agent 挂或摘 MCP 服务（左侧一节的管理入口）。 */
  | { type: 'mcp-select' }
  /**
   * 一个 MCP 服务的配置；`server` 为 null 是添加新服务。`back` 是返回时回到的面板，null 就收起右栏。
   * `checkError` 是刚建好时随后的试连请求出错的原因（服务上没记结果），打开时写在状态行。
   */
  | {
      type: 'mcp-server'
      server: string | null
      back: 'mcp-library' | 'mcp-select' | null
      checkError?: string | undefined
    }
  /** 模型与供应商（顶部导航，要 `model:manage`）：供应商、密钥、模型与默认模型，不改当前 agent 的草稿。 */
  | { type: 'providers' }

/** 技能面板里的哪一页：技能库、给当前 Agent 选技能、新建技能、编辑一个技能。`back` 是返回时回到哪一页，null 是收起面板。 */
export type SkillView =
  | { kind: 'library' }
  | { kind: 'catalog' }
  | { kind: 'new'; back: 'library' | 'catalog' }
  | { kind: 'editor'; skillId: string; back: 'library' | 'catalog' | null }
