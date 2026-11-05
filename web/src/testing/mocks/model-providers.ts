import { http, HttpResponse } from 'msw'
import type {
  AgentModelRef,
  AgentUsageOut,
  CredentialCreateIn,
  CredentialOut,
  CredentialTestIn,
  CredentialUpdateIn,
  CustomModelCreateIn,
  DeclarationOut,
  DefaultModelIn,
  DefaultModelOut,
  ModelOptionsOut,
  ModelProviderCreateIn,
  ModelProviderOut,
  ModelProviderUpdateIn,
  ModelTestIn,
  ModelUpdateIn,
  ProbeOut,
  ProviderModelOut,
} from '@/shared/api/generated/types.gen'

type ModelType = ProviderModelOut['type']
type CustomModel = Omit<ProviderModelOut, 'source' | 'usedBy'>
type MockCredential = Omit<CredentialOut, 'usedBy'>
type MockProvider = Omit<ModelProviderOut, 'credentials' | 'models'> & {
  credentials: MockCredential[]
  disabledDeclared: string[]
  custom: CustomModel[]
}
type Usage = (match: (model: AgentModelRef) => boolean) => AgentUsageOut[]

const uuid = (group: number, n: number) =>
  `00000000-0000-4000-8000-${String(group).padStart(4, '0')}${String(n).padStart(8, '0')}`

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const BAILIAN_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

const apiKeyField = {
  default: null,
  label: 'API Key',
  name: 'api_key',
  required: true,
  type: 'secret',
} as const

const openDeclaration = (
  name: string,
  label: string,
  apis: DeclarationOut['apis'],
  baseUrl: DeclarationOut['credentialFields'][number],
): DeclarationOut => ({
  apis,
  credentialFields: [apiKeyField, baseUrl],
  customModels: true,
  label,
  models: [],
  name,
})

const optionalBaseUrl = {
  default: null,
  label: '接口地址',
  name: 'base_url',
  required: false,
  type: 'text',
} as const

const mockDeclarations: DeclarationOut[] = [
  {
    apis: ['responses', 'chat'],
    credentialFields: [
      { default: null, label: 'API Key', name: 'api_key', required: true, type: 'secret' },
      { default: BAILIAN_URL, label: '接口地址', name: 'base_url', required: true, type: 'text' },
    ],
    customModels: true,
    label: '阿里云百炼',
    models: [
      {
        api: 'responses',
        contextSize: 1_048_576,
        name: 'qwen3.8-flash',
        thinking: ['none', 'low', 'medium', 'high'],
        type: 'llm',
      },
      {
        api: 'chat',
        contextSize: 1_048_576,
        name: 'ZHIPU/GLM-5.3-Flash',
        thinking: ['none', 'low', 'medium', 'high'],
        type: 'llm',
      },
    ],
    name: 'bailian',
  },
  openDeclaration('gemini', 'Google Gemini', ['gemini'], optionalBaseUrl),
  openDeclaration('openai-compatible', 'OpenAI 兼容', ['chat', 'responses'], {
    ...optionalBaseUrl,
    required: true,
  }),
  openDeclaration('openrouter', 'OpenRouter', ['chat'], optionalBaseUrl),
  openDeclaration('volcengine', '火山方舟', ['chat', 'responses'], {
    ...optionalBaseUrl,
    default: 'https://ark.cn-beijing.volces.com/api/v3',
    required: true,
  }),
]

const credential = (
  id: string,
  name: string,
  minutesAgo: number,
  fields: Record<string, string>,
): MockCredential => ({ createdAt: ago(minutesAgo), fields, id, name, updatedAt: ago(minutesAgo) })

const llm = (
  name: string,
  contextSize: number,
  thinking: CustomModel['thinking'],
  api: 'chat' | 'responses' = 'responses',
): CustomModel => ({ api, contextSize, enabled: true, name, thinking, type: 'llm' })

