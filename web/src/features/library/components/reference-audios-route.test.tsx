import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { PERMISSION } from '@/shared/auth/permissions'
import { Toaster } from '@/shared/ui/toast'
import { loginAs, mockAuthUser } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { renderWithProviders } from '@/testing/render'
import { DEFAULT_REFERENCE_AUDIO_SCOPE, type ReferenceAudioScope } from '../reference-audios.api'
import { ReferenceAudiosRoute } from './reference-audios-route'

function Harness({ onScope }: { onScope: ((scope: ReferenceAudioScope) => void) | undefined }) {
  const [scope, setScope] = useState(DEFAULT_REFERENCE_AUDIO_SCOPE)
  return (
    <>
      <ReferenceAudiosRoute
        onScopeChange={(next) => {
          onScope?.(next)
          setScope(next)
        }}
        scope={scope}
        tabs={null}
      />
      <Toaster />
    </>
  )
}

/** 记下发往参考音频库的写请求：方法、路径（去掉 /api）和请求体。 */
const recordWrites = () => {
  const writes: { method: string; path: string; body: unknown }[] = []
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url)
    if (request.method === 'GET' || !url.pathname.includes('/api/references/audios')) return
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

const list = () => screen.getByRole('list', { name: '音频' })
/** 列表里各行的标题，按先后：从每行的试听键读。 */
const titles = () =>
  within(list())
    .getAllByRole('button', { name: /^试听：/ })
    .map((button) => button.getAttribute('aria-label')?.replace(/^试听：/, ''))
const rowOf = (title: string) =>
  within(list())
    .getAllByRole('listitem')
    .find((row) => within(row).queryByText(title) !== null) ??
  (() => {
    throw new Error(`列表里没有「${title}」`)
  })()

const open = async (onScope?: (scope: ReferenceAudioScope) => void) => {
  const user = userEvent.setup()
  await renderWithProviders(<Harness onScope={onScope} />)
  await screen.findByRole('list', { name: '音频' })
  return user
}

beforeEach(() => {
  loginAs(mockAuthUser)
})

describe('资料库 · 音频库', () => {
  it('列出全部音频，按类型筛：只读这一类，条数写在筛选上；每行写着类型、语种、时长、添加人和备注', async () => {
    const asked: (string | null)[] = []
    server.events.on('request:start', ({ request }) => {
      const url = new URL(request.url)
      if (url.pathname.endsWith('/api/references/audios'))
        asked.push(url.searchParams.get('audioKind'))
    })
    const scopes: ReferenceAudioScope[] = []
    const user = await open((scope) => scopes.push(scope))
    expect(titles()).toEqual([
      '翻页声',
      '城市夜景氛围',
      '轻快原声吉他',
      'Klaus',
      'Emma',
      '温柔女声',
    ])
    expect(screen.getByText('共 6 条')).toBeVisible()
    expect(within(rowOf('Emma')).getByText('音色 · English · 0:06 · 小林')).toBeVisible()
    expect(within(rowOf('温柔女声')).getByText('适合口播讲解')).toBeVisible()

    const kinds = screen.getByRole('radiogroup', { name: '音频类型' })
    await waitFor(() =>
      expect(within(kinds).getByRole('radio', { name: /^配乐/ })).toHaveTextContent('配乐2'),
    )
    await user.click(within(kinds).getByRole('radio', { name: /^配乐/ }))
    expect(scopes.at(-1)).toEqual({ audioKind: 'bgm', q: '' })
    await waitFor(() => expect(titles()).toEqual(['城市夜景氛围', '轻快原声吉他']))
    expect(screen.getByText('找到 2 条')).toBeVisible()
    expect(asked.at(-1)).toBe('bgm')
  })

  it('能上传的人才有「添加音频」', async () => {
    loginAs(mockAuthUser, {
      permissions: mockAuthUser.permissions.filter(
        (permission) => permission !== PERMISSION.uploadsWrite,
      ),
    })
    await open()
    expect(screen.queryByRole('button', { name: '添加音频' })).toBeNull()
  })

  it('添加音色：选文件后标题取文件名，填语种和台词；接口说时长不合规时原样提示，改好再加就进了列表', async () => {
    const writes = recordWrites()
    const user = await open()
    await user.click(await screen.findByRole('button', { name: '添加音频' }))
    const dialog = screen.getByRole('dialog', { name: '添加音频' })
    await user.click(within(dialog).getByRole('radio', { name: '音色' }))
    await user.upload(
      within(dialog).getByLabelText('选择音频文件'),
      new File(['voice'], '店长口播.mp3', { type: 'audio/mpeg' }),
    )
    expect(within(dialog).getByRole('textbox', { name: '标题' })).toHaveValue('店长口播')
    await user.selectOptions(within(dialog).getByRole('combobox', { name: '语种' }), 'en')
    await user.type(within(dialog).getByRole('textbox', { name: '台词' }), 'Hello there')

    server.use(
      http.post(
        '*/api/references/audios',
        () =>
          HttpResponse.json({ detail: '音色要在 3 到 30 秒之间，这段有 45 秒' }, { status: 422 }),
        { once: true },
      ),
    )
    await user.click(within(dialog).getByRole('button', { name: '添加' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '添加失败：音色要在 3 到 30 秒之间，这段有 45 秒',
    )

    await user.click(within(dialog).getByRole('button', { name: '添加' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '添加音频' })).toBeNull())
    expect(await screen.findByText('已添加')).toBeVisible()
    await waitFor(() => expect(titles()[0]).toBe('店长口播'))
    const created = writes.filter((write) => write.method === 'POST')
    expect(created).toHaveLength(2)
    expect(created[1]?.body).toEqual({
      audioKind: 'voice',
      locale: 'en',
      title: '店长口播',
      transcript: 'Hello there',
      uploadId: expect.any(String) as string,
    })
  })

  it('修改自己加的：只发改了的，清空备注发 null；别人加的没有修改、移除', async () => {
    const writes = recordWrites()
    const user = await open()
    expect(within(rowOf('Emma')).queryByRole('button', { name: /^修改/ })).toBeNull()
    expect(within(rowOf('Emma')).queryByRole('button', { name: /^移除/ })).toBeNull()

    await user.click(within(rowOf('温柔女声')).getByRole('button', { name: '修改：温柔女声' }))
    const dialog = screen.getByRole('dialog', { name: '修改「温柔女声」' })
    const title = within(dialog).getByRole('textbox', { name: '标题' })
    await user.clear(title)
    await user.type(title, '温柔女声 · 慢速')
    await user.clear(within(dialog).getByRole('textbox', { name: '备注' }))
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(within(list()).getByText('温柔女声 · 慢速')).toBeVisible())
    expect(writes).toEqual([
      {
        body: { description: null, title: '温柔女声 · 慢速' },
        method: 'PATCH',
        path: expect.stringMatching(/^\/references\/audios\/[0-9a-f-]+$/) as string,
      },
    ])
    expect(within(rowOf('温柔女声 · 慢速')).queryByText('适合口播讲解')).toBeNull()
  })

  it('移除：确认后从列表里去掉', async () => {
    const writes = recordWrites()
    const user = await open()
    await user.click(within(rowOf('温柔女声')).getByRole('button', { name: '移除：温柔女声' }))
    const dialog = screen.getByRole('dialog', { name: '移除「温柔女声」' })
    await user.click(within(dialog).getByRole('button', { name: '移除' }))

    expect(await screen.findByText('已从资料库移除')).toBeVisible()
    await waitFor(() => expect(within(list()).queryByText('温柔女声')).toBeNull())
    expect(writes.map(({ method }) => method)).toEqual(['DELETE'])
  })
})
