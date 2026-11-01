import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { loginAs, mockGovernor } from '@/testing/mocks/handlers'
import { server } from '@/testing/mocks/server'
import { mockSkillFile, mockSkillId } from '@/testing/mocks/skills'
import { renderWithProviders } from '@/testing/render'
import { AgentPreviewConversation } from '@/routes/-agent-preview-conversation'
import { readDescription, skillBody } from '../skill-files'
import { AgentConfigPage } from './agent-config-page'

type Body = Record<string, unknown>
type Sent = { method: string; path: string; search: URLSearchParams; body: Body | null }

function Harness() {
  const [agentId, setAgentId] = useState<string | undefined>('director')
  return (
    <AgentConfigPage
      agentId={agentId}
      onAgentChange={setAgentId}
      PreviewConversation={AgentPreviewConversation}
    />
  )
}

const renderPage = async () => {
  loginAs(mockGovernor)
  const user = userEvent.setup()
  await renderWithProviders(<Harness />)
  await screen.findByRole('button', { name: /^切换 Agent，当前：/ })
  return user
}

/** 记下发往技能库与 Agent 草稿的写请求，响应仍交给预置的 mock。 */
const recordWrites = () => {
  const sent: Sent[] = []
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'GET') return
    const url = new URL(request.url)
    const entry: Sent = {
      body: null,
      method: request.method,
      path: url.pathname,
      search: url.searchParams,
    }
    sent.push(entry)
    void request
      .clone()
      .text()
      .then((text) => {
        entry.body = text === '' ? null : (JSON.parse(text) as Body)
      })
  })
  return sent
}

const editor = () => screen.getByRole('region', { name: 'Agent 配置编辑器' })
const skillSection = () => within(editor()).getByRole('region', { name: '技能' })
const skillCards = () =>
  within(skillSection())
    .queryAllByText(/./, { selector: 'span.truncate' })
    .map((node) => node.textContent)
const sidePanel = () => screen.getByRole('region', { name: '配置调整' })

/** jsdom 没有排版，点击定不了光标：直接把 DOM 选区放到这段末尾，再告诉 ProseMirror 选区变了。 */
const placeCaretAtEnd = (block: Element) => {
  const text = block.lastChild as Text
  document.getSelection()?.collapse(text, text.length)
  document.dispatchEvent(new Event('selectionchange'))
}

const typeAtEndOfLastParagraph = async (user: ReturnType<typeof userEvent.setup>, text: string) => {
  const content = await within(sidePanel()).findByRole('textbox', { name: '文件内容' })
  const paragraphs = content.querySelectorAll('p')
  await user.click(content)
  placeCaretAtEnd(paragraphs[paragraphs.length - 1] as Element)
  await user.keyboard(text)
}

const openDirectorSkill = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(
    within(skillSection()).getByRole('button', { name: '编辑技能：照参考片做新视频' }),
  )
  const panel = sidePanel()
  await within(panel).findByRole('heading', { name: '编辑技能' })
  await waitFor(() =>
    expect(within(panel).getByRole('textbox', { name: '简短说明' })).toBeEnabled(),
  )
  return panel
}

const filePath = (skill: string, path: string) =>
  `/api/skills/${mockSkillId(skill)}/draft/files/${path}`

