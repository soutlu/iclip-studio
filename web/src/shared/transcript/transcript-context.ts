/** 通过 Context 注入连接、两个读取池与本地发送状态，允许测试替换 WebSocket 实现而无需 mock 模块。 */

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
