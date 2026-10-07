/** 制作页的 mock：每段对话一份读好的工程（形状同 `GET /conversations/{id}/film`），改字照后端的规矩查，
 * 改完把工作区里 `film.icml` 的版本加一，文件列表与制作页的版本对得上；出片记一条视频记录，镜号是组号。 */

import { http, HttpResponse } from 'msw'
import type {
  FilmGroupOut,
  FilmTextEditsIn,
  FilmVideoGenerationIn,
  FilmViewOut,
} from '@/shared/api/generated/types.gen'
import apparelImage from './assets/apparel.webp'
import backpackImage from './assets/backpack.webp'
import loafersImage from './assets/loafers.webp'
import { acceptMockVideo, putMockWorkspaceFile } from './workspace'

const FILM_PATH = 'film.icml'
const RUN_PATH = 'film.icrun'

const films = new Map<string, FilmViewOut>()

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

/** 一组 12 秒的穿搭短片：三个出场元素（一张生成的、一张用户给的、一张还没生成）、四个镜头，两句台词。 */
const mockGroup = (): FilmGroupOut => ({
  aspectRatio: '9:16',
  frames: [
    {
      kind: 'generated',
      label: '金发女生',
      node: 'girl_look',
      number: 1,
      prompt: [
        {
          kind: 'text',
          text: '画面是用手机实拍的，真实自然。二十岁上下的白人女生，金色齐耳波波头。',
        },
      ],
      url: apparelImage,
    },
    {
      kind: 'photo',
      label: '绒面一脚蹬',
      node: 'loafer_photo',
      number: 2,
      prompt: null,
      url: loafersImage,
    },
    {
      kind: 'generated',
      label: '涂鸦滑板场',
      node: 'park_look',
      number: null,
      prompt: [{ kind: 'text', text: '户外露天水泥滑板场，坡面和地面喷满街头涂鸦。' }],
      url: null,
    },
    {
      kind: 'generated',
      label: '镜头 1',
      node: 'shot1_view',
      number: 3,
      prompt: [
        { kind: 'image', label: '金发女生', node: 'girl_look', url: apparelImage },
        { kind: 'text', text: '的人物，站在坡面上，双手把长板横扛在肩后。' },
      ],
      url: backpackImage,
    },
    {
      kind: 'generated',
      label: '镜头 2',
      node: 'shot2_view',
      number: null,
      prompt: [{ kind: 'text', text: '高角度俯拍脚部特写，她坐在坡面边缘，小腿悬空。' }],
      url: null,
    },
  ],
  index: 1,
  model: 'vendor-a-seedance-2-0',
  seconds: 12,
  settings: [
    {
      image: null,
      kind: 'shooting',
      label: null,
      target: 'value:shooting',
      text: '摄影：手持拍摄，带轻微呼吸感，以低机位仰拍和脚部特写为主。\n剪辑：全片硬切，快节奏。',
    },
    {
      image: 'girl_look',
      kind: 'element',
      label: '人物 金发女生',
      target: 'element:金发女生',
      text: '二十岁上下的白人女生，脸型偏长，肤色白皙，金色齐耳波波头。',
    },
    {
      image: 'loafer_photo',
      kind: 'element',
      label: '产品 绒面一脚蹬',
      target: 'element:绒面一脚蹬',
      text: '低帮一脚蹬绒面鞋，鞋面是浅米色反绒皮。',
    },
    {
      image: 'park_look',
      kind: 'element',
      label: '场景 涂鸦滑板场',
      target: 'element:涂鸦滑板场',
      text: '户外露天水泥滑板场，坡面和地面喷满街头涂鸦。',
    },
    {
      image: null,
      kind: 'voice',
      label: '声音 旁白',
      target: 'voice:旁白',
      text: '年轻女性松弛的中音，普通话，语速偏慢。',
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
export const seedMockFilm = (conversationId: string, options: { problems?: number } = {}) => {
  const filmVersion = putMockWorkspaceFile(conversationId, FILM_PATH, FILM_SOURCE)
  const runVersion = putMockWorkspaceFile(conversationId, RUN_PATH, RUN_SOURCE)
  const problems = options.problems ?? 0
  films.set(conversationId, {
    filmVersion,
    groups: problems > 0 ? [] : [mockGroup()],
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

export const resetMockFilm = () => films.clear()

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
    const film = films.get(String(params['conversationId']))
    if (film === undefined) return HttpResponse.json({ detail: '没有工程文件' }, { status: 404 })
    return HttpResponse.json({ film })
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
    return HttpResponse.json({ film: next })
  }),

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
