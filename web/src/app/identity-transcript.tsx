import { useState, type ReactNode } from 'react'
import { useUser } from '@/shared/auth'
import { TranscriptProvider } from '@/shared/transcript/transcript-provider'

const useIdentityKey = (): number => {
  const { data, isSuccess } = useUser()
  const identity = isSuccess ? (data?.id ?? null) : undefined
  const [scope, setScope] = useState({ generation: 0, identity })
  if (identity !== undefined && identity !== scope.identity) {
    setScope({
      generation: scope.identity === undefined ? scope.generation : scope.generation + 1,
      identity,
    })
  }
  return scope.generation
}

type IdentityTranscriptProviderProps = {
  children: ReactNode
  createSocket?: ((url: string) => WebSocket) | undefined
}

export function IdentityTranscriptProvider({
  children,
  createSocket,
}: IdentityTranscriptProviderProps) {
  return (
    <TranscriptProvider createSocket={createSocket} identityKey={useIdentityKey()}>
      {children}
    </TranscriptProvider>
  )
}
