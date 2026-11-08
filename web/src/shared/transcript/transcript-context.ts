import { createContext } from 'react'
import type { TranscriptConnection } from './connection'
import type { LocalPromptStore } from './local-prompts'
import type { MainTranscriptPool } from './main-pool'
import type { SubAgentTranscriptPool } from './sub-agent-pool'

export const TranscriptConnectionContext = createContext<TranscriptConnection | null>(null)

export interface TranscriptPools {
  main: MainTranscriptPool
  sub: SubAgentTranscriptPool
}

export const TranscriptPoolsContext = createContext<TranscriptPools | null>(null)

export const LocalPromptsContext = createContext<LocalPromptStore | null>(null)
