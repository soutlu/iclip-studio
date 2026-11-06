// OSS 只有 HTTP/1.1，浏览器每域名 6 条连接：激活槽位、预加载槽位、关键帧读取占 3 条，剩下的给缩略图。
const MAX_RUNNING = 3

type Ticket = { start: () => void }

const waiting = new Set<Ticket>()
const running = new Set<Ticket>()

const advance = () => {
  for (const ticket of waiting) {
    if (running.size >= MAX_RUNNING) return
    waiting.delete(ticket)
    running.add(ticket)
    ticket.start()
  }
}

export const acquire = (start: () => void): (() => void) => {
  const ticket = { start }
  waiting.add(ticket)
  advance()
  return () => {
    waiting.delete(ticket)
    if (running.delete(ticket)) advance()
  }
}
