/** 制作页的 mock：每段对话一份读好的工程（形状同 `GET /conversations/{id}/film`），改字照后端的规矩查，
 * 改完把工作区里 `film.icml` 的版本加一，文件列表与制作页的版本对得上；出片记一条视频记录，镜号是组号。
 *
 * 照后端现行的写法：`frames` 先是这组视频的参考图列表，按列表先后，`number` 就是位置，没有图的也有；再按镜头先后接上
 * 还没进列表的机位图，`number` 为 null。全局设定与镜头正文里用 `@ImageN` 指列表第 N 张，选用了机位图的镜头开头写
 * 「参考@ImageN，」；`settings[].images` 恒为空。
 * 图照后端的规矩定：用户给的图总有图；生成图只认选用，没选用就没图，生成出来的不自动用上。机位图第一次选用时插进列表
 * （排在镜头更靠后的机位图之前）、那一镜开头写引用、后面的图号加一，取消选用时反过来（同后端 `_place_view`）。
 * 生图描述按它自己的参考图列表写 `@ImageN`，读的时候每个都拆成图片段，带这个编号，没图的地址为 null、称呼记进
 * `missing`。列表里有没图的，生图、出片都拒。
 * 改字时字里插入、删除图片照后端 `_renumber_group`：新图从 M+1 起编、地址在 `images` 里，已在列表里的用原编号，不在的
 * 排在机位图之前（叫「素材照片N」），后面的编号与镜头开头的引用顺延；不再用的元素图出列表；机位图的引用删不掉、挪不动。 */

import { http, HttpResponse } from 'msw'
import type {
  FilmFrameOut,
  FilmGroupOut,
  FilmImageChoiceIn,
  FilmImageGenerationIn,
  FilmTextEditsIn,
  FilmVideoGenerationIn,
  FilmViewOut,
} from '@/shared/api/generated/types.gen'
import apparelImage from './assets/apparel.webp'
import backpackImage from './assets/backpack.webp'
import loafersImage from './assets/loafers.webp'
import { acceptMockImage, acceptMockVideo, putMockWorkspaceFile } from './workspace'

const FILM_PATH = 'film.icml'
const RUN_PATH = 'film.icrun'

/** 工程文件里的一张图：生成图带描述（`@ImageN` 指 `references` 的第 N 张）与画幅，用户给的图带地址。 */
type MockImage = Pick<FilmFrameOut, 'aspectRatio' | 'kind' | 'label' | 'node'> & {
  photo: string | null
  description: string | null
  references: readonly string[]
}

/** 工程文件里的一组视频：`images` 是参考图列表照文件写，`views` 是各镜头 `view` 指的机位图；地址、编号、描述的拆分与
 * 正文读的时候现算（见 `resolved`）。 */
type MockGroup = Omit<FilmGroupOut, 'frames' | 'prompt'> & {
  images: readonly MockImage[]
  views: readonly MockImage[]
}

type MockFilm = Omit<FilmViewOut, 'groups'> & { groups: MockGroup[] }

const films = new Map<string, MockFilm>()
/** 每段对话里每张图现在的地址：生成图是运行文件里的选用（null 是没选用），用户给的图是工程文件里的地址。 */
const chosen = new Map<string, Map<string, string | null>>()
/** 放工程时就选用了的生成图：人物与镜头 2 的机位图；场景图与镜头 1 的机位图没选用。 */
const SEEDED_CHOICES: ReadonlyMap<string, string> = new Map([
  ['girl_look', apparelImage],
  ['shot2_view', backpackImage],
])
/** `complete` 时另外选用的：列表里每张都有图，能出片。 */
const COMPLETE_CHOICES: ReadonlyMap<string, string> = new Map([
  ['park_look', `${backpackImage}?view=park`],
  ['shot1_view', `${apparelImage}?view=shot1`],
])
/** 按描述生图出过几张，给每张一个不同的地址。 */
let generatedCount = 0

/** 文件页上看到的工程原文；制作页不读它，只是让文件页有东西可看。 */
const FILM_SOURCE = [
  '<?icml using="iclip-studio/film@1"?>',
  '<Film version="1">',
  '  <Element id="金发女生" type="人物">二十岁上下的白人女生，脸型偏长，金色齐耳波波头。</Element>',
  '  <!-- 其余节点略 -->',
  '</Film>',
  '',
].join('\n')

