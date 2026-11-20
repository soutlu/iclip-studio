import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { audio, caption, fixtureCatalog, host, video } from '@/testing/final-cut'
import { renderWithProviders } from '@/testing/render'
import type { Canvas, FilmClip } from './composition/film'
import { FilmInspector } from './film-inspector'
import { SOURCE_SHOWN, type ShownLocale } from './locales'

const VIDEO = video({ id: 'v1', syncOrigin: 'take-1', muted: true })
const ORIGINAL = audio({ id: 'orig', label: '原声', syncOrigin: 'take-1', track: 1 })
const MUSIC = audio({ id: 'music', label: '配乐' })
const NARRATION = audio({
  id: 'narration',
  label: '旁白',
  dub: { locale: null, caption: 'cap-a1', trimmed: false, voice: 'voice-1' },
})
const ENGLISH_DUB = audio({
  id: 'en-a1',
  label: '英文配音',
  dub: { locale: 'en', caption: 'cap-a1', trimmed: false, voice: null },
})

/** 和编辑器一样：片段由外面记着，「属性」里隐藏、静音改的是外面这一份。 */
function Harness({
  initial,
  selectedId,
  locale = SOURCE_SHOWN,
  onOpenCaptions = () => {},
  initialCanvas = { width: 1080, height: 1920 },
  onCanvas = () => {},
}: {
  initial: readonly FilmClip[]
  selectedId: string
  locale?: ShownLocale
  onOpenCaptions?: () => void
  initialCanvas?: Canvas
  onCanvas?: (canvas: Canvas) => void
}) {
  const [clips, setClips] = useState(initial)
  const [canvas, setCanvas] = useState(initialCanvas)
  const noop = () => {}
  return (
    <FilmInspector
      audioPeaks={new Map()}
      canvas={canvas}
      catalog={fixtureCatalog}
      clips={clips}
      keyframes={new Map()}
      locale={locale}
      onAttributes={noop}
      onCanvas={(next) => {
        onCanvas(next)
        setCanvas(next)
      }}
      onCaptionStyle={noop}
      onCaptionText={noop}
      onGesture={noop}
      onHide={(id, hidden) =>
        setClips((current) => current.map((clip) => (clip.id === id ? { ...clip, hidden } : clip)))
      }
      onOpenCaptions={onOpenCaptions}
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
    />
  )
}

const head = () => screen.getByRole('banner')

