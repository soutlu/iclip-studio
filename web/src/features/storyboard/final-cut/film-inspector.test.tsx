import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ReferenceAudio } from '@/shared/api/reference-audios'
import { audio, caption, fixtureCatalog, host, video } from '@/testing/final-cut'
import { renderWithProviders } from '@/testing/render'
import { NO_CAPTION_STYLE } from './composition/captions'
import type { FilmClip } from './composition/film'
import type { PickDubVoice } from './dub-props'
import { FilmInspector } from './film-inspector'
import { SOURCE_SHOWN, type ShownLocale } from './locales'
import type { VoiceControl } from './voice-choices'
import type { LineState } from './voice-lines'

const VIDEO = video({ id: 'v1', syncOrigin: 'take-1', muted: true })
const ORIGINAL = audio({ id: 'orig', label: '原声', syncOrigin: 'take-1', track: 1 })
const MUSIC = audio({ id: 'music', label: '配乐' })
const NARRATION = audio({
  id: 'narration',
  label: '旁白',
  dub: { locale: null, caption: 'cap-a1', trimmed: false, text: null, voice: 'voice-1', speed: 1 },
})
const ENGLISH_DUB = audio({
  id: 'en-a1',
  label: '英文配音',
  dub: { locale: 'en', caption: 'cap-a1', trimmed: false, text: null, voice: null, speed: 1 },
})

/** 资料库里的音色：只有编号、名字和声线要紧。 */
const VOICES = [
  { id: 'emma', title: 'Emma', gender: 'female' },
  { id: 'klaus', title: 'Klaus', gender: 'male' },
] as ReferenceAudio[]

const READY: LineState = {
  status: 'ready',
  own: undefined,
  voice: 'emma',
  speed: 1,
  trimmed: false,
  pending: false,
  blocked: undefined,
  chooseBlocked: undefined,
}

/** English 显示着时的配音：`line` 是 cap-a1 这句的样子，`dubLine` 记下单句合成。 */
const english = (line: Partial<LineState>, dubLine = vi.fn()): VoiceControl => ({
  locale: 'en',
  mode: 'dub',
  onMode: vi.fn(),
  voice: 'emma',
  onVoice: vi.fn(),
  lines: new Map([['cap-a1', { ...READY, ...line }]]),
  onLine: vi.fn(),
  summary: { dubbed: true, pending: 0, running: 0 },
  generate: { blocked: undefined, run: vi.fn() },
  fill: { blocked: undefined, run: vi.fn() },
  dubLine,
})

/** 和编辑器一样：片段由外面记着，「属性」里静音改的是外面这一份。 */
function Harness({
  initial,
  selectedId,
  locale = SOURCE_SHOWN,
  onOpenCaptions = () => {},
  voice,
  onPickVoice,
}: {
  initial: readonly FilmClip[]
  selectedId: string
  locale?: ShownLocale
  onOpenCaptions?: () => void
  voice?: VoiceControl
  onPickVoice?: PickDubVoice
}) {
  const [clips, setClips] = useState(initial)
  const noop = () => {}
  return (
    <FilmInspector
      audioPeaks={new Map()}
      canvas={{ width: 1080, height: 1920 }}
      catalog={fixtureCatalog}
      clips={clips}
      keyframes={new Map()}
      locale={locale}
      onAttributes={noop}
      captionStyle={NO_CAPTION_STYLE}
      onCaptionStyle={noop}
      onCaptionTrackStyle={noop}
      onCaptionOwnStyle={noop}
      onCaptionText={noop}
      onGesture={noop}
      onHide={(id, hidden) =>
        setClips((current) => current.map((clip) => (clip.id === id ? { ...clip, hidden } : clip)))
      }
      onOpenCaptions={onOpenCaptions}
      onPickVoice={onPickVoice}
      onRemove={noop}
      onRetime={noop}
      onTextEditing={noop}
      onValues={noop}
      selected={clips.filter((clip) => clip.id === selectedId)}
      silentSource={() => false}
      smartMix={undefined}
      soundControls={{ run: noop, link: noop, resync: noop, locate: noop }}
      sourceMs={() => undefined}
      sourceName={() => undefined}
      texts={{ bindings: new Map(), multilingual: false, onText: noop, onFollow: noop }}
      voice={voice}
      voices={VOICES}
    />
  )
}

const head = () => screen.getByRole('banner')

describe('属性 · 分离出来的原声', () => {
  it('「声音与节奏」最后是「静音此段」，拨它改的是片段的隐藏标记', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness initial={[VIDEO, ORIGINAL]} selectedId="orig" />)
    const mute = screen.getByRole('switch', { name: '静音此段' })
    expect(screen.queryByRole('switch', { name: '循环播放' })).toBeNull()
    expect(mute).not.toBeChecked()

    await user.click(mute)
    expect(mute).toBeChecked()
    await user.click(mute)
    expect(mute).not.toBeChecked()
  })

  it('别的音频片段是「循环播放」', async () => {
    await renderWithProviders(<Harness initial={[MUSIC]} selectedId="music" />)
    expect(screen.getByRole('switch', { name: '循环播放' })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: '静音此段' })).toBeNull()
  })
})

