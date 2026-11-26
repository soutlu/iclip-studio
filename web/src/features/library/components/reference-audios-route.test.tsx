import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

/** 记下列表请求的查询参数。 */
const recordListQueries = () => {
  const queries: URLSearchParams[] = []
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/api/references/audios')) queries.push(url.searchParams)
  })
  return queries
}

const list = (name = '音色') => screen.getByRole('list', { name })
/** 某张表里各行的名称，按先后：从每行的试听键读。 */
const titles = (name = '音色') =>
  within(list(name))
    .getAllByRole('button', { name: /^(暂停)?试听：/ })
    .map((button) => button.getAttribute('aria-label')?.replace(/^(暂停)?试听：/, ''))
const rowOf = (title: string, name = '音色') =>
  within(list(name))
    .getAllByRole('listitem')
    .find((row) => within(row).queryByText(title) !== null) ??
  (() => {
    throw new Error(`列表里没有「${title}」`)
  })()
const kindTab = (name: string) =>
  within(screen.getByRole('radiogroup', { name: '音频类型' })).getByRole('radio', {
    name: new RegExp(`^${name}`),
  })

const open = async (onScope?: (scope: ReferenceAudioScope) => void) => {
  const user = userEvent.setup()
  await renderWithProviders(<Harness onScope={onScope} />)
  await screen.findByRole('list', { name: '音色' })
  return user
}

beforeEach(() => {
  loginAs(mockAuthUser)
})