const RUN_SOURCE = '<?icml using="iclip-studio/run@1"?>\n<Run version="1"/>\n'

const generated = (
  node: string,
  label: string,
  aspectRatio: string,
  description: string,
  references: readonly string[] = [],
): MockImage => ({
  aspectRatio,
  description,
  kind: 'generated',
  label,
  node,
  photo: null,
  references,
})

const photo = (node: string, label: string, url: string): MockImage => ({
  aspectRatio: null,
  description: null,
  kind: 'photo',
  label,
  node,
  photo: url,
  references: [],
})

/** 一组 12 秒的穿搭短片，照文件写、还没有任何机位图进列表：参考图列表依次是人物一张生成图、产品两张用户给的、场景一张
 * 生成图；镜头 1、镜头 2 各有一张机位图；四个镜头，两句台词。同一个元素的几张图都叫元素的名字，与后端相同。 */
const mockGroup = (): MockGroup => ({
  aspectRatio: '9:16',
  images: [
    generated(
      'girl_look',
      '金发女生',
      '3:4',
      '画面是用手机实拍的，真实自然。二十岁上下的白人女生，金色齐耳波波头。',
    ),
    photo('loafer_photo', '绒面一脚蹬', loafersImage),
    photo('loafer_sole', '绒面一脚蹬', `${loafersImage}?side=sole`),
    generated('park_look', '涂鸦滑板场', '9:16', '户外露天水泥滑板场，坡面和地面喷满街头涂鸦。'),
  ],
  index: 1,
  model: 'vendor-a-seedance-2-0',
  seconds: 12,
  settings: [
    {
      images: [],
      kind: 'shooting',
      label: '拍摄与剪辑',
      target: 'value:拍摄与剪辑',
      text: '摄影：手持拍摄，带轻微呼吸感，以低机位仰拍和脚部特写为主。\n剪辑：全片硬切，快节奏。',
    },
    {
      images: [],
      kind: 'element',
      label: '人物',
      target: 'value:金发女生',
      text: '金发女生，二十岁上下的白人女生，脸型偏长，金色齐耳波波头，长相参考@Image1。',
    },
    {
      images: [],
      kind: 'element',
      label: '产品',
      target: 'value:绒面一脚蹬',
      text: '绒面一脚蹬，浅米色反绒皮的低帮鞋，鞋面参考@Image2，鞋底参考@Image3。',
    },
    {
      images: [],
      kind: 'element',
      label: '场景',
      target: 'value:涂鸦滑板场',
      text: '户外露天水泥滑板场参考@Image4，坡面和地面喷满街头涂鸦。',
    },
    {
      images: [],
      kind: 'voice',
      label: '声音',
      target: 'value:旁白声音',
      text: '旁白：年轻女性松弛的中音，普通话，语速偏慢。',
    },
  ],
  shots: [
    {
      end: 3,
      lines: [],
      parts: ['低机位仰拍全景，镜头缓慢后拉。女生站在坡面上，双手把一块长板横扛在肩后。'],
      start: 0,
      target: 'shot:board:1',
      view: 'shot1_view',
    },
    {
      end: 6,
      lines: [{ role: '旁白', target: 'line:soft', text: '软得像拖鞋，稳得像板鞋。' }],
      parts: ['高角度俯拍脚部特写，镜头缓慢右移。她坐在坡面边缘，小腿悬空。\n', ''],
      start: 3,
      target: 'shot:board:2',
      view: 'shot2_view',
    },
    {
      end: 9,
      lines: [],
      parts: ['低机位脚部特写，镜头缓慢左移。画面只有她的小腿和鞋，她在水泥地面上向前走。'],
      start: 6,
      target: 'shot:board:3',
      view: null,
    },
    {
      end: 12,
      lines: [{ role: '旁白', target: 'line:street', text: '滑板场到街角，一双就够了。' }],
      parts: ['高角度俯拍全景，她把长板竖在右腿边。', ''],
      start: 9,
      target: 'shot:board:4',
      view: null,
    },
  ],
  video: 'board_video',
  views: [
    generated(
      'shot1_view',
      '镜头 1',
      '9:16',
      '@Image1的人物，站在@Image2的坡面上，双手把长板横扛在肩后。',
      ['girl_look', 'park_look'],
    ),
    generated(
      'shot2_view',
      '镜头 2',
      '9:16',
      '高角度俯拍@Image1的脚部特写，她坐在坡面边缘，小腿悬空。',
      ['girl_look'],
    ),
  ],
})

