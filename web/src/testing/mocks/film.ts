/** 制作页的 mock：每段对话一份读好的工程（形状同 `GET /conversations/{id}/film`），改字照后端的规矩查，
 * 改完把工作区里 `film.icml` 的版本加一，文件列表与制作页的版本对得上；出片记一条视频记录，镜号是组号。
 *
 * 照后端现行的写法：`frames` 是这组视频的参考图列表，按列表先后，`number` 就是位置，没有图的也有；全局设定与镜头
 * 正文里用 `@ImageN` 指列表第 N 张，选用了机位图的镜头开头写「参考@ImageN，」；`settings[].images` 恒为空。
 * 图照后端的规矩定：用户给的图总有图；生成图只认选用，没选用就没图，生成出来的不自动用上。生图描述按它自己的参考图列表
 * 写 `@ImageN`，读的时候有图的拆成图片段，没图的留在文字里、称呼记进 `missing`。列表里有没图的，生图、出片都拒。
 * 选用、取消选用只改地址，列表与编号不动（后端在机位图第一次选用、取消选用时才改列表，这里不模拟）。 */

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

/** 工程文件里的一组视频：参考图列表照文件写；地址、编号、描述的拆分与正文读的时候现算（见 `resolved`）。 */
type MockGroup = Omit<FilmGroupOut, 'frames' | 'prompt'> & { images: readonly MockImage[] }

type MockFilm = Omit<FilmViewOut, 'groups'> & { groups: MockGroup[] }

const films = new Map<string, MockFilm>()
/** 每段对话里每张图现在的地址：生成图是运行文件里的选用（null 是没选用），用户给的图是工程文件里的地址。 */
const chosen = new Map<string, Map<string, string | null>>()
/** 放工程时就选用了的生成图。 */
const SEEDED_CHOICES: ReadonlyMap<string, string> = new Map([
  ['girl_look', apparelImage],
  ['shot1_view', backpackImage],
])
/** `complete` 时另外选用的：列表里每张都有图，能出片。 */
const COMPLETE_CHOICES: ReadonlyMap<string, string> = new Map([
  ['park_look', `${backpackImage}?view=park`],
  ['shot2_view', `${apparelImage}?view=shot2`],
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

/** 一组 12 秒的穿搭短片：参考图列表依次是人物一张生成图、产品两张用户给的、场景一张还没选用的生成图、镜头 1 与镜头 2
 * 的机位图（镜头 2 的列在表里、还没选用）；四个镜头，两句台词。同一个元素的几张图都叫元素的名字，与后端相同。 */
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
    generated('shot1_view', '镜头 1', '9:16', '@Image1的人物，站在坡面上，双手把长板横扛在肩后。', [
      'girl_look',
    ]),
    generated(
      'shot2_view',
      '镜头 2',
      '9:16',
      '高角度俯拍脚部特写，她坐在坡面边缘，小腿悬空，场地参考@Image1。',
      ['park_look'],
    ),
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
      parts: [
        '参考@Image5，低机位仰拍全景，镜头缓慢后拉。女生站在坡面上，双手把一块长板横扛在肩后。',
      ],
      start: 0,
      target: 'shot:board:1',
      view: 'shot1_view',
    },
    {
      end: 6,
      lines: [{ role: '旁白', target: 'line:soft', text: '软得像拖鞋，稳得像板鞋。' }],
      parts: ['参考@Image6，高角度俯拍脚部特写，镜头缓慢右移。她坐在坡面边缘，小腿悬空。\n', ''],
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
})

/** 给一段对话放一份能用的工程：工作区里有 `film.icml` 与 `film.icrun`，制作页读得出一组。默认场景图与镜头 2 的
 * 机位图没选用、出不了片；`complete` 时全都选用了。 */
