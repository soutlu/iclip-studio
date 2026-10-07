/** 制作页的 mock：每段对话一份读好的工程（形状同 `GET /conversations/{id}/film`），改字照后端的规矩查，
 * 改完把工作区里 `film.icml` 的版本加一，文件列表与制作页的版本对得上；出片记一条视频记录，镜号是组号。
 * 图照后端的规矩定：用户给的图总有图；生成图只认选用，没选用就没图，生成出来的不自动用上。编号按有图的现算；
 * 生图描述里没图的参考图照后端只写文字，称呼列进 `missing`。 */

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

const films = new Map<string, FilmViewOut>()
/** 每段对话里每张图现在的地址：生成图是运行文件里的选用（null 是没选用），用户给的图是工程文件里的地址。 */
const chosen = new Map<string, Map<string, string | null>>()
/** 放工程时就选用了的生成图。 */
const SEEDED_CHOICES: ReadonlyMap<string, string> = new Map([
  ['girl_look', apparelImage],
  ['shot1_view', backpackImage],
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

/** 一组 12 秒的穿搭短片：三个出场元素（人物挂一张生成的、产品挂两张用户给的、场景挂一张还没生成的）、四个镜头，两句台词。
 * 同一个元素的几张图都叫元素的名字，与后端相同。这里是工程文件写的样子：生成图的地址与编号读的时候现算（见 `resolved`），
 * 描述里的参考图按文件写全，`url` 由 `resolved` 填。 */
const mockGroup = (): FilmGroupOut => ({
  aspectRatio: '9:16',
  frames: [
    {
      aspectRatio: '3:4',
      kind: 'generated',
      label: '金发女生',
      missing: [],
      node: 'girl_look',
      number: null,
      prompt: [
        {
          kind: 'text',
          text: '画面是用手机实拍的，真实自然。二十岁上下的白人女生，金色齐耳波波头。',
        },
      ],
      url: null,
    },
    {
      aspectRatio: null,
      kind: 'photo',
      label: '绒面一脚蹬',
      missing: [],
      node: 'loafer_photo',
      number: null,
      prompt: null,
      url: loafersImage,
    },
    {
      aspectRatio: null,
      kind: 'photo',
      label: '绒面一脚蹬',
      missing: [],
      node: 'loafer_sole',
      number: null,
      prompt: null,
      url: `${loafersImage}?side=sole`,
    },
    {
      aspectRatio: '9:16',
      kind: 'generated',
      label: '涂鸦滑板场',
      missing: [],
      node: 'park_look',
      number: null,
      prompt: [{ kind: 'text', text: '户外露天水泥滑板场，坡面和地面喷满街头涂鸦。' }],
      url: null,
    },
    {
      aspectRatio: '9:16',
      kind: 'generated',
      label: '镜头 1',
      missing: [],
      node: 'shot1_view',
      number: null,
      prompt: [
        { kind: 'image', label: '金发女生', node: 'girl_look', url: '' },
        { kind: 'text', text: '的人物，站在坡面上，双手把长板横扛在肩后。' },
      ],
      url: null,
    },
    {
      aspectRatio: '9:16',
      kind: 'generated',
      label: '镜头 2',
      missing: [],
      node: 'shot2_view',
      number: null,
      prompt: [
        { kind: 'text', text: '高角度俯拍脚部特写，她坐在坡面边缘，小腿悬空，参考' },
        { kind: 'image', label: '涂鸦滑板场', node: 'park_look', url: '' },
        { kind: 'text', text: '。' },
      ],
      url: null,
    },
  ],
  index: 1,
  model: 'vendor-a-seedance-2-0',
  seconds: 12,
  settings: [
    {
      images: [],
      kind: 'shooting',
      label: null,
      target: 'value:拍摄与剪辑',
      text: '摄影：手持拍摄，带轻微呼吸感，以低机位仰拍和脚部特写为主。\n剪辑：全片硬切，快节奏。',
    },
    {
      images: ['girl_look'],
      kind: 'element',
      label: '人物 金发女生',
      target: 'value:金发女生',
      text: '二十岁上下的白人女生，脸型偏长，肤色白皙，金色齐耳波波头。',
    },
    {
      images: ['loafer_photo', 'loafer_sole'],
      kind: 'element',
      label: '产品 绒面一脚蹬',
      target: 'value:绒面一脚蹬',
      text: '低帮一脚蹬绒面鞋，鞋面是浅米色反绒皮。',
    },
    {
      images: ['park_look'],
      kind: 'element',
      label: '场景 涂鸦滑板场',
      target: 'value:涂鸦滑板场',
      text: '户外露天水泥滑板场，坡面和地面喷满街头涂鸦。',
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
})

/** 给一段对话放一份能用的工程：工作区里有 `film.icml` 与 `film.icrun`，制作页读得出一组。 */
export const seedMockFilm = (
  conversationId: string,
  options: { problems?: number; model?: string | undefined } = {},
) => {
  const filmVersion = putMockWorkspaceFile(conversationId, FILM_PATH, FILM_SOURCE)
  const runVersion = putMockWorkspaceFile(conversationId, RUN_PATH, RUN_SOURCE)
  const problems = options.problems ?? 0
  chosen.set(conversationId, new Map(SEEDED_CHOICES))
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

/** 生图描述里写在参考图前面、只在有图时才写的「，参考」。 */
const CITE = '，参考'

/** 一张生成图的描述照后端拼：有图的参考图填上地址；没图的参考图去掉，连同前面的「，参考」，称呼记进 `missing`。 */
const resolvedPrompt = (
  frame: FilmFrameOut,
  urlOf: (node: string) => string | null,
): Pick<FilmFrameOut, 'missing' | 'prompt'> => {
  if (frame.prompt === null) return { missing: [], prompt: null }
  const missing: string[] = []
  const prompt: NonNullable<FilmFrameOut['prompt']> = []
  for (const run of frame.prompt) {
    // 生成的类型里 `kind` 有默认值、是可选的，按有没有 `node` 分。
    if (!('node' in run)) {
      prompt.push(run)
      continue
    }
    const url = urlOf(run.node)
    if (url !== null) {
      prompt.push({ ...run, url })
      continue
    }
    if (!missing.includes(run.label)) missing.push(run.label)
    const before = prompt.at(-1)
    if (before !== undefined && !('node' in before) && before.text.endsWith(CITE))
      prompt[prompt.length - 1] = { ...before, text: before.text.slice(0, -CITE.length) }
  }
  return { missing, prompt }
}

/** 读的那一刻每张图用哪张、编号几：用户给的图用文件里的地址，生成图只认选用；编号只给有图的、按先后从 1 起。 */
const resolved = (conversationId: string, film: FilmViewOut): FilmViewOut => {
  const picks = chosen.get(conversationId) ?? new Map<string, string | null>()
  const frames = film.groups.flatMap((group) => group.frames)
  const urlOf = (node: string): string | null => {
    const frame = frames.find((item) => item.node === node)
    if (picks.has(node)) return picks.get(node) ?? null
    return frame?.kind === 'photo' ? frame.url : null
  }
  return {
    ...film,
    groups: film.groups.map((group) => {
      let number = 0
      return {
        ...group,
        frames: group.frames.map((frame) => {
          const url = urlOf(frame.node)
          return {
            ...frame,
            ...resolvedPrompt(frame, urlOf),
            number: url === null ? null : ++number,
            url,
          }
        }),
      }
    }),
  }
}

const versionsMatch = (
  film: FilmViewOut,
  body: { filmVersion: number; runVersion: number | null },
) => body.filmVersion === film.filmVersion && body.runVersion === film.runVersion

const frameOf = (film: FilmViewOut, node: string) =>
  film.groups.flatMap((group) => group.frames).find((frame) => frame.node === node)

const rejected = (detail: string) => HttpResponse.json({ detail }, { status: 422 })

/** 按后端的规矩把几段字改进去；不合规矩返回给人看的一句话。 */
const applyEdits = (film: FilmViewOut, body: FilmTextEditsIn): FilmGroupOut[] | string => {
  let groups = film.groups
  for (const edit of body.edits) {
    const texts = [edit.text ?? '', ...(edit.parts ?? []), ...(edit.lines ?? []).map((l) => l.text)]
    if (texts.some((text) => text.includes('@Image')))
      return '文字里不能写 @Image，图的编号是自动排的'
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
  return groups
}

/** 照后端拼一组出片的正文：设定在前，每镜写起止秒；只给成片卡与回读用。 */
const videoPrompt = (group: FilmGroupOut) =>
  [
    group.settings.map((setting) => setting.text).join('\n'),
    ...group.shots.map(
      (shot, index) => `[${shot.start}–${shot.end}秒｜镜头${index + 1}] ${shot.parts.join('')}`,
    ),
  ].join('\n')

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
    const frame = frameOf(film, body.node)
    if (frame === undefined) return rejected('要换的这张图找不到了，刷新后再换')
    const picks = chosen.get(conversationId) ?? new Map<string, string | null>()
    chosen.set(conversationId, picks)
    // 生成图取消选用就是没图，不回到生成过的哪一张。
    if (body.url === null && frame.kind === 'photo')
      return rejected('这张图是你给的，只能换成另一张，不能清空')
    picks.set(body.node, body.url)
    const next =
      frame.kind === 'photo'
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
      const frame = frameOf(film, body.node)
      if (frame?.kind !== 'generated') return rejected('用户给的图不能按描述生成')
      const prompt = (frame.prompt ?? [])
        .map((run) => ('node' in run ? run.label : run.text))
        .join('')
      // 每次出的地址都不一样：同一个地址会被当成这张图在用的那版，进不了版本条。
      generatedCount += 1
      const created = acceptMockImage({
        conversationId,
        metadata: { film_node: body.node },
        outputUrl: `${backpackImage}?generated=${String(generatedCount)}`,
        prompt,
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
