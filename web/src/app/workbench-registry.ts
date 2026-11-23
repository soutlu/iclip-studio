import { SubAgentPanel, agentCallOf } from '@/features/conversations'
import {
  createFinalCut,
  FILM_PATH,
  FilmPanel,
  FINAL_CUT_DIR,
  FINAL_CUT_PATH,
  FinalCutPanel,
  SHOTS_PATH,
  StoryboardPanel,
} from '@/features/storyboard'
import { WorkspaceFilesPanel } from '@/features/workspace'
import { ArtifactRegistry } from '@/shared/workbench'

export const workbenchRegistry = new ArtifactRegistry()

workbenchRegistry.register({
  autoOpen: true,
  component: StoryboardPanel,
  empty: '暂无',
  frameless: true,
  icon: 'artifact-storyboard',
  label: '分镜',
  match: { path: SHOTS_PATH },
  title: () => '分镜',
  type: 'storyboard',
})

workbenchRegistry.register({
  autoOpen: true,
  component: FilmPanel,
  frameless: true,
  icon: 'artifact-film',
  label: '制作',
  match: { path: FILM_PATH },
  title: () => '制作',
  type: 'film',
})

// 仅当工作区存在主文件时显示页签（由 Agent 写入或用户通过「+」新建）；ID 为 final-cut，URL 参数为 ?artifact=final-cut。
// final-cut/ 下的其余文件亦归属此产物，在文件页预览时提供「打开 final-cut」入口。
workbenchRegistry.register({
  autoOpen: false,
  component: FinalCutPanel,
  create: { agentCreatedNotice: 'Agent 已创建 final-cut 工程', run: createFinalCut },
  frameless: true,
  hiddenWhenReadOnly: true,
  icon: 'final-cut-shots',
  label: 'final-cut',
  match: { anyPath: [FINAL_CUT_PATH], dir: FINAL_CUT_DIR },
  title: () => 'final-cut',
  type: 'final-cut',
})

workbenchRegistry.register({
  autoOpen: false,
  component: WorkspaceFilesPanel,
  detail: (source) => (source.kind === 'workspace' ? `${source.fileCount} 个文件` : undefined),
  empty: '暂无',
  frameless: true,
  icon: 'file-folder',
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