export const seedMockFilm = (
  conversationId: string,
  options: { problems?: number; model?: string | undefined; complete?: boolean } = {},
) => {
  const filmVersion = putMockWorkspaceFile(conversationId, FILM_PATH, FILM_SOURCE)
  const runVersion = putMockWorkspaceFile(conversationId, RUN_PATH, RUN_SOURCE)
  const problems = options.problems ?? 0
  chosen.set(
    conversationId,
    new Map([...SEEDED_CHOICES, ...(options.complete === true ? COMPLETE_CHOICES : [])]),
  )
  films.set(conversationId, {
    filmVersion,
    groups:
      problems > 0
        ? []
        : [{ ...mockGroup(), ...(options.model === undefined ? {} : { model: options.model }) }],
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

const IMAGE_NUMBER = /@Image(\d+)/g

/** 一张生成图的描述照后端拆：有图的参考图是图片段，没图的 `@ImageN` 留在文字里，称呼按列表先后记进 `missing`。 */
const resolvedPrompt = (
  image: MockImage,
  labelOf: (node: string) => string,
  urlOf: (node: string) => string | null,
): Pick<FilmFrameOut, 'missing' | 'prompt'> => {
  if (image.description === null) return { missing: [], prompt: null }
  const missing = image.references.flatMap((node) => (urlOf(node) === null ? [labelOf(node)] : []))
  const prompt: NonNullable<FilmFrameOut['prompt']> = []
  const pushText = (text: string) => {
    if (text === '') return
    const before = prompt.at(-1)
    if (before?.kind === 'text')
      prompt[prompt.length - 1] = { kind: 'text', text: before.text + text }
    else prompt.push({ kind: 'text', text })
  }
  let cursor = 0
  for (const match of image.description.matchAll(IMAGE_NUMBER)) {
    pushText(image.description.slice(cursor, match.index))
    cursor = match.index + match[0].length
    const node = image.references[Number(match[1]) - 1]
    const url = node === undefined ? null : urlOf(node)
    if (node === undefined || url === null) pushText(match[0])
    else prompt.push({ kind: 'image', label: labelOf(node), node, url })
  }
  pushText(image.description.slice(cursor))
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

/** 这段对话现在每张图的地址：用户给的图用文件里的地址，生成图只认选用。 */
const urlsOf = (conversationId: string, film: MockFilm) => {
  const picks = chosen.get(conversationId) ?? new Map<string, string | null>()
  const images = film.groups.flatMap((group) => group.images)
  return (node: string): string | null => {
    if (picks.has(node)) return picks.get(node) ?? null
    return images.find((item) => item.node === node)?.photo ?? null
  }
}

/** 读的那一刻的制作页：参考图按列表先后编号，地址、描述的拆分与这组的正文现算。 */
const resolved = (conversationId: string, film: MockFilm): FilmViewOut => {
  const urlOf = urlsOf(conversationId, film)
  const images = film.groups.flatMap((group) => group.images)
  const labelOf = (node: string) => images.find((item) => item.node === node)?.label ?? node
  return {
    ...film,
    groups: film.groups.map(({ images: listed, ...group }) => ({
      ...group,
      frames: listed.map((image, index) => ({
        aspectRatio: image.aspectRatio,
        kind: image.kind,
        label: image.label,
        node: image.node,
        number: index + 1,
        url: urlOf(image.node),
        ...resolvedPrompt(image, labelOf, urlOf),
      })),
      prompt: videoPrompt({ images: listed, ...group }),
    })),
  }
}

const versionsMatch = (film: MockFilm, body: { filmVersion: number; runVersion: number | null }) =>
  body.filmVersion === film.filmVersion && body.runVersion === film.runVersion

const imageOf = (film: MockFilm, node: string) =>
  film.groups.flatMap((group) => group.images).find((image) => image.node === node)

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

/** 按后端的规矩把几段字改进去；不合规矩返回给人看的一句话。 */
const applyEdits = (film: MockFilm, body: FilmTextEditsIn): MockGroup[] | string => {
  let groups = film.groups
  for (const edit of body.edits) {
    const shot = groups.flatMap((group) => group.shots).find((item) => item.target === edit.target)
    const setting = groups
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
      groups = groups.map((group) => ({
        ...group,
        shots: group.shots.map((item) =>
          item.target !== edit.target
            ? item
            : {
                ...item,
                lines: item.lines.map((line, index) => ({
                  ...line,
                  text: lines[index]?.text ?? '',
                })),
                parts,
              },
        ),
      }))
    } else if (setting !== undefined) {
      if ((edit.text ?? '').trim() === '') return '这段字不能是空的'
      groups = groups.map((group) => ({
        ...group,
        settings: group.settings.map((item) =>
          item.target === edit.target ? { ...item, text: edit.text ?? '' } : item,
        ),
      }))
    } else {
      return '要改的这段字找不到了，刷新后再改'
    }
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
    const groups = applyEdits(film, body)
    if (typeof groups === 'string') return rejected(groups)
    const next = {
      ...film,
      filmVersion: putMockWorkspaceFile(conversationId, FILM_PATH, FILM_SOURCE),
      groups,
    }
    films.set(conversationId, next)
    return HttpResponse.json({ film: resolved(conversationId, next) })
  }),

  // 生成图登记进运行文件并选用，运行文件版本加一；用户给的图改工程文件里的地址，工程文件版本加一。
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
    const next =
      image.kind === 'photo'
        ? { ...film, filmVersion: putMockWorkspaceFile(conversationId, FILM_PATH, FILM_SOURCE) }
        : { ...film, runVersion: putMockWorkspaceFile(conversationId, RUN_PATH, RUN_SOURCE) }
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
