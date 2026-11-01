/**
 * Agent 配置的 mock：几个 agent（含一个长名字、一个没发布过、一个已归档）、带发布人的版本、本部署的插件、
 * 可选的模型（技能在 ./skills），形状照合同 §18–§19。草稿、发布与恢复改内存里的数据，lockVersion 与发布检查照合同做，
 * 发布检查只做页面用得到的那几条（模型、插件依赖、技能、子 agent）。每例由 `resetMockAgentConfig` 放回预置数据。
 */

import { http, HttpResponse } from 'msw'
import type {
  AgentConfig,
  AgentCreateIn,
  AgentDetailOut,
  AgentDraftIn,
  AgentOut,
  AgentPluginOut,
  AgentProblemOut,
  AgentPublishIn,
  AgentRestoreIn,
  AgentUpdateIn,
  AgentVersionDetailOut,
  ModelOptionsOut,
} from '@/shared/api/generated/types.gen'
import { findMockSkill, mockSkillId } from './skills'

type Actor = { id: string; name: string }

const uuid = (group: number, n: number) =>
  `00000000-0000-4000-8000-${String(group).padStart(4, '0')}${String(n).padStart(8, '0')}`

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const PEOPLE = {
  chen: { id: uuid(1, 1), name: '陈思远' },
  zhou: { id: uuid(1, 2), name: '周晓' },
} as const

export const mockAgentPlugins: AgentPluginOut[] = [
  {
    description: '读取素材、保存方案与创作文件',
    label: '工作区文件',
    name: 'workspace',
    parameters: {},
    requires: [],
  },
  {
    description: '理解参考片的内容与视觉语言',
    label: '视频理解',
    name: 'video',
    parameters: {},
    requires: ['workspace'],
  },
  {
    description: '拆解镜头、节奏和关键画面',
    label: '视频拆解',
    name: 'video_breakdown',
    parameters: {},
    requires: ['workspace'],
  },
  {
    description: '提取参考帧，生成镜头画面',
    label: '取帧与出图',
    name: 'shot_video',
    parameters: {},
    requires: ['workspace'],
  },
  {
    description: '创建、编辑与检查成片工程',
    label: '导演工程',
    name: 'iclip_studio',
    parameters: {},
    requires: ['workspace'],
  },
  {
    description: '整理镜头提示词与分镜结构',
    label: '镜头组表',
    name: 'video_shots',
    parameters: {},
    requires: ['workspace'],
  },
]

export const mockModelOptions: ModelOptionsOut = {
  providers: [
    {
      credentials: [
        { fields: { api_key: '••••DEMO' }, id: uuid(2, 1), isDefault: true, name: '主账号' },
        { fields: { api_key: '••••7F2A' }, id: uuid(2, 2), isDefault: false, name: '创作团队' },
      ],
      id: uuid(3, 1),
      label: '阿里云百炼',
      models: [
        {
          contextSize: 1_048_576,
          name: 'qwen3.8-flash',
          thinking: ['none', 'low', 'medium', 'high'],
        },
        { contextSize: 262_144, name: 'qwen3.8-plus', thinking: ['none', 'low', 'medium', 'high'] },
        { contextSize: 262_144, name: 'qwen3.8-max', thinking: ['low', 'medium', 'high'] },
      ],
      name: 'bailian',
    },
    {
      credentials: [
        {
          fields: { api_key: '••••K9QM', base_url: 'https://models.example/v1' },
          id: uuid(2, 3),
          isDefault: true,
          name: '团队服务',
        },
      ],
      id: uuid(3, 2),
      label: '团队模型服务',
      models: [
        { contextSize: 131_072, name: 'studio-chat', thinking: [] },
        { contextSize: 1_048_576, name: 'studio-chat-long', thinking: ['minimal', 'xhigh'] },
      ],
      name: 'team-models',
    },
  ],
}

// 技能由技能库的 mock 管（./skills），这里只按 id 查它发没发布过。
export { mockSkillId }

const DIRECTOR_PROMPT = [
  '## 角色',
  '',
  '你是视频导演。把参考素材与创作意图，转化为清晰、可执行的新片方案。具体流程与写法由导演技能定义。',
  '',
  '## 工作方式',
  '',
  '- 先理解需求与素材，整理创作 Brief。',
  '- 拆解参考片的节奏、镜头和视觉语言。',
  '- 调用导演技能，完成执行方案与工程文件。',
  '',
  '## 表达准则',
  '',
  '区分事实与推测，**不虚构素材或执行结果**。缺少关键信息时先澄清，并简洁说明当前进展。',
].join('\n')

