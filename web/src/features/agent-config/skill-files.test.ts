import { describe, expect, it } from 'vitest'
import {
  readDescription,
  referencePath,
  skillBody,
  sortSkillPaths,
  withDescription,
  withSkillBody,
} from './skill-files'

const SOURCE = [
  '---',
  'name: director',
  'description: 从需求理解到新片方案。',
  'license: MIT',
  '---',
  '',
  '# 照参考片做新视频',
  '',
  '正文',
].join('\n')

describe('readDescription', () => {
  it.each([
    ['普通写法', 'description: 从需求理解到新片方案。', '从需求理解到新片方案。'],
    ['行尾注释', 'description: 拆解参考片 # 旧说明', '拆解参考片'],
    ['双引号带转义', 'description: "第一句：\\"引号\\"\\n第二句"', '第一句："引号"\n第二句'],
    ['单引号', "description: 'It''s 一句话'", "It's 一句话"],
    ['普通写法跨行', 'description: 第一行\n  接着第二行', '第一行 接着第二行'],
    ['折叠块', 'description: >-\n  第一行\n  第二行\n\n  第二段', '第一行 第二行\n第二段'],
    ['保留块', 'description: |\n  第一行\n  第二行', '第一行\n第二行'],
  ])('%s', (_case, field, expected) => {
    expect(readDescription(`---\nname: a\n${field}\nlicense: MIT\n---\n\n# 标题`)).toBe(expected)
  })

  it('没有 frontmatter 或没写说明时为 null', () => {
    expect(readDescription('# 只有正文')).toBeNull()
    expect(readDescription('---\nname: a\n---\n')).toBeNull()
  })
})

describe('withDescription', () => {
  it('只换 description 一项，别的键与正文原样留着', () => {
    const next = withDescription(SOURCE, '新的说明: 带冒号', 'director')
    expect(next).toBe(
      SOURCE.replace('description: 从需求理解到新片方案。', 'description: "新的说明: 带冒号"'),
    )
    expect(readDescription(next)).toBe('新的说明: 带冒号')
  })

  it('写进去的说明原样读回来，边打边写时词间的空格不丢', () => {
    expect(readDescription(withDescription(SOURCE, '拆解参考片 ', 'director'))).toBe('拆解参考片 ')
  })

  it('跨行的旧说明整段换掉，后面的键不受影响', () => {
    const source = '---\nname: a\ndescription: >\n  旧的\n  说明\nlicense: MIT\n---\n正文'
    expect(withDescription(source, '新说明', 'a')).toBe(
      '---\nname: a\ndescription: "新说明"\nlicense: MIT\n---\n正文',
    )
  })

  it('没写说明时补在最后；保留 CRLF', () => {
    expect(withDescription('---\r\nname: a\r\n---\r\n正文', '说明', 'a')).toBe(
      '---\r\nname: a\r\ndescription: "说明"\r\n---\r\n正文',
    )
  })

  it('没有 frontmatter 时补一份，带上技能标识', () => {
    const next = withDescription('\n# 标题\n', '说明', 'platform-adapt')
    expect(next).toBe('---\nname: platform-adapt\ndescription: "说明"\n---\n\n# 标题\n')
    expect(skillBody(next)).toBe('# 标题\n')
  })
})

describe('skillBody / withSkillBody', () => {
  it('编辑器只看到正文；换回去时 frontmatter 不动，交出的正文能原样读回来', () => {
    expect(skillBody(SOURCE)).toBe('# 照参考片做新视频\n\n正文')
    const next = withSkillBody(SOURCE, '# 新标题\n\n改过的正文')
    expect(next).toBe(SOURCE.replace('# 照参考片做新视频\n\n正文', '# 新标题\n\n改过的正文'))
    expect(skillBody(next)).toBe('# 新标题\n\n改过的正文')
    expect(readDescription(next)).toBe('从需求理解到新片方案。')
  })

  it('没有 frontmatter 时整篇就是正文', () => {
    expect(skillBody('# 标题')).toBe('# 标题')
    expect(withSkillBody('# 标题', '# 新')).toBe('# 新')
  })
})

describe('referencePath', () => {
  const existing = ['SKILL.md', 'references/brief.md', 'references/sub/shots.json']

  it.each([
    ['brief-guide.md', 'references/brief-guide.md'],
    ['  sub/notes.txt ', 'references/sub/notes.txt'],
    ['references/schema.yaml', 'references/schema.yaml'],
  ])('%s → %s', (input, path) => {
    expect(referencePath(input, existing)).toEqual({ path })
  })

  it.each([
    ['', '请填写文件名'],
    ['a\nb.md', '文件名不能包含换行或控制字符'],
    ['/etc/a.md', '请填写 references/ 下的相对路径'],
    ['sub\\a.md', '路径不能包含反斜杠，请用 / 分隔目录'],
    ['../a.md', '路径里不能有空的一段、. 或 ..'],
    ['sub//a.md', '路径里不能有空的一段、. 或 ..'],
    ['brief.md', '已有同名文件，请换一个文件名'],
  ])('%j 不合格', (input, error) => {
    expect(referencePath(input, existing)).toEqual({ error })
  })

  it('改名时与原名相同不算重名', () => {
    expect(referencePath('brief.md', existing, 'references/brief.md')).toEqual({
      path: 'references/brief.md',
    })
  })
})

describe('sortSkillPaths', () => {
  it('SKILL.md 在最前，参考文件按路径排', () => {
    expect(sortSkillPaths(['references/b.md', 'SKILL.md', 'references/a.json'])).toEqual([
      'SKILL.md',
      'references/a.json',
      'references/b.md',
    ])
  })
})
