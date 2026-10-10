import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ImageGenerationIn,
  FilmImageChoiceIn,
  FilmImageGenerationIn,
  FilmTextEditsIn,
  FilmVideoGenerationIn,
  FilmViewOut,
} from '@/shared/api/generated/types.gen'
import { Toaster } from '@/shared/ui/toast'
import type { ArtifactRendererProps } from '@/shared/workbench'
import { pasteFilesIntoComposer, pasteTextIntoComposer } from '@/testing/editor'
import { editMockFilmShot, seedMockFilm } from '@/testing/mocks/film'
import { loginAs, mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { makeGenerationJob } from '@/testing/generation-job'
import { renderWithProviders } from '@/testing/render'
import { DEFAULT_GENERATE_AUDIO, DEFAULT_VIDEO_RESOLUTION } from '../video-generation-options'
import { FilmReader } from './film-reader'

const CONVERSATION_ID = '6d1f0c3e-2b4a-4c8e-9f1d-3a5b7c9e1f20'
const artifact: ArtifactRendererProps['artifact'] = {
  id: 'file:film.icml',
  source: { kind: 'file', path: 'film.icml', version: 1 },
  title: '制作',
  type: 'film',
}

/** 记下每次改字发出去的体；不拦，照常交给 mock 处理。 */
const recordEdits = () => {
  const bodies: FilmTextEditsIn[] = []
  server.use(
    http.patch('*/api/conversations/:conversationId/film/text', async ({ request }) => {
      bodies.push((await request.clone().json()) as FilmTextEditsIn)
    }),
  )
  return bodies
}

/** 记下每次出片发出去的体；不拦，照常交给 mock 处理。 */
const recordVideos = () => {
  const videos: FilmVideoGenerationIn[] = []
  server.use(
    http.post('*/api/conversations/:conversationId/film/video-generations', async ({ request }) => {
      videos.push((await request.clone().json()) as FilmVideoGenerationIn)
    }),
  )
  return videos
}

const mount = async ({
  readOnly = false,
  problems = 0,
  model,
  complete = false,
}: { readOnly?: boolean; problems?: number; model?: string; complete?: boolean } = {}) => {
  seedMockFilm(CONVERSATION_ID, { complete, model, problems })
  await renderWithProviders(
    <>
      <FilmReader artifact={artifact} conversationId={CONVERSATION_ID} readOnly={readOnly} />
      <Toaster />
    </>,
    { initialPath: '/?shot=1' },
  )
}

/** 挂上一份能用的工程，返回文案列；默认场景图与镜头 2 的机位图没选用，`complete` 时全都选用了。 */
const renderFilm = async ({ readOnly = false, complete = false } = {}) => {
  await mount({ complete, readOnly })
  return screen.findByRole('region', { name: '分镜文案' })
}

/** 一段字的编辑器里那几枚图片芯片的读屏名字，按先后。 */
const chipsIn = (editor: HTMLElement) =>
  within(editor)
    .queryAllByRole('button')
    .map((chip) => chip.getAttribute('aria-label'))

/** 整段换成 `text`：全选后粘贴，走编辑器自己的事务。 */
const replaceText = async (editor: HTMLElement, text: string) => {
  editor.focus()
  await userEvent.keyboard('{Control>}a{/Control}')
  pasteTextIntoComposer(editor, text)
}

/** 记下换图与按描述生图发出去的体；不拦，照常交给 mock 处理。 */
const recordImages = () => {
  const choices: FilmImageChoiceIn[] = []
  const generations: FilmImageGenerationIn[] = []
  server.use(
    http.put('*/api/conversations/:conversationId/film/image', async ({ request }) => {
      choices.push((await request.clone().json()) as FilmImageChoiceIn)
    }),
    http.post('*/api/conversations/:conversationId/film/image-generations', async ({ request }) => {
      generations.push((await request.clone().json()) as FilmImageGenerationIn)
    }),
  )
  return { choices, generations }
}

/** 本对话的图片记录：图片任务的两种查法（对话级与按图）都给这几条，视频没有。 */
const serveImageJobs = (jobs: ReturnType<typeof makeGenerationJob>[]) =>
  server.use(
    http.get('*/api/generations', ({ request }) =>
      HttpResponse.json({
        items: new URL(request.url).searchParams.get('kind') === 'image' ? jobs : [],
      }),
    ),
  )

/** 镜头 1 那张机位图（没选用、不在列表里）按描述生成过一次，状态与结果照给的。 */
const shot1Generation = (over: Partial<ReturnType<typeof makeGenerationJob>>) =>
  makeGenerationJob({
    kind: 'image',
    metadata: { film_node: 'shot1_view' },
    sourceUrl: null,
    ...over,
  })

/** 参考图条上每枚芯片的字，按先后。 */
const stripTexts = (script: HTMLElement) =>
  within(within(script).getByRole('group', { name: '参考图' }))
    .getAllByRole('button')
    .map((chip) => chip.textContent)

const photo = () => new File(['photo'], '我的照片.png', { type: 'image/png' })

/** 舞台左上的标签：正文编辑器之外、写在舞台工具条上的那一枚。 */
const stageTag = () => document.querySelector('.storyboard-stage-tag')?.textContent ?? null

describe('制作页', () => {
  it('字里的 @ImageN 在原位置是对应编号的芯片，镜头开头的「参考@ImageN，」也是；段名照模板，后面不挂芯片', async () => {
    const script = await renderFilm()
    const settings = within(script).getByRole('group', { name: '全局设定' })
    const label = (name: string) =>
      within(settings).getByText(name, { selector: '.film-setting-label' })
    expect(within(label('人物：')).queryAllByRole('button')).toEqual([])
    // 声音的正文开头已有说话人，称呼后面空一格接，不再写「：」。
    expect(label('声音').textContent).toBe('声音 ')
    expect(within(settings).getByRole('textbox', { name: '声音' })).toHaveTextContent(
      /^旁白：年轻女性/,
    )

    const product = within(settings).getByRole('textbox', { name: '产品' })
    expect(chipsIn(product)).toEqual(['在舞台查看绒面一脚蹬 @2', '在舞台查看绒面一脚蹬 @3'])
    expect(product).toHaveTextContent('鞋面参考@2，鞋底参考@3。')
    // 没选用的图照样按编号出芯片，画一格空位。
    expect(chipsIn(within(settings).getByRole('textbox', { name: '场景' }))).toEqual([
      '在舞台查看涂鸦滑板场 @4',
    ])
    const shot2 = within(script).getByRole('textbox', { name: '镜头 2的描述' })
    expect(chipsIn(shot2)).toEqual(['在舞台查看镜头 2 @5'])
    expect(shot2).toHaveTextContent(/^参考@5，高角度俯拍/)
    // 镜头 1 的机位图没选用，不在列表里，正文开头没有引用。
    expect(chipsIn(within(script).getByRole('textbox', { name: '镜头 1的描述' }))).toEqual([])
    expect(within(script).getAllByRole('group', { name: /^镜头 \d$/ })).toHaveLength(4)
  })

  it('点字里的芯片：选中这段、舞台看那张，只高亮那一枚；左右切图时文案列跟到写着它的段', async () => {
    const script = await renderFilm()
    const settings = within(script).getByRole('group', { name: '全局设定' })
    expect(stageTag()).toBe('@1')
    const front = within(settings).getByRole('button', { name: '在舞台查看绒面一脚蹬 @2' })
    const sole = within(settings).getByRole('button', { name: '在舞台查看绒面一脚蹬 @3' })

    await userEvent.click(sole)
    await waitFor(() => expect(stageTag()).toBe('@3'))
    expect(sole).toHaveAttribute('data-highlighted')
    expect(front).not.toHaveAttribute('data-highlighted')

    // 第 4 张还没有图，舞台是生成卡；再往后是镜头 2 的画面，选中跟到镜头 2，它开头那枚芯片高亮。
    await userEvent.click(screen.getByRole('button', { name: '下一帧' }))
    expect(
      await screen.findByRole('heading', { name: '涂鸦滑板场 · 图像生成' }),
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '下一帧' }))
    const shot = within(script).getByRole('group', { name: '镜头 2' })
    await waitFor(() => expect(shot).toHaveAttribute('aria-current', 'true'))
    expect(stageTag()).toBe('@5')
    expect(within(shot).getByRole('button', { name: '在舞台查看镜头 2 @5' })).toHaveAttribute(
      'data-highlighted',
    )
    expect(sole).not.toHaveAttribute('data-highlighted')
    // 列表之后是没进列表的镜头 1 机位图：舞台写它的名字，选中跟到镜头 1。
    await userEvent.click(screen.getByRole('button', { name: '下一帧' }))
    await waitFor(() =>
      expect(within(script).getByRole('group', { name: '镜头 1' })).toHaveAttribute(
        'aria-current',
        'true',
      ),
    )
    expect(stageTag()).toBe('镜头 1')
  })

  it('参考图条按列表先后只列会发出去的图，写编号与名字，没选用的标出来；点哪张舞台看哪张，文案列跟到写着它的段', async () => {
    const script = await renderFilm()
    // 没进列表的镜头 1 机位图不在条上。
    expect(stripTexts(script)).toEqual([
      '@1金发女生',
      '@2绒面一脚蹬',
      '@3绒面一脚蹬',
      '@4涂鸦滑板场未选用',
      '@5镜头 2',
    ])
    const strip = within(script).getByRole('group', { name: '参考图' })
    const view = within(strip).getByRole('button', { name: '在舞台查看镜头 2 @5' })

    await userEvent.click(view)
    await waitFor(() => expect(stageTag()).toBe('@5'))
    expect(within(script).getByRole('group', { name: '镜头 2' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(view).toHaveAttribute('data-highlighted')
  })

  it('没选用的机位图在它那一镜的头部、舞台与生图卡上：没有编号，舞台写它的名字', async () => {
    const script = await renderFilm()
    await userEvent.click(within(script).getByRole('button', { name: '在舞台查看镜头 1的画面' }))

    expect(await screen.findByRole('region', { name: '镜头 1的生图描述' })).toBeInTheDocument()
    expect(stageTag()).toBe('镜头 1')
    expect(within(script).getByRole('group', { name: '镜头 1' })).toHaveAttribute(
      'aria-current',
      'true',
    )
  })

  it('「复制完整提示词」复制的是后端给的这组正文', async () => {
    const served: string[] = []
    server.events.on('response:mocked', async ({ request, response }) => {
      if (request.method !== 'GET' || !new URL(request.url).pathname.endsWith('/film')) return
      const body = (await response.clone().json()) as { film: FilmViewOut }
      served.push(body.film.groups[0]?.prompt ?? '')
    })
    const user = userEvent.setup()
    await renderFilm()
    await user.click(screen.getByRole('button', { name: '复制完整提示词' }))

    expect(served.at(-1)).toContain('参考@Image5，')
    await expect(navigator.clipboard.readText()).resolves.toBe(served.at(-1))
  })

  it('有没存下的改动时「复制完整提示词」不可用，说明原因；存好后复制的是存好的那一版', async () => {
    const user = userEvent.setup()
    const script = await renderFilm()
    const copy = screen.getByRole('button', { name: '复制完整提示词' })
    await replaceText(
      within(script).getByRole('textbox', { name: '镜头 3的描述' }),
      '改过的第三镜。',
    )

    expect(copy).toHaveAttribute('aria-disabled', 'true')
    await user.hover(copy)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('修改尚未保存，无法复制')

    expect(await screen.findByText('已保存')).toBeInTheDocument()
    await waitFor(() => expect(copy).not.toHaveAttribute('aria-disabled'))
    await user.click(copy)
    await expect(navigator.clipboard.readText()).resolves.toContain('6–9秒 改过的第三镜。')
  })

  it('改了带芯片的那段：写回的字里 @ImageN 照原样，粘贴进来的 @ImageN 也是芯片', async () => {
    const bodies = recordEdits()
    const script = await renderFilm()
    const scene = within(script).getByRole('textbox', { name: '场景' })
    const original = '户外露天水泥滑板场参考@Image4，坡面和地面喷满街头涂鸦。'
    scene.focus()
    pasteTextIntoComposer(scene, '傍晚，参考@Image1，')

    await waitFor(() => expect(bodies).toHaveLength(1))
    const text = bodies[0]?.edits[0]?.text ?? ''
    expect(bodies[0]?.edits[0]?.target).toBe('value:涂鸦滑板场')
    expect(text.replace('傍晚，参考@Image1，', '')).toBe(original)
    expect(chipsIn(scene).toSorted()).toEqual(['在舞台查看涂鸦滑板场 @4', '在舞台查看金发女生 @1'])
  })

  it('改一句台词只发这一镜：正文原样带回，台词按原来的先后带上各自的 target', async () => {
    const bodies = recordEdits()
    const script = await renderFilm()
    await replaceText(
      within(script).getByRole('textbox', { name: '镜头 2 旁白的台词' }),
      '一双就够了。',
    )

    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({
      edits: [
        {
          lines: [{ target: 'line:soft', text: '一双就够了。' }],
          parts: [
            '参考@Image5，高角度俯拍脚部特写，镜头缓慢右移。她坐在坡面边缘，小腿悬空。\n',
            '',
          ],
          target: 'shot:board:2',
        },
      ],
      filmVersion: 1,
    })
    expect(await screen.findByText('已保存')).toBeInTheDocument()
  })

  it('改镜头正文只换中间的字，台词前的换行照旧', async () => {
    const bodies = recordEdits()
    const script = await renderFilm()
    await replaceText(
      within(script).getByRole('textbox', { name: '镜头 2的描述' }),
      '参考@Image5，换了一句。',
    )

    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]?.edits[0]?.parts).toEqual(['参考@Image5，换了一句。\n', ''])
  })

  it('不合规矩的改动不写回：说清原因，草稿留着', async () => {
    const script = await renderFilm()
    const words = within(script).getByRole('textbox', { name: '镜头 4 旁白的台词' })
    await replaceText(words, ' ')

    expect(await screen.findByRole('alert')).toHaveTextContent('台词不能是空的')
    expect(words).toHaveTextContent(/^\s*$/)
  })

  it('写回时别的段被改过：这段没动就按新版本再发一次', async () => {
    const bodies = recordEdits()
    const script = await renderFilm()
    editMockFilmShot(CONVERSATION_ID, 4, 'AI 导演改过的第四镜。')
    await replaceText(
      within(script).getByRole('textbox', { name: '镜头 3的描述' }),
      '我改的第三镜。',
    )

    await waitFor(() => expect(bodies.map((body) => body.filmVersion)).toEqual([1, 2]))
    expect(await screen.findByText('AI 导演改过的第四镜。')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: '分镜版本冲突' })).not.toBeInTheDocument()
  })

  it('写回时同一段也被改过：问留谁的，留我的就以新版本为底写回', async () => {
    const bodies = recordEdits()
    const script = await renderFilm()
    editMockFilmShot(CONVERSATION_ID, 3, 'AI 导演改过的第三镜。')
    await replaceText(
      within(script).getByRole('textbox', { name: '镜头 3的描述' }),
      '我改的第三镜。',
    )

    const dialog = await screen.findByRole('dialog', { name: '分镜版本冲突' })
    expect(dialog).toHaveTextContent('镜头 3在编辑期间已被修改')
    await userEvent.click(within(dialog).getByRole('button', { name: '保留我的修改' }))

    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1]).toMatchObject({
      edits: [{ parts: ['我改的第三镜。'], target: 'shot:board:3' }],
      filmVersion: 2,
    })
  })

  it('这组参考图列表里有没选用的：出片按钮不可用，状态行写缺几张；没进列表的机位图不算', async () => {
    const videos = recordVideos()
    await renderFilm()
    const bar = screen.getByRole('group', { name: '出片工具栏' })
    const generate = within(bar).getByRole('button', { name: '生成第 1 组' })

    await waitFor(() =>
      expect(bar).toHaveTextContent('1 张参考图尚未选用，无法生成视频；请先选用图片'),
    )
    expect(generate).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(generate)
    expect(videos).toEqual([])
  })

  it('参考图都有图时，先存改了的字再按存好的那一版出这一组：模型默认照文件，画幅只显示；成片进本组，选它舞台就放它', async () => {
    const bodies = recordEdits()
    const videos = recordVideos()
    const script = await renderFilm({ complete: true })
    const bar = screen.getByRole('group', { name: '出片工具栏' })
    expect(within(bar).queryByRole('button', { name: '画幅' })).not.toBeInTheDocument()
    expect(bar).toHaveTextContent('9:16')
    const generate = within(bar).getByRole('button', { name: '生成第 1 组' })
    await waitFor(() => expect(generate).not.toHaveAttribute('aria-disabled'))

    await replaceText(
      within(script).getByRole('textbox', { name: '镜头 3的描述' }),
      '改过的第三镜。',
    )
    // 不等停手自动存：点出片时先存，再按存好的那一版出。
    await userEvent.click(generate)
    await waitFor(() => expect(videos).toHaveLength(1))
    expect(bodies).toHaveLength(1)
    expect(videos[0]).toEqual({
      filmVersion: 2,
      generateAudio: DEFAULT_GENERATE_AUDIO,
      model: 'vendor-a-seedance-2-0',
      resolution: DEFAULT_VIDEO_RESOLUTION,
      runVersion: 1,
      video: 'board_video',
    })

    await userEvent.click(await screen.findByRole('button', { name: /的成片/ }))
    expect(stageTag()).toBeNull()
    expect(screen.queryByRole('button', { name: '回填提示词' })).not.toBeInTheDocument()
    await userEvent.click(within(script).getByRole('button', { name: '镜头 1' }))
    await waitFor(() => expect(stageTag()).toBe('@5'))
  })

  it('文件里写的模型不在可选的里面，出片栏用服务端的默认', async () => {
    await mount({ model: 'retired-model' })
    const bar = await screen.findByRole('group', { name: '出片工具栏' })

    await waitFor(() =>
      expect(within(bar).getByRole('button', { name: '视频模型' })).toHaveTextContent(
        'vendor-a-seedance-2-5',
      ),
    )
  })

  it('分镜检查出问题时只写有几处，交给 AI 导演改', async () => {
    await mount({ problems: 2 })
    expect(await screen.findByText('分镜有 2 处问题，需要 AI 导演修改')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('只读时字都不能改', async () => {
    const script = await renderFilm({ readOnly: true })
    for (const editor of within(script).getAllByRole('textbox'))
      expect(editor).toHaveAttribute('contenteditable', 'false')
  })
})

describe('制作页的图', () => {
  beforeEach(() => {
    // 上传要登录；jsdom 读不出图的尺寸，给一张够大的。
    loginAs(mockAuthUser)
    vi.stubGlobal('createImageBitmap', async () => ({ close: () => {}, height: 800, width: 600 }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('「替换」选一张图：传好就换掉舞台上这张，按读到的两个版本号发', async () => {
    const { choices } = recordImages()
    await renderFilm()
    await userEvent.upload(screen.getByLabelText('选择替换图片'), photo())

    await waitFor(() => expect(choices).toHaveLength(1))
    expect(choices[0]).toMatchObject({ filmVersion: 1, node: 'girl_look', runVersion: 1 })
    const url = choices[0]?.url ?? ''
    await waitFor(() =>
      expect(screen.getByRole('img', { name: '金发女生' })).toHaveAttribute('src', url),
    )
    expect(await screen.findByText('已替换金发女生')).toBeInTheDocument()
  })

  it('点过舞台后粘贴图片也是换这张；往字里贴图不收，只提示贴到画面上', async () => {
    const { choices } = recordImages()
    const script = await renderFilm()
    pasteFilesIntoComposer(within(script).getByRole('textbox', { name: '镜头 1的描述' }), [photo()])
    expect(await screen.findByText('文字中无法粘贴图片；请将图片粘贴到画面上')).toBeInTheDocument()

    pasteFilesIntoComposer(screen.getByRole('button', { name: '打开原图' }), [photo()])
    await waitFor(() => expect(choices).toHaveLength(1))
    expect(choices[0]?.node).toBe('girl_look')
  })

  it('暂无图片的生成图在舞台上是生成卡：点「生成图片」按这张图发，随即转成生成中', async () => {
    const { generations } = recordImages()
    const script = await renderFilm()
    const strip = within(script).getByRole('group', { name: '参考图' })
    await userEvent.click(
      within(strip).getByRole('button', { name: '在舞台查看涂鸦滑板场 @4，未选用' }),
    )

    const card = await screen.findByRole('region', { name: '涂鸦滑板场的生图描述' })
    expect(within(card).getByRole('heading', { name: '涂鸦滑板场 · 图像生成' })).toBeInTheDocument()
    await userEvent.click(within(card).getByRole('button', { name: '生成图片' }))

    await waitFor(() =>
      expect(generations).toEqual([{ filmVersion: 1, node: 'park_look', runVersion: 1 }]),
    )
    expect(await screen.findByRole('status', { name: /^生成中/ })).toBeInTheDocument()
  })

  it('生成卡：参考图按这张图自己的列表编号，没选用的画空位；有没选用的「生成图片」不可用，写明缺哪几张', async () => {
    const { generations } = recordImages()
    const script = await renderFilm()
    await userEvent.click(within(script).getByRole('button', { name: '镜头 1' }))

    const card = await screen.findByRole('region', { name: '镜头 1的生图描述' })
    const blocker = '参考图尚未选用：涂鸦滑板场，无法生成图片；请先选用图片'
    expect(card).toHaveTextContent(blocker)
    const button = within(card).getByRole('button', { name: '生成图片' })
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription(blocker)
    // 组里涂鸦滑板场是 @4，这张图自己的列表里它是 @2。
    expect(card).toHaveTextContent('@1的人物，站在@2的坡面上')
    expect(
      within(card).getByRole('img', { name: '金发女生 @1' }).querySelector('img'),
    ).not.toBeNull()
    expect(within(card).getByRole('img', { name: '涂鸦滑板场 @2' }).querySelector('img')).toBeNull()
    expect(card).not.toHaveTextContent('@Image')
    expect(generations).toEqual([])
  })

  it('生成卡：上次生成失败写原因，按钮是「重新生成」', async () => {
    serveImageJobs([shot1Generation({ errorMessage: '上游超时', status: 'failed' })])
    const script = await renderFilm()
    await userEvent.click(within(script).getByRole('button', { name: '镜头 1' }))

    const card = await screen.findByRole('region', { name: '镜头 1的生图描述' })
    expect(await within(card).findByRole('alert')).toHaveTextContent('上游超时')
    expect(within(card).getByRole('button', { name: '重新生成' })).toBeInTheDocument()
  })

  it('生成卡：生成好了不自动用上；选用没进列表的机位图后它插进列表，编号、图条、正文引用与舞台都跟着变', async () => {
    const result = 'https://example.com/shot1-result.png'
    serveImageJobs([shot1Generation({ outputUrl: result, status: 'completed' })])
    const { choices } = recordImages()
    const script = await renderFilm()
    await userEvent.click(within(script).getByRole('button', { name: '镜头 1' }))

    const card = await screen.findByRole('region', { name: '镜头 1的生成结果' })
    expect(card).toHaveTextContent('镜头 1 尚未选用图片')
    expect(card.querySelector('img')).toHaveAttribute('src', result)
    expect(card).toHaveTextContent('参考图尚未选用：涂鸦滑板场，无法生成图片；请先选用图片')
    expect(within(card).getByRole('button', { name: '再生成' })).toBeDisabled()
    // 生成过就能开编辑器，到版本里挑。
    expect(screen.getByRole('button', { name: '编辑图片' })).toBeInTheDocument()

    await userEvent.click(within(card).getByRole('button', { name: '选用该图片' }))

    await waitFor(() =>
      expect(choices).toEqual([{ filmVersion: 1, node: 'shot1_view', runVersion: 1, url: result }]),
    )
    // 镜头 1 的机位图排在镜头 2 的之前：它成了 @5，镜头 2 的挪到 @6，舞台跟着这张图走。
    await waitFor(() =>
      expect(screen.getByRole('img', { name: '镜头 1' })).toHaveAttribute('src', result),
    )
    expect(stageTag()).toBe('@5')
    expect(stripTexts(script)).toEqual([
      '@1金发女生',
      '@2绒面一脚蹬',
      '@3绒面一脚蹬',
      '@4涂鸦滑板场未选用',
      '@5镜头 1',
      '@6镜头 2',
    ])
    expect(chipsIn(within(script).getByRole('textbox', { name: '镜头 1的描述' }))).toEqual([
      '在舞台查看镜头 1 @5',
    ])
    expect(chipsIn(within(script).getByRole('textbox', { name: '镜头 2的描述' }))).toEqual([
      '在舞台查看镜头 2 @6',
    ])
    expect(within(script).getByRole('group', { name: '镜头 1' })).toHaveAttribute(
      'aria-current',
      'true',
    )
  })

  it('悬停图片芯片出预览卡，「放大」开灯箱', async () => {
    const script = await renderFilm()
    const settings = within(script).getByRole('group', { name: '全局设定' })
    await userEvent.hover(within(settings).getByRole('button', { name: '在舞台查看金发女生 @1' }))
    const tip = await screen.findByRole('tooltip')
    await userEvent.click(within(tip).getByRole('button', { name: '放大' }))
    expect(await screen.findByRole('dialog', { name: /金发女生/ })).toBeInTheDocument()
  })
})

describe('制作页的图片编辑器', () => {
  beforeEach(() => {
    loginAs(mockAuthUser)
  })

  it('有图的那张能开编辑器：标题写图的名字，第一格叫「在用」，提交的编辑按这张图的画幅、带上它的标记', async () => {
    const submissions: ImageGenerationIn[] = []
    server.use(
      http.post('*/api/generations/image', async ({ request }) => {
        submissions.push((await request.clone().json()) as ImageGenerationIn)
      }),
    )
    await renderFilm()
    await userEvent.click(screen.getByRole('button', { name: '编辑图片' }))

    const editor = await screen.findByRole('dialog', { name: /^编辑图片/ })
    expect(editor).toHaveTextContent('金发女生')
    expect(within(editor).getByRole('group', { name: '该图片的版本' })).toHaveTextContent('在用')
    pasteTextIntoComposer(
      within(editor).getByRole('textbox', { name: '修改要求' }),
      '把背景换成傍晚的暖光',
    )
    await userEvent.click(within(editor).getByRole('button', { name: '生成图片' }))

    await waitFor(() => expect(submissions).toHaveLength(1))
    expect(submissions[0]).toMatchObject({
      aspectRatio: '3:4',
      metadata: { film_node: 'girl_look' },
    })
  })

  it('生成图的版本条末尾有「再生成」：输入卡装着这张图的描述，没改就按文件里的出，改过的这一次带上', async () => {
    const { generations } = recordImages()
    const script = await renderFilm()
    await userEvent.click(within(script).getByRole('button', { name: '在舞台查看镜头 2的画面' }))
    await userEvent.click(await screen.findByRole('button', { name: '编辑图片' }))
    const editor = await screen.findByRole('dialog', { name: /^编辑图片/ })
    const strip = within(editor).getByRole('group', { name: '该图片的版本' })
    await userEvent.click(within(strip).getByRole('button', { name: '再生成' }))

    const box = within(editor).getByRole('textbox', { name: '修改要求' })
    expect(box).toHaveTextContent('金发女生的脚部特写')
    // 输入卡的提交按钮也叫「再生成」，不在版本条里。
    const send = () =>
      within(editor)
        .getAllByRole('button', { name: '再生成' })
        .find((button) => !strip.contains(button))
    await userEvent.click(send() ?? editor)
    await waitFor(() => expect(generations).toHaveLength(1))
    expect(generations[0]).toEqual({ filmVersion: 1, node: 'shot2_view', runVersion: 1 })

    pasteTextIntoComposer(box, '傍晚，')
    await userEvent.click(send() ?? editor)
    await waitFor(() => expect(generations).toHaveLength(2))
    expect(generations[1]?.prompt?.text).toContain('傍晚，')
    expect(generations[1]?.prompt?.text).toContain('@Image1的脚部特写')
    expect(generations[1]?.prompt?.referenceImageUrls).toHaveLength(1)
  })

  it('这张图的参考图有没选用的：「再生成」与生成卡一样拦住，写同一句原因，按钮与回车都不提交', async () => {
    serveImageJobs([
      shot1Generation({ outputUrl: 'https://example.com/shot1-result.png', status: 'completed' }),
    ])
    const { generations } = recordImages()
    const script = await renderFilm()
    await userEvent.click(within(script).getByRole('button', { name: '镜头 1' }))
    await screen.findByRole('region', { name: '镜头 1的生成结果' })
    await userEvent.click(screen.getByRole('button', { name: '编辑图片' }))
    const editor = await screen.findByRole('dialog', { name: /^编辑图片/ })
    const strip = within(editor).getByRole('group', { name: '该图片的版本' })
    await userEvent.click(within(strip).getByRole('button', { name: '再生成' }))

    expect(editor).toHaveTextContent('参考图尚未选用：涂鸦滑板场，无法生成图片；请先选用图片')
    const send = within(editor)
      .getAllByRole('button', { name: '再生成' })
      .find((button) => !strip.contains(button))
    expect(send).toBeDisabled()
    const box = within(editor).getByRole('textbox', { name: '修改要求' })
    box.focus()
    await userEvent.keyboard('{Enter}')
    expect(generations).toEqual([])
  })

  it('生成过、没选用的那张也能开编辑器：选用再撤销，机位图进列表又移出，舞台一直跟着这张图，编号跟着还原', async () => {
    const result = 'https://example.com/shot1-result.png'
    serveImageJobs([shot1Generation({ outputUrl: result, status: 'completed' })])
    const { choices } = recordImages()
    const script = await renderFilm()
    await userEvent.click(within(script).getByRole('button', { name: '镜头 1' }))
    await screen.findByRole('region', { name: '镜头 1的生成结果' })
    expect(stageTag()).toBe('镜头 1')
    await userEvent.click(screen.getByRole('button', { name: '编辑图片' }))

    const editor = await screen.findByRole('dialog', { name: /^编辑图片/ })
    const strip = within(editor).getByRole('group', { name: '该图片的版本' })
    expect(strip).not.toHaveTextContent('在用')
    expect(within(editor).getByRole('img', { name: '结果' })).toHaveAttribute('src', result)
    await userEvent.click(within(editor).getByRole('button', { name: '选用该图片' }))

    await waitFor(() => expect(choices).toHaveLength(1))
    expect(choices[0]).toMatchObject({ node: 'shot1_view', url: result })
    expect(await within(editor).findByText('已选用')).toBeInTheDocument()
    expect(strip).toHaveTextContent('在用')
    // 插进列表成了 @5（舞台原来的第 5 张是镜头 2 的机位图，现在挪到 @6）：舞台跟着镜头 1 的图走。
    await waitFor(() => expect(stageTag()).toBe('@5'))

    await userEvent.click(within(editor).getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(choices).toHaveLength(2))
    expect(choices[1]).toMatchObject({ node: 'shot1_view', url: null })
    await waitFor(() => expect(strip).not.toHaveTextContent('在用'))
    expect(within(editor).getByRole('button', { name: '选用该图片' })).toBeInTheDocument()
    // 移出列表：位置 5 又是镜头 2 的机位图，舞台不停在那里，跟到列表后面的镜头 1。
    await waitFor(() => expect(stageTag()).toBe('镜头 1'))
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(editor).not.toBeInTheDocument())
    expect(stripTexts(script)).toEqual([
      '@1金发女生',
      '@2绒面一脚蹬',
      '@3绒面一脚蹬',
      '@4涂鸦滑板场未选用',
      '@5镜头 2',
    ])
    expect(chipsIn(within(script).getByRole('textbox', { name: '镜头 1的描述' }))).toEqual([])
    expect(chipsIn(within(script).getByRole('textbox', { name: '镜头 2的描述' }))).toEqual([
      '在舞台查看镜头 2 @5',
    ])
  })

  it('编辑出了新结果，舞台挂「有新结果」；点开就是那条，「选用该图片」给它换地址，换上后角标消失', async () => {
    const edited = 'https://example.com/edited.png'
    serveImageJobs([
      makeGenerationJob({
        kind: 'image',
        metadata: { film_node: 'girl_look' },
        outputUrl: edited,
        sourceUrl: 'https://example.com/base.png',
      }),
    ])
    const { choices } = recordImages()
    await renderFilm()

    await userEvent.click(await screen.findByRole('button', { name: /有新结果/ }))
    const editor = await screen.findByRole('dialog', { name: /^编辑图片/ })
    await userEvent.click(within(editor).getByRole('button', { name: '选用该图片' }))

    await waitFor(() => expect(choices).toHaveLength(1))
    expect(choices[0]).toMatchObject({ node: 'girl_look', url: edited })
    await userEvent.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /有新结果/ })).not.toBeInTheDocument(),
    )
  })
})
