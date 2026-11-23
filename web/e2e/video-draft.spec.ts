import { expect, test } from '@playwright/test'
import { openConversation, openStoryboardShot } from './helpers'

test.use({ viewport: { height: 900, width: 1440 } })

test('样片：选样片出片，新卡标「样片」；做好后转 1080p，转好后点「查看 1080p」选中那张卡', async ({
  page,
}) => {
  const panel = await openConversation(page, '夜景延时素材生成')
  await openStoryboardShot(panel, 2)
  const group = panel.getByRole('region', { name: '镜头组 2' })
  const takes = group.getByRole('region', { name: '本组素材片', exact: true })
  const bar = panel.getByRole('group', { name: '出片工具栏' })

  const sample = bar.getByRole('radio', { name: '样片', exact: true })
  await sample.click()
  await expect(sample).toHaveAttribute('aria-checked', 'true')
  const submitted = page.waitForRequest(
    (request) => request.url().endsWith('/api/generations/video') && request.method() === 'POST',
  )
  await bar.getByRole('button', { name: '生成第 2 组', exact: true }).click()
  expect((await submitted).postDataJSON()).toMatchObject({
    provider_options: { draft: true },
    resolution: '480p',
  })

  const draftCard = takes.getByRole('button', { name: /的素材片/ }).filter({ hasText: '样片' })
  await expect(draftCard).toHaveCount(1)
  await expect(draftCard).toHaveAccessibleName(/的素材片$/, { timeout: 15_000 })
  await draftCard.click()

  const converted = page.waitForRequest(
    (request) =>
      request.url().endsWith('/api/generations/video-draft-completions') &&
      request.method() === 'POST',
  )
  await group.getByRole('button', { name: '转 1080p', exact: true }).click()
  expect((await converted).postDataJSON()).toMatchObject({ draftJobId: expect.any(String) })

  const fullHdCard = takes.getByRole('button', { name: /的素材片/ }).first()
  await expect(fullHdCard).toContainText('1080p')
  const converting = group.getByRole('button', { name: '正在转 1080p', exact: true })
  await expect(converting).toHaveAttribute('aria-busy', 'true')
  await expect(converting).toHaveText('转 1080p')

  const view = group.getByRole('button', { name: '查看 1080p', exact: true })
  await expect(view).toBeVisible({ timeout: 15_000 })
  await takes.getByRole('button', { name: '向后滚动', exact: true }).click()
  await expect(fullHdCard).not.toBeInViewport()
  await view.click()
  await expect(fullHdCard).toHaveAttribute('aria-pressed', 'true')
  await expect(fullHdCard).toBeInViewport()
  await expect(draftCard).toHaveAttribute('aria-pressed', 'false')
})
