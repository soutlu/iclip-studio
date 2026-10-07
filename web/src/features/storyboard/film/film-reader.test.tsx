import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http } from 'msw'
import { describe, expect, it } from 'vitest'
import type { FilmTextEditsIn, FilmVideoGenerationIn } from '@/shared/api/generated/types.gen'
import type { ArtifactRendererProps } from '@/shared/workbench'
import { pasteTextIntoComposer } from '@/testing/editor'
import { editMockFilmShot, seedMockFilm } from '@/testing/mocks/film'
import { server } from '@/testing/mocks/server'
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

const mount = async ({ readOnly = false, problems = 0 } = {}) => {
  seedMockFilm(CONVERSATION_ID, { problems })
  await renderWithProviders(
    <FilmReader artifact={artifact} conversationId={CONVERSATION_ID} readOnly={readOnly} />,
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

/** 舞台左上的标签：正文编辑器之外、写在舞台工具条上的那一枚。 */
const stageTag = () => document.querySelector('.storyboard-stage-tag')?.textContent ?? null

describe('制作页', () => {
  it('全局设定一段一行，元素挂的图是芯片；舞台先看第一张，点芯片换图，左右切图时文案列跟到挂它的段', async () => {
    const script = await renderFilm()
    const settings = within(script).getByRole('group', { name: '全局设定' })
    expect(within(settings).getByText(/人物 金发女生：/)).toBeInTheDocument()
    expect(within(script).getAllByRole('group', { name: /^镜头 \d$/ })).toHaveLength(4)
    expect(stageTag()).toBe('@1')

    await userEvent.click(within(settings).getByRole('button', { name: '在舞台查看绒面一脚蹬' }))
    await waitFor(() => expect(stageTag()).toBe('@2'))

    // 第 3 张还没有图，舞台写一句；再往后是镜头 1 的画面，选中跟到镜头 1。
    await userEvent.click(screen.getByRole('button', { name: '下一帧' }))
    expect(await screen.findByText('涂鸦滑板场还没有图')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '下一帧' }))
    await waitFor(() =>
      expect(within(script).getByRole('group', { name: '镜头 1' })).toHaveAttribute(
        'aria-current',
        'true',
      ),
    )
    expect(stageTag()).toBe('@3')
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
    expect(screen.queryByRole('dialog', { name: '分镜有别的改动' })).not.toBeInTheDocument()
  })

  it('写回时同一段也被改过：问留谁的，留我的就以新版本为底写回', async () => {
    const bodies = recordEdits()
    const script = await renderFilm()
    editMockFilmShot(CONVERSATION_ID, 1, 'AI 导演改过的第一镜。')
    await replaceText(
      within(script).getByRole('textbox', { name: '镜头 1的描述' }),
      '我改的第一镜。',
    )

    const dialog = await screen.findByRole('dialog', { name: '分镜有别的改动' })
    expect(dialog).toHaveTextContent('镜头 1在你编辑时被改了')
    await userEvent.click(within(dialog).getByRole('button', { name: '留我的' }))

    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1]).toMatchObject({
      edits: [{ parts: ['我改的第一镜。'], target: 'shot:board:1' }],
      filmVersion: 2,
    })
  })

  it('出片先存改了的字，再按存好的那一版出这一组：模型默认照文件，画幅只显示；成片进本组，选它舞台就放它', async () => {
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
    await waitFor(() => expect(stageTag()).toBe('@3'))
  })

  it('分镜检查出问题时只写有几处，交给 AI 导演改', async () => {
    await mount({ problems: 2 })
    expect(await screen.findByText('分镜有 2 处要 AI 导演改一下')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('只读时字都不能改', async () => {
    const script = await renderFilm({ readOnly: true })
    for (const editor of within(script).getAllByRole('textbox'))
      expect(editor).toHaveAttribute('contenteditable', 'false')
  })
})
