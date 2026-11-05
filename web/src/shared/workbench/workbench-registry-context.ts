import { createContext } from 'react'
import type { ArtifactRegistry } from './registry'

export const WorkbenchRegistryContext = createContext<ArtifactRegistry | null>(null)
