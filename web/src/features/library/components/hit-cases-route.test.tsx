import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stubIntersectionObserver } from '@/testing/intersection-observer'
import { loginAs, mockAuthUser, mockGovernor } from '@/testing/mocks/handlers'
import { resetMockHitCases } from '@/testing/mocks/hit-cases'
import { mockLibraryVersionIds, mockLibraryVideos } from '@/testing/mocks/library'
import { mockTagId } from '@/testing/mocks/library-tags'
import { resetMockReferences } from '@/testing/mocks/references'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { stubScrollViewport } from '@/testing/scroll-viewport'
import { DEFAULT_HIT_CASE_SCOPE, type HitCaseScope } from '../hit-cases.api'
import { HitCasesRoute, type HitCaseTarget } from './hit-cases-route'

function Harness({ onTarget }: { onTarget?: (target: HitCaseTarget | null) => void }) {
  const [scope, setScope] = useState<HitCaseScope>(DEFAULT_HIT_CASE_SCOPE)
  const [target, setTarget] = useState<HitCaseTarget | null>(null)
  return (
    <HitCasesRoute
      cardId={target?.cardId ?? null}
      onHitCaseChange={(next) => {
        onTarget?.(next)
        setTarget(next)
      }}
      onScopeChange={(next) => {
        setScope(next)
        setTarget(null)
      }}
      scope={scope}
      shareLinkOf={(card, version) => `https://iclip.test/library?video=${card}&version=${version}`}
      tabs={null}
      versionId={target?.jobId ?? null}
    />
  )
}

const SKATE = '滑板女孩 · 厚底靴街拍'
const SANDALS = '春夏凉鞋合集'
const BEACH = '童鞋海边亲子'

const faceOf = (title: string) => {
  const video = mockLibraryVideos().find((candidate) => candidate.title === title)
  if (video === undefined) throw new Error(title)
  return { cardId: video.id, jobId: video.face.jobId }
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const recordListQueries = () => {
  const queries: URLSearchParams[] = []
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/library/hit-cases')) queries.push(url.searchParams)
  })
  return queries
}

beforeEach(() => {
  stubScrollViewport({ role: 'main', name: '资料库' }, { width: 1200, height: 900 })
})

describe('爆款素材库列表', () => {
  it('卡片同成片素材，打标中与打标失败带状态，打完的不带；入选晚的在前，底部计数', async () => {
    resetMockHitCases([
      { addedAt: minutesAgo(1), jobId: faceOf(SANDALS).jobId },
      { addedAt: minutesAgo(2), jobId: faceOf(BEACH).jobId, tagStatus: 'running' },
      {
        addedAt: minutesAgo(3),
        jobId: faceOf(SKATE).jobId,
        tagError: 'timeout',
        tagStatus: 'failed',
      },
    ])
    await renderWithProviders(<Harness />)

    await screen.findByRole('article', { name: SANDALS })
    expect(screen.getAllByRole('article').map((card) => card.getAttribute('aria-label'))).toEqual([
      SANDALS,
      BEACH,
      SKATE,
    ])
    const sandals = screen.getByRole('article', { name: SANDALS })
    expect(within(sandals).queryByText(/打标/)).not.toBeInTheDocument()
    expect(within(screen.getByRole('article', { name: BEACH })).getByText('正在打标')).toBeVisible()
    expect(within(screen.getByRole('article', { name: SKATE })).getByText('打标失败')).toBeVisible()
    // 一张卡里的一版，不带整张卡的组数与版数。
    expect(within(screen.getByRole('article', { name: SKATE })).queryByText(/版$/)).toBeNull()
    expect(screen.getByText('共 3 条')).toBeVisible()
  })

  it('按标签筛选：选中的标签带进查询，计数改说找到几条；没有匹配时说怎么办', async () => {
    resetMockHitCases([
      { jobId: faceOf(SANDALS).jobId, tagIds: [mockTagId('AMZ')] },
      { jobId: faceOf(BEACH).jobId, tagIds: [mockTagId('DTC')] },
    ])
    const queries = recordListQueries()
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await screen.findByText('共 2 条')

    await user.click(screen.getByRole('button', { name: '平台&渠道：平台&渠道' }))
    const popup = await screen.findByRole('dialog', { name: '选择平台&渠道' })
    // 候选旁的条数是爆款素材库自己的。
    expect(within(popup).getByRole('checkbox', { name: /^AMZ/ })).toHaveAccessibleName('AMZ1')
    expect(within(popup).getByRole('checkbox', { name: /^TikTok/ })).toHaveAccessibleName('TikTok0')
    await user.click(within(popup).getByRole('checkbox', { name: /^AMZ/ }))

    expect(await screen.findByText('找到 1 条')).toBeVisible()
    expect(queries.at(-1)?.getAll('tags')).toEqual([mockTagId('AMZ')])
    expect(screen.getAllByRole('article').map((card) => card.getAttribute('aria-label'))).toEqual([
      SANDALS,
    ])

    await user.click(within(popup).getByRole('checkbox', { name: /^AMZ/ }))
    await user.click(within(popup).getByRole('checkbox', { name: /^TikTok/ }))
    expect(await screen.findByText('暂无匹配的爆款素材，请更换或清除标签筛选')).toBeVisible()
  })

  it('空的时候说怎么把素材片加进来', async () => {
    resetMockHitCases([])
    await renderWithProviders(<Harness />)

    expect(
      await screen.findByText(
        '暂无爆款素材，请在「成片素材」中打开一条视频，在「爆款素材」页签点击「加入爆款素材库」',
      ),
    ).toBeVisible()
  })
})