const IMAGE_NUMBER = /@Image(\d+)/g

const cite = (number: number) => `参考@Image${String(number)}，`

/** 一组的字（全局设定与镜头正文）里的图号按 `shift` 改：`shift(K)` 给出新的 K。 */
const renumbered = (group: MockGroup, shift: (number: number) => number): MockGroup => {
  const apply = (text: string) =>
    text.replace(IMAGE_NUMBER, (_, digits: string) => `@Image${String(shift(Number(digits)))}`)
  return {
    ...group,
    settings: group.settings.map((setting) => ({ ...setting, text: apply(setting.text) })),
    shots: group.shots.map((shot) => ({ ...shot, parts: shot.parts.map(apply) })),
  }
}

/** 第 `index` 镜正文开头（首部空白之后）的字换成 `edit(去掉首部空白的字)`。 */
const editShotHead = (group: MockGroup, index: number, edit: (text: string) => string) => ({
  ...group,
  shots: group.shots.map((shot, at) => {
    if (at !== index) return shot
    const [head = '', ...rest] = shot.parts
    const lead = head.length - head.trimStart().length
    return { ...shot, parts: [head.slice(0, lead) + edit(head.slice(lead)), ...rest] }
  }),
})

/** 让机位图 `node` 在这组的参考图列表里（`listed`）或不在，同后端 `_place_view`：插进列表时排在镜头更靠后的机位图之前，
 * 那一镜开头写「参考@ImageN，」，不小于 N 的图号加一；移出时删掉这两处，比 N 大的图号减一。不是这组的机位图或本来就是
 * 这样时原样返回。 */
const placeView = (group: MockGroup, node: string, listed: boolean): MockGroup => {
  const shot = group.shots.findIndex((item) => item.view === node)
  const view = group.views.find((item) => item.node === node)
  if (shot < 0 || view === undefined) return group
  const present = group.images.findIndex((item) => item.node === node)
  if (listed === present >= 0) return group
  if (listed) {
    const later = group.images.findIndex((item) => {
      const owner = group.shots.findIndex((candidate) => candidate.view === item.node)
      return owner > shot
    })
    const at = later < 0 ? group.images.length : later
    const number = at + 1
    const shifted = renumbered(group, (k) => (k >= number ? k + 1 : k))
    return editShotHead(
      { ...shifted, images: shifted.images.toSpliced(at, 0, view) },
      shot,
      (text) => cite(number) + text,
    )
  }
  const number = present + 1
  const stripped = editShotHead(group, shot, (text) =>
    text.startsWith(cite(number)) ? text.slice(cite(number).length) : text,
  )
  const shifted = renumbered(stripped, (k) => (k > number ? k - 1 : k))
  return { ...shifted, images: shifted.images.toSpliced(present, 1) }
}

/** 按选用把各组的机位图放进或移出列表。 */
const placeViews = (groups: readonly MockGroup[], picks: ReadonlyMap<string, string | null>) =>
  groups.map((group) =>
    group.views.reduce(
      (placed, view) => placeView(placed, view.node, (picks.get(view.node) ?? null) !== null),
      group,
    ),
  )

/** 给一段对话放一份能用的工程：工作区里有 `film.icml` 与 `film.icrun`，制作页读得出一组。默认场景图与镜头 1 的
 * 机位图没选用、出不了片；`complete` 时全都选用了。工程按选用经 `placeView` 摆好，与后端选用时写回的一样。 */