const seedProviders = (): MockProvider[] => [
  {
    createdAt: ago(60 * 24 * 30),
    credentials: [
      credential(uuid(2, 1), '主账号', 60 * 24 * 30, {
        api_key: 'sk-mock-main-DEMO',
        base_url: BAILIAN_URL,
      }),
      credential(uuid(2, 2), '创作团队', 60 * 24 * 31, {
        api_key: 'sk-mock-team-7F2A',
        base_url: BAILIAN_URL,
      }),
    ],
    custom: [
      llm('qwen3.8-max', 262_144, ['low', 'medium', 'high']),
      llm('qwen3.8-plus', 262_144, ['none', 'low', 'medium', 'high']),
      {
        api: null,
        contextSize: null,
        enabled: true,
        name: 'text-embedding-v4',
        thinking: [],
        type: 'embedding',
      },
    ],
    defaultCredentialId: uuid(2, 1),
    disabledDeclared: [],
    enabled: true,
    id: uuid(3, 1),
    label: '阿里云百炼',
    name: 'bailian',
    provider: 'bailian',
    updatedAt: ago(60),
  },
  {
    createdAt: ago(60 * 24 * 40),
    credentials: [
      credential(uuid(2, 3), '团队服务', 60 * 24 * 40, {
        api_key: 'sk-mock-svc-K9QM',
        base_url: 'https://models.example/v1',
      }),
    ],
    custom: [
      llm('studio-chat', 131_072, [], 'chat'),
      llm('studio-chat-long', 1_048_576, ['minimal', 'xhigh'], 'chat'),
    ],
    defaultCredentialId: uuid(2, 3),
    disabledDeclared: ['llm:qwen3.8-flash', 'llm:ZHIPU/GLM-5.3-Flash'],
    enabled: true,
    id: uuid(3, 2),
    label: '团队模型服务',
    name: 'team-models',
    provider: 'bailian',
    updatedAt: ago(60 * 24),
  },
]

const seedDefaults = (): DefaultModelOut[] => [
  {
    modelName: 'qwen3.8-flash',
    providerId: uuid(3, 1),
    providerName: 'bailian',
    type: 'llm',
    updatedAt: ago(60 * 24),
  },
  {
    modelName: 'text-embedding-v4',
    providerId: uuid(3, 1),
    providerName: 'bailian',
    type: 'embedding',
    updatedAt: ago(60 * 24),
  },
]

let providers = seedProviders()
let defaults = seedDefaults()

export const resetMockModelProviders = () => {
  providers = seedProviders()
  defaults = seedDefaults()
}

const declarationOf = (provider: MockProvider) =>
  mockDeclarations.find((item) => item.name === provider.provider)

const maskedFields = (provider: MockProvider, fields: Record<string, string>) => {
  const secrets = new Set(
    declarationOf(provider)
      ?.credentialFields.filter((field) => field.type === 'secret')
      .map((field) => field.name),
  )
  return Object.fromEntries(
    Object.entries(fields).map(([name, value]) => [
      name,
      secrets.has(name) ? (value.length < 8 ? '••••' : `••••${value.slice(-4)}`) : value,
    ]),
  )
}

const modelsOf = (provider: MockProvider): Omit<ProviderModelOut, 'usedBy'>[] => [
  ...(declarationOf(provider)?.models ?? []).map((model) => ({
    ...model,
    enabled: !provider.disabledDeclared.includes(`${model.type}:${model.name}`),
    source: 'declared' as const,
  })),
  ...[...provider.custom]
    .sort((a, b) => (a.type === b.type ? (a.name < b.name ? -1 : 1) : a.type < b.type ? -1 : 1))
    .map((model) => ({ ...model, source: 'custom' as const })),
]

const byCreatedDesc = <T extends { createdAt: string }>(items: readonly T[]) =>
  [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))

