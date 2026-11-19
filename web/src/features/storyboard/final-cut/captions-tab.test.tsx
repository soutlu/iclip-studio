import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { audio, caption, fixtureCatalog, host } from '@/testing/final-cut'
import { renderWithProviders } from '@/testing/render'
import { captionsFocus } from './caption-edit'
import { CaptionsTab } from './captions-tab'
import type { FilmClip } from './composition/film'
import { textHosts } from './composition/locale-text'
import type { LocaleControls } from './editor-toolbar'
import { SOURCE_SHOWN } from './locales'

const FIRST = caption({ id: 'cap-a1', text: '第一句', variable: 'cap_a1', start: 0 })
const SECOND = caption({ id: 'cap-b2', text: '第二句', variable: 'cap_b2', start: 3000 })
const TITLE = host({ id: 'title-1', start: 1000 })
const DUB = audio({
  id: 'en-b2',
  start: 3000,
  dub: { locale: 'en', caption: 'cap-b2', trimmed: false, voice: null },
})
const CLIPS: readonly FilmClip[] = [FIRST, SECOND, TITLE, DUB]

/** 和编辑器一样：选中由外面记着，「字幕」按选中的片段算该标哪句、该切到哪一段。 */
function Harness({ locales }: { locales: LocaleControls }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const hosts = textHosts(CLIPS, fixtureCatalog)
  const picked = CLIPS.filter((clip) => selected.has(clip.id))
  const noop = () => {}
  return (
    <>
      {CLIPS.map((clip) => (
        <button key={clip.id} onClick={() => setSelected(new Set([clip.id]))} type="button">
          {`时间线上选中 ${clip.id}`}
        </button>
      ))}
      <CaptionsTab
        active
        addBlocked={undefined}
        captions={[FIRST, SECOND]}
        focus={captionsFocus(picked, new Set(hosts.map((each) => each.id)))}
        locale={SOURCE_SHOWN}
        locales={locales}
        narration={undefined}
        onAdd={() => Promise.resolve(undefined)}
        onNotice={noop}
        onPick={noop}
        onRecognize={noop}
        onRemove={noop}
        onText={noop}
        problem={undefined}
        recognizeBlocked={undefined}
        recognizing={0}
        selected={selected}
        texts={{
          hosts,
          catalog: fixtureCatalog,
          bindings: new Map(),
          multilingual: false,
          onText: noop,
          onFollow: noop,
          onPick: noop,
        }}
        translate={undefined}
        voice={undefined}
      />
    </>
  )
}

const renderTab = async () => {
  const locales = {
    current: null,
    present: ['en'],
    onSwitch: vi.fn<LocaleControls['onSwitch']>(),
    onAdd: vi.fn<LocaleControls['onAdd']>(),
  } satisfies LocaleControls
  await renderWithProviders(<Harness locales={locales} />)
  return { ...locales, user: userEvent.setup() }
}

const languages = () => screen.getByRole('group', { name: '原文与译文' })
const view = (name: RegExp) =>
  within(screen.getByRole('group', { name: '字幕或组件文字' })).getByRole('button', { name })
const pick = (user: ReturnType<typeof userEvent.setup>, id: string) =>
  user.click(screen.getByRole('button', { name: `时间线上选中 ${id}` }))

describe('「字幕」顶部的语言', () => {
  it('原文和加了的语言各一个小块，写语言代码，当前的高亮；点一个切过去', async () => {
    const { user, onSwitch } = await renderTab()
    const chips = within(languages()).getAllByRole('button')
    expect(chips.map((chip) => chip.textContent)).toEqual(['原文', 'EN', ''])
    expect(within(languages()).getByRole('button', { name: '原文' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await user.click(within(languages()).getByRole('button', { name: 'English（EN）' }))
    expect(onSwitch).toHaveBeenCalledExactlyOnceWith('en')
  })

  it('点「+」列出还没加的语言（和工具条上的一样），选一个加上', async () => {
    const { user, onAdd } = await renderTab()
    await user.click(within(languages()).getByRole('button', { name: '添加语言' }))
    const menu = await screen.findByRole('menu')
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['中文（ZH）', 'Deutsch（DE）', 'Español（ES）', 'Français（FR）'])
    await user.click(within(menu).getByRole('menuitem', { name: 'Deutsch（DE）' }))
    expect(onAdd).toHaveBeenCalledExactlyOnceWith('de')
  })
})

describe('「字幕」跟着选中走', () => {
  it('时间线上选中有文字的贴片：切到「组件文字」', async () => {
    const { user } = await renderTab()
    expect(view(/^字幕/)).toHaveAttribute('aria-pressed', 'true')
    await pick(user, 'title-1')
    expect(view(/^组件文字/)).toHaveAttribute('aria-pressed', 'true')
  })

  it('选中配音片段：切回「字幕」，标出它配的那一句', async () => {
    const { user } = await renderTab()
    await pick(user, 'title-1')
    await pick(user, 'en-b2')
    expect(view(/^字幕/)).toHaveAttribute('aria-pressed', 'true')
    const rows = within(screen.getByRole('list', { name: '字幕' })).getAllByRole('listitem')
    expect(rows.map((row) => row.getAttribute('aria-current'))).toEqual([null, 'true'])
  })

  it('选中以后用户自己点了另一段：听用户的，直到下一次选中变了', async () => {
    const { user } = await renderTab()
    await pick(user, 'title-1')
    await user.click(view(/^字幕/))
    await pick(user, 'title-1')
    expect(view(/^字幕/)).toHaveAttribute('aria-pressed', 'true')
    await pick(user, 'cap-a1')
    await pick(user, 'title-1')
    expect(view(/^组件文字/)).toHaveAttribute('aria-pressed', 'true')
  })
})
