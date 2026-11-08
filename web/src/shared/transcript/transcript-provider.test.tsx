import { act, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, expect, it } from 'vitest'
import { FakeSocket, SERVER_HELLO } from '@/testing/ws'
import { TranscriptProvider } from './transcript-provider'

describe('TranscriptProvider', () => {
  it('StrictMode 开发态挂载只建一条连接，且就是在用的那条', async () => {
    const sockets: FakeSocket[] = []
    const createSocket = () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket as unknown as WebSocket
    }

    render(
      <StrictMode>
        <TranscriptProvider createSocket={createSocket}>{null}</TranscriptProvider>
      </StrictMode>,
    )
    await act(async () => {})

    expect(sockets).toHaveLength(1)
    const [socket] = sockets
    act(() => {
      socket?.deliver(SERVER_HELLO)
      socket?.deliver({ payload: { nonce: 'n1' }, type: 'ping' })
    })
    expect(socket?.frames()).toContainEqual({ payload: { nonce: 'n1' }, type: 'pong' })
  })
})
