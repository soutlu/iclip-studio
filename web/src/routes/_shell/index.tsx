import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { HomePage } from '../-home-page'

/** 首页查询串，首页读到后即从地址栏移除：侧栏合集行「在合集里新建任务」带来的合集，资料库「做同款」带来的卡。 */
const homeSearchSchema = z.object({
  collection: z.uuid().optional().catch(undefined),
  same: z.uuid().optional().catch(undefined),
})

export const Route = createFileRoute('/_shell/')({
  component: HomePage,
  validateSearch: homeSearchSchema,
})
