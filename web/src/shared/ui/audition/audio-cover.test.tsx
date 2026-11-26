import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AudioCover, audioCoverAppearance } from './audio-cover'

describe('audioCoverAppearance', () => {
  it('按音色场景与声线区分图形和色调，相邻常见音色不撞形撞色', () => {
    const bright = audioCoverAppearance('v-1', {
      audioKind: 'voice',
      gender: 'female',
      age: 'young',
      scenarios: ['commercials', 'social'],
    })
    const energetic = audioCoverAppearance('v-2', {
      audioKind: 'voice',
      gender: 'male',
      age: 'young',
      scenarios: ['social', 'tutorials'],
    })
    const calm = audioCoverAppearance('v-3', {
      audioKind: 'voice',
      gender: 'female',
      age: 'young',
      scenarios: ['social', 'wellness'],
    })

    expect(bright).toEqual({ glyph: 'audio-cover-bright', tone: 'copper' })
    expect(energetic).toEqual({ glyph: 'audio-cover-studio', tone: 'teal' })
    expect(calm).toEqual({ glyph: 'audio-cover-calm', tone: 'umber' })
  })

  it('覆盖其余音色场景与仅填性别年龄的回退规则', () => {
    expect(audioCoverAppearance('v-doc', { scenarios: ['documentaries'] })).toEqual({
      glyph: 'audio-cover-cinema',
      tone: 'slate',
    })
    expect(audioCoverAppearance('v-char', { scenarios: ['characters'] })).toEqual({
      glyph: 'audio-cover-dialogue',
      tone: 'ochre',
    })
    expect(audioCoverAppearance('v-exp', { scenarios: ['explainers'] })).toEqual({
      glyph: 'audio-cover-tuning',
      tone: 'slate',
    })
    expect(audioCoverAppearance('v-ad-m', { gender: 'male', scenarios: ['commercials'] })).toEqual({
      glyph: 'audio-cover-broadcast',
      tone: 'copper',
    })
    expect(audioCoverAppearance('v-soc', { scenarios: ['social'] })).toEqual({
      glyph: 'audio-cover-pulse',
      tone: 'teal',
    })
    expect(audioCoverAppearance('v-fm', { gender: 'female', age: 'middle' })).toEqual({
      glyph: 'audio-cover-calm',
      tone: 'umber',
    })
    expect(audioCoverAppearance('v-ms', { gender: 'male', age: 'senior' })).toEqual({
      glyph: 'audio-cover-cinema',
      tone: 'slate',
    })
    expect(audioCoverAppearance('v-neu', { gender: 'neutral' })).toEqual({
      glyph: 'audio-cover-tuning',
      tone: 'slate',
    })
  })

  it('配乐按曲风或情绪匹配对应封面图形，未填属性时按编号稳定回退', () => {
    expect(audioCoverAppearance('b-1', { audioKind: 'bgm', genre: 'piano' })).toEqual({
      glyph: 'audio-cover-piano',
      tone: 'slate',
    })
    expect(audioCoverAppearance('b-2', { audioKind: 'bgm', genre: 'acoustic' })).toEqual({
      glyph: 'audio-cover-acoustic',
      tone: 'umber',
    })
    expect(audioCoverAppearance('b-3', { audioKind: 'bgm', genre: 'electronic' })).toEqual({
      glyph: 'audio-cover-electronic',
      tone: 'teal',
    })
    expect(audioCoverAppearance('b-4', { audioKind: 'bgm', genre: 'orchestral' })).toEqual({
      glyph: 'audio-cover-vinyl',
      tone: 'ochre',
    })
    expect(audioCoverAppearance('b-5', { audioKind: 'bgm', mood: 'warm' })).toEqual({
      glyph: 'audio-cover-acoustic',
      tone: 'umber',
    })
    expect(audioCoverAppearance('b-6', { audioKind: 'bgm', mood: 'epic' })).toEqual({
      glyph: 'audio-cover-vinyl',
      tone: 'ochre',
    })
    expect(audioCoverAppearance('b-raw', { audioKind: 'bgm' })).toEqual(
      audioCoverAppearance('b-raw', { audioKind: 'bgm' }),
    )
  })
})

describe('AudioCover', () => {
  it('可点击封面提供试听与暂停试听无障碍名称，支持点击与键盘触发', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    const { rerender } = render(
      <AudioCover id="v-1" onToggle={onToggle} state="idle" title="清亮女声" />,
    )

    const button = screen.getByRole('button', { name: '试听：清亮女声' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    await user.click(button)
    await user.keyboard('{Enter}')
    expect(onToggle).toHaveBeenCalledTimes(2)

    rerender(<AudioCover id="v-1" onToggle={onToggle} state="playing" title="清亮女声" />)
    const playingButton = screen.getByRole('button', { name: '暂停试听：清亮女声' })
    expect(playingButton).toHaveAttribute('aria-pressed', 'true')
  })

  it('不传 onToggle 时作为纯装饰封面渲染，不嵌套多余按钮且保留子层提示', () => {
    render(
      <AudioCover id="v-1" size="sm" state="paused" title="清亮女声">
        <span role="status">缓冲中</span>
      </AudioCover>,
    )

    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('缓冲中')
  })
})