const cap = (toolset: string) => ({ enabled: true, parameters: {}, toolset, type: 'cap' as const })

const directorConfig = (thinking: 'low' | 'medium', tools: string[]): AgentConfig => ({
  instructions: DIRECTOR_PROMPT,
  model: { name: 'qwen3.8-flash', provider: 'bailian', settings: { thinking } },
  schema_version: 1,
  subagents: [{ agent: 'breakdown-helper', max_calls: 3, timeout_seconds: 300 }],
  // 挂着一个 MCP 服务：这一版页面不管它，保存草稿也要原样带上。
  tools: [...tools.map(cap), { server: 'feishu-docs', tools: ['search', 'read'], type: 'mcp' }],
})

type MockAgent = Omit<
  AgentDetailOut,
  'activeVersion' | 'hasSubagents' | 'hasUnpublishedChanges' | 'isSubagent' | 'usedBy'
> & {
  /** 版本号从大到小。 */
  versions: AgentVersionDetailOut[]
  activeVersionId: string | null
}

const version = (
  n: number,
  id: string,
  by: Actor,
  minutesAgo: number,
  config: AgentConfig,
  skillIds: string[],
): AgentVersionDetailOut => ({
  config,
  createdAt: ago(minutesAgo),
  createdBy: by.id,
  createdByName: by.name,
  id,
  note: null,
  skillIds,
  version: n,
})

const agent = (
  sortOrder: number,
  fields: Pick<AgentDetailOut, 'description' | 'id' | 'listed' | 'name' | 'status'>,
  draft: { config: AgentConfig; skillIds: string[]; baseVersionId: string | null },
  versions: AgentVersionDetailOut[],
): MockAgent => ({
  ...fields,
  activeVersionId: versions[0]?.id ?? null,
  createdAt: ago(60 * 24 * 60 - sortOrder),
  createdBy: PEOPLE.chen.id,
  createdByName: PEOPLE.chen.name,
  draft: {
    ...draft,
    lockVersion: 3,
    updatedAt: ago(30),
    updatedBy: PEOPLE.zhou.id,
    updatedByName: PEOPLE.zhou.name,
  },
  sortOrder,
  updatedAt: ago(30),
  versions,
})