export const seedMockFilm = (
  conversationId: string,
  options: { problems?: number; model?: string | undefined; complete?: boolean } = {},
) => {
  const filmVersion = putMockWorkspaceFile(conversationId, FILM_PATH, FILM_SOURCE)
  const runVersion = putMockWorkspaceFile(conversationId, RUN_PATH, RUN_SOURCE)
  const problems = options.problems ?? 0
  const picks = new Map<string, string | null>([
    ...SEEDED_CHOICES,
    ...(options.complete === true ? COMPLETE_CHOICES : []),
  ])
  chosen.set(conversationId, picks)
  const group = { ...mockGroup(), ...(options.model === undefined ? {} : { model: options.model }) }
  films.set(conversationId, {
    filmVersion,
    groups: problems > 0 ? [] : placeViews([group], picks),
    problems,
    runVersion,
  })
}

/** 模拟 AI 导演改了文件：第 `shot` 镜换成 `text`，工程文件版本加一。 */
export const editMockFilmShot = (conversationId: string, shot: number, text: string) => {
  const film = films.get(conversationId)
  if (film === undefined) return
  films.set(conversationId, {
    ...film,
    filmVersion: putMockWorkspaceFile(conversationId, FILM_PATH, FILM_SOURCE),
    groups: film.groups.map((group) => ({
      ...group,
      shots: group.shots.map((item, index) =>
        index === shot - 1 ? { ...item, lines: [], parts: [text] } : item,
      ),
    })),
  })
}

export const resetMockFilm = () => {
  films.clear()
  chosen.clear()
  generatedCount = 0
}

/** 一张生成图的描述照后端拆：每个 `@ImageN` 都是图片段，带 N 与现在的地址（没图为 null）；没图的称呼按列表先后记进
 * `missing`。 */
const resolvedPrompt = (
  image: MockImage,
  labelOf: (node: string) => string,
  urlOf: (node: string) => string | null,
): Pick<FilmFrameOut, 'missing' | 'prompt'> => {
  if (image.description === null) return { missing: [], prompt: null }
  const missing = image.references.flatMap((node) => (urlOf(node) === null ? [labelOf(node)] : []))
  const prompt: NonNullable<FilmFrameOut['prompt']> = []
  let cursor = 0
  for (const match of image.description.matchAll(IMAGE_NUMBER)) {
    const text = image.description.slice(cursor, match.index)
    if (text !== '') prompt.push({ kind: 'text', text })
    cursor = match.index + match[0].length
    const number = Number(match[1])
    const node = image.references[number - 1] ?? ''
    prompt.push({ kind: 'image', label: labelOf(node), node, number, url: urlOf(node) })
  }
  const rest = image.description.slice(cursor)
  if (rest !== '') prompt.push({ kind: 'text', text: rest })
  return { missing, prompt }
}

const seconds = (value: number) => String(value)

/** 照后端（shot_prompt.py）拼一组出片的正文：全局设定按段名一段一段写（段名、换行、同名的几段一行一段，段与段之间
 * 空一行），再空一行写「镜头：」，每镜一行起止秒与正文（台词写成 `{台词}`），末尾约束。 */
const videoPrompt = (group: MockGroup): string => {
  const sections: { label: string; texts: string[] }[] = []
  for (const setting of group.settings) {
    const label = setting.label ?? ''
    const last = sections.at(-1)
    if (last?.label === label) last.texts.push(setting.text)
    else sections.push({ label, texts: [setting.text] })
  }
  const shots = group.shots.map((shot) => {
    const text = shot.parts.reduce((joined, part, index) => {
      const line = shot.lines[index - 1]
      return joined + (line === undefined ? '' : `{${line.text}}`) + part
    }, '')
    return `${seconds(shot.start)}–${seconds(shot.end)}秒 ${text}`
  })
  return [
    sections.map((section) => `${section.label}：\n${section.texts.join('\n')}`).join('\n\n'),
    '',
    '镜头：',
    ...shots,
    '不要生成字幕，不要生成背景音乐。',
  ].join('\n')
}

const allImages = (film: MockFilm) =>
  film.groups.flatMap((group) => [...group.images, ...group.views])

/** 这段对话现在每张图的地址：用户给的图用文件里的地址，生成图只认选用。 */
const urlsOf = (conversationId: string, film: MockFilm) => {
  const picks = chosen.get(conversationId) ?? new Map<string, string | null>()
  const images = allImages(film)
  return (node: string): string | null => {
    if (picks.has(node)) return picks.get(node) ?? null
    return images.find((item) => item.node === node)?.photo ?? null
  }
}

