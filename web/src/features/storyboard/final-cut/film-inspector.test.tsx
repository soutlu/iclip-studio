import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { audio, caption, fixtureCatalog, host, video } from '@/testing/final-cut'
import { renderWithProviders } from '@/testing/render'
import type { FilmClip } from './composition/film'
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
}: {
  initial: readonly FilmClip[]
  selectedId: string
  locale?: ShownLocale
  onOpenCaptions?: () => void
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

describe('属性 · 分离出来的原声', () => {
  it('「音量与变速」右上是「静音此段」，和头部的静音按钮是同一个状态', async () => {
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
  it('贴片：标题右边写着显示着的语言，点它打开「字幕·配音」', async () => {
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

  it('字幕：原文下写「原文」，点它打开「字幕·配音」', async () => {
    const user = userEvent.setup()
    const onOpenCaptions = vi.fn()
    await renderWithProviders(
      <Harness initial={[caption()]} onOpenCaptions={onOpenCaptions} selectedId="cap-a1" />,
    )
    await user.click(screen.getByRole('button', { name: '显示的语言：原文' }))
    expect(onOpenCaptions).toHaveBeenCalledOnce()
  })
})