const seedAgents = (): MockAgent[] => {
  const directorSkills = [1, 2, 3].map((n) => uuid(4, n))
  const v6 = directorConfig('low', [
    'workspace',
    'video',
    'video_breakdown',
    'shot_video',
    'iclip_studio',
  ])
  const helperConfig = (instructions: string, tools: string[]): AgentConfig => ({
    instructions,
    model: { name: 'qwen3.8-plus', provider: 'bailian', settings: { thinking: 'low' } },
    schema_version: 1,
    subagents: [],
    tools: tools.map(cap),
  })
  const storyboard = helperConfig('## 角色\n\n你负责把创作 Brief 整理成镜头脚本。', [
    'workspace',
    'video_shots',
  ])
  const breakdown = helperConfig('## 角色\n\n你负责分析参考片的镜头、节奏与视觉语言。', [
    'workspace',
    'video',
    'video_breakdown',
  ])
  return [
    agent(
      1,
      {
        description: '将参考素材与创作需求转化为新片方案。',
        id: 'director',
        listed: true,
        name: 'AI 导演',
        status: 'active',
      },
      // 草稿比当前版本多想一档：有未发布的修改。
      {
        baseVersionId: uuid(6, 6),
        config: directorConfig('medium', [
          'workspace',
          'video',
          'video_breakdown',
          'shot_video',
          'iclip_studio',
        ]),
        skillIds: directorSkills,
      },
      [
        version(6, uuid(6, 6), PEOPLE.chen, 120, v6, directorSkills),
        version(
          5,
          uuid(6, 5),
          PEOPLE.zhou,
          60 * 24 * 3,
          { ...directorConfig('low', ['workspace', 'video', 'iclip_studio']), subagents: [] },
          directorSkills.slice(0, 2),
        ),
        version(
          4,
          uuid(6, 4),
          PEOPLE.chen,
          60 * 24 * 14,
          { ...directorConfig('low', ['workspace', 'video']), subagents: [] },
          directorSkills.slice(0, 1),
        ),
      ],
    ),
    agent(
      2,
      {
        description: '把创作 Brief 整理成镜头脚本。',
        id: 'storyboard-helper',
        listed: false,
        name: '分镜助手',
        status: 'active',
      },
      { baseVersionId: uuid(7, 2), config: storyboard, skillIds: [uuid(4, 2)] },
      [version(2, uuid(7, 2), PEOPLE.zhou, 60 * 24 * 5, storyboard, [uuid(4, 2)])],
    ),
    agent(
      3,
      {
        description: '分析参考片的镜头、节奏与视觉语言。',
        id: 'breakdown-helper',
        listed: false,
        name: '拆解助手',
        status: 'active',
      },
      { baseVersionId: uuid(8, 3), config: breakdown, skillIds: [] },
      [version(3, uuid(8, 3), PEOPLE.chen, 60 * 24 * 2, breakdown, [])],
    ),
    agent(
      4,
      {
        description: '把一条中文方案批量改写成英语、西语与法语的短视频版本。',
        id: 'cross-border-multilingual',
        listed: false,
        name: '跨境电商多语种短视频批量生成助手',
        status: 'active',
      },
      {
        baseVersionId: null,
        config: { instructions: '', model: null, schema_version: 1, subagents: [], tools: [] },
        skillIds: [],
      },
      [],
    ),
    agent(
      5,
      {
        description: '早期的文案助手，已由 AI 导演接替。',
        id: 'legacy-copywriter',
        listed: false,
        name: '旧版文案助手',
        status: 'archived',
      },
      { baseVersionId: uuid(9, 1), config: storyboard, skillIds: [] },
      [version(1, uuid(9, 1), PEOPLE.zhou, 60 * 24 * 90, storyboard, [])],
    ),
  ]
}

let agents = seedAgents()

export const resetMockAgentConfig = () => {
  agents = seedAgents()
}

const findAgent = (id: string) => agents.find((item) => item.id === id)

const activeOf = (item: MockAgent) => item.versions.find((v) => v.id === item.activeVersionId)

/** 键序无关的比较：配置是 JSON 文档，前端回传时键的先后可能不同。 */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === 'object' && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, inner]) => inner !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([key, inner]) => [key, canonical(inner)]),
        )
      : value

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

const subagentIdsOf = (config: AgentConfig | undefined) =>
  (config?.subagents ?? []).map((binding) => binding.agent)

const referencesOf = (item: MockAgent) => [
  ...subagentIdsOf(item.draft.config),
  ...subagentIdsOf(activeOf(item)?.config),
]

const toOut = (item: MockAgent): AgentOut => {
  const active = activeOf(item)
  return {
    activeVersion:
      active === undefined
        ? null
        : { id: active.id, publishedAt: active.createdAt, version: active.version },
    createdAt: item.createdAt,
    createdBy: item.createdBy,
    createdByName: item.createdByName,
    description: item.description,
    hasSubagents: referencesOf(item).length > 0,
    hasUnpublishedChanges:
      active === undefined ||
      !sameJson(active.config, item.draft.config) ||
      !sameJson(active.skillIds, item.draft.skillIds),
    id: item.id,
    isSubagent: agents.some(
      (other) => other.id !== item.id && referencesOf(other).includes(item.id),
    ),
    listed: item.listed,
    name: item.name,
    sortOrder: item.sortOrder,
    status: item.status,
    updatedAt: item.updatedAt,
  }
}

const toDetail = (item: MockAgent): AgentDetailOut => ({
  ...toOut(item),
  draft: item.draft,
  usedBy: agents
    .filter((other) => other.id !== item.id)
    .flatMap((other) => {
      const inDraft = subagentIdsOf(other.draft.config).includes(item.id)
      const inActiveVersion = subagentIdsOf(activeOf(other)?.config).includes(item.id)
      return inDraft || inActiveVersion
        ? [{ agentId: other.id, agentName: other.name, inActiveVersion, inDraft }]
        : []
    }),
})

const notFound = () => HttpResponse.json({ detail: '没有这个 agent' }, { status: 404 })
const stale = () =>
  HttpResponse.json({ detail: '草稿已被别人修改，请重新读取后再操作' }, { status: 409 })

const ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/
const RESERVED_IDS = new Set(['plugins', 'order', 'import', 'model-options'])

/** 页面用得到的几条发布检查，`path` 写法照合同 §19「发布」。 */
const publishProblems = (item: MockAgent): AgentProblemOut[] => {
  const { config, skillIds } = item.draft
  const problems: AgentProblemOut[] = []
  const model = config.model
  if (model === null || model === undefined) {
    problems.push({ message: '请选择模型', path: 'model' })
  } else {
    const provider = mockModelOptions.providers.find((p) => p.name === model.provider)
    const option = provider?.models.find((m) => m.name === model.name)
    if (provider === undefined)
      problems.push({ message: '供应商不存在或已停用', path: 'model.provider' })
    else if (option === undefined)
      problems.push({ message: '模型不存在或已停用', path: 'model.name' })
    else if (
      model.settings?.thinking !== null &&
      model.settings?.thinking !== undefined &&
      !option.thinking.includes(model.settings.thinking)
    )
      problems.push({ message: '这个模型不支持所选的思考档位', path: 'model.settings.thinking' })
  }
  const enabled = new Set(
    (config.tools ?? []).flatMap((tool) =>
      tool.type === 'cap' && tool.enabled !== false ? [tool.toolset] : [],
    ),
  )
  ;(config.tools ?? []).forEach((tool, index) => {
    if (tool.type !== 'cap' || tool.enabled === false) return
    const plugin = mockAgentPlugins.find((p) => p.name === tool.toolset)
    if (plugin === undefined) {
      problems.push({ message: `插件「${tool.toolset}」已不在本部署`, path: `tools[${index}]` })
      return
    }
    for (const required of plugin.requires) {
      if (enabled.has(required)) continue
      const label = mockAgentPlugins.find((p) => p.name === required)?.label ?? required
      problems.push({
        message: `「${plugin.label}」需要同时启用「${label}」`,
        path: `tools[${index}]`,
      })
    }
  })
  skillIds.forEach((id, index) => {
    const found = findMockSkill(id)
    if (found === undefined || found.latestVersion === null)
      problems.push({
        message: `技能「${found?.displayName ?? id}」还没有发布`,
        path: `skills[${index}]`,
      })
  })
  const subagents = config.subagents ?? []
  if (subagents.length > 0 && toOut(item).isSubagent)
    problems.push({
      message: '这个 agent 正被别人用作子 Agent，不能再有子 Agent',
      path: 'subagents',
    })
  subagents.forEach((binding, index) => {
    const child = findAgent(binding.agent)
    const reason =
      child === undefined
        ? '不存在'
        : child.id === item.id
          ? '不能选自己'
          : child.status === 'archived'
            ? '已归档'
            : activeOf(child) === undefined
              ? '还没有发布'
              : referencesOf(child).length > 0
                ? '自己有子 Agent'
                : null
    if (reason !== null)
      problems.push({
        message: `子 Agent「${child?.name ?? binding.agent}」${reason}`,
        path: `subagents[${index}].agent`,
      })
  })
  return problems
}

