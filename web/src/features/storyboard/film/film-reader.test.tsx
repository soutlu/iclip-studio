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

const mount = async ({
  readOnly = false,
  problems = 0,
  model,
}: { readOnly?: boolean; problems?: number; model?: string } = {}) => {
  seedMockFilm(CONVERSATION_ID, { model, problems })
  await renderWithProviders(
    <>
      <FilmReader artifact={artifact} conversationId={CONVERSATION_ID} readOnly={readOnly} />
      <Toaster />
    </>,
    { initialPath: '/?shot=1' },
  )
}

/** 挂上一份能用的工程，返回文案列。 */
const renderFilm = async ({ readOnly = false } = {}) => {
  await mount({ readOnly })
  return screen.findByRole('region', { name: '分镜文案' })
}

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

/** 镜头 2 那张生成图按描述生成过一次，状态与结果照给的。 */
const shot2Generation = (over: Partial<ReturnType<typeof makeGenerationJob>>) =>
  makeGenerationJob({
    kind: 'image',
    metadata: { film_node: 'shot2_view' },
    sourceUrl: null,
    ...over,
  })

const photo = () => new File(['photo'], '我的照片.png', { type: 'image/png' })

/** 舞台左上的标签：正文编辑器之外、写在舞台工具条上的那一枚。 */
const stageTag = () => document.querySelector('.storyboard-stage-tag')?.textContent ?? null