export const mockModelOptions = (): ModelOptionsOut => ({
  providers: byCreatedDesc(providers)
    .filter((provider) => provider.enabled)
    .map((provider) => ({
      credentials: byCreatedDesc(provider.credentials).map((item) => ({
        fields: maskedFields(provider, item.fields),
        id: item.id,
        isDefault: item.id === provider.defaultCredentialId,
        name: item.name,
      })),
      id: provider.id,
      label: provider.label,
      models: modelsOf(provider)
        .filter((model) => model.type === 'llm' && model.enabled)
        .map(({ contextSize, name, thinking }) => ({ contextSize, name, thinking })),
      name: provider.name,
    })),
})

const detail = (message: string, status: number) =>
  HttpResponse.json({ detail: message }, { status })
const notFound = () => detail('没有这个供应商', 404)
const inUse = (users: AgentUsageOut[], action: string) =>
  detail(`${users.map((user) => user.agentName).join('、')} 正在使用，不能${action}`, 409)

const findProvider = (id: unknown) => providers.find((item) => item.id === id)

const isDefaultModel = (provider: MockProvider, type: ModelType, name: string) =>
  defaults.some(
    (item) => item.providerId === provider.id && item.type === type && item.modelName === name,
  )

const probe = (fields: Record<string, string>): ProbeOut =>
  Object.values(fields).some((value) => value.includes('invalid'))
    ? { elapsedMs: 420, ok: false, reason: '接口返回 401，API Key 无效' }
    : { elapsedMs: 236, ok: true, reason: null }

const checkFields = (provider: MockProvider, fields: Record<string, string>) => {
  const declared = declarationOf(provider)?.credentialFields ?? []
  const unknown = Object.keys(fields).find((name) => !declared.some((field) => field.name === name))
  if (unknown !== undefined) return `声明里没有字段 ${unknown}`
  const missing = declared.find(
    (field) => field.required && (fields[field.name] ?? '').trim() === '',
  )
  return missing === undefined ? null : `请填写${missing.label}`
}

const withDefaults = (provider: MockProvider, fields: Record<string, string>) => {
  const filled: Record<string, string> = {}
  for (const field of declarationOf(provider)?.credentialFields ?? []) {
    const value = (fields[field.name] ?? '').trim() || (field.default ?? '')
    if (value !== '') filled[field.name] = value
  }
  return filled
}

const checkCustomModel = (
  provider: MockProvider,
  model: Pick<CustomModel, 'api' | 'thinking' | 'type'>,
) => {
  if (model.type === 'llm' && model.api === null) return 'llm 模型要写接口'
  const declaration = declarationOf(provider)
  if (model.api !== null && declaration !== undefined && !declaration.apis.includes(model.api))
    return `${declaration.label}的模型只能走 ${declaration.apis.join('、')} 接口，不能走 ${model.api}`
  if (model.type !== 'llm' && (model.api !== null || model.thinking.length > 0))
    return '只有 llm 模型能写接口与思考档位'
  if (new Set(model.thinking).size !== model.thinking.length) return '思考档位不能重复'
  return null
}

const modelPathOf = (url: string) => {
  const [, tail = ''] = new URL(url).pathname.split('/models/')
  const [type = '', ...rest] = tail.split('/')
  return { name: rest.map(decodeURIComponent).join('/'), type: type as ModelType }
}

