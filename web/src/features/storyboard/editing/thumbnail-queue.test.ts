import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquire } from './thumbnail-queue'

const cancels: (() => void)[] = []

const enqueue = () => {
  const start = vi.fn<() => void>()
  const cancel = acquire(start)
  cancels.push(cancel)
  return { start, cancel }
}

afterEach(() => {
  for (const cancel of cancels.splice(0)) cancel()
})

describe('acquire', () => {
  it('同时最多 3 个在跑', () => {
    const tickets = [enqueue(), enqueue(), enqueue(), enqueue()]
    expect(tickets.map(({ start }) => start.mock.calls.length)).toEqual([1, 1, 1, 0])
  })

  it('释放后按先进先出轮到下一个', () => {
    const [first, , , fourth, fifth] = [enqueue(), enqueue(), enqueue(), enqueue(), enqueue()]
    first?.cancel()
    expect(fourth?.start).toHaveBeenCalledTimes(1)
    expect(fifth?.start).not.toHaveBeenCalled()
  })

  it('取消排队的不占名额，也不会再开始', () => {
    const [first, , , fourth, fifth] = [enqueue(), enqueue(), enqueue(), enqueue(), enqueue()]
    fourth?.cancel()
    first?.cancel()
    expect(fourth?.start).not.toHaveBeenCalled()
    expect(fifth?.start).toHaveBeenCalledTimes(1)
  })

  it('重复释放只还一个名额', () => {
    const [first, , , fourth, fifth] = [enqueue(), enqueue(), enqueue(), enqueue(), enqueue()]
    first?.cancel()
    first?.cancel()
    expect(fourth?.start).toHaveBeenCalledTimes(1)
    expect(fifth?.start).not.toHaveBeenCalled()
  })
})