describe('制作页', () => {
  it('全局设定一段一行，元素挂的图是芯片；舞台先看第一张，点芯片换图，左右切图时文案列跟到挂它的段', async () => {
    const script = await renderFilm()
    const settings = within(script).getByRole('group', { name: '全局设定' })
    expect(within(settings).getByText(/人物 金发女生：/)).toBeInTheDocument()
    // 声音的正文开头已有说话人，称呼后面空一格接，不再写「：」。
    expect(
      within(settings).getByText('声音', { selector: '.film-setting-label' }).textContent,
    ).toBe('声音 ')
    expect(within(settings).getByRole('textbox', { name: '声音' })).toHaveTextContent(
      /^旁白：年轻女性/,
    )
    expect(within(script).getAllByRole('group', { name: /^镜头 \d$/ })).toHaveLength(4)
    expect(stageTag()).toBe('@1')

    await userEvent.click(within(settings).getByRole('button', { name: '在舞台查看绒面一脚蹬 @2' }))
    await waitFor(() => expect(stageTag()).toBe('@2'))

    // 再往后是同一元素的第二张；第 4 张还没有图，舞台写一句；再往后是镜头 1 的画面，选中跟到镜头 1。
    await userEvent.click(screen.getByRole('button', { name: '下一帧' }))
    await waitFor(() => expect(stageTag()).toBe('@3'))
    await userEvent.click(screen.getByRole('button', { name: '下一帧' }))
    expect(
      await screen.findByRole('heading', { name: '涂鸦滑板场 · 图像生成' }),
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '下一帧' }))
    await waitFor(() =>
      expect(within(script).getByRole('group', { name: '镜头 1' })).toHaveAttribute(
        'aria-current',
        'true',
      ),
    )
    expect(stageTag()).toBe('@4')
  })

  it('一个元素挂几张图就排几枚芯片，按先后；点哪枚舞台看哪张，只高亮那一枚', async () => {
    const script = await renderFilm()
    const settings = within(script).getByRole('group', { name: '全局设定' })
    // 读屏名字带芯片上的字，同一元素的两张分得开；排在前面的是 @2。
    const front = within(settings).getByRole('button', { name: '在舞台查看绒面一脚蹬 @2' })
    const sole = within(settings).getByRole('button', { name: '在舞台查看绒面一脚蹬 @3' })
    expect(front.compareDocumentPosition(sole) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // 还没有编号的芯片上就是名字，只念一次。
    expect(
      within(settings).getByRole('button', { name: '在舞台查看涂鸦滑板场' }),
    ).toHaveTextContent('涂鸦滑板场')

    await userEvent.click(sole)
    await waitFor(() => expect(stageTag()).toBe('@3'))
    expect(sole).toHaveAttribute('data-highlighted')
    expect(front).not.toHaveAttribute('data-highlighted')

    await userEvent.click(front)
    await waitFor(() => expect(stageTag()).toBe('@2'))
    expect(front).toHaveAttribute('data-highlighted')
    expect(sole).not.toHaveAttribute('data-highlighted')
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
          parts: ['高角度俯拍脚部特写，镜头缓慢右移。她坐在坡面边缘，小腿悬空。\n', ''],
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
    await replaceText(within(script).getByRole('textbox', { name: '镜头 2的描述' }), '换了一句。')

    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]?.edits[0]?.parts).toEqual(['换了一句。\n', ''])
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
      within(script).getByRole('textbox', { name: '镜头 1的描述' }),
      '我改的第一镜。',
    )

    await waitFor(() => expect(bodies.map((body) => body.filmVersion)).toEqual([1, 2]))
    expect(await screen.findByText('AI 导演改过的第四镜。')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: '分镜版本冲突' })).not.toBeInTheDocument()
  })

  it('写回时同一段也被改过：问留谁的，留我的就以新版本为底写回', async () => {
    const bodies = recordEdits()
    const script = await renderFilm()
    editMockFilmShot(CONVERSATION_ID, 1, 'AI 导演改过的第一镜。')
    await replaceText(
      within(script).getByRole('textbox', { name: '镜头 1的描述' }),
      '我改的第一镜。',
    )

    const dialog = await screen.findByRole('dialog', { name: '分镜版本冲突' })
    expect(dialog).toHaveTextContent('镜头 1在编辑期间已被修改')
    await userEvent.click(within(dialog).getByRole('button', { name: '保留我的修改' }))

    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1]).toMatchObject({
      edits: [{ parts: ['我改的第一镜。'], target: 'shot:board:1' }],
      filmVersion: 2,
    })
  })

  it('缺图不拦出片，先存改了的字再按存好的那一版出这一组：模型默认照文件，画幅只显示；成片进本组，选它舞台就放它', async () => {
    const bodies = recordEdits()
    const videos: FilmVideoGenerationIn[] = []
    server.use(
      http.post(
        '*/api/conversations/:conversationId/film/video-generations',
        async ({ request }) => {
          videos.push((await request.clone().json()) as FilmVideoGenerationIn)
        },
      ),
    )
    const script = await renderFilm()
    const bar = screen.getByRole('group', { name: '出片工具栏' })
    expect(within(bar).queryByRole('button', { name: '画幅' })).not.toBeInTheDocument()
    expect(bar).toHaveTextContent('9:16')
    const generate = within(bar).getByRole('button', { name: '生成第 1 组' })
    await waitFor(() => expect(generate).not.toHaveAttribute('aria-disabled'))

    await replaceText(
      within(script).getByRole('textbox', { name: '镜头 1的描述' }),
      '改过的第一镜。',
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
    await waitFor(() => expect(stageTag()).toBe('@4'))
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
    await userEvent.click(within(script).getByRole('button', { name: '镜头 2' }))

    const card = await screen.findByRole('region', { name: '镜头 2的生图描述' })
    expect(within(card).getByRole('heading', { name: '镜头 2 · 图像生成' })).toBeInTheDocument()
    await userEvent.click(within(card).getByRole('button', { name: '生成图片' }))

    await waitFor(() =>
      expect(generations).toEqual([{ filmVersion: 1, node: 'shot2_view', runVersion: 1 }]),
    )
    expect(await screen.findByRole('status', { name: /^生成中/ })).toBeInTheDocument()
  })

  it('生成卡：描述里挂的生成图没有图时，按钮上方提醒只用描述，出片栏不重复提醒；不挂没图的生成图就不提醒', async () => {
    const script = await renderFilm()
    await userEvent.click(within(script).getByRole('button', { name: '镜头 2' }))

    const card = await screen.findByRole('region', { name: '镜头 2的生图描述' })
    expect(card).toHaveTextContent('涂鸦滑板场的图片缺失，将参考描述生成')
    expect(screen.getByRole('group', { name: '出片工具栏' })).not.toHaveTextContent('图片缺失')
    // 没图的参考图只写文字，不出芯片。
    expect(within(card).queryByRole('img', { name: /涂鸦滑板场/ })).not.toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: '编辑图片' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '上一帧' }))
    await userEvent.click(screen.getByRole('button', { name: '上一帧' }))
    const park = await screen.findByRole('region', { name: '涂鸦滑板场的生图描述' })
    expect(park).not.toHaveTextContent('缺失')
    // 从没生成过、也没选用：不能开编辑器。
    expect(screen.queryByRole('button', { name: '编辑图片' })).not.toBeInTheDocument()
  })

  it('生成卡：上次生成失败写原因，按钮是「重新生成」', async () => {
    serveImageJobs([shot2Generation({ errorMessage: '上游超时', status: 'failed' })])
    const script = await renderFilm()
    await userEvent.click(within(script).getByRole('button', { name: '镜头 2' }))

    const card = await screen.findByRole('region', { name: '镜头 2的生图描述' })
    expect(await within(card).findByRole('alert')).toHaveTextContent('上游超时')
    expect(within(card).getByRole('button', { name: '重新生成' })).toBeInTheDocument()
  })

  it('生成卡：生成好了不自动用上，卡上放结果与「选用该图片」；点了才选用，舞台换成它', async () => {
    const result = 'https://example.com/shot2-result.png'
    serveImageJobs([shot2Generation({ outputUrl: result, status: 'completed' })])
    const { choices } = recordImages()
    const script = await renderFilm()
    await userEvent.click(within(script).getByRole('button', { name: '镜头 2' }))

    const card = await screen.findByRole('region', { name: '镜头 2的生成结果' })
    expect(card).toHaveTextContent('镜头 2 尚未选用图片')
    expect(card.querySelector('img')).toHaveAttribute('src', result)
    expect(card).toHaveTextContent('涂鸦滑板场的图片缺失，将参考描述生成')
    expect(within(card).getByRole('button', { name: '再生成' })).toBeInTheDocument()
    // 生成过就能开编辑器，到版本里挑。
    expect(screen.getByRole('button', { name: '编辑图片' })).toBeInTheDocument()

    await userEvent.click(within(card).getByRole('button', { name: '选用该图片' }))

    await waitFor(() =>
      expect(choices).toEqual([{ filmVersion: 1, node: 'shot2_view', runVersion: 1, url: result }]),
    )
    await waitFor(() =>
      expect(screen.getByRole('img', { name: '镜头 2' })).toHaveAttribute('src', result),
    )
    expect(screen.queryByRole('region', { name: '镜头 2的生成结果' })).not.toBeInTheDocument()
  })

  it('悬停图片芯片出预览卡，「放大」开灯箱', async () => {
    const script = await renderFilm()
    await userEvent.hover(within(script).getByRole('button', { name: '在舞台查看金发女生 @1' }))
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
    await userEvent.click(within(script).getByRole('button', { name: '在舞台查看镜头 1的画面' }))
    await userEvent.click(await screen.findByRole('button', { name: '编辑图片' }))
    const editor = await screen.findByRole('dialog', { name: /^编辑图片/ })
    const strip = within(editor).getByRole('group', { name: '该图片的版本' })
    await userEvent.click(within(strip).getByRole('button', { name: '再生成' }))

    const box = within(editor).getByRole('textbox', { name: '修改要求' })
    expect(box).toHaveTextContent('金发女生的人物，站在坡面上')
    // 输入卡的提交按钮也叫「再生成」，不在版本条里。
    const send = () =>
      within(editor)
        .getAllByRole('button', { name: '再生成' })
        .find((button) => !strip.contains(button))
    await userEvent.click(send() ?? editor)
    await waitFor(() => expect(generations).toHaveLength(1))
    expect(generations[0]).toEqual({ filmVersion: 1, node: 'shot1_view', runVersion: 1 })

    pasteTextIntoComposer(box, '傍晚，')
    await userEvent.click(send() ?? editor)
    await waitFor(() => expect(generations).toHaveLength(2))
    expect(generations[1]?.prompt?.text).toContain('傍晚，')
    expect(generations[1]?.prompt?.text).toContain('@Image1的人物，站在坡面上')
    expect(generations[1]?.prompt?.referenceImageUrls).toHaveLength(1)
  })

  it('生成过、没选用的那张也能开编辑器：没有「在用」一格，选中的结果点「选用该图片」就选用，撤销回到没图', async () => {
    const result = 'https://example.com/shot2-result.png'
    serveImageJobs([shot2Generation({ outputUrl: result, status: 'completed' })])
    const { choices } = recordImages()
    const script = await renderFilm()
    await userEvent.click(within(script).getByRole('button', { name: '镜头 2' }))
    await screen.findByRole('region', { name: '镜头 2的生成结果' })
    await userEvent.click(screen.getByRole('button', { name: '编辑图片' }))

    const editor = await screen.findByRole('dialog', { name: /^编辑图片/ })
    const strip = within(editor).getByRole('group', { name: '该图片的版本' })
    expect(strip).not.toHaveTextContent('在用')
    expect(within(editor).getByRole('img', { name: '结果' })).toHaveAttribute('src', result)
    await userEvent.click(within(editor).getByRole('button', { name: '选用该图片' }))

    await waitFor(() => expect(choices).toHaveLength(1))
    expect(choices[0]).toMatchObject({ node: 'shot2_view', url: result })
    expect(await within(editor).findByText('已选用')).toBeInTheDocument()
    expect(strip).toHaveTextContent('在用')

    await userEvent.click(within(editor).getByRole('button', { name: '撤销' }))
    await waitFor(() => expect(choices).toHaveLength(2))
    expect(choices[1]).toMatchObject({ node: 'shot2_view', url: null })
    await waitFor(() => expect(strip).not.toHaveTextContent('在用'))
    expect(within(editor).getByRole('button', { name: '选用该图片' })).toBeInTheDocument()
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