export const modelProviderHandlers = (usage: Usage) => {
  const providerUsers = (provider: MockProvider) =>
    usage((model) => model.provider === provider.name)

  const toOut = (provider: MockProvider): ModelProviderOut => ({
    ...provider,
    credentials: byCreatedDesc(provider.credentials).map((item) => ({
      ...item,
      fields: maskedFields(provider, item.fields),
      usedBy: usage((model) => model.provider === provider.name && model.credential_id === item.id),
    })),
    models: modelsOf(provider).map((model) => ({
      ...model,
      usedBy:
        model.type === 'llm'
          ? usage((ref) => ref.provider === provider.name && ref.name === model.name)
          : [],
    })),
  })

  const modelOut = (provider: MockProvider, type: ModelType, name: string) =>
    toOut(provider).models.find((model) => model.type === type && model.name === name)

  return [
    http.get('*/api/model-providers', () =>
      HttpResponse.json({ providers: byCreatedDesc(providers).map(toOut) }),
    ),

    http.get('*/api/model-providers/declarations', () =>
      HttpResponse.json({ declarations: mockDeclarations }),
    ),

    http.post('*/api/model-providers', async ({ request }) => {
      const body = (await request.json()) as ModelProviderCreateIn
      if (!/^[a-z0-9-]{1,64}$/.test(body.name))
        return detail('引用名只能用小写字母、数字和连字符', 422)
      if (providers.some((item) => item.name === body.name))
        return detail(`引用名 ${body.name} 已被使用`, 422)
      if (!mockDeclarations.some((item) => item.name === body.provider))
        return detail('没有这份模型声明', 422)
      const now = new Date().toISOString()
      const created: MockProvider = {
        createdAt: now,
        credentials: [],
        custom: [],
        defaultCredentialId: null,
        disabledDeclared: [],
        enabled: true,
        id: crypto.randomUUID(),
        label: body.label.trim(),
        name: body.name,
        provider: body.provider,
        updatedAt: now,
      }
      providers.push(created)
      return HttpResponse.json(toOut(created), { status: 201 })
    }),

    http.patch('*/api/model-providers/:providerId', async ({ params, request }) => {
      const provider = findProvider(params['providerId'])
      if (provider === undefined) return notFound()
      const body = (await request.json()) as ModelProviderUpdateIn
      if (body.defaultCredentialId !== undefined && body.defaultCredentialId !== null) {
        if (!provider.credentials.some((item) => item.id === body.defaultCredentialId))
          return detail('默认密钥要是这个供应商的密钥', 422)
        provider.defaultCredentialId = body.defaultCredentialId
      }
      if (body.enabled === false && provider.enabled) {
        const users = providerUsers(provider)
        if (users.length > 0) return inUse(users, '停用')
      }
      if (body.enabled !== undefined && body.enabled !== null) provider.enabled = body.enabled
      if (body.label !== undefined && body.label !== null) {
        if (body.label.trim() === '') return detail('请填写显示名', 422)
        provider.label = body.label.trim()
      }
      provider.updatedAt = new Date().toISOString()
      return HttpResponse.json(toOut(provider))
    }),

    http.delete('*/api/model-providers/:providerId', ({ params }) => {
      const provider = findProvider(params['providerId'])
      if (provider === undefined) return notFound()
      const users = providerUsers(provider)
      if (users.length > 0) return inUse(users, '删除')
      if (defaults.some((item) => item.providerId === provider.id))
        return detail('默认模型在这个供应商里，不能删除；请先在「默认模型」里换掉', 409)
      providers = providers.filter((item) => item !== provider)
      return new HttpResponse(null, { status: 204 })
    }),

    http.post('*/api/model-providers/:providerId/credentials/test', async ({ params, request }) => {
      const provider = findProvider(params['providerId'])
      if (provider === undefined) return notFound()
      const body = (await request.json()) as CredentialTestIn
      const saved = provider.credentials.find((item) => item.id === body.credentialId)
      if (body.credentialId && saved === undefined) return detail('没有这把密钥', 404)
      const fields =
        saved === undefined
          ? withDefaults(provider, body.fields ?? {})
          : { ...saved.fields, ...(body.fields ?? {}) }
      const problem = checkFields(provider, fields)
      if (problem !== null) return detail(problem, 422)
      if (!modelsOf(provider).some((model) => model.type === 'llm' && model.enabled))
        return detail('先添加一个模型再试连', 422)
      return HttpResponse.json(probe(fields))
    }),

    http.post('*/api/model-providers/:providerId/models/test', async ({ params, request }) => {
      const provider = findProvider(params['providerId'])
      if (provider === undefined) return notFound()
      const body = (await request.json()) as ModelTestIn
      const model = modelsOf(provider).find(
        (item) => item.type === body.type && item.name === body.name,
      )
      if (model === undefined) return detail('模型不存在', 404)
      if (model.type !== 'llm') return detail('只有 llm 模型能测试', 422)
      const credentialId = body.credentialId ?? provider.defaultCredentialId
      if (credentialId === null) return detail('先添加密钥', 422)
      const saved = provider.credentials.find((item) => item.id === credentialId)
      if (saved === undefined) return detail('密钥不存在', 404)
      return HttpResponse.json(probe(saved.fields))
    }),

    http.post('*/api/model-providers/:providerId/credentials', async ({ params, request }) => {
      const provider = findProvider(params['providerId'])
      if (provider === undefined) return notFound()
      const body = (await request.json()) as CredentialCreateIn
      const name = body.name.trim()
      if (name === '') return detail('请填写密钥名称', 422)
      if (provider.credentials.some((item) => item.name === name))
        return detail(`这个供应商已有名为 ${name} 的密钥`, 422)
      const fields = withDefaults(provider, body.fields)
      const problem = checkFields(provider, fields)
      if (problem !== null) return detail(problem, 422)
      const created = credential(crypto.randomUUID(), name, 0, fields)
      provider.credentials.push(created)
      provider.defaultCredentialId ??= created.id
      const out = toOut(provider).credentials.find((item) => item.id === created.id)
      return HttpResponse.json(out, { status: 201 })
    }),

    http.patch(
      '*/api/model-providers/:providerId/credentials/:credentialId',
      async ({ params, request }) => {
        const provider = findProvider(params['providerId'])
        const saved = provider?.credentials.find((item) => item.id === params['credentialId'])
        if (provider === undefined || saved === undefined) return detail('没有这把密钥', 404)
        const body = (await request.json()) as CredentialUpdateIn
        const name = body.name?.trim()
        if (name !== undefined) {
          if (name === '') return detail('请填写密钥名称', 422)
          if (provider.credentials.some((item) => item !== saved && item.name === name))
            return detail(`这个供应商已有名为 ${name} 的密钥`, 422)
        }
        const fields = { ...saved.fields, ...(body.fields ?? {}) }
        if (JSON.stringify(fields) !== JSON.stringify(saved.fields)) {
          const problem = checkFields(provider, fields)
          if (problem !== null) return detail(problem, 422)
          saved.fields = Object.fromEntries(
            Object.entries(fields)
              .map(([key, value]) => [key, value.trim()] as const)
              .filter(([, value]) => value !== ''),
          )
        }
        if (name !== undefined) saved.name = name
        saved.updatedAt = new Date().toISOString()
        return HttpResponse.json(toOut(provider).credentials.find((item) => item.id === saved.id))
      },
    ),

    http.delete('*/api/model-providers/:providerId/credentials/:credentialId', ({ params }) => {
      const provider = findProvider(params['providerId'])
      const saved = provider?.credentials.find((item) => item.id === params['credentialId'])
      if (provider === undefined || saved === undefined) return detail('没有这把密钥', 404)
      if (provider.defaultCredentialId === saved.id)
        return detail('默认密钥不能删除，请先把另一把设为默认', 409)
      const users = usage((model) => model.credential_id === saved.id)
      if (users.length > 0) return inUse(users, '删除')
      provider.credentials = provider.credentials.filter((item) => item !== saved)
      return new HttpResponse(null, { status: 204 })
    }),

    http.post('*/api/model-providers/:providerId/models', async ({ params, request }) => {
      const provider = findProvider(params['providerId'])
      if (provider === undefined) return notFound()
      if (declarationOf(provider)?.customModels !== true)
        return detail('这个供应商不能自己加模型', 422)
      const body = (await request.json()) as CustomModelCreateIn
      const model: CustomModel = {
        api: body.api ?? null,
        contextSize: body.contextSize ?? null,
        enabled: true,
        name: body.name.trim(),
        thinking: body.thinking ?? [],
        type: body.type,
      }
      if (model.name === '') return detail('请填写模型名', 422)
      if (modelsOf(provider).some((item) => item.type === model.type && item.name === model.name))
        return detail(`已有同名同类型的模型 ${model.name}`, 422)
      const problem = checkCustomModel(provider, model)
      if (problem !== null) return detail(problem, 422)
      provider.custom.push(model)
      return HttpResponse.json(modelOut(provider, model.type, model.name), { status: 201 })
    }),

    http.patch('*/api/model-providers/:providerId/models/*', async ({ params, request }) => {
      const provider = findProvider(params['providerId'])
      if (provider === undefined) return notFound()
      const { name, type } = modelPathOf(request.url)
      const current = modelOut(provider, type, name)
      if (current === undefined) return detail('没有这个模型', 404)
      const body = (await request.json()) as ModelUpdateIn
      const changesProperties = body.api != null || body.thinking != null || 'contextSize' in body
      if (current.source === 'declared' && changesProperties)
        return detail('声明里的模型只能启用或停用', 422)
      if (body.enabled === false && current.enabled) {
        if (current.usedBy.length > 0) return inUse(current.usedBy, '停用')
        if (isDefaultModel(provider, type, name))
          return detail(`它是 ${type} 的默认模型，不能停用；请先在「默认模型」里换掉`, 409)
      }
      if (current.source === 'declared') {
        const key = `${type}:${name}`
        provider.disabledDeclared = provider.disabledDeclared.filter((item) => item !== key)
        if (body.enabled === false || (body.enabled == null && !current.enabled))
          provider.disabledDeclared.push(key)
      } else {
        const custom = provider.custom.find((item) => item.type === type && item.name === name)
        if (custom === undefined) return detail('没有这个模型', 404)
        const next: CustomModel = {
          ...custom,
          ...(body.api == null ? {} : { api: body.api }),
          ...('contextSize' in body ? { contextSize: body.contextSize ?? null } : {}),
          ...(body.thinking == null ? {} : { thinking: body.thinking }),
          ...(body.enabled == null ? {} : { enabled: body.enabled }),
        }
        const problem = checkCustomModel(provider, next)
        if (problem !== null) return detail(problem, 422)
        Object.assign(custom, next)
      }
      return HttpResponse.json(modelOut(provider, type, name))
    }),

    http.delete('*/api/model-providers/:providerId/models/*', ({ params, request }) => {
      const provider = findProvider(params['providerId'])
      if (provider === undefined) return notFound()
      const { name, type } = modelPathOf(request.url)
      const current = modelOut(provider, type, name)
      if (current === undefined) return detail('没有这个模型', 404)
      if (current.source === 'declared') return detail('声明里的模型不能删除', 422)
      if (current.usedBy.length > 0) return inUse(current.usedBy, '删除')
      if (isDefaultModel(provider, type, name))
        return detail(`它是 ${type} 的默认模型，不能删除；请先在「默认模型」里换掉`, 409)
      provider.custom = provider.custom.filter(
        (item) => !(item.type === type && item.name === name),
      )
      return new HttpResponse(null, { status: 204 })
    }),

    http.get('*/api/default-models', () => HttpResponse.json({ defaults })),

    http.put('*/api/default-models/:modelType', async ({ params, request }) => {
      const type = String(params['modelType']) as ModelType
      const body = (await request.json()) as DefaultModelIn
      const provider = findProvider(body.providerId)
      if (provider === undefined) return detail('供应商不存在', 422)
      const model = modelOut(provider, type, body.modelName)
      if (model === undefined) return detail(`供应商没有 ${type} 模型 ${body.modelName}`, 422)
      if (!model.enabled) return detail(`模型 ${body.modelName} 已停用`, 422)
      const next: DefaultModelOut = {
        modelName: body.modelName,
        providerId: provider.id,
        providerName: provider.name,
        type,
        updatedAt: new Date().toISOString(),
      }
      defaults = [...defaults.filter((item) => item.type !== type), next].sort((a, b) =>
        a.type < b.type ? -1 : 1,
      )
      return HttpResponse.json(next)
    }),
  ]
}
