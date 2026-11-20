import { openComposition } from '@hyperframes/sdk'
import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { expect } from 'vitest'
import {
  CAPTIONS_PATH,
  captionsHostElement,
  captionsScene,
  captionVariable,
} from '@/features/storyboard/final-cut/composition/captions'
import {
  DEFAULT_CANVAS,
  emptyProject,
  type CaptionClip,
  type FilmClip,
} from '@/features/storyboard/final-cut/composition/film'
import { FinalCutEditor } from '@/features/storyboard/final-cut/final-cut-editor'
import type { GenerationJob } from '@/features/storyboard/storyboard.api'
import { Toaster } from '@/shared/ui/toast'
import { fixtureCatalog, mainFile, video } from './final-cut'
import { files, sounds, unreadable } from './final-cut-media'
import { makeGenerationJob } from './generation-job'
import { addMockConversation } from './mocks/conversations'
import { server } from './mocks/server'
import { mockProjectMain, putMockProjectMain } from './mocks/whole-film'
import { mockWorkspaceFile, putMockWorkspaceFile } from './mocks/workspace'
import { servePreviewPages } from './preview-page'
import { renderWithProviders } from './render'
import { WithHeaderSlot } from './workbench-header-slot'

// final-cut 编辑器各组用例（final-cut-editor-*.test.tsx）共用的准备。每个用例文件自己写
// `vi.mock('mediabunny', ...)`、`vi.setConfig`，并把 `setUpEditorCase` / `tearDownEditorCase`
// 交给自己的 `beforeEach` / `afterEach`

export const CONVERSATION = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
export const URL_A = 'https://media.test/take-a.mp4'
export const URL_B = 'https://media.test/take-b.mp4'
export const URL_SILENT = 'https://media.test/take-silent.mp4'
export const URL_UNREADABLE = 'https://media.test/take-unreadable.mp4'
export const TAKE_A = '11111111-2222-4333-8444-555555555555'
export const TAKE_B = '66666666-7777-4888-8999-aaaaaaaaaaaa'
export const TAKE_SILENT = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
const TAKE_UNREADABLE = 'cccccccc-dddd-4eee-8fff-000000000000'

files.set(URL_A, { keyframes: [0, 2, 4.5], duration: 6 })
files.set(URL_B, { keyframes: [0, 1.5], duration: 3 })
files.set(URL_SILENT, { keyframes: [0, 1], duration: 2 })
files.set(URL_UNREADABLE, { keyframes: [0, 1], duration: 2 })
sounds.add(URL_A)
sounds.add(URL_B)
unreadable.add(URL_UNREADABLE)

export const takes = [
  makeGenerationJob({
    id: TAKE_A,
    createdAt: '2026-09-01T10:00:00Z',
    outputUrl: URL_A,
    shotIndex: 1,
    durationMs: 6000,
  }),
  makeGenerationJob({
    id: TAKE_B,
    createdAt: '2026-09-01T10:05:00Z',
    outputUrl: URL_B,
    shotIndex: 1,
    durationMs: 3000,
  }),
]

/** 同一组的另外两条素材片：一条没有音轨，一条读不出有没有音轨。 */
export const quietTakes = [
  makeGenerationJob({
    id: TAKE_SILENT,
    createdAt: '2026-09-01T10:10:00Z',
    outputUrl: URL_SILENT,
    shotIndex: 1,
    durationMs: 2000,
  }),
  makeGenerationJob({
    id: TAKE_UNREADABLE,
    createdAt: '2026-09-01T10:15:00Z',
    outputUrl: URL_UNREADABLE,
    shotIndex: 1,
    durationMs: 2000,
  }),
]

export const serveGenerations = (records: GenerationJob[]) => {
  const conversation = addMockConversation('成片编辑', undefined, undefined, CONVERSATION)
  server.use(
    http.get('*/api/generations', ({ request }) => {
      const kind = new URL(request.url).searchParams.get('kind')
      return HttpResponse.json({
        items: records.filter((job) => kind === null || job.kind === kind),
      })
    }),
    http.get('*/api/conversations/:conversationId', () => HttpResponse.json({ conversation })),
  )
}

// 编辑器默认停手 800 毫秒后保存；测试默认改为 10 毫秒以省去空等。
// 需要验证「修改后尚未落盘」中间态的用例，在打开编辑器前调用 `keepRealSaveDelay()` 恢复真实延迟。
let saveDelay: { saveDelayMs?: number } = { saveDelayMs: 10 }
export const keepRealSaveDelay = () => {
  saveDelay = {}
}

/** 挂上编辑器，不等它打开。 */
const renderEditor = async (records: GenerationJob[] = takes) => {
  serveGenerations(records)
  const editor = (
    <>
      <WithHeaderSlot>
        <FinalCutEditor conversationId={CONVERSATION} {...saveDelay} />
      </WithHeaderSlot>
      <Toaster />
    </>
  )
  const rendered = await renderWithProviders(editor)
  return {
    close: () => rendered.rerender(<Toaster />),
    reopen: () => rendered.rerender(editor),
    queryClient: rendered.queryClient,
    socket: rendered.socket,
  }
}

/**
 * 打开编辑器，等它打开。工作区里还没有工程时先放一份按默认模版建的空工程（版本 1），和在工作台里新建过
 * final-cut 以后一样；新建本身见 `create-final-cut.test.ts`。
 */
export const openEditor = async (records: GenerationJob[] = takes) => {
  if (mockProjectMain(CONVERSATION) === undefined)
    putMockProjectMain(CONVERSATION, emptyProject(DEFAULT_CANVAS, fixtureCatalog))
  const opened = await renderEditor(records)
  await screen.findByRole('toolbar', { name: '剪辑工具' })
  return opened
}

