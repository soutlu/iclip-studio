import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AudioCover, audioCoverArt } from './audio-cover'

describe('audioCoverArt', () => {
  it('音色的 8 类场景并成 5 张插画；填了几个场景时按固定先后取第一个对得上的', () => {
    expect(audioCoverArt('v-1', { scenarios: ['wellness'] })).toBe('clara')
    expect(audioCoverArt('v-2', { scenarios: ['commercials'] })).toBe('klaus')
    expect(audioCoverArt('v-3', { scenarios: ['trailers'] })).toBe('klaus')
    expect(audioCoverArt('v-4', { scenarios: ['explainers'] })).toBe('marcus')
    expect(audioCoverArt('v-5', { scenarios: ['tutorials'] })).toBe('marcus')
    expect(audioCoverArt('v-6', { scenarios: ['documentaries'] })).toBe('marcus')
    expect(audioCoverArt('v-7', { scenarios: ['social'] })).toBe('emma')
    expect(audioCoverArt('v-8', { scenarios: ['characters'] })).toBe('gentle')
    expect(audioCoverArt('v-9', { gender: 'male', scenarios: ['social', 'wellness'] })).toBe(
      'clara',
    )
  })

  it('音色没填场景时按性别和年龄挑：女声叶子 / 同心圆，男声话筒 / 收音机', () => {
    expect(audioCoverArt('v-f', { gender: 'female' })).toBe('emma')
    expect(audioCoverArt('v-fy', { gender: 'female', age: 'young' })).toBe('emma')
    expect(audioCoverArt('v-fm', { gender: 'female', age: 'middle' })).toBe('gentle')
    expect(audioCoverArt('v-m', { gender: 'male', age: 'young' })).toBe('klaus')
    expect(audioCoverArt('v-ms', { gender: 'male', age: 'senior' })).toBe('marcus')
    expect(audioCoverArt('v-n', { gender: 'neutral' })).toBe('clara')
  })

  it('什么都没填时按编号在 5 张音色插画里稳定挑一张', () => {
    const first = audioCoverArt('v-raw')
    expect(['emma', 'klaus', 'gentle', 'clara', 'marcus']).toContain(first)
    expect(audioCoverArt('v-raw')).toBe(first)
  })

  it('配乐按曲风或情绪匹配对应插画，未填属性时按编号稳定回退', () => {
    expect(audioCoverArt('b-1', { audioKind: 'bgm', genre: 'piano' })).toBe('commute')
    expect(audioCoverArt('b-2', { audioKind: 'bgm', genre: 'acoustic' })).toBe('linen')
    expect(audioCoverArt('b-3', { audioKind: 'bgm', genre: 'electronic' })).toBe('pulse')
    expect(audioCoverArt('b-4', { audioKind: 'bgm', genre: 'orchestral' })).toBe('velvet')
    expect(audioCoverArt('b-5', { audioKind: 'bgm', mood: 'warm' })).toBe('linen')
    expect(audioCoverArt('b-6', { audioKind: 'bgm', mood: 'uplifting' })).toBe('pulse')
    expect(audioCoverArt('b-7', { audioKind: 'bgm', mood: 'epic' })).toBe('velvet')
    expect(['commute', 'linen', 'pulse', 'velvet']).toContain(
      audioCoverArt('b-raw', { audioKind: 'bgm' }),
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

  it('插画是装饰图，不进读屏；指定 art 时换成指定的那张', () => {
    const { container, rerender } = render(
      <AudioCover
        id="b-1"
        state="idle"
        title="钢琴"
        traits={{ audioKind: 'bgm', genre: 'piano' }}
      />,
    )
    const image = () => container.querySelector('img')
    expect(image()).toHaveAttribute('alt', '')
    const piano = image()?.getAttribute('src')

    rerender(<AudioCover art="original" id="b-1" state="idle" title="原片音色" />)
    expect(image()?.getAttribute('src')).not.toBe(piano)
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