describe('属性 · 画面尺寸', () => {
  const ratios = () => within(screen.getByRole('group', { name: '画面比例' }))
  const pressed = () =>
    ratios()
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-pressed') === 'true')
      .map((button) => button.textContent)
  const width = () => screen.getByRole('textbox', { name: '宽' })
  const height = () => screen.getByRole('textbox', { name: '高' })
  const RANGE_TEXT = '宽高要在 240–4096 之间'

  const renderCard = async (initialCanvas: Canvas = { width: 720, height: 1280 }) => {
    const onCanvas = vi.fn()
    const user = userEvent.setup()
    // 时间线上有视频片段时也能改
    await renderWithProviders(
      <Harness initial={[VIDEO]} initialCanvas={initialCanvas} onCanvas={onCanvas} selectedId="" />,
    )
    return { user, onCanvas }
  }

  it('六个比例按钮，宽高正好等于哪一种时它按下，都不是时都不按下；点一下改成它', async () => {
    const { user, onCanvas } = await renderCard()
    expect(
      ratios()
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['9:16', '3:4', '1:1', '4:3', '16:9', '21:9'])
    expect(pressed()).toEqual([])
    expect(width()).toHaveValue('720')
    expect(height()).toHaveValue('1280')

    await user.click(ratios().getByRole('button', { name: '21:9' }))
    expect(onCanvas).toHaveBeenLastCalledWith({ width: 2520, height: 1080 })
    expect(pressed()).toEqual(['21:9'])
    expect(width()).toHaveValue('2520')
    expect(height()).toHaveValue('1080')
  })

  it('数字框回车或失焦生效，奇数减 1；改成预设的宽高时那个比例按下', async () => {
    const { user, onCanvas } = await renderCard()
    await user.clear(width())
    await user.type(width(), '1081{Enter}')
    expect(onCanvas).toHaveBeenLastCalledWith({ width: 1080, height: 1280 })
    expect(width()).toHaveValue('1080')

    await user.clear(height())
    await user.type(height(), '1440')
    await user.tab()
    expect(onCanvas).toHaveBeenLastCalledWith({ width: 1080, height: 1440 })
    expect(pressed()).toEqual(['3:4'])
    expect(screen.queryByText(RANGE_TEXT)).toBeNull()
  })

  it('超出 240–4096、不是整数、空着时框下面提示，框回到原来的值，画面不变；下一次改成功后提示消失', async () => {
    const { user, onCanvas } = await renderCard()
    for (const typed of ['4097', '239', '12a', '1080.5']) {
      await user.clear(width())
      await user.type(width(), `${typed}{Enter}`)
      expect(screen.getByRole('alert')).toHaveTextContent(RANGE_TEXT)
      expect(width()).toHaveValue('720')
      expect(width()).toHaveAttribute('aria-invalid', 'true')
    }
    await user.clear(height())
    await user.tab()
    expect(height()).toHaveValue('1280')
    expect(onCanvas).not.toHaveBeenCalled()

    await user.clear(width())
    await user.type(width(), '4096{Enter}')
    expect(onCanvas).toHaveBeenLastCalledWith({ width: 4096, height: 1280 })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('Esc 放弃输入，回到原来的值', async () => {
    const { user, onCanvas } = await renderCard()
    await user.clear(width())
    await user.type(width(), '1920{Escape}')
    expect(width()).toHaveValue('720')
    expect(onCanvas).not.toHaveBeenCalled()
  })
})

describe('属性 · 分离出来的原声', () => {
  it('「声音与节奏」右上是「静音此段」，和头部的静音按钮是同一个状态', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness initial={[VIDEO, ORIGINAL]} selectedId="orig" />)
    const mute = screen.getByRole('switch', { name: '静音此段' })
    expect(screen.queryByRole('switch', { name: '循环播放' })).toBeNull()
    expect(mute).not.toBeChecked()

    await user.click(mute)
    expect(mute).toBeChecked()
    const unmute = within(head()).getByRole('button', { name: '取消静音' })
    await user.click(unmute)
    expect(mute).not.toBeChecked()
    expect(within(head()).getByRole('button', { name: '静音' })).toBeInTheDocument()
  })

  it('别的音频片段仍是「循环播放」', async () => {
    await renderWithProviders(<Harness initial={[MUSIC]} selectedId="music" />)
    expect(screen.getByRole('switch', { name: '循环播放' })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: '静音此段' })).toBeNull()
  })
})

describe('属性 · 片段种类', () => {
  it.each([
    ['其它语言的配音片段', ENGLISH_DUB],
    ['原文下的旁白片段', NARRATION],
  ])('%s头部写「AI 配音」', async (_, clip) => {
    await renderWithProviders(<Harness initial={[clip]} selectedId={clip.id} />)
    expect(within(head()).getByText('AI 配音')).toBeInTheDocument()
  })

  it('分离出来的原声仍写「分离原声」', async () => {
    await renderWithProviders(<Harness initial={[VIDEO, ORIGINAL]} selectedId="orig" />)
    expect(within(head()).getByText('分离原声')).toBeInTheDocument()
  })
})

describe('属性 · 「内容与样式」的语言小块', () => {
  it('贴片：标题右边写着显示着的语言，点它打开「字幕」', async () => {
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

  it('字幕：原文下写「原文」，点它打开「字幕」', async () => {
    const user = userEvent.setup()
    const onOpenCaptions = vi.fn()
    await renderWithProviders(
      <Harness initial={[caption()]} onOpenCaptions={onOpenCaptions} selectedId="cap-a1" />,
    )
    await user.click(screen.getByRole('button', { name: '显示的语言：原文' }))
    expect(onOpenCaptions).toHaveBeenCalledOnce()
  })
})
