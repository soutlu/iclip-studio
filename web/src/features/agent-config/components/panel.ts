/** 右侧此刻打开的配置面板；没开时右侧是空白的占位（测试预览以后放这里）。 */
export type Panel =
  | { type: 'prompt' }
  | { type: 'model' }
  | { type: 'plugins' }
  /** `focus` 是从左侧哪张子 Agent 卡片点进来的，先展开它。 */
  | { type: 'subagents'; focus: string | undefined }
  | { type: 'definition' }
  | { type: 'skills'; view: SkillView }

/** 技能面板里的哪一页：技能库、给当前 Agent 选技能、新建技能、编辑一个技能。`back` 是返回时回到哪一页，null 是收起面板。 */
export type SkillView =
  | { kind: 'library' }
  | { kind: 'catalog' }
  | { kind: 'new'; back: 'library' | 'catalog' }
  | { kind: 'editor'; skillId: string; back: 'library' | 'catalog' | null }
