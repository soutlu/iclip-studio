import { SubAgentPanel, agentCallOf } from '@/features/conversations'
import { FILM_PATH, FilmPanel, SHOTS_PATH, StoryboardPanel } from '@/features/storyboard'
import { WorkspaceFilesPanel } from '@/features/workspace'
import { ArtifactRegistry } from '@/shared/workbench'

export const workbenchRegistry = new ArtifactRegistry()

workbenchRegistry.register({
  autoOpen: true,
  component: StoryboardPanel,
  empty: '暂无分镜，agent 交付后显示',
  icon: 'grid',
  label: '分镜',
  match: { path: SHOTS_PATH },
  title: () => '分镜',
  type: 'storyboard',
})

workbenchRegistry.register({
  autoOpen: true,
  component: FilmPanel,
  icon: 'video',
  label: '制作',
  match: { path: FILM_PATH },
  title: () => '制作',
  type: 'film',
})

workbenchRegistry.register({
  autoOpen: false,
  component: WorkspaceFilesPanel,
  detail: (source) => (source.kind === 'workspace' ? `${source.fileCount} 个文件` : undefined),
  empty: '暂无文件',
  icon: 'folder',
  label: '文件',
  match: { workspace: true },
  title: () => '文件',
  type: 'workspace',
})

const DETAIL_MAX = 14

const clip = (text: string): string =>
  text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text

workbenchRegistry.register({
  autoOpen: false,
  component: SubAgentPanel,
  detail: (source) => {
    const prompt = source.kind === 'frame' ? agentCallOf(source.display)?.prompt : undefined
    return prompt === undefined ? undefined : clip(prompt)
  },
  icon: 'agent',
  label: '委派任务',
  match: { displayKind: 'agent_call' },
  title: (source) =>
    `委派任务 · ${(source.kind === 'frame' ? agentCallOf(source.display)?.agentName : undefined) ?? '子代理'}`,
  type: 'sub-agent',
})