describe('属性 · 标题行', () => {
  it.each([
    ['其它语言的配音片段', ENGLISH_DUB],
    ['原文下的旁白片段', NARRATION],
  ])('%s：标题写「配音片段」和起止时间', async (_, clip) => {
    await renderWithProviders(<Harness initial={[clip]} selectedId={clip.id} />)
    expect(within(head()).getByRole('heading', { name: '配音片段' })).toBeInTheDocument()
    expect(within(head()).getByText('0.00 – 2.00s')).toBeInTheDocument()
  })

  it('分离出来的原声：标题是片段名，图标读作「分离原声」，右边只有「合并回视频」', async () => {
    await renderWithProviders(<Harness initial={[VIDEO, ORIGINAL]} selectedId="orig" />)
    expect(within(head()).getByRole('heading', { name: '原声' })).toBeInTheDocument()
    expect(within(head()).getByRole('img', { name: '分离原声' })).toBeInTheDocument()
    expect(within(head()).getAllByRole('button')).toEqual([
      within(head()).getByRole('button', { name: '合并回视频' }),
    ])
  })

  it('配乐：标题是曲名，没有快捷动作；音量只在最上面有一条', async () => {
    await renderWithProviders(<Harness initial={[MUSIC]} selectedId="music" />)
    expect(within(head()).getByRole('heading', { name: '配乐' })).toBeInTheDocument()
    expect(within(head()).queryByRole('button')).toBeNull()
    expect(screen.getAllByRole('slider', { name: '音量' })).toHaveLength(1)
  })
})

describe('属性 · 配音片段', () => {
  const voiceButton = () => screen.getByRole('button', { name: /^音色：/ })

  it('「音色」写这句生效的音色，点它把这句和按钮交出去；「槽位倍速」写倍数', async () => {
    const user = userEvent.setup()
    const onPickVoice = vi.fn<PickDubVoice>()
    await renderWithProviders(
      <Harness
        initial={[ENGLISH_DUB]}
        onPickVoice={onPickVoice}
        selectedId="en-a1"
        voice={english({ voice: 'klaus', speed: 1.18 })}
      />,
    )
    expect(voiceButton()).toHaveAccessibleName('音色：Klaus')
    expect(screen.getByText('1.18×')).toBeInTheDocument()
    await user.click(voiceButton())
    expect(onPickVoice).toHaveBeenCalledExactlyOnceWith('cap-a1', voiceButton())
  })

  it('从原片取的音色写「原片音色」，没加速写 1×，截了尾写「倍速 · 截尾」；没给选音色的回调时「音色」不能点', async () => {
    const { rerender } = await renderWithProviders(
      <Harness initial={[ENGLISH_DUB]} selectedId="en-a1" voice={english({ voice: null })} />,
    )
    expect(voiceButton()).toHaveAccessibleName('音色：原片音色')
    expect(voiceButton()).toBeDisabled()
    expect(screen.getByText('1×')).toBeInTheDocument()
    rerender(
      <Harness
        initial={[ENGLISH_DUB]}
        selectedId="en-a1"
        voice={english({ speed: 1.5, trimmed: true })}
      />,
    )
    expect(screen.getByText('倍速 · 截尾')).toBeInTheDocument()
  })

  it('标题行右边「重新合成」只合成这一句；不能合成时置灰、点了不合成', async () => {
    const user = userEvent.setup()
    const dubLine = vi.fn()
    const { rerender } = await renderWithProviders(
      <Harness
        initial={[ENGLISH_DUB]}
        selectedId="en-a1"
        voice={english({ status: 'stale', pending: true }, dubLine)}
      />,
    )
    await user.click(within(head()).getByRole('button', { name: '重新合成' }))
    expect(dubLine).toHaveBeenCalledExactlyOnceWith('cap-a1')

    rerender(
      <Harness
        initial={[ENGLISH_DUB]}
        selectedId="en-a1"
        voice={english({ blocked: '正在生成配音，请稍候' }, dubLine)}
      />,
    )
    const redub = within(head()).getByRole('button', { name: '重新合成' })
    expect(redub).toHaveAttribute('aria-disabled', 'true')
    await user.click(redub)
    expect(dubLine).toHaveBeenCalledOnce()
  })

  it('不是显示着的语言的配音：音色照片段合成时记下的，不能改音色，没有「重新合成」', async () => {
    await renderWithProviders(
      <Harness
        initial={[NARRATION]}
        onPickVoice={vi.fn()}
        selectedId="narration"
        voice={english({})}
      />,
    )
    expect(voiceButton()).toHaveAccessibleName('音色：资料库音色')
    expect(voiceButton()).toBeDisabled()
    expect(within(head()).queryByRole('button', { name: '重新合成' })).toBeNull()
  })
})

describe('属性 · 文字那一组的语言小块', () => {
  it('元素片段：「内容与样式」右边写着显示着的语言，点它打开「字幕」', async () => {
    const user = userEvent.setup()
    const onOpenCaptions = vi.fn()
    await renderWithProviders(
      <Harness
        initial={[host()]}
        locale={{ code: 'en', values: {} }}
        onOpenCaptions={onOpenCaptions}
        selectedId="title-1"
      />,
    )
    expect(screen.getByRole('heading', { level: 4, name: '内容与样式' })).toBeInTheDocument()
    const chip = screen.getByRole('button', { name: '显示的语言：English' })
    expect(chip).toHaveTextContent('English')
    await user.click(chip)
    expect(onOpenCaptions).toHaveBeenCalledOnce()
  })

  it('字幕：「内容」右边原文下写「原文」，点它打开「字幕」', async () => {
    const user = userEvent.setup()
    const onOpenCaptions = vi.fn()
    await renderWithProviders(
      <Harness initial={[caption()]} onOpenCaptions={onOpenCaptions} selectedId="cap-a1" />,
    )
    expect(screen.getByRole('heading', { level: 4, name: '内容' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '显示的语言：原文' }))
    expect(onOpenCaptions).toHaveBeenCalledOnce()
  })
})
