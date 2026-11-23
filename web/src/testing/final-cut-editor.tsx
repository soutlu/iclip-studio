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

// final-cut 编辑器集成测试用例（final-cut-editor-*.test.tsx）共用测试夹具。
// 各测试文件需自行配置 `vi.mock('mediabunny', ...)` 与 `vi.setConfig`，并在 `beforeEach` / `afterEach` 中调用 `setUpEditorCase` / `tearDownEditorCase`

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

/** 同镜头组的另外两条素材片：一条无音轨，一条音轨检测失败。 */
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

/** 挂载编辑器组件（不等待初始化完成）。 */
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
 * 挂载编辑器并等待其初始化就绪。若工作区尚无工程，预先写入一份按默认模板生成的空工程（版本 1），
 * 与工作台新建 final-cut 后的初始态一致；新建流程本身由 `create-final-cut.test.ts` 覆盖。
 */
export const openEditor = async (records: GenerationJob[] = takes) => {
  if (mockProjectMain(CONVERSATION) === undefined)
    putMockProjectMain(CONVERSATION, emptyProject(DEFAULT_CANVAS, fixtureCatalog))
  const opened = await renderEditor(records)
  await screen.findByRole('toolbar', { name: '剪辑工具' })
  return opened
}

/** 获取编辑器根节点：点击编辑器空白处时焦点落于此元素。 */
export const editorRoot = () => screen.getByRole('group', { name: 'final-cut 编辑器' })

// 预览页运行真实通信与控制逻辑，内部播放器替换为测试替身，编辑器通过 postMessage 协议与之交互
export let previewPages: ReturnType<typeof servePreviewPages>

/** 供测试文件 `beforeEach` 调用：恢复 10ms 保存延迟并启动预览页测试替身。 */
export const setUpEditorCase = () => {
  saveDelay = { saveDelayMs: 10 }
  previewPages = servePreviewPages({ run: true })
}

/** 供测试文件 `afterEach` 调用：停止并清理预览页测试替身。 */
export const tearDownEditorCase = () => previewPages.stop()

type PreviewPlayerElement = HTMLElement & {
  readonly currentTime: number
  playbackRate: number
  muted: boolean
  loop: boolean
  iframeElement: HTMLIFrameElement
  /** 播放器内部运行库时钟当前时刻（秒），供用例改写以模拟播放推进（见 `hyperframes-player.ts`）。 */
  runtimeTime: number
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

/** 字幕场景单句测试数据：`owner` 为所属视频片段 ID，手动添加时为 `null`。 */
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
 * 向模拟工作区写入测试工程：按 `clips` 生成主文件；传入 `lines` 时按编辑器 SDK 格式补齐字幕宿主、变量声明与字幕场景文件；
 * 传入 `voiceModes` 时在主文件根节点写入人声模式配置。
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

/** 解析已落盘字幕场景中各句的 `[文本, 开始秒数, 时长秒数, 所属片段 ID]`（保持文件顺序）。 */
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

/** 提取已落盘主文件根节点声明的字幕变量默认值列表。 */
export const savedVariableTexts = () =>
  (
    JSON.parse(
      new DOMParser()
        .parseFromString(savedFilm(), 'text/html')
        .documentElement.getAttribute('data-composition-variables') ?? '[]',
    ) as { default: unknown }[]
  ).map((declaration) => declaration.default)

export const undoButton = () => within(toolbar()).getByRole('button', { name: '撤销' })