describe('技能库与添加技能', () => {
  it('顶部「技能库」列出技能，可搜索，从没发布过的带「草稿」；新建技能后进入它的编辑器', async () => {
    const user = await renderPage()
    const sent = recordWrites()
    await user.click(screen.getByRole('tab', { name: '技能库' }))
    const panel = sidePanel()
    expect(within(panel).getByRole('heading', { name: '技能库' })).toBeInTheDocument()
    const draftRow = await within(panel).findByRole('button', { name: '编辑技能：多平台尺寸适配' })
    expect(draftRow).toHaveTextContent('草稿')
    expect(within(panel).getByRole('button', { name: '编辑技能：分镜创作' })).not.toHaveTextContent(
      '草稿',
    )

    await user.type(within(panel).getByRole('searchbox', { name: '搜索技能' }), '卖点')
    expect(within(panel).getAllByRole('button', { name: /^编辑技能：/ })).toHaveLength(1)
    expect(
      within(panel).getByRole('button', { name: '编辑技能：商品卖点提炼' }),
    ).toBeInTheDocument()

    await user.click(within(panel).getByRole('button', { name: '新建技能' }))
    const form = sidePanel()
    await user.click(within(form).getByRole('button', { name: '创建技能' }))
    expect(within(form).getByLabelText('名称')).toHaveAccessibleDescription('请填写名称')
    await user.type(within(form).getByLabelText('名称'), '新品视频策划')
    await user.type(within(form).getByLabelText('标识'), 'Bad Name')
    await user.type(within(form).getByLabelText('简短说明'), '从卖点到分镜。')
    await user.click(within(form).getByRole('button', { name: '创建技能' }))
    expect(within(form).getByLabelText('标识')).toHaveAttribute('aria-invalid', 'true')
    expect(sent.filter((item) => item.path === '/api/skills')).toHaveLength(0)

    await user.clear(within(form).getByLabelText('标识'))
    await user.type(within(form).getByLabelText('标识'), 'product-video-planning')
    await user.click(within(form).getByRole('button', { name: '创建技能' }))

    const created = sidePanel()
    await within(created).findByRole('heading', { name: '编辑技能' })
    expect(sent.find((item) => item.path === '/api/skills')?.body).toEqual({
      description: '从卖点到分镜。',
      displayName: '新品视频策划',
      name: 'product-video-planning',
    })
    expect(within(created).getByRole('textbox', { name: '技能名称' })).toHaveValue('新品视频策划')
    await waitFor(() =>
      expect(within(created).getByRole('textbox', { name: '简短说明' })).toHaveValue(
        '从卖点到分镜。',
      ),
    )
    expect(within(created).getByRole('img', { name: '尚未发布' })).toHaveTextContent('草稿')
    // 返回回到技能库，新技能在里面。
    await user.click(within(created).getByRole('button', { name: '返回' }))
    expect(
      await within(sidePanel()).findByRole('button', { name: '编辑技能：新品视频策划' }),
    ).toBeInTheDocument()
  })

  it('左侧「添加技能」：点一行添加或去掉，没发布过的进编辑器；保存草稿按先后带上 skillIds', async () => {
    const user = await renderPage()
    const sent = recordWrites()
    expect(skillCards()).toEqual(['照参考片做新视频', '分镜创作', '爆款脚本拆解与二次创作方法论'])

    await user.click(within(skillSection()).getByRole('button', { name: '添加技能' }))
    let panel = sidePanel()
    expect(within(panel).getByRole('heading', { name: '添加技能' })).toBeInTheDocument()
    const replica = await within(panel).findByRole('button', { name: '参考视频复刻' })
    expect(replica).toHaveAttribute('aria-pressed', 'false')
    await user.click(replica)
    expect(replica).toHaveAttribute('aria-pressed', 'true')
    await user.click(within(panel).getByRole('button', { name: '分镜创作' }))
    expect(within(panel).getByRole('button', { name: '分镜创作' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(skillCards()).toEqual([
      '照参考片做新视频',
      '爆款脚本拆解与二次创作方法论',
      '参考视频复刻',
    ])

    // 没发布过的不能添加：点了进它的编辑器，返回回到选技能。
    await user.click(within(panel).getByRole('button', { name: '编辑技能：多平台尺寸适配' }))
    panel = sidePanel()
    expect(await within(panel).findByRole('textbox', { name: '技能名称' })).toHaveValue(
      '多平台尺寸适配',
    )
    expect(within(panel).queryByRole('button', { name: '从当前 Agent 移除' })).toBeNull()
    await user.click(within(panel).getByRole('button', { name: '返回' }))
    expect(within(sidePanel()).getByRole('heading', { name: '添加技能' })).toBeInTheDocument()
    expect(skillCards()).not.toContain('多平台尺寸适配')

    // 绑着的技能在编辑器里可以从当前 Agent 移除，回到选技能。
    await user.click(within(skillSection()).getByRole('button', { name: '编辑技能：参考视频复刻' }))
    await user.click(await within(sidePanel()).findByRole('button', { name: '从当前 Agent 移除' }))
    expect(
      await within(sidePanel()).findByRole('button', { name: '参考视频复刻' }),
    ).toHaveAttribute('aria-pressed', 'false')
    await user.click(within(sidePanel()).getByRole('button', { name: '参考视频复刻' }))

    await user.click(within(editor()).getByRole('button', { name: '保存草稿' }))
    await waitFor(() =>
      expect(sent.some((item) => item.path === '/api/agents/director/draft')).toBe(true),
    )
    await waitFor(() =>
      expect(sent.find((item) => item.path === '/api/agents/director/draft')?.body).toMatchObject({
        skillIds: [
          mockSkillId('director'),
          mockSkillId('viral-script-remix'),
          mockSkillId('exact-replica-workflow'),
        ],
      }),
    )
  })

  it('没有绑定技能时左侧是「添加技能」卡片', async () => {
    loginAs(mockGovernor)
    const user = userEvent.setup()
    function Empty() {
      const [agentId, setAgentId] = useState<string | undefined>('breakdown-helper')
      return (
        <AgentConfigPage
          agentId={agentId}
          onAgentChange={setAgentId}
          PreviewConversation={AgentPreviewConversation}
        />
      )
    }
    await renderWithProviders(<Empty />)
    await screen.findByRole('button', { name: /^切换 Agent，当前：/ })
    const cards = within(skillSection()).getAllByRole('button', { name: '添加技能' })
    expect(cards).toHaveLength(2)
    await user.click(cards[1] as HTMLElement)
    expect(within(sidePanel()).getByRole('heading', { name: '添加技能' })).toBeInTheDocument()
  })
})

describe('编辑技能', () => {
  it('保存草稿只写改过的文件，各带读到的 hash；新文件 baseHash 为 null；改名称走 PATCH', async () => {
    const user = await renderPage()
    const sent = recordWrites()
    const panel = await openDirectorSkill(user)
    // 编辑器里不显示 frontmatter。
    const content = within(panel).getByRole('textbox', { name: '文件内容' })
    expect(content).toHaveTextContent('照参考片做新视频')
    expect(content).not.toHaveTextContent('description')
    expect(within(panel).getByRole('img', { name: '已发布 v4' })).toHaveTextContent('v4')

    await user.click(within(panel).getByRole('tab', { name: 'brief-guide.md' }))
    await waitFor(() =>
      expect(within(panel).getByRole('textbox', { name: '文件内容' })).toHaveTextContent(
        '创作 Brief',
      ),
    )
    await typeAtEndOfLastParagraph(user, '附上参考链接。')

    // json 用纯文本编辑。
    await user.click(within(panel).getByRole('tab', { name: 'shot-schema.json' }))
    const json = await within(panel).findByRole('textbox', { name: '文件内容' })
    expect(json.tagName).toBe('TEXTAREA')
    await user.clear(json)
    await user.type(json, '{{}')

    await user.click(within(panel).getByRole('button', { name: '添加参考文件' }))
    await user.type(within(panel).getByRole('textbox', { name: '参考文件名' }), 'notes.md{Enter}')
    expect(within(panel).getByRole('tab', { name: 'notes.md' })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    const title = within(panel).getByRole('textbox', { name: '技能名称' })
    await user.clear(title)
    await user.type(title, '照参考片做新片')
    expect(
      within(panel).getByRole('img', { name: '已发布 v4，有未保存的修改' }),
    ).toBeInTheDocument()

    const briefHash = mockSkillFile('director', 'references/brief-guide.md').hash
    const schemaHash = mockSkillFile('director', 'references/shot-schema.json').hash
    await user.click(within(panel).getByRole('button', { name: '保存草稿' }))
    await waitFor(() =>
      expect(within(panel).getByRole('button', { name: '保存草稿' })).toBeDisabled(),
    )

    const puts = sent.filter((item) => item.method === 'PUT')
    expect(puts.map((item) => item.path)).toEqual([
      filePath('director', 'references/brief-guide.md'),
      filePath('director', 'references/notes.md'),
      filePath('director', 'references/shot-schema.json'),
    ])
    expect(puts[0]?.body).toMatchObject({ baseHash: briefHash })
    expect(String(puts[0]?.body?.['content'])).toContain('附上参考链接。')
    expect(puts[1]?.body).toEqual({ baseHash: null, content: '' })
    expect(puts[2]?.body).toEqual({ baseHash: schemaHash, content: '{}' })
    expect(sent.find((item) => item.method === 'PATCH')?.body).toEqual({
      displayName: '照参考片做新片',
    })
    // 存好后草稿有未发布的修改。
    expect(
      within(panel).getByRole('img', { name: '已发布 v4，草稿有未发布的修改' }),
    ).toBeInTheDocument()
  })

  it('文件已被别人改过（409）：就地说明，丢掉这个文件的改动并读回最新内容', async () => {
    const user = await renderPage()
    const panel = await openDirectorSkill(user)
    server.use(
      http.put('*/api/skills/:skillId/draft/files/references/brief-guide.md', () =>
        HttpResponse.json({ detail: '文件已被修改' }, { status: 409 }),
      ),
    )
    await user.click(within(panel).getByRole('tab', { name: 'brief-guide.md' }))
    await waitFor(() =>
      expect(within(panel).getByRole('textbox', { name: '文件内容' })).toHaveTextContent(
        '创作 Brief',
      ),
    )
    await typeAtEndOfLastParagraph(user, '这句会丢。')
    expect(within(panel).getByRole('textbox', { name: '文件内容' })).toHaveTextContent('这句会丢。')
    await user.click(within(panel).getByRole('button', { name: '保存草稿' }))

    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'brief-guide.md 已被别人修改，已读取最新内容',
    )
    await waitFor(() =>
      expect(within(panel).getByRole('textbox', { name: '文件内容' })).not.toHaveTextContent(
        '这句会丢。',
      ),
    )
    expect(within(panel).getByRole('button', { name: '保存草稿' })).toBeDisabled()
  })

  it('保存时超过上限（413）：就地说明上限，改动留着', async () => {
    const user = await renderPage()
    const panel = await openDirectorSkill(user)
    server.use(
      http.put(
        '*/api/skills/:skillId/draft/files/*',
        () => new HttpResponse(null, { status: 413 }),
      ),
    )
    await user.click(within(panel).getByRole('tab', { name: 'shot-schema.json' }))
    await user.type(await within(panel).findByRole('textbox', { name: '文件内容' }), ' ')
    await user.click(within(panel).getByRole('button', { name: '保存草稿' }))
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'shot-schema.json 超过大小上限；单个文件不超过 1 MB，全部文件合计不超过 5 MB',
    )
    expect(within(panel).getByRole('button', { name: '保存草稿' })).toBeEnabled()
  })

  it('改说明只重写 SKILL.md frontmatter 里的 description，正文不动', async () => {
    const user = await renderPage()
    const sent = recordWrites()
    const panel = await openDirectorSkill(user)
    const original = mockSkillFile('director', 'SKILL.md')
    const description = within(panel).getByRole('textbox', { name: '简短说明' })
    expect(description).toHaveValue('从需求理解、参考片拆解，到新片执行方案与工程。')

    await user.clear(description)
    await user.type(description, '照参考片做新片： 从拆解到工程')
    expect(description).toHaveValue('照参考片做新片： 从拆解到工程')
    await user.click(within(panel).getByRole('button', { name: '保存草稿' }))

    await waitFor(() => expect(sent.filter((item) => item.method === 'PUT')).toHaveLength(1))
    const put = sent.find((item) => item.method === 'PUT')
    expect(put?.path).toBe(filePath('director', 'SKILL.md'))
    await waitFor(() => expect(put?.body).not.toBeNull())
    expect(put?.body?.['baseHash']).toBe(original.hash)
    const content = String(put?.body?.['content'])
    expect(readDescription(content)).toBe('照参考片做新片： 从拆解到工程')
    expect(content).toContain('name: director\n')
    expect(skillBody(content)).toBe(skillBody(original.content))
  })

  it('说明清空时不保存，就地提示', async () => {
    const user = await renderPage()
    const sent = recordWrites()
    const panel = await openDirectorSkill(user)
    await user.clear(within(panel).getByRole('textbox', { name: '简短说明' }))
    await user.click(within(panel).getByRole('button', { name: '保存草稿' }))
    expect(within(panel).getByRole('alert')).toHaveTextContent('请填写简短说明')
    expect(within(panel).getByRole('textbox', { name: '简短说明' })).toHaveFocus()
    expect(sent).toHaveLength(0)
  })

  it('重命名走改名端点，带读到的 hash；双击也能改名，Esc 只收起输入框', async () => {
    const user = await renderPage()
    const sent = recordWrites()
    const panel = await openDirectorSkill(user)
    const hash = mockSkillFile('director', 'references/brief-guide.md').hash

    await user.click(within(panel).getByRole('tab', { name: 'reference-video-guide.md' }))
    await waitFor(() =>
      expect(within(panel).getByRole('textbox', { name: '文件内容' })).toHaveTextContent(
        '参考片拆解',
      ),
    )
    await user.dblClick(within(panel).getByRole('tab', { name: 'reference-video-guide.md' }))
    const input = within(panel).getByRole('textbox', { name: '新文件名' })
    expect(input).toHaveValue('reference-video-guide.md')
    expect(input).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(within(panel).queryByRole('textbox', { name: '新文件名' })).toBeNull()
    expect(within(panel).getByRole('heading', { name: '编辑技能' })).toBeInTheDocument()
    expect(within(panel).getByRole('tab', { name: 'reference-video-guide.md' })).toHaveFocus()

    // 添加参考文件按 Esc 取消，焦点回到「添加参考文件」。
    await user.click(within(panel).getByRole('button', { name: '添加参考文件' }))
    expect(within(panel).getByRole('textbox', { name: '参考文件名' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(within(panel).getByRole('button', { name: '添加参考文件' })).toHaveFocus()

    await user.click(within(panel).getByRole('tab', { name: 'brief-guide.md' }))
    await user.click(within(panel).getByRole('button', { name: 'brief-guide.md 的操作' }))
    await user.click(await screen.findByRole('menuitem', { name: '重命名' }))
    const rename = within(panel).getByRole('textbox', { name: '新文件名' })
    // 与已有文件重名：就地说明，不发请求。
    await user.clear(rename)
    await user.type(rename, 'shot-schema.json{Enter}')
    expect(within(panel).getByRole('alert')).toHaveTextContent('已有同名文件，请换一个文件名')
    await user.clear(rename)
    await user.type(rename, 'guides/brief.md{Enter}')

    const renamed = await within(panel).findByRole('tab', { name: 'guides/brief.md' })
    expect(renamed).toHaveAttribute('aria-selected', 'true')
    expect(renamed).toHaveFocus()
    expect(within(panel).queryByRole('tab', { name: 'brief-guide.md' })).toBeNull()
    expect(sent.map((item) => item.path)).toEqual([
      `/api/skills/${mockSkillId('director')}/draft/files/rename`,
    ])
    await waitFor(() =>
      expect(sent[0]?.body).toEqual({
        baseHash: hash,
        from: 'references/brief-guide.md',
        to: 'references/guides/brief.md',
      }),
    )
    expect(mockSkillFile('director', 'references/guides/brief.md').hash).toBe(hash)
  })

  it('删除先就地确认，再带读到的 hash 删除；取消不删', async () => {
    const user = await renderPage()
    const sent = recordWrites()
    const panel = await openDirectorSkill(user)
    const hash = mockSkillFile('director', 'references/brief-guide.md').hash

    const remove = async () => {
      await user.click(within(panel).getByRole('tab', { name: 'brief-guide.md' }))
      await user.click(within(panel).getByRole('button', { name: 'brief-guide.md 的操作' }))
      await user.click(await screen.findByRole('menuitem', { name: '删除' }))
      expect(within(panel).getByText('删除 brief-guide.md？')).toBeInTheDocument()
    }
    await remove()
    await user.click(within(panel).getByRole('button', { name: '取消' }))
    expect(within(panel).getByRole('tab', { name: 'brief-guide.md' })).toBeInTheDocument()
    expect(sent).toHaveLength(0)

    await remove()
    await user.click(within(panel).getByRole('button', { name: '删除' }))
    await waitFor(() =>
      expect(within(panel).queryByRole('tab', { name: 'brief-guide.md' })).toBeNull(),
    )
    expect(within(panel).getByRole('tab', { name: 'SKILL.md' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]?.method).toBe('DELETE')
    expect(sent[0]?.path).toBe(filePath('director', 'references/brief-guide.md'))
    expect(sent[0]?.search.get('baseHash')).toBe(hash)
  })

  it('发布技能：先存上没保存的改动再发布，版本号随之更新', async () => {
    const user = await renderPage()
    const sent = recordWrites()
    await user.click(screen.getByRole('tab', { name: '技能库' }))
    await user.click(
      await within(sidePanel()).findByRole('button', { name: '编辑技能：多平台尺寸适配' }),
    )
    const panel = sidePanel()
    expect(await within(panel).findByRole('img', { name: '尚未发布' })).toBeInTheDocument()
    await waitFor(() =>
      expect(within(panel).getByRole('textbox', { name: '简短说明' })).toBeEnabled(),
    )
    await user.type(within(panel).getByRole('textbox', { name: '简短说明' }), '，含抖音与小红书')

    await user.click(within(panel).getByRole('button', { name: '发布技能' }))
    expect(await within(panel).findByRole('img', { name: '已发布 v1' })).toHaveTextContent('v1')
    expect(sent.map((item) => `${item.method} ${item.path}`)).toEqual([
      `PUT ${filePath('platform-adapt', 'SKILL.md')}`,
      `POST /api/skills/${mockSkillId('platform-adapt')}/versions`,
    ])
    expect(within(panel).getByRole('button', { name: '发布技能' })).toBeDisabled()
    // 技能库里不再是草稿，说明跟着新版本。
    await user.click(within(panel).getByRole('button', { name: '返回' }))
    expect(
      await within(sidePanel()).findByRole('button', { name: '编辑技能：多平台尺寸适配' }),
    ).toHaveTextContent('把成片方案改成各平台的画幅和时长。，含抖音与小红书')
    expect(
      within(sidePanel()).getByRole('button', { name: '编辑技能：多平台尺寸适配' }),
    ).not.toHaveTextContent('草稿')
  })

  it('发布被拦下时就地写出原因', async () => {
    const user = await renderPage()
    const panel = await openDirectorSkill(user)
    expect(within(panel).getByRole('button', { name: '发布技能' })).toBeDisabled()
    server.use(
      http.post('*/api/skills/:skillId/versions', () =>
        HttpResponse.json({ detail: 'SKILL.md 的 frontmatter 缺少 description' }, { status: 422 }),
      ),
    )
    await user.type(within(panel).getByRole('textbox', { name: '技能名称' }), '！')
    await user.click(within(panel).getByRole('button', { name: '发布技能' }))
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      '发布失败：SKILL.md 的 frontmatter 缺少 description',
    )
  })
})