/** 编辑器的根节点：点在编辑器的空白处时焦点落在它上面。 */
export const editorRoot = () => screen.getByRole('group', { name: 'final-cut 编辑器' })

// 预览页换成跑着真逻辑的替身（播放器是测试替身），编辑器经消息和它来往
export let previewPages: ReturnType<typeof servePreviewPages>

/** 交给每个用例文件的 `beforeEach`：保存等待换回 10 毫秒，换上预览页替身。 */
export const setUpEditorCase = () => {
  saveDelay = { saveDelayMs: 10 }
  previewPages = servePreviewPages({ run: true })
}

/** 交给每个用例文件的 `afterEach`：停掉预览页替身。 */
export const tearDownEditorCase = () => previewPages.stop()

type PreviewPlayerElement = HTMLElement & {
  readonly currentTime: number
  playbackRate: number
  muted: boolean
  loop: boolean
  iframeElement: HTMLIFrameElement
}

/** 获取当前已就绪的预览播放器（排除仍在后台加载的 `.is-pending` 实例）。 */
export const previewPlayer = () => {
  const found = previewPages
    .latest()
    .mount?.querySelector<PreviewPlayerElement>('hyperframes-player:not(.is-pending)')
  if (found === null || found === undefined) throw new Error('预览页里还没有换上来的播放器')
  return found
}

/** 等待预览页完成播放器加载与实例切换。 */
export const previewSettled = () =>
  waitFor(() => {
    expect(previewPages.latest().mount?.querySelectorAll('hyperframes-player')).toHaveLength(1)
    expect(previewPlayer()).toBeDefined()
  })

export const toolbar = () => screen.getByRole('toolbar', { name: '剪辑工具' })
export const transport = () => screen.getByRole('group', { name: '播放控制' })
export const progress = () => within(transport()).getByRole('slider', { name: '播放进度' })
const materials = () => screen.getByRole('region', { name: '视频素材区' })
export const shot = (name: RegExp) => within(materials()).findByRole('button', { name })

export const savedFilm = () => mockProjectMain(CONVERSATION)?.content ?? ''
export const savedVersion = () => mockProjectMain(CONVERSATION)?.version
export const WRITE_URL = '*/api/conversations/:conversationId/workspace/file'
export const savedClips = () => savedFilm().match(/<video [^>]*>/g) ?? []

export const waitSaved = (check: () => void) => waitFor(check, { timeout: 4000 })

export const twoVideos = () =>
  mainFile(
    [
      video({ src: URL_A, duration: 2_000 }),
      video({ id: 'clip-2', src: URL_B, start: 2_000, duration: 1_500 }),
    ],
    { width: 720, height: 1280 },
  )

/** 字幕场景里的一句：`owner` 是它属于的视频片段，手动加的是 null。 */
export type SceneLine = Pick<
  CaptionClip,
  'id' | 'start' | 'duration' | 'variable' | 'text' | 'owner'
>
export const sceneLine = (
  key: string,
  start: number,
  duration: number,
  owner: string | null = null,
) => ({
  id: `cap-${key}`,
  variable: `cap_${key}`,
  text: `字幕 ${key}`,
  start,
  duration,
  owner,
})

export const CAPTION_CANVAS = { width: 720, height: 1280 }
export const SCENE_FILE = `final-cut/${CAPTIONS_PATH}`

/**
 * 工作区里放一份工程：主文件按 `clips` 写；有 `lines` 时照编辑器用 SDK 写的样子加上字幕宿主、变量和场景文件；
 * 给了 `voiceModes` 时写进主文件根上的人声设置。
 */
export const putFilm = async (clips: FilmClip[], lines: SceneLine[] = [], voiceModes?: string) => {
  const main = await openComposition(mainFile(clips, CAPTION_CANVAS))
  if (voiceModes !== undefined) main.setAttribute('film', 'data-voice-modes', voiceModes)
  if (lines.length > 0) {
    const end = Math.max(...[...clips, ...lines].map((clip) => clip.start + clip.duration))
    main.addElement('film', 99, captionsHostElement(CAPTION_CANVAS, end))
    for (const each of lines) main.declareVariable(captionVariable(each))
    putMockWorkspaceFile(
      CONVERSATION,
      SCENE_FILE,
      captionsScene(CAPTION_CANVAS, fixtureCatalog, lines),
    )
  }
  putMockProjectMain(CONVERSATION, main.serialize())
}

/** 存下来的字幕场景里各句的「字、开始、时长（秒）、属于哪个片段」，按文件里的先后。 */
export const savedSceneLines = () =>
  [
    ...new DOMParser()
      .parseFromString(
        (mockWorkspaceFile(CONVERSATION, SCENE_FILE)?.content ?? '').replace(/<\/?template>/g, ''),
        'text/html',
      )
      .querySelectorAll('.caption'),
  ].map((element) => [
    element.textContent,
    Number(element.getAttribute('data-start')),
    Number(element.getAttribute('data-duration')),
    element.getAttribute('data-caption-of'),
  ])

/** 存下来的主文件根上声明的字幕变量的默认值。 */
export const savedVariableTexts = () =>
  (
    JSON.parse(
      new DOMParser()
        .parseFromString(savedFilm(), 'text/html')
        .documentElement.getAttribute('data-composition-variables') ?? '[]',
    ) as { default: unknown }[]
  ).map((declaration) => declaration.default)

export const undoButton = () => within(toolbar()).getByRole('button', { name: '撤销' })
