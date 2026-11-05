import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { HomePage } from '../-home-page'

const homeSearchSchema = z.object({
  collection: z.uuid().optional().catch(undefined),
  same: z.uuid().optional().catch(undefined),
  reference: z.uuid().optional().catch(undefined),
})

export const Route = createFileRoute('/_shell/')({
  component: HomePage,
  validateSearch: homeSearchSchema,
})
