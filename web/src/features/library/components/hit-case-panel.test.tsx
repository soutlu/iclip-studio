import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { toast, Toaster } from '@/shared/ui/toast'
import { loginAs, mockAuthUser } from '@/testing/mocks/handlers'
import { resetMockHitCases } from '@/testing/mocks/hit-cases'
import { mockLibraryVideos } from '@/testing/mocks/library'
import { mockTagId } from '@/testing/mocks/library-tags'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { HitCasePanel } from './hit-case-panel'

const faceJobOf = (title: string | null) => {
  const video = mockLibraryVideos().find((candidate) => candidate.title === title)
  if (video === undefined) throw new Error(String(title))
  return video.face.jobId
}

/** 记下发出的写请求：方法、路径（去掉 /api）与请求体。 */
const recordWrites = () => {
  const writes: { method: string; path: string; body: unknown }[] = []
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url)
    if (request.method === 'GET' || !url.pathname.includes('/library/hit-cases')) return
    void request
      .clone()
      .text()
      .then((text) =>
        writes.push({
          body: text === '' ? undefined : (JSON.parse(text) as unknown),
          method: request.method,
          path: url.pathname.replace('/api', ''),
        }),
      )
  })
  return writes
}

const renderPanel = (jobId: string) =>
  renderWithProviders(
    <>
      <HitCasePanel jobId={jobId} />
      <Toaster />
    </>,
  )

const dimensionRows = () =>
  screen
    .getAllByRole('group')
    .map((group) => group.getAttribute('aria-label'))
    .filter((name) => ['品牌', '平台&渠道', '品类', '场景', '内容结构'].includes(name ?? ''))

beforeEach(() => {
  loginAs(mockAuthUser)
  resetMockHitCases([])
})

afterEach(() => {
  toast.dismiss()
})

describe('没入选、能入选', () => {
  it('只让选人工维度；加入时把选的标签一起带上，之后显示打标中与全部维度', async () => {
    const jobId = faceJobOf('跑鞋手持展示')
    const writes = recordWrites()
    const user = userEvent.setup()
    await renderPanel(jobId)

    const add = await screen.findByRole('button', { name: '加入爆款素材库' })
    expect(dimensionRows()).toEqual(['品牌', '平台&渠道'])
    await user.click(screen.getByRole('button', { name: '添加平台&渠道' }))
    const picker = await screen.findByRole('dialog', { name: '添加平台&渠道' })
    await user.click(within(picker).getByRole('option', { name: 'AMZ' }))
    expect(within(screen.getByRole('group', { name: '平台&渠道' })).getByText('AMZ')).toBeVisible()
    await user.click(add)

    await waitFor(() =>
      expect(writes).toEqual([
        {
          body: { tagIds: [mockTagId('AMZ')] },
          method: 'PUT',
          path: `/library/hit-cases/${jobId}`,
        },
      ]),
    )
    expect(await screen.findByText('正在打标，完成后自动更新标签')).toBeVisible()
    expect(dimensionRows()).toEqual(['品牌', '平台&渠道', '品类', '场景', '内容结构'])
    expect(screen.getByRole('button', { name: '移出爆款素材库' })).toBeVisible()
    expect(screen.getByText(/由 tester 加入爆款素材库$/)).toBeVisible()
  })
})

describe('不能入选', () => {
  it.each([
    ['所在对话没有新片执行方案', '跑鞋质感大片', '所在对话没有新片执行方案，无法加入爆款素材库'],
    ['不属于任何对话', null, '该视频不属于任何对话，没有新片执行方案，无法加入爆款素材库'],
  ])('%s：按钮置灰，点按说明原因，不发请求', async (_name, title, hint) => {
    const writes = recordWrites()
    const user = userEvent.setup()
    await renderPanel(faceJobOf(title))

    const add = await screen.findByRole('button', { name: '加入爆款素材库' })
    expect(add).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByRole('group', { name: '平台&渠道' })).not.toBeInTheDocument()
    await user.click(add)

    expect(await screen.findByRole('tooltip')).toHaveTextContent(hint)
    expect(writes).toEqual([])
  })
})

describe('已入选', () => {
  it('改标签整份 PUT；打标失败说原因，确认后重新打标；确认后移出，回到能加入的样子', async () => {
    const jobId = faceJobOf('春夏凉鞋合集')
    resetMockHitCases([
      {
        jobId,
        tagError: 'no_source_text',
        tagIds: [mockTagId('AMZ'), mockTagId('TikTok')],
        tagStatus: 'failed',
      },
    ])
    const writes = recordWrites()
    const user = userEvent.setup()
    await renderPanel(jobId)

    expect(
      await screen.findByText(
        '所在对话暂无可读的新片执行方案，无法打标，AI 打的标签已清空；请在补充新片执行方案后点击「重新打标」重试。',
      ),
    ).toBeVisible()
    // AI 维度旁的提示是爆款的说法。
    expect(
      within(screen.getByRole('group', { name: '品类' })).getByRole('img', {
        name: '由 AI 自动打标，重新打标时会重写该项标签',
      }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '移除TikTok' }))
    await waitFor(() =>
      expect(writes.at(-1)).toEqual({
        body: { tagIds: [mockTagId('AMZ')] },
        method: 'PUT',
        path: `/library/hit-cases/${jobId}/tags`,
      }),
    )

    await user.click(within(screen.getByRole('alert')).getByRole('button', { name: '重新打标' }))
    expect(screen.getByRole('status')).toHaveTextContent('重新打标会按所在对话当前的新片执行方案')
    await user.click(screen.getByRole('button', { name: '重新打标' }))
    await waitFor(() =>
      expect(writes.at(-1)).toMatchObject({
        method: 'POST',
        path: `/library/hit-cases/${jobId}/tagging`,
      }),
    )
    expect(await screen.findByText('正在打标，完成后自动更新标签')).toBeVisible()

    await user.click(screen.getByRole('button', { name: '移出爆款素材库' }))
    await user.click(screen.getByRole('button', { name: '移出' }))
    await waitFor(() =>
      expect(writes.at(-1)).toMatchObject({
        method: 'DELETE',
        path: `/library/hit-cases/${jobId}`,
      }),
    )
    expect(await screen.findByRole('button', { name: '加入爆款素材库' })).not.toHaveAttribute(
      'aria-disabled',
    )
  })

  it('没有提交权限的人看得到打标失败，但没有「重新打标」', async () => {
    loginAs(mockAuthUser, {
      permissions: mockAuthUser.permissions.filter((one) => one !== 'generation:submit'),
    })
    const jobId = faceJobOf('春夏凉鞋合集')
    resetMockHitCases([{ jobId, tagError: 'timeout', tagStatus: 'failed' }])
    await renderPanel(jobId)

    expect(await screen.findByText('打标超时，AI 打的标签已清空。')).toBeVisible()
    expect(screen.queryByRole('button', { name: '重新打标' })).not.toBeInTheDocument()
  })
})
