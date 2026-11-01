/**
 * 技能库的 mock：几个技能（含一个从没发布过的），草稿文件与最新版，形状照合同 §17。
 * 改草稿、改名、删除、发布、新建与改显示名都改内存里的数据，hash 冲突、路径规则、上限与发布检查照合同做；
 * hash 用简单的 FNV（客户端只把它当不透明的值回传）。每例由 `resetMockSkills` 放回预置数据。
 */

import { http, HttpResponse } from 'msw'
import type {
  DraftFileRenameIn,
  DraftFileWriteIn,
  SkillCreateIn,
  SkillDetailOut,
  SkillOut,
  SkillUpdateIn,
} from '@/shared/api/generated/types.gen'

type Actor = { id: string; name: string }

const uuid = (group: number, n: number) =>
  `00000000-0000-4000-8000-${String(group).padStart(4, '0')}${String(n).padStart(8, '0')}`

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const CHEN: Actor = { id: uuid(1, 1), name: '陈思远' }

const SKILL_MD = 'SKILL.md'
const MAX_FILE = 1024 * 1024
const MAX_TOTAL = 5 * 1024 * 1024
const MAX_FILES = 200
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const fnv = (text: string) => {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0').repeat(8)
}

const sizeOf = (text: string) => new TextEncoder().encode(text).length

type MockFile = { content: string; hash: string; updatedAt: string }

type MockSkill = Omit<SkillOut, 'hasUnpublishedChanges'> & {
  files: Map<string, MockFile>
  /** 最新版的内容 hash；没发布过为 null。 */
  latestContentHash: string | null
}

const file = (content: string, updatedAt = ago(60 * 24)): MockFile => ({
  content,
  hash: fnv(content),
  updatedAt,
})

const skillMd = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`

const contentHash = (files: Map<string, MockFile>) =>
  fnv(
    [...files]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, item]) => `${path}:${item.hash}`)
      .join('\n'),
  )

/** frontmatter 里一行写的 `name` / `description`；mock 只认本 mock 与页面写出来的两种写法。 */
const frontmatterField = (source: string, key: string): string | null => {
  const header = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1]
  const raw =
    header === undefined ? undefined : new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(header)?.[1]
  if (raw === undefined) return null
  if (!raw.startsWith('"')) return raw.trim()
  try {
    return (JSON.parse(raw) as string).trim()
  } catch {
    return null
  }
}

const seedSkill = (
  n: number,
  name: string,
  displayName: string,
  description: string,
  latestVersion: number | null,
  references: Record<string, string> = {},
  body = `# ${displayName}\n\n${description}\n`,
): MockSkill => {
  const files = new Map<string, MockFile>([[SKILL_MD, file(skillMd(name, description, body))]])
  for (const [path, content] of Object.entries(references)) files.set(path, file(content))
  return {
    createdAt: ago(60 * 24 * 30),
    createdBy: CHEN.id,
    createdByName: CHEN.name,
    description,
    displayName,
    files,
    id: uuid(4, n),
    latestContentHash: latestVersion === null ? null : contentHash(files),
    latestVersion,
    latestVersionId: latestVersion === null ? null : uuid(5, n),
    name,
    status: 'active',
    updatedAt: ago(60 * 24),
  }
}

const DIRECTOR_BODY = [
  '# 照参考片做新视频',
  '',
  '将参考素材与创作需求转化为新片方案。',
  '',
  '## 参考文件',
  '',
  '* [Brief 指南](references/brief-guide.md)',
  '* [参考片拆解](references/reference-video-guide.md)',
  '',
].join('\n')

const seedSkills = (): MockSkill[] => [
  seedSkill(
    1,
    'director',
    '照参考片做新视频',
    '从需求理解、参考片拆解，到新片执行方案与工程。',
    4,
    {
      'references/brief-guide.md':
        '# 创作 Brief\n\n## 素材\n\n记录产品、参考视频和可用图片。\n\n## 需求\n\n明确片长、画幅、目标受众与产品卖点。\n',
      'references/reference-video-guide.md': '# 参考片拆解\n\n按镜头记下景别、运镜、节奏与转场。\n',
      'references/shot-schema.json': '{\n  "shot": "镜头编号",\n  "duration": 3\n}\n',
    },
    DIRECTOR_BODY,
  ),
  seedSkill(2, 'storyboard-workflow', '分镜创作', '把素材和创作要求转化为结构完整的镜头组。', 7),
  seedSkill(
    3,
    'viral-script-remix',
    '爆款脚本拆解与二次创作方法论',
    '拆出爆款脚本的钩子、节奏与转化结构，改写成自家产品的版本。',
    2,
  ),
  seedSkill(
    4,
    'exact-replica-workflow',
    '参考视频复刻',
    '保留参考片的镜头与节奏，替换产品和场景。',
    3,
  ),
  seedSkill(5, 'selling-points', '商品卖点提炼', '从商品详情和用户评论中提炼卖点与使用场景。', 5),
  seedSkill(6, 'platform-adapt', '多平台尺寸适配', '把成片方案改成各平台的画幅和时长。', null),
]