/** 读的那一刻的制作页：参考图按列表先后编号，后面接没进列表的机位图；地址、描述的拆分与这组的正文现算。 */
const resolved = (conversationId: string, film: MockFilm): FilmViewOut => {
  const urlOf = urlsOf(conversationId, film)
  const images = allImages(film)
  const labelOf = (node: string) => images.find((item) => item.node === node)?.label ?? node
  const frameOf = (image: MockImage, number: number | null): FilmFrameOut => ({
    aspectRatio: image.aspectRatio,
    kind: image.kind,
    label: image.label,
    node: image.node,
    number,
    url: urlOf(image.node),
    ...resolvedPrompt(image, labelOf, urlOf),
  })
  return {
    ...film,
    groups: film.groups.map(({ images: listed, views, ...group }) => ({
      ...group,
      frames: [
        ...listed.map((image, index) => frameOf(image, index + 1)),
        ...group.shots.flatMap((shot) => {
          const view = views.find((item) => item.node === shot.view)
          return view === undefined || listed.some((item) => item.node === view.node)
            ? []
            : [frameOf(view, null)]
        }),
      ],
      prompt: videoPrompt({ images: listed, views, ...group }),
    })),
  }
}

const versionsMatch = (film: MockFilm, body: { filmVersion: number; runVersion: number | null }) =>
  body.filmVersion === film.filmVersion && body.runVersion === film.runVersion

const imageOf = (film: MockFilm, node: string) =>
  allImages(film).find((image) => image.node === node)

const rejected = (detail: string) => HttpResponse.json({ detail }, { status: 422 })

/** 后端保存检查的一条：一组的字里写的 `@ImageN` 正好是 1 到列表长度。 */
const numbersMatch = (group: MockGroup): boolean => {
  const texts = [
    ...group.settings.map((setting) => setting.text),
    ...group.shots.flatMap((shot) => shot.parts),
  ].join('\n')
  const used = new Set([...texts.matchAll(IMAGE_NUMBER)].map((match) => Number(match[1])))
  return used.size === group.images.length && group.images.every((_, index) => used.has(index + 1))
}

/** 改过的字里一处图号指的图：数字是这组参考图列表里现有的第几张（从 0 起），字符串是新插入的图的地址。 */
type MockKey = number | string
type MockRun = string | { key: MockKey }

const VIEW_LOCKED = '机位图的引用随选用增删；请在镜头上取消选用'

/** 照后端拆一段改过的字：列表现有 `count` 张，`@Image1`…`@Image{count}` 是现有的图，再往后依次是 `keys`（新插入的图）。
 * 这组没有的编号返回给人看的一句话。 */
const parseRuns = (
  text: string,
  count: number,
  keys: readonly MockKey[],
  temps: Set<number>,
): MockRun[] | string => {
  const runs: MockRun[] = []
  let cursor = 0
  for (const match of text.matchAll(IMAGE_NUMBER)) {
    if (match.index > cursor) runs.push(text.slice(cursor, match.index))
    cursor = match.index + match[0].length
    const number = Number(match[1])
    const temp = keys[number - count - 1]
    if (number >= 1 && number <= count) runs.push({ key: number - 1 })
    else if (number > count && temp !== undefined) {
      runs.push({ key: temp })
      temps.add(number)
    } else return `字里的 @Image${String(number)} 没有对应的图，刷新后再改`
  }
  if (cursor < text.length) runs.push(text.slice(cursor))
  return runs
}

/** 页面插入的新照片：「素材」里已有同一地址的就用它，没有就叫「素材照片N」（N 取第一个没被占用的）。 */
const photoFor = (film: MockFilm, url: string): MockImage => {
  const images = allImages(film)
  const same = images.find((image) => image.kind === 'photo' && image.photo === url)
  if (same !== undefined) return same
  let number = 1
  while (images.some((image) => image.node === `素材照片${String(number)}`)) number += 1
  const name = `素材照片${String(number)}`
  return photo(name, name, url)
}

/** 照后端 `_renumber_group` 改一组的字：新插入的图不在列表里时排在元素图之后、机位图之前，字里一处都不再用的元素图从
 * 列表删掉，再按新旧编号对照改这组全部的字；机位图开头的引用删掉、挪动或多写一处都不写。拍法与声音在后端是几组共用的字，
 * 不能写图号。 */