describe('从爆款素材库打开', () => {
  beforeEach(() => {
    stubIntersectionObserver()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  })

  it('打开所在的卡并选中那一版；上一条、下一条按爆款列表走，同一张卡的另一版也算一条', async () => {
    const [, second, third] = mockLibraryVersionIds(SKATE)
    if (second === undefined || third === undefined) throw new Error('滑板女孩至少要有三版')
    const skateCard = faceOf(SKATE).cardId
    resetMockHitCases([
      { addedAt: minutesAgo(1), jobId: second },
      { addedAt: minutesAgo(2), jobId: third },
      { addedAt: minutesAgo(3), jobId: faceOf(SANDALS).jobId },
    ])
    const onTarget = vi.fn()
    const user = userEvent.setup()
    await renderWithProviders(<Harness onTarget={onTarget} />)

    const cards = await screen.findAllByRole('article', { name: SKATE })
    await user.click(within(cards[0] as HTMLElement).getByRole('button', { name: /查看详情/ }))
    expect(onTarget).toHaveBeenLastCalledWith({ cardId: skateCard, jobId: second })
    const viewer = await screen.findByRole('dialog', { name: SKATE })
    const versions = await within(viewer).findByRole('group', { name: '该镜头组的版本' })
    await waitFor(() =>
      expect(within(versions).getByRole('button', { pressed: true })).toHaveAccessibleName('2'),
    )

    await user.click(within(viewer).getByRole('button', { name: '下一条' }))
    expect(onTarget).toHaveBeenLastCalledWith({ cardId: skateCard, jobId: third })
    await waitFor(() =>
      expect(
        within(
          within(screen.getByRole('dialog', { name: SKATE })).getByRole('group', {
            name: '该镜头组的版本',
          }),
        ).getByRole('button', { pressed: true }),
      ).toHaveAccessibleName('3'),
    )

    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '下一条' }))
    expect(await screen.findByRole('dialog', { name: SANDALS })).toBeVisible()
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: '下一条' }),
    ).toHaveAttribute('aria-disabled', 'true')
  })
})

describe('爆款素材库的管理标签', () => {
  it('非治理者看不到入口', async () => {
    loginAs(mockAuthUser)
    resetMockHitCases([{ jobId: faceOf(SANDALS).jobId }])
    await renderWithProviders(<Harness />)

    await screen.findByRole('article', { name: SANDALS })
    expect(screen.queryByRole('button', { name: '管理标签' })).toBeNull()
  })

  it('治理者打开后面板替换卡片列表，条数算上爆款，「完成」回到列表', async () => {
    loginAs(mockGovernor)
    resetMockReferences([])
    resetMockHitCases([{ jobId: faceOf(SANDALS).jobId, tagIds: [mockTagId('AMZ')] }])
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await screen.findByRole('article', { name: SANDALS })

    await user.click(screen.getByRole('button', { name: '管理标签' }))
    const panel = await screen.findByRole('region', { name: '管理标签' })

    expect(screen.getByRole('button', { name: '管理标签' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('article')).toBeNull()
    await user.click(within(panel).getByRole('button', { name: /^切换维度/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: '平台&渠道' }))
    const values = await within(panel).findByRole('list', { name: '平台&渠道的取值' })
    expect(within(values).getByText('灵感库 0 · 爆款 1')).toBeVisible()
    expect(within(values).getAllByText('灵感库 0 · 爆款 0')).toHaveLength(4)
    await user.click(within(panel).getByRole('button', { name: '完成' }))
    expect(await screen.findByRole('article', { name: SANDALS })).toBeVisible()
  })
})