let skills = seedSkills()

export const resetMockSkills = () => {
  skills = seedSkills()
}

export const findMockSkill = (id: string): SkillOut | undefined => {
  const found = skills.find((item) => item.id === id)
  return found === undefined ? undefined : toOut(found)
}

export const mockSkillId = (name: string): string => {
  const found = skills.find((item) => item.name === name)
  if (found === undefined) throw new Error(`mock 里没有技能 ${name}`)
  return found.id
}

/** 草稿里一个文件此刻的内容与 hash，测试用它断言回传的 baseHash。 */
export const mockSkillFile = (name: string, path: string): MockFile => {
  const found = skills.find((item) => item.name === name)?.files.get(path)
  if (found === undefined) throw new Error(`mock 里技能 ${name} 没有文件 ${path}`)
  return found
}

const toOut = ({ files, latestContentHash, ...rest }: MockSkill): SkillOut => ({
  ...rest,
  hasUnpublishedChanges: latestContentHash === null || latestContentHash !== contentHash(files),
})

const toDetail = (item: MockSkill): SkillDetailOut => ({
  ...toOut(item),
  draftFiles: [...item.files]
    .sort(([a], [b]) => (a === SKILL_MD ? -1 : b === SKILL_MD ? 1 : a < b ? -1 : 1))
    .map(([path, { hash, updatedAt, content }]) => ({
      hash,
      path,
      size: sizeOf(content),
      updatedAt,
    })),
  usedBy: [],
})

const fileOut = (path: string, item: MockFile) => ({ ...item, path, size: sizeOf(item.content) })

const notFound = (what = '没有这个技能') => HttpResponse.json({ detail: what }, { status: 404 })
const invalid = (detail: string) => HttpResponse.json({ detail }, { status: 422 })
const conflict = (detail: string) => HttpResponse.json({ detail }, { status: 409 })

const findSkill = (id: unknown) => skills.find((item) => item.id === String(id))

/** 端点路径里 `/draft/files/` 之后的文件路径，斜杠原样、每段解码。 */
const filePathOf = (request: Request) =>
  new URL(request.url).pathname
    .split('/draft/files/')[1]
    ?.split('/')
    .map(decodeURIComponent)
    .join('/') ?? ''

const pathProblem = (path: string): string | null => {
  if (path === SKILL_MD) return null
  if (!path.startsWith('references/') || path.includes('\\'))
    return '只收 SKILL.md 与 references/ 下的文件'
  if (path.split('/').some((part) => part === '' || part === '.' || part === '..'))
    return '路径里不能有空段、. 或 ..'
  return null
}

const limitProblem = (files: Map<string, MockFile>): string | null => {
  if (files.size > MAX_FILES) return `最多 ${MAX_FILES} 个文件`
  for (const [path, item] of files) if (sizeOf(item.content) > MAX_FILE) return `${path} 超过 1 MB`
  const total = [...files.values()].reduce((sum, item) => sum + sizeOf(item.content), 0)
  return total > MAX_TOTAL ? '全部文件合计超过 5 MB' : null
}

/** 没发布过的技能，说明跟着草稿里的 `SKILL.md` 走。 */
const followDraft = (item: MockSkill) => {
  if (item.latestVersion !== null) return
  const description = frontmatterField(item.files.get(SKILL_MD)?.content ?? '', 'description')
  if (description) item.description = description
}

const touch = (item: MockSkill) => {
  item.updatedAt = new Date().toISOString()
  followDraft(item)
}