const renumberGroup = (
  film: MockFilm,
  group: MockGroup,
  edits: readonly FilmTextEditsIn['edits'][number][],
  urlOf: (node: string) => string | null,
): MockGroup | string => {
  const count = group.images.length
  const runsOf = new Map<string, MockRun[][]>()
  const heads = new Map<string, string>()
  for (const edit of edits) {
    const setting = group.settings.find((item) => item.target === edit.target)
    const texts = setting === undefined ? (edit.parts ?? []) : [edit.text ?? '']
    const images = edit.images ?? []
    if (
      (setting?.kind === 'shooting' || setting?.kind === 'voice') &&
      (images.length > 0 || texts.join('').match(IMAGE_NUMBER) !== null)
    )
      return '这段文字用在几个地方，无法插入图片；带图号的文字只能用在一个节点里'
    const keys = images.map((url) => {
      const same = group.images.findIndex((image) => urlOf(image.node) === url)
      return same < 0 ? url : same
    })
    const temps = new Set<number>()
    const parsed = texts.map((text) => parseRuns(text, count, keys, temps))
    const failed = parsed.find((item) => typeof item === 'string')
    if (failed !== undefined) return failed
    if (temps.size !== keys.length) return '插入的图和字对不上，刷新后再改'
    runsOf.set(
      edit.target,
      parsed.filter((item) => typeof item !== 'string'),
    )
    heads.set(edit.target, texts.join('').trimStart())
  }
  const originalKeys = (text: string) =>
    [...text.matchAll(IMAGE_NUMBER)].map((match) => Number(match[1]) - 1)
  const keysOf = (target: string | null, texts: readonly string[]): MockKey[] => {
    const runs = target === null ? undefined : runsOf.get(target)
    return runs === undefined
      ? texts.flatMap(originalKeys)
      : runs.flat().flatMap((run) => (typeof run === 'string' ? [] : [run.key]))
  }
  const used = new Map<MockKey, number>()
  for (const key of [
    ...group.settings.flatMap((setting) => keysOf(setting.target, [setting.text])),
    ...group.shots.flatMap((shot) => keysOf(shot.target, shot.parts)),
  ])
    used.set(key, (used.get(key) ?? 0) + 1)
  const views = new Map<number, number>()
  group.images.forEach((image, index) => {
    const shot = group.shots.findIndex((item) => item.view === image.node)
    if (shot >= 0) views.set(index, shot)
  })
  for (const [index, shot] of views) {
    const target = group.shots[shot]?.target ?? null
    const head = target === null ? undefined : heads.get(target)
    if ((head !== undefined && !head.startsWith(cite(index + 1))) || used.get(index) !== 1)
      return VIEW_LOCKED
  }
  const added = [...new Set([...used.keys()].filter((key) => typeof key === 'string'))]
  const firstView = Math.min(count, ...views.keys())
  const kept = group.images.flatMap((_, index) =>
    views.has(index) || used.has(index) ? [index] : [],
  )
  const order: MockKey[] = [
    ...kept.filter((index) => index < firstView),
    ...added,
    ...kept.filter((index) => index >= firstView),
  ]
  const final = new Map(order.map((key, position) => [key, position + 1]))
  const numbered = (key: MockKey) => `@Image${String(final.get(key) ?? 0)}`
  const render = (runs: readonly MockRun[]) =>
    runs.map((run) => (typeof run === 'string' ? run : numbered(run.key))).join('')
  const renumber = (text: string) =>
    text.replace(IMAGE_NUMBER, (_, digits: string) => numbered(Number(digits) - 1))
  return {
    ...group,
    images: order.map((key) =>
      typeof key === 'string' ? photoFor(film, key) : (group.images[key] as MockImage),
    ),
    settings: group.settings.map((setting) => {
      const runs = setting.target === null ? undefined : runsOf.get(setting.target)
      return {
        ...setting,
        text: runs === undefined ? renumber(setting.text) : render(runs[0] ?? []),
      }
    }),
    shots: group.shots.map((shot) => {
      const runs = shot.target === null ? undefined : runsOf.get(shot.target)
      return {
        ...shot,
        parts: runs === undefined ? shot.parts.map(renumber) : runs.map(render),
      }
    }),
  }
}

