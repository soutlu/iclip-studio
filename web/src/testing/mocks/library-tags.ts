/** 资料库标签树的 mock：照迁移预置的五个维度（品牌空、平台&渠道人工、品类 / 场景 / 内容结构由 AI 打），
 * id 固定可复现。条数由调用方给出各条目的标签现算；按标签筛选的匹配照合同 §15 做。
 * 单测与演示行用 `mockTagId(名字)` 取 id。 */

import { http, HttpResponse } from 'msw'
import type { LibraryTagOut, LibraryTagsOut } from '@/shared/api/generated/types.gen'

type Node = Omit<LibraryTagOut, 'counts' | 'children'> & { children: Node[] }

const CATEGORIES = [
  '高跟鞋',
  '平底鞋',
  '乐福鞋',
  '牛津鞋',
  '一脚蹬',
  '穆勒鞋',
  '拖鞋',
  '短靴',
  '中筒靴',
  '及膝靴',
  '过膝靴',
  '高跟凉鞋',
  '坡跟凉鞋',
  '厚底凉鞋',
  '平底凉鞋',
  '夹趾拖',
  '凉拖鞋',
  '运动凉鞋',
  '跑鞋',
  '足球鞋',
  '篮球鞋',
  '啦啦队鞋',
  '棒&垒球鞋',
  '滑板鞋',
  '舞蹈鞋',
  '橄榄球鞋',
  '高尔夫鞋',
  '网球鞋',
  '训练鞋',
  '女性骑行鞋',
  '健步鞋',
  '板鞋',
  '徒步鞋',
  '徒步靴',
  '雪地靴',
  '雨靴',
  '水鞋',
  '猎靴',
  '医疗用鞋',
  '餐厨用鞋',
  '军事用靴',
  '工业用鞋',
  '工业用靴',
  '皮带',
  '钱包',
  '包',
  '袜子',
  '鞋垫',
  'T恤',
  '衬衫',
  '卫衣',
  '毛衣',
  '外套',
  '裤子',
  '半身裙',
  '连衣裙',
] as const

/** 内容结构的大类（名字、判断句）与各自的小类（名字、英文名）。 */
const STRUCTURE: readonly (readonly [string, string, readonly (readonly [string, string])[]])[] = [
  [
    '产品展示型',
    '产品本身是主体，拍特写、细节、功能，或拍它怎么做出来',
    [
      ['360°全景展示', '360 Spin'],
      ['细节微距特写', 'Macro Detail'],
      ['功能暴力测试', 'Stress Test'],
      ['拆解/组装演示', 'Exploded View'],
    ],
  ],
  [
    '真人种草型',
    '模特穿上或戴上产品展示上身效果，或人物在生活场景里自然地使用产品，不对着镜头讲解',
    [
      ['动态上身展示', 'Static Try-on'],
      ['动态场景跟拍', 'Action Follow'],
      ['POV 第一人称视角', 'POV Experience'],
      ['多场景快速切换', 'Multi-Scene Montage'],
    ],
  ],
  [
    '口播讲解型',
    '有人对着镜头讲，说话占了大部分时长',
    [
      ['专家评测解说', 'Expert Review'],
      ['痛点解决方案', 'Problem Solver'],
      ['沉浸式 ASMR', 'Silent ASMR'],
      ['幕后/工厂探秘', 'Behind the Scenes'],
    ],
  ],
  [
    '开箱测评型',
    '拆包装上手，或在片中做测试、对比',
    [
      ['标准开箱流程', 'Standard Unboxing'],
      ['极速上手体验', 'Quick First Look'],
      ['对比测评', 'Comparison Battle'],
    ],
  ],
  [
    '剧情叙事型',
    '有角色和情节，人物之间的互动推着故事往前走',
    [
      ['困境反转剧', 'Problem-Solution Arc'],
      ['幽默反转型', 'Comedy Twist'],
      ['情感共鸣剧', 'Emotional Journey'],
      ['挑战任务剧', 'Challenge Based'],
    ],
  ],
  [
    '素材混剪型',
    '不是连贯的实拍：由图片、零散素材拼成，或是动画、三维渲染',
    [
      ['卡点变装/转场', 'Beat Sync Transition'],
      ['用户评价拼贴', 'Review Mashup'],
      ['图文幻灯片', 'Photo Slideshow'],
    ],
  ],
  [
    '直播切片优化型',
    '画面来自直播间，主播在直播布景前讲',
    [
      ['高光时刻剪辑', 'Highlight Reel'],
      ['问答集锦', 'Q&A Compilation'],
    ],
  ],
]

