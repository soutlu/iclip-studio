export type Panel =
  | { type: 'prompt' }
  | { type: 'model' }
  | { type: 'plugins' }
  | { type: 'subagents'; focus: string | undefined }
  | { type: 'definition' }
  | { type: 'skills'; view: SkillView }
  | { type: 'mcp-library' }
  | { type: 'mcp-select' }
  | {
      type: 'mcp-server'
      server: string | null
      back: 'mcp-library' | 'mcp-select' | null
      checkError?: string | undefined
    }
  | { type: 'providers' }

export type SkillView =
  | { kind: 'library' }
  | { kind: 'catalog' }
  | { kind: 'new'; back: 'library' | 'catalog' }
  | { kind: 'editor'; skillId: string; back: 'library' | 'catalog' | null }