/** 按后端的规矩把几段字改进去；不合规矩返回给人看的一句话。 */
const applyEdits = (
  film: MockFilm,
  body: FilmTextEditsIn,
  urlOf: (node: string) => string | null,
): MockGroup[] | string => {
  for (const edit of body.edits) {
    const shot = film.groups
      .flatMap((group) => group.shots)
      .find((item) => item.target === edit.target)
    const setting = film.groups
      .flatMap((group) => group.settings)
      .find((item) => item.target === edit.target)
    if (shot !== undefined) {
      const lines = edit.lines ?? []
      const parts = edit.parts ?? []
      if (parts.length !== lines.length + 1) return '镜头的文字和台词对不上，刷新后再改'
      if (lines.map((line) => line.target).join() !== shot.lines.map((line) => line.target).join())
        return '台词只能改字，不能删、不能加，也不能调先后；要动台词跟 AI 导演说'
      if (lines.some((line) => line.text.trim() === '')) return '台词不能是空的'
      if (parts.join('').trim() === '') return '镜头的文字不能是空的'
    } else if (setting !== undefined) {
      if ((edit.text ?? '').trim() === '') return '这段字不能是空的'
    } else {
      return '要改的这段字找不到了，刷新后再改'
    }
  }
  const groups: MockGroup[] = []
  for (const group of film.groups) {
    const mine = body.edits.filter(
      (edit) =>
        group.shots.some((shot) => shot.target === edit.target) ||
        group.settings.some((setting) => setting.target === edit.target),
    )
    const lined = {
      ...group,
      shots: group.shots.map((shot) => {
        const edit = mine.find((item) => item.target === shot.target)
        return edit === undefined
          ? shot
          : {
              ...shot,
              lines: shot.lines.map((line, index) => ({
                ...line,
                text: edit.lines?.[index]?.text ?? '',
              })),
            }
      }),
    }
    const renumbered = renumberGroup(film, lined, mine, urlOf)
    if (typeof renumbered === 'string') return renumbered
    groups.push(renumbered)
  }
  if (!groups.every(numbersMatch)) return '这样改以后分镜有问题，没有保存；可以跟 AI 导演说想怎么改'
  return groups
}

const missingText = (labels: readonly string[]) =>
  `以下参考图尚未选用：${labels.join('、')}；无法生成`