let nextId = 0
const node = (
  name: string,
  position: number,
  extra: { autoFill?: 'ai'; guide?: string; children?: Node[] } = {},
): Node => {
  nextId += 1
  return {
    autoFill: extra.autoFill ?? null,
    children: extra.children ?? [],
    guide: extra.guide ?? null,
    id: `5a900000-0000-4000-8000-${String(nextId).padStart(12, '0')}`,
    name,
    position,
  }
}

const leaves = (names: readonly string[]) => names.map((name, index) => node(name, index))

const TREE: readonly Node[] = [
  node('品牌', 0),
  node('平台&渠道', 1, { children: leaves(['AMZ', 'DTC', 'TikTok', 'INS', 'ADS']) }),
  node('品类', 2, {
    autoFill: 'ai',
    children: leaves(CATEGORIES),
    guide: '看出场的产品，每个产品选一个最贴切的；模特顺带穿的衣服不算；清单里没有的不选',
  }),
  node('场景', 3, {
    autoFill: 'ai',
    children: leaves(['居家/日常放松', '户外/公园散步', '通勤/长时间站立']),
  }),
  node('内容结构', 4, {
    autoFill: 'ai',
    children: STRUCTURE.map(([name, guide, children], index) =>
      node(name, index, {
        children: children.map(([child, english], position) =>
          node(child, position, { guide: english }),
        ),
        guide,
      }),
    ),
    guide: '选最贴切的小类，小类都不贴切时选大类',
  }),
]

/** 每个节点在树里的位置：所在维度（维度自己就是它）、上级与全部下级。 */
type Place = { node: Node; dimension: Node; parent: Node | null; descendants: string[] }

const places = new Map<string, Place>()
const walk = (current: Node, dimension: Node, parent: Node | null): string[] => {
  const descendants = current.children.flatMap((child) => [
    child.id,
    ...walk(child, dimension, current),
  ])
  places.set(current.id, { descendants, dimension, node: current, parent })
  return descendants
}
for (const dimension of TREE) walk(dimension, dimension, null)

/** 按名字取 id；名字不在树里直接报错，免得演示数据写错了不出声。 */
export const mockTagId = (name: string): string => {
  for (const place of places.values()) if (place.node.name === name) return place.node.id
  throw new Error(`标签树里没有「${name}」`)
}

/** 是树里的取值（不是维度本身）。 */
export const isMockTagValue = (id: string): boolean => {
  const place = places.get(id)
  return place !== undefined && place.parent !== null
}

/** 这个取值是不是 AI 打的维度下的。 */
export const isMockAiTag = (id: string): boolean => places.get(id)?.dimension.autoFill === 'ai'

/** 按标签筛选：选中的按维度分组，同一维度命中任一，不同维度都要命中，选了上级也算它的下级。
 * 有不认识的 id 交回 null（合同里是 422）。 */
export const mockTagMatcher = (
  selected: readonly string[],
): ((tagIds: readonly string[]) => boolean) | null => {
  const groups = new Map<string, Set<string>>()
  for (const id of selected) {
    const place = places.get(id)
    if (place === undefined) return null
    const group = groups.get(place.dimension.id) ?? new Set<string>()
    if (place.parent !== null) group.add(id)
    for (const descendant of place.descendants) group.add(descendant)
    groups.set(place.dimension.id, group)
  }
  return (tagIds) => [...groups.values()].every((group) => tagIds.some((id) => group.has(id)))
}

const withCounts = (current: Node, entries: readonly (readonly string[])[]): LibraryTagOut => {
  const covered = new Set([current.id, ...(places.get(current.id)?.descendants ?? [])])
  return {
    ...current,
    children: current.children.map((child) => withCounts(child, entries)),
    counts: {
      hitCases: 0,
      references: entries.filter((tagIds) => tagIds.some((id) => covered.has(id))).length,
    },
  }
}

/** `GET /library-tags` 的答复；`entries` 是各条目的标签，条数照它现算。 */
export const mockLibraryTagTree = (
  entries: readonly (readonly string[])[] = [],
): LibraryTagsOut => ({ dimensions: TREE.map((dimension) => withCounts(dimension, entries)) })

/** `entries` 给出此刻每条没移除的参考视频的标签。 */
export const libraryTagHandlers = (entries: () => readonly (readonly string[])[]) => [
  http.get('*/api/library-tags', () => HttpResponse.json(mockLibraryTagTree(entries()))),
]