/** Agent 配置页用到的全部端点；`actor` 是当前登录的人，记成新版本的发布人与草稿的修改人。 */
export const agentConfigHandlers = (actor: () => Actor) => [
  http.get('*/api/agents', () => HttpResponse.json({ items: agents.map(toOut) })),

  http.post('*/api/agents', async ({ request }) => {
    const body = (await request.json()) as AgentCreateIn
    if (!ID_PATTERN.test(body.id) || RESERVED_IDS.has(body.id))
      return HttpResponse.json({ detail: `标识「${body.id}」不可用` }, { status: 422 })
    if (findAgent(body.id) !== undefined)
      return HttpResponse.json({ detail: `标识「${body.id}」已被占用` }, { status: 409 })
    const who = actor()
    const created = agent(
      Math.max(...agents.map((item) => item.sortOrder)) + 1,
      {
        description: body.description ?? '',
        id: body.id,
        listed: body.listed ?? false,
        name: body.name,
        status: 'active',
      },
      {
        baseVersionId: null,
        config: { instructions: '', model: null, schema_version: 1, subagents: [], tools: [] },
        skillIds: [],
      },
      [],
    )
    created.createdBy = who.id
    created.createdByName = who.name
    created.draft = { ...created.draft, lockVersion: 0, updatedBy: who.id, updatedByName: who.name }
    agents.push(created)
    return HttpResponse.json(toDetail(created), { status: 201 })
  }),

  http.get('*/api/agents/model-options', () => HttpResponse.json(mockModelOptions)),
  http.get('*/api/agents/plugins', () => HttpResponse.json({ items: mockAgentPlugins })),

  http.get('*/api/agents/:agentId', ({ params }) => {
    const item = findAgent(String(params['agentId']))
    return item === undefined ? notFound() : HttpResponse.json(toDetail(item))
  }),

  http.patch('*/api/agents/:agentId', async ({ params, request }) => {
    const item = findAgent(String(params['agentId']))
    if (item === undefined) return notFound()
    const body = (await request.json()) as AgentUpdateIn
    if (body.name !== undefined && body.name !== null) item.name = body.name
    if (body.description !== undefined && body.description !== null)
      item.description = body.description
    if (body.listed !== undefined && body.listed !== null) item.listed = body.listed
    item.updatedAt = new Date().toISOString()
    return HttpResponse.json(toDetail(item))
  }),

  http.put('*/api/agents/:agentId/draft', async ({ params, request }) => {
    const item = findAgent(String(params['agentId']))
    if (item === undefined) return notFound()
    const body = (await request.json()) as AgentDraftIn
    if (body.lockVersion !== item.draft.lockVersion) return stale()
    const who = actor()
    item.draft = {
      ...item.draft,
      config: body.config,
      lockVersion: item.draft.lockVersion + 1,
      skillIds: body.skillIds,
      updatedAt: new Date().toISOString(),
      updatedBy: who.id,
      updatedByName: who.name,
    }
    return HttpResponse.json(toDetail(item))
  }),

  http.get('*/api/agents/:agentId/versions', ({ params }) => {
    const item = findAgent(String(params['agentId']))
    if (item === undefined) return notFound()
    return HttpResponse.json({
      items: item.versions.map(({ config: _config, skillIds: _skillIds, ...rest }) => rest),
    })
  }),

  http.post('*/api/agents/:agentId/versions', async ({ params, request }) => {
    const item = findAgent(String(params['agentId']))
    if (item === undefined) return notFound()
    const body = (await request.json()) as AgentPublishIn
    if (body.lockVersion !== item.draft.lockVersion) return stale()
    const problems = publishProblems(item)
    if (problems.length > 0)
      return HttpResponse.json(
        { detail: problems.map((p) => p.message).join('；'), problems },
        { status: 422 },
      )
    if (!toOut(item).hasUnpublishedChanges)
      return HttpResponse.json({ detail: '没有可发布的改动' }, { status: 422 })
    const who = actor()
    const next = version(
      (item.versions[0]?.version ?? 0) + 1,
      crypto.randomUUID(),
      who,
      0,
      structuredClone(item.draft.config),
      [...item.draft.skillIds],
    )
    item.versions.unshift(next)
    item.activeVersionId = next.id
    item.draft = { ...item.draft, baseVersionId: next.id }
    const { config: _config, skillIds: _skillIds, ...out } = next
    return HttpResponse.json(out, { status: 201 })
  }),

  http.get('*/api/agents/:agentId/versions/:versionId', ({ params }) => {
    const found = findAgent(String(params['agentId']))?.versions.find(
      (v) => v.id === params['versionId'],
    )
    return found === undefined
      ? HttpResponse.json({ detail: '没有这个版本' }, { status: 404 })
      : HttpResponse.json(found)
  }),

  http.post('*/api/agents/:agentId/versions/:versionId/restore', async ({ params, request }) => {
    const item = findAgent(String(params['agentId']))
    const found = item?.versions.find((v) => v.id === params['versionId'])
    if (item === undefined || found === undefined)
      return HttpResponse.json({ detail: '没有这个版本' }, { status: 404 })
    const body = (await request.json()) as AgentRestoreIn
    if (body.lockVersion !== item.draft.lockVersion) return stale()
    const who = actor()
    item.draft = {
      baseVersionId: found.id,
      config: structuredClone(found.config),
      lockVersion: item.draft.lockVersion + 1,
      skillIds: [...found.skillIds],
      updatedAt: new Date().toISOString(),
      updatedBy: who.id,
      updatedByName: who.name,
    }
    return HttpResponse.json(toDetail(item))
  }),
]