export const filmHandlers = [
  http.get('*/api/conversations/:conversationId/film', ({ params }) => {
    const conversationId = String(params['conversationId'])
    const film = films.get(conversationId)
    if (film === undefined) return HttpResponse.json({ detail: '没有工程文件' }, { status: 404 })
    return HttpResponse.json({ film: resolved(conversationId, film) })
  }),

  http.patch('*/api/conversations/:conversationId/film/text', async ({ params, request }) => {
    const conversationId = String(params['conversationId'])
    const film = films.get(conversationId)
    if (film === undefined) return HttpResponse.json({ detail: '没有工程文件' }, { status: 404 })
    const body = (await request.json()) as FilmTextEditsIn
    if (body.filmVersion !== film.filmVersion)
      return HttpResponse.json({ detail: '分镜刚被改过，刷新后再改' }, { status: 409 })
    if (film.problems > 0) return rejected('分镜有问题，等 AI 导演改好再改')
    const groups = applyEdits(film, body, urlsOf(conversationId, film))
    if (typeof groups === 'string') return rejected(groups)
    const next = {
      ...film,
      filmVersion: putMockWorkspaceFile(conversationId, FILM_PATH, FILM_SOURCE),
      groups,
    }
    films.set(conversationId, next)
    return HttpResponse.json({ film: resolved(conversationId, next) })
  }),

  // 生成图登记进运行文件并选用，运行文件版本加一；机位图第一次选用、取消选用时工程文件跟着改，版本也加一。
  // 用户给的图改工程文件里的地址，工程文件版本加一。
  http.put('*/api/conversations/:conversationId/film/image', async ({ params, request }) => {
    const conversationId = String(params['conversationId'])
    const film = films.get(conversationId)
    if (film === undefined) return HttpResponse.json({ detail: '没有工程文件' }, { status: 404 })
    const body = (await request.json()) as FilmImageChoiceIn
    if (!versionsMatch(film, body))
      return HttpResponse.json({ detail: '分镜刚被改过，刷新后再换' }, { status: 409 })
    const image = imageOf(film, body.node)
    if (image === undefined) return rejected('要换的这张图找不到了，刷新后再换')
    const picks = chosen.get(conversationId) ?? new Map<string, string | null>()
    chosen.set(conversationId, picks)
    // 生成图取消选用就是没图，不回到生成过的哪一张。
    if (body.url === null && image.kind === 'photo')
      return rejected('这张图是你给的，只能换成另一张，不能清空')
    picks.set(body.node, body.url)
    if (image.kind === 'photo') {
      const next = {
        ...film,
        filmVersion: putMockWorkspaceFile(conversationId, FILM_PATH, FILM_SOURCE),
      }
      films.set(conversationId, next)
      return HttpResponse.json({ film: resolved(conversationId, next) })
    }
    const groups = film.groups.map((group) => placeView(group, body.node, body.url !== null))
    const placed = groups.some((group, index) => group !== film.groups[index])
    const next = {
      ...film,
      filmVersion: placed
        ? putMockWorkspaceFile(conversationId, FILM_PATH, FILM_SOURCE)
        : film.filmVersion,
      groups,
      runVersion: putMockWorkspaceFile(conversationId, RUN_PATH, RUN_SOURCE),
    }
    films.set(conversationId, next)
    return HttpResponse.json({ film: resolved(conversationId, next) })
  }),

  http.post(
    '*/api/conversations/:conversationId/film/image-generations',
    async ({ params, request }) => {
      const conversationId = String(params['conversationId'])
      const film = films.get(conversationId)
      if (film === undefined) return HttpResponse.json({ detail: '没有工程文件' }, { status: 404 })
      const body = (await request.json()) as FilmImageGenerationIn
      if (!versionsMatch(film, body))
        return HttpResponse.json({ detail: '分镜刚被改过，刷新后再生成' }, { status: 409 })
      const image = imageOf(film, body.node)
      if (image?.kind !== 'generated' || image.description === null)
        return rejected('用户给的图不能按描述生成')
      const urlOf = urlsOf(conversationId, film)
      const missing = image.references.filter((node) => urlOf(node) === null)
      if (missing.length > 0)
        return rejected(missingText(missing.map((node) => imageOf(film, node)?.label ?? node)))
      // 每次出的地址都不一样：同一个地址会被当成这张图在用的那版，进不了版本条。
      generatedCount += 1
      const created = acceptMockImage({
        conversationId,
        metadata: { film_node: body.node },
        outputUrl: `${backpackImage}?generated=${String(generatedCount)}`,
        prompt: body.prompt?.text ?? image.description,
      })
      return HttpResponse.json({ jobId: created.id }, { status: 202 })
    },
  ),

  http.post(
    '*/api/conversations/:conversationId/film/video-generations',
    async ({ params, request }) => {
      const conversationId = String(params['conversationId'])
      const film = films.get(conversationId)
      if (film === undefined) return HttpResponse.json({ detail: '没有工程文件' }, { status: 404 })
      const body = (await request.json()) as FilmVideoGenerationIn
      if (body.filmVersion !== film.filmVersion || body.runVersion !== film.runVersion)
        return HttpResponse.json({ detail: '分镜刚被改过，刷新后再出片' }, { status: 409 })
      const group = film.groups.find((item) => item.video === body.video)
      if (group === undefined) return rejected('这一组已经不在分镜里了')
      const urlOf = urlsOf(conversationId, film)
      const missing = group.images.filter((image) => urlOf(image.node) === null)
      if (missing.length > 0) return rejected(missingText(missing.map((image) => image.label)))
      const prompt = videoPrompt(group)
      const created = acceptMockVideo({
        conversationId,
        metadata: { film_node: group.video },
        prompt,
        request: {
          aspect_ratio: group.aspectRatio,
          generate_audio: body.generateAudio,
          model: body.model,
          prompt,
          resolution: body.resolution,
          seconds: group.seconds,
          shot_index: group.index,
        },
        shotIndex: group.index,
      })
      return HttpResponse.json({ jobId: created.id }, { status: 202 })
    },
  ),
]