describe('资料库 · 音频库', () => {
  it('默认列音色：语种（没设的叫多语种）、声线、场景和时长各占一列，条数写在子类切换上', async () => {
    const queries = recordListQueries()
    await open()
    expect(titles()).toEqual(['Klaus', 'Emma', '温柔女声'])
    expect(queries.at(-1)?.get('audioKind')).toBe('voice')
    expect(screen.getByText('共 3 个音色')).toBeVisible()
    await waitFor(() => expect(kindTab('全部')).toHaveTextContent('全部6'))
    expect(kindTab('音色')).toHaveAttribute('aria-checked', 'true')

    const emma = rowOf('Emma')
    for (const text of ['English', '女声 · 青年', '教程引导 · 社媒种草', '0:06'])
      expect(within(emma).getByText(text)).toBeInTheDocument()
    expect(within(rowOf('温柔女声')).getByText('多语种')).toBeInTheDocument()
  })

  it('属性筛选每项选一个：换一项替掉原来的，再点选中的清空；筛完写着找到几条；切子类时属性筛选清掉', async () => {
    const queries = recordListQueries()
    const scopes: ReferenceAudioScope[] = []
    const user = await open((scope) => scopes.push(scope))
    /** 打开 `trigger` 的弹层点 `option`，等弹层关上。 */
    const pick = async (trigger: string, popup: string, option: string | RegExp) => {
      await user.click(screen.getByRole('button', { name: trigger }))
      const dialog = await screen.findByRole('dialog', { name: popup })
      await user.click(within(dialog).getByRole('radio', { name: option }))
      await waitFor(() => expect(screen.queryByRole('dialog', { name: popup })).toBeNull())
    }

    await pick('语种：语种', '选择语种', 'English')
    expect(scopes.at(-1)).toEqual({ kind: 'voice', q: '', traits: { locale: 'en' } })
    await waitFor(() => expect(titles()).toEqual(['Emma']))
    expect(queries.at(-1)?.getAll('locale')).toEqual(['en'])
    expect(screen.getByText('找到 1 个音色')).toBeVisible()

    await pick('语种：English', '选择语种', '多语种')
    expect(scopes.at(-1)).toEqual({ kind: 'voice', q: '', traits: { locale: 'none' } })
    await waitFor(() => expect(titles()).toEqual(['温柔女声']))
    expect(queries.at(-1)?.getAll('locale')).toEqual(['none'])

    await pick('语种：多语种', '选择语种', '多语种')
    expect(scopes.at(-1)).toEqual({ kind: 'voice', q: '', traits: {} })
    await waitFor(() => expect(titles()).toEqual(['Klaus', 'Emma', '温柔女声']))
    // 不筛的那份已在缓存里，列表先照缓存出来；等后台重读的请求发出去
    await waitFor(() => expect(queries.at(-1)?.getAll('locale')).toEqual([]))
    expect(screen.getByRole('button', { name: '语种：语种' })).toBeVisible()

    await pick('语种：语种', '选择语种', 'English')
    await user.click(kindTab('配乐'))
    expect(scopes.at(-1)).toEqual({ kind: 'bgm', q: '', traits: {} })
    await screen.findByRole('list', { name: '配乐' })
    await pick('节奏：节奏', '选择节奏', /快速/)
    await waitFor(() => expect(titles('配乐')).toEqual(['城市夜景氛围']))
    expect(within(rowOf('城市夜景氛围', '配乐')).getByText('122 BPM')).toBeInTheDocument()
    expect(within(rowOf('城市夜景氛围', '配乐')).getByText('电子律动 · 松弛')).toBeInTheDocument()
    expect(screen.getByText('找到 1 首配乐')).toBeVisible()
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

  it('添加带属性的音色：名称取文件名，场景最多两个（第三个换掉最早的）；接口报错原样提示，改好再加，列表各列显示填的属性', async () => {
    const writes = recordWrites()
    const user = await open()
    await user.click(await screen.findByRole('button', { name: '添加音频' }))
    const dialog = screen.getByRole('dialog', { name: '添加音频' })
    expect(within(dialog).getByRole('radio', { name: '音色' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await user.upload(
      within(dialog).getByLabelText('选择音频文件'),
      new File(['voice'], 'Gravity.mp3', { type: 'audio/mpeg' }),
    )
    expect(within(dialog).getByRole('textbox', { name: '名称' })).toHaveValue('Gravity')
    expect(within(dialog).getByRole('radio', { name: '多语种' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await user.type(
      within(dialog).getByRole('textbox', { name: '一句话风格描述' }),
      '深沉温厚的电影质感男声',
    )
    await user.click(within(dialog).getByRole('radio', { name: 'English' }))
    await user.click(within(dialog).getByRole('radio', { name: '男声' }))
    const scenarios = within(dialog).getByRole('toolbar', { name: '适用场景' })
    for (const name of ['纪录片', '电影预告', '商业广告'])
      await user.click(within(scenarios).getByRole('button', { name }))
    expect(within(scenarios).getByRole('button', { name: '纪录片' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    await user.type(
      within(dialog).getByRole('textbox', { name: '参考台词（选填）' }),
      'Look closely',
    )

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
    await waitFor(() => expect(titles()[0]).toBe('Gravity'))
    const created = writes.filter((write) => write.method === 'POST')
    expect(created).toHaveLength(2)
    expect(created[1]?.body).toEqual({
      audioKind: 'voice',
      description: '深沉温厚的电影质感男声',
      gender: 'male',
      locale: 'en',
      scenarios: ['trailers', 'commercials'],
      title: 'Gravity',
      transcript: 'Look closely',
      uploadId: expect.any(String) as string,
    })
    const row = rowOf('Gravity')
    for (const text of ['深沉温厚的电影质感男声', 'English', '男声', '电影预告 · 商业广告'])
      expect(within(row).getByText(text)).toBeInTheDocument()
  })

  it('修改自己加的属性：只发改了的，取消的属性发 null；别人加的没有修改、移除', async () => {
    const writes = recordWrites()
    const user = await open()
    expect(within(rowOf('Emma')).queryByRole('button', { name: /^修改/ })).toBeNull()
    expect(within(rowOf('Emma')).queryByRole('button', { name: /^移除/ })).toBeNull()

    await user.click(within(rowOf('温柔女声')).getByRole('button', { name: '修改：温柔女声' }))
    const dialog = screen.getByRole('dialog', { name: '修改「温柔女声」' })
    expect(within(dialog).queryByLabelText('选择音频文件')).toBeNull()
    await user.clear(within(dialog).getByRole('textbox', { name: '一句话风格描述' }))
    await user.click(within(dialog).getByRole('radio', { name: '中性' }))
    // 再点一下选中的年龄就是不填
    await user.click(within(dialog).getByRole('radio', { name: '青年' }))
    await user.click(
      within(within(dialog).getByRole('toolbar', { name: '适用场景' })).getByRole('button', {
        name: '社媒种草',
      }),
    )
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(within(rowOf('温柔女声')).getByText('中性')).toBeInTheDocument())
    expect(writes).toEqual([
      {
        body: { age: null, description: null, gender: 'neutral', scenarios: ['explainers'] },
        method: 'PATCH',
        path: expect.stringMatching(/^\/references\/audios\/[0-9a-f-]+$/) as string,
      },
    ])
    expect(within(rowOf('温柔女声')).getByText('产品解说')).toBeInTheDocument()
    expect(within(rowOf('温柔女声')).queryByText('温柔亲和的女声，适合口播讲解')).toBeNull()
  })

  it('音色能展开台词和上传人', async () => {
    const user = await open()
    await user.click(within(rowOf('温柔女声')).getByRole('button', { name: '台词：温柔女声' }))
    const row = rowOf('温柔女声')
    expect(within(row).getByText('今天给大家看一双很舒服的拖鞋。')).toBeVisible()
    expect(within(row).getByText('上传人 tester')).toBeVisible()
  })

  it('试听：点封面出现底部试听条，暂停时试听条还在，点 ✕ 收起', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve())
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const user = await open()

    await user.click(within(rowOf('Emma')).getByRole('button', { name: '试听：Emma' }))
    const bar = screen.getByRole('region', { name: '试听：Emma' })
    expect(within(bar).getByText('English · 女声 · 青年 · 教程引导 · 社媒种草')).toBeVisible()
    expect(within(bar).getByRole('slider', { name: '播放进度：Emma' })).toBeInTheDocument()
    expect(within(rowOf('Emma')).getByRole('button', { name: '暂停试听：Emma' })).toBeVisible()

    await user.click(within(bar).getByRole('button', { name: '暂停' }))
    expect(within(rowOf('Emma')).getByRole('button', { name: '试听：Emma' })).toBeVisible()
    expect(within(bar).getByRole('button', { name: '播放' })).toBeVisible()

    await user.click(within(bar).getByRole('button', { name: '关闭试听' }))
    expect(screen.queryByRole('region', { name: '试听：Emma' })).toBeNull()
  })

  it('「全部」分音色、配乐、音效三段，各列最新几条；「查看全部」切到那个子类，关键词留着', async () => {
    const queries = recordListQueries()
    const scopes: ReferenceAudioScope[] = []
    const user = await open((scope) => scopes.push(scope))
    await user.click(kindTab('全部'))
    await screen.findByRole('list', { name: '配乐' })

    expect(titles()).toEqual(['Klaus', 'Emma', '温柔女声'])
    expect(titles('配乐')).toEqual(['城市夜景氛围', '轻快原声吉他'])
    expect(titles('音效')).toEqual(['翻页声'])
    expect(screen.getByText('共 6 条音频')).toBeVisible()
    expect(queries.at(-1)?.get('limit')).toBe('5')
    expect(screen.queryByRole('button', { name: /^语种：/ })).toBeNull()

    await user.type(screen.getByRole('textbox', { name: '搜索音频' }), '城市')
    await waitFor(() => expect(screen.getByText('找到 1 条音频')).toBeVisible())
    expect(screen.queryByRole('list', { name: '音色' })).toBeNull()
    expect(titles('配乐')).toEqual(['城市夜景氛围'])

    await user.click(screen.getByRole('button', { name: '查看全部配乐' }))
    expect(scopes.at(-1)).toEqual({ kind: 'bgm', q: '城市', traits: {} })
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
