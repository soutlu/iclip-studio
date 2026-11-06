import { http, HttpResponse } from 'msw'
import type {
  FilmAspectRatioIn,
  FilmFrameOut,
  FilmGroupOut,
  FilmImageChoiceIn,
  FilmImageGenerationIn,
  FilmTextEditsIn,
  FilmVideoGenerationIn,
  FilmViewOut,
} from '@/shared/api/generated/types.gen'
import { ASPECT_RATIOS } from '@/shared/lib/aspect-ratio'
import apparelImage from './assets/apparel.webp'
import backpackImage from './assets/backpack.webp'
import loafersImage from './assets/loafers.webp'
import { acceptMockImage, acceptMockVideo, putMockWorkspaceFile } from './workspace'

const FILM_PATH = 'film.icml'
const RUN_PATH = 'film.icrun'

type MockImage = Pick<FilmFrameOut, 'aspectRatio' | 'kind' | 'label' | 'node'> & {
  photo: string | null
  description: string | null
  references: readonly string[]
}

type MockGroup = Omit<FilmGroupOut, 'frames' | 'prompt'> & {
  images: readonly MockImage[]
  views: readonly MockImage[]
}

type MockFilm = Omit<FilmViewOut, 'groups'> & { groups: MockGroup[] }

const films = new Map<string, MockFilm>()
const chosen = new Map<string, Map<string, string | null>>()
const SEEDED_CHOICES: ReadonlyMap<string, string> = new Map([
  ['girl_look', apparelImage],
  ['shot2_view', backpackImage],
])
const COMPLETE_CHOICES: ReadonlyMap<string, string> = new Map([
  ['park_look', `${backpackImage}?view=park`],
  ['shot1_view', `${apparelImage}?view=shot1`],
])
let generatedCount = 0

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
      shared: true,
      target: 'value:拍摄与剪辑',
      text: '摄影：手持拍摄，带轻微呼吸感，以低机位仰拍和脚部特写为主。\n剪辑：全片硬切，快节奏。',
    },
    {
      images: [],
      kind: 'element',
      label: '人物',
      shared: false,
      target: 'value:金发女生',
      text: '金发女生，二十岁上下的白人女生，脸型偏长，金色齐耳波波头，长相参考@Image1。',
    },
    {
      images: [],
      kind: 'element',
      label: '产品',
      shared: false,
      target: 'value:绒面一脚蹬',
      text: '绒面一脚蹬，浅米色反绒皮的低帮鞋，鞋面参考@Image2，鞋底参考@Image3。',
    },
    {
      images: [],
      kind: 'element',
      label: '场景',
      shared: false,
      target: 'value:涂鸦滑板场',
      text: '户外露天水泥滑板场参考@Image4，坡面和地面喷满街头涂鸦。',
    },
    {
      images: [],
      kind: 'voice',
      label: '声音',
      shared: true,
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

const renumbered = (group: MockGroup, shift: (number: number) => number): MockGroup => {
  const apply = (text: string) =>
    text.replace(IMAGE_NUMBER, (_, digits: string) => `@Image${String(shift(Number(digits)))}`)
  return {
    ...group,
    settings: group.settings.map((setting) => ({ ...setting, text: apply(setting.text) })),
    shots: group.shots.map((shot) => ({ ...shot, parts: shot.parts.map(apply) })),
  }
}

const editShotHead = (group: MockGroup, index: number, edit: (text: string) => string) => ({
  ...group,
  shots: group.shots.map((shot, at) => {
    if (at !== index) return shot
    const [head = '', ...rest] = shot.parts
    const lead = head.length - head.trimStart().length
    return { ...shot, parts: [head.slice(0, lead) + edit(head.slice(lead)), ...rest] }
  }),
})

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

const placeViews = (groups: readonly MockGroup[], picks: ReadonlyMap<string, string | null>) =>
  groups.map((group) =>
    group.views.reduce(
      (placed, view) => placeView(placed, view.node, (picks.get(view.node) ?? null) !== null),
      group,
    ),
  )

const SHARED_BODY: FilmGroupOut['settings'][number] = {
  images: [],
  kind: 'element',
  label: '人物',
  shared: true,
  target: 'value:金发女生身材',
  text: '身材高挑匀称，肩宽适中。',
}

export const seedMockFilm = (
  conversationId: string,
  options: {
    problems?: number
    model?: string | undefined
    complete?: boolean
    sharedBody?: boolean
    musicDescription?: string
  } = {},
) => {
  const filmVersion = putMockWorkspaceFile(conversationId, FILM_PATH, FILM_SOURCE)
  const runVersion = putMockWorkspaceFile(conversationId, RUN_PATH, RUN_SOURCE)
  const problems = options.problems ?? 0
  const picks = new Map<string, string | null>([
    ...SEEDED_CHOICES,
    ...(options.complete === true ? COMPLETE_CHOICES : []),
  ])
  chosen.set(conversationId, picks)
  const seeded = mockGroup()
  const group = {
    ...seeded,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.sharedBody === true
      ? { settings: seeded.settings.toSpliced(2, 0, SHARED_BODY) }
      : {}),
  }
  films.set(conversationId, {
    filmVersion,
    groups: problems > 0 ? [] : placeViews([group], picks),
    musicDescription: options.musicDescription ?? null,
    problems,
    runVersion,
  })
}

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