/** 技能库用到的全部端点；`actor` 是当前登录的人，记成新技能的创建人。 */
export const skillHandlers = (actor: () => Actor) => [
  http.get('*/api/skills', () =>
    HttpResponse.json({ items: skills.filter((item) => item.status === 'active').map(toOut) }),
  ),

  http.post('*/api/skills', async ({ request }) => {
    const body = (await request.json()) as SkillCreateIn
    if (!NAME_PATTERN.test(body.name) || body.name.length > 64)
      return invalid(`技能标识「${body.name}」不合规矩`)
    if (skills.some((item) => item.name === body.name))
      return conflict(`技能标识「${body.name}」已被占用`)
    const who = actor()
    const created = seedSkill(
      skills.length + 1,
      body.name,
      body.displayName,
      body.description,
      null,
    )
    created.id = crypto.randomUUID()
    created.createdBy = who.id
    created.createdByName = who.name
    created.createdAt = new Date().toISOString()
    skills.push(created)
    return HttpResponse.json(toDetail(created), { status: 201 })
  }),

  http.get('*/api/skills/:skillId', ({ params }) => {
    const item = findSkill(params['skillId'])
    return item === undefined ? notFound() : HttpResponse.json(toDetail(item))
  }),

  http.patch('*/api/skills/:skillId', async ({ params, request }) => {
    const item = findSkill(params['skillId'])
    if (item === undefined) return notFound()
    const body = (await request.json()) as SkillUpdateIn
    const displayName = body.displayName.split(/\s+/).join(' ').trim()
    if (displayName === '') return invalid('请填写显示名')
    item.displayName = displayName
    item.updatedAt = new Date().toISOString()
    return HttpResponse.json(toDetail(item))
  }),

  http.post('*/api/skills/:skillId/draft/files/rename', async ({ params, request }) => {
    const item = findSkill(params['skillId'])
    if (item === undefined) return notFound()
    const body = (await request.json()) as DraftFileRenameIn
    if (body.from === SKILL_MD) return invalid('SKILL.md 不能改名')
    if (body.from === body.to) return invalid('新旧路径相同')
    const problem = pathProblem(body.to)
    if (problem !== null) return invalid(problem)
    const found = item.files.get(body.from)
    if (found === undefined) return notFound('没有这个文件')
    if (found.hash !== body.baseHash) return conflict('文件已被别人修改，请重新读取后再改名')
    if (item.files.has(body.to)) return conflict(`${body.to} 已存在`)
    item.files.delete(body.from)
    item.files.set(body.to, found)
    touch(item)
    return HttpResponse.json(fileOut(body.to, found))
  }),

  http.get('*/api/skills/:skillId/draft/files/*', ({ params, request }) => {
    const item = findSkill(params['skillId'])
    const path = filePathOf(request)
    const found = item?.files.get(path)
    return found === undefined ? notFound('没有这个文件') : HttpResponse.json(fileOut(path, found))
  }),

  http.put('*/api/skills/:skillId/draft/files/*', async ({ params, request }) => {
    const item = findSkill(params['skillId'])
    if (item === undefined) return notFound()
    const path = filePathOf(request)
    const problem = pathProblem(path)
    if (problem !== null) return invalid(problem)
    const body = (await request.json()) as DraftFileWriteIn
    const existing = item.files.get(path)
    if (body.baseHash === null && existing !== undefined) return conflict(`${path} 已存在`)
    if (body.baseHash !== null && existing?.hash !== body.baseHash)
      return conflict(`${path} 已被别人修改，请重新读取后再改`)
    const next = new Map(item.files)
    const written = file(body.content, new Date().toISOString())
    next.set(path, written)
    const limit = limitProblem(next)
    if (limit !== null) return invalid(limit)
    item.files = next
    touch(item)
    return HttpResponse.json(fileOut(path, written))
  }),

  http.delete('*/api/skills/:skillId/draft/files/*', ({ params, request }) => {
    const item = findSkill(params['skillId'])
    if (item === undefined) return notFound()
    const path = filePathOf(request)
    if (path === SKILL_MD) return invalid('SKILL.md 不能删除')
    const found = item.files.get(path)
    if (found === undefined) return notFound('没有这个文件')
    if (found.hash !== new URL(request.url).searchParams.get('baseHash'))
      return conflict(`${path} 已被别人修改，请重新读取后再删除`)
    item.files.delete(path)
    touch(item)
    return new HttpResponse(null, { status: 204 })
  }),

  http.post('*/api/skills/:skillId/versions', ({ params }) => {
    const item = findSkill(params['skillId'])
    if (item === undefined) return notFound()
    const source = item.files.get(SKILL_MD)?.content ?? ''
    const problems: string[] = []
    const name = frontmatterField(source, 'name')
    if (name !== item.name)
      problems.push(`SKILL.md 的 frontmatter 里 name 应是技能标识「${item.name}」`)
    const description = frontmatterField(source, 'description')
    if (!description) problems.push('SKILL.md 的 frontmatter 缺少 description')
    if (problems.length > 0) return invalid(problems.join('；'))
    const hash = contentHash(item.files)
    if (hash === item.latestContentHash) return invalid('没有可发布的改动')
    const who = actor()
    const version = (item.latestVersion ?? 0) + 1
    const id = crypto.randomUUID()
    item.latestVersion = version
    item.latestVersionId = id
    item.latestContentHash = hash
    item.description = description ?? item.description
    item.updatedAt = new Date().toISOString()
    return HttpResponse.json(
      {
        contentHash: hash,
        createdAt: item.updatedAt,
        createdBy: who.id,
        createdByName: who.name,
        id,
        note: null,
        version,
      },
      { status: 201 },
    )
  }),
]
