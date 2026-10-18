import { fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderWithTooltip } from '@/testing/render'
import { StageBackdrop } from './stage-backdrop'

const urls = [
  'https://media.test/a.jpg',
  'https://media.test/b.jpg',
  'https://media.test/c.jpg',
] as const
const imageFor = (container: HTMLElement, url: string) => {
  const image = [...container.querySelectorAll('img')].find((item) => item.src === url)
  if (image === undefined) throw new Error(`没有背景图片：${url}`)
  return image
}

describe('StageBackdrop', () => {
  it('快速换图时保留最后加载成功的背景，下一张加载成功后才显示', () => {
    const { container, rerender } = renderWithTooltip(<StageBackdrop url={urls[0]} />)
    fireEvent.load(imageFor(container, urls[0]))
    rerender(<StageBackdrop url={urls[1]} />)
    expect(imageFor(container, urls[0])).toBeVisible()
    expect(imageFor(container, urls[1])).not.toBeVisible()
    rerender(<StageBackdrop url={urls[2]} />)
    expect(imageFor(container, urls[0])).toBeVisible()
    expect(imageFor(container, urls[2])).not.toBeVisible()
    fireEvent.load(imageFor(container, urls[2]))
    expect(imageFor(container, urls[2])).toBeVisible()
  })

  it('候选图片加载失败保留已加载背景；没有URL立即清空，再打开不恢复旧来源', () => {
    const { container, rerender } = renderWithTooltip(<StageBackdrop url={urls[0]} />)
    fireEvent.load(imageFor(container, urls[0]))
    rerender(<StageBackdrop url={urls[1]} />)
    fireEvent.error(imageFor(container, urls[1]))
    expect(imageFor(container, urls[0])).toBeVisible()
    expect(imageFor(container, urls[1])).not.toBeVisible()
    rerender(<StageBackdrop url={undefined} />)
    expect(container.querySelectorAll('img')).toHaveLength(0)
    rerender(<StageBackdrop url={urls[2]} />)
    expect(imageFor(container, urls[2])).not.toBeVisible()
  })

  it('切回仍在DOM中的已缓存图片，不依赖重复的load事件', () => {
    const { container, rerender } = renderWithTooltip(<StageBackdrop url={urls[0]} />)
    const first = imageFor(container, urls[0])
    Object.defineProperty(first, 'complete', { configurable: true, value: true })
    Object.defineProperty(first, 'naturalWidth', { configurable: true, value: 320 })
    fireEvent.load(first)
    rerender(<StageBackdrop url={urls[1]} />)
    fireEvent.load(imageFor(container, urls[1]))
    rerender(<StageBackdrop url={urls[0]} />)
    expect(imageFor(container, urls[0])).toBeVisible()
  })
})
