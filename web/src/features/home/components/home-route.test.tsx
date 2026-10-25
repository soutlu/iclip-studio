import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { readyAttachment, type ComposerPart, type ComposerSubmission } from '@/shared/ui/composer'
import { pasteTextIntoComposer } from '@/testing/editor'
import { renderWithProviders } from '@/testing/render'
import { HomeRoute } from './home-route'

describe('HomeRoute', () => {
  it('渲染标题、输入卡及路由传入的选择控件，默认没有附件入口', async () => {
    await renderWithProviders(
      <HomeRoute
        agentPicker={<button type="button">选择 Agent</button>}
        collectionPicker={<button type="button">关联合集</button>}
      />,
    )

    expect(screen.getByRole('heading', { name: 'iClip' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '展开鞋盒，展示鞋履与服装' })).toBeVisible()
    expect(screen.getByLabelText('输入消息')).toBeVisible()
    expect(screen.queryByRole('button', { name: '添加附件' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '选择 Agent' })).toBeVisible()
    expect(screen.getByRole('button', { name: '关联合集' })).toBeVisible()
  })

  it('附件入口由外部权限判断开启', async () => {
    await renderWithProviders(<HomeRoute attachmentsEnabled />)
    expect(screen.getByRole('button', { name: '添加附件' })).toBeVisible()
  })

  it.each([true, false])('发送返回 %s 时只在成功后清空正文', async (success) => {
    const user = userEvent.setup()
    const sent: ComposerSubmission[] = []
    await renderWithProviders(
      <HomeRoute
        onSend={async (input) => {
          sent.push(input)
          return success
        }}
      />,
    )
    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '做一个产品宣传片')
    await user.click(screen.getByRole('button', { name: '发送' }))

    expect(sent).toEqual([
      {
        media: [],
        parts: [{ kind: 'text', text: '做一个产品宣传片' }],
        text: '做一个产品宣传片',
      },
    ])
    expect(screen.getByLabelText('输入消息').textContent).toBe(success ? '' : '做一个产品宣传片')
  })

  it('发送仍在等待结果时保留输入，并阻止重复发送', async () => {
    const user = userEvent.setup()
    const sent: ComposerSubmission[] = []
    let resolveSend: (value: boolean) => void = () => {}
    const pending = new Promise<boolean>((resolve) => {
      resolveSend = resolve
    })
    await renderWithProviders(
      <HomeRoute
        onSend={(input) => {
          sent.push(input)
          return pending
        }}
      />,
    )
    const editor = screen.getByLabelText('输入消息')
    pasteTextIntoComposer(editor, '正在发送的创作要求')
    await user.dblClick(screen.getByRole('button', { name: '发送' }))
    expect(sent).toHaveLength(1)
    expect(editor).toHaveTextContent('正在发送的创作要求')
    await act(async () => {
      resolveSend(true)
      await pending
    })
    await waitFor(() => expect(editor.textContent).toBe(''))
  })

  it('外部发送状态禁用发送按钮并保留当前输入', async () => {
    await renderWithProviders(<HomeRoute sending />)
    pasteTextIntoComposer(screen.getByLabelText('输入消息'), '正在发送的创作要求')
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    expect(screen.getByLabelText('输入消息')).toHaveTextContent('正在发送的创作要求')
  })

  it('挂载时恢复草稿里的正文与附件，恢复不算改动；之后的输入照常通知', async () => {
    const url = 'https://bkt.oss-ap-southeast-1.aliyuncs.com/u/草稿参考.png'
    const onDraftChange = vi.fn()
    await renderWithProviders(
      <HomeRoute
        attachmentsEnabled
        draftParts={[
          { kind: 'text', text: '参照这张图做宣传片' },
          { kind: 'media', media: readyAttachment({ kind: 'image', name: '草稿参考.png', url }) },
        ]}
        onDraftChange={onDraftChange}
      />,
    )
    const editor = screen.getByLabelText('输入消息')
    expect(editor).toHaveTextContent('参照这张图做宣传片')
    expect(within(editor).getByText('草稿参考.png')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()
    expect(onDraftChange).not.toHaveBeenCalled()

    pasteTextIntoComposer(editor, '，时长 15 秒')
    await waitFor(() => expect(onDraftChange).toHaveBeenCalled())
    const parts = onDraftChange.mock.lastCall?.[0] as ComposerPart[]
    expect(parts.map((part) => part.kind)).toContain('media')
    expect(parts.some((part) => part.kind === 'text' && part.text.includes('时长 15 秒'))).toBe(
      true,
    )
  })
})

it('StrictMode 下恢复草稿后加入参考视频，effect 重放不丢失或重复附件', async () => {
  await renderWithProviders(
    <StrictMode>
      <HomeRoute
        draftParts={[{ kind: 'text', text: '保留原草稿' }]}
        referenceUrl="https://example.com/reference.mp4"
      />
    </StrictMode>,
  )
  const editor = screen.getByLabelText('输入消息')
  await within(editor).findByText('参考视频')
  expect(editor).toHaveTextContent('保留原草稿')
  expect(within(editor).getAllByText('参考视频')).toHaveLength(1)
  expect(editor).not.toHaveTextContent('https://example.com/reference.mp4')
})