const urlsOf = (conversationId: string, film: MockFilm) => {
  const picks = chosen.get(conversationId) ?? new Map<string, string | null>()
  const images = allImages(film)
  return (node: string): string | null => {
    if (picks.has(node)) return picks.get(node) ?? null
    return images.find((item) => item.node === node)?.photo ?? null
  }
}

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

const numbersMatch = (group: MockGroup): boolean => {
  const texts = [
    ...group.settings.map((setting) => setting.text),
    ...group.shots.flatMap((shot) => shot.parts),
  ].join('\n')
  const used = new Set([...texts.matchAll(IMAGE_NUMBER)].map((match) => Number(match[1])))
  return used.size === group.images.length && group.images.every((_, index) => used.has(index + 1))
}

type MockKey = number | string
type MockRun = string | { key: MockKey }

const VIEW_LOCKED = '机位图的引用随选用增删；请在镜头上取消选用'

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

const photoFor = (film: MockFilm, url: string): MockImage => {
  const images = allImages(film)
  const same = images.find((image) => image.kind === 'photo' && image.photo === url)
  if (same !== undefined) return same
  let number = 1
  while (images.some((image) => image.node === `素材照片${String(number)}`)) number += 1
  const name = `素材照片${String(number)}`
  return photo(name, name, url)
}

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
      setting?.shared === true &&
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

  http.put('*/api/conversations/:conversationId/film/aspect-ratio', async ({ params, request }) => {
    const conversationId = String(params['conversationId'])
    const film = films.get(conversationId)
    if (film === undefined) return HttpResponse.json({ detail: '没有工程文件' }, { status: 404 })
    const body = (await request.json()) as FilmAspectRatioIn
    if (body.filmVersion !== film.filmVersion)
      return HttpResponse.json({ detail: '分镜刚被改过，刷新后再改' }, { status: 409 })
    if (!ASPECT_RATIOS.some((ratio) => ratio === body.aspectRatio))
      return rejected(`不支持 ${body.aspectRatio} 画幅，可选 ${ASPECT_RATIOS.join('、')}`)
    const views = new Set(film.groups.flatMap((group) => group.views.map((view) => view.node)))
    const reshaped = (image: MockImage): MockImage =>
      views.has(image.node) && image.aspectRatio !== null
        ? { ...image, aspectRatio: body.aspectRatio }
        : image
    const changed = film.groups.some(
      (group) =>
        group.aspectRatio !== body.aspectRatio ||
        group.views.some((view) => reshaped(view).aspectRatio !== view.aspectRatio),
    )
    if (!changed) return HttpResponse.json({ film: resolved(conversationId, film) })
    const next = {
      ...film,
      filmVersion: putMockWorkspaceFile(conversationId, FILM_PATH, FILM_SOURCE),
      groups: film.groups.map((group) => ({
        ...group,
        aspectRatio: body.aspectRatio,
        images: group.images.map(reshaped),
        views: group.views.map(reshaped),
      })),
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
