import { describe, expect, it } from 'vitest'
import type { ArtifactEntry } from './artifact'
import { ArtifactRegistry, composeArtifacts } from './registry'

const Placeholder = () => null

const shotsEntry: ArtifactEntry = {
  autoOpen: true,
  component: Placeholder,
  empty: '暂无分镜，agent 交付后显示',
  icon: 'grid',
  label: '分镜',
  match: { path: 'video_shot.json' },
  title: () => '分镜',
  type: 'storyboard',
}

const agentEntry: ArtifactEntry = {
  autoOpen: false,
  component: Placeholder,
  icon: 'agent',
  label: '派活',
  match: { displayKind: 'agent_call' },
  title: () => '派活',
  type: 'sub-agent',
}

const agentFrame = { display: { kind: 'agent_call' }, toolCallId: 'call_frames', view: 'generic' }

const workspaceEntry: ArtifactEntry = {
  autoOpen: false,
  component: Placeholder,
  empty: '还没有文件',
  icon: 'folder',
  label: '文件',
  match: { workspace: true },
  title: () => '文件',
  type: 'workspace',
}

const editingEntry: ArtifactEntry = {
  autoOpen: false,
  component: Placeholder,
  hiddenWhenReadOnly: true,
  icon: 'video-type',
  label: '剪辑',
  match: { anyPath: ['video_shot.json', 'film.icml'] },
  title: () => '剪辑',
  type: 'editing',
}

const patternEntry = (pattern: string, type = 'canvas'): ArtifactEntry => ({
  autoOpen: false,
  component: Placeholder,
  empty: '还没有画布',
  icon: 'grid',
  label: '画布',
  match: { pattern },
  title: (source) => (source.kind === 'file' ? source.path : '画布'),
  type,
})

const matchedPaths = (registry: ArtifactRegistry, paths: string[]) =>
  registry
    .matchFiles(paths.map((path) => ({ path, version: 1 })))
    .map(
      (artifact) =>
        `${artifact.type}:${artifact.source.kind === 'file' ? artifact.source.path : ''}`,
    )

const registryWith = (...entries: ArtifactEntry[]) => {
  const registry = new ArtifactRegistry()
  for (const entry of entries) registry.register(entry)
  return registry
}

describe('ArtifactRegistry', () => {
  it('文件按路径命中，id 是 file:<path>', () => {
    const artifacts = registryWith(shotsEntry).matchFiles([
      { path: 'video_shot.json', version: 3 },
      { path: 'frames/extraction.json', version: 1 },
    ])

    expect(artifacts).toEqual([
      {
        id: 'file:video_shot.json',
        source: { kind: 'file', path: 'video_shot.json', version: 3 },
        title: '分镜',
        type: 'storyboard',
      },
    ])
  })

  it('工具帧按 display.kind 命中，来源带上 display 与 agentRefs', () => {
    const display = { agent_name: 'shot-writer', kind: 'agent_call', prompt: '写三个镜头' }

    const artifacts = registryWith(agentEntry).matchFrames([
      { agentRefs: [{ agentId: 'run-1' }], display, toolCallId: 'call_d1', view: 'generic' },
      { display: { kind: 'file_io' }, toolCallId: 'call_r', view: 'generic' },
    ])

    expect(artifacts).toEqual([
      {
        id: 'frame:call_d1',
        source: {
          agentRefs: [{ agentId: 'run-1' }],
          display,
          kind: 'frame',
          metadata: undefined,
          toolCallId: 'call_d1',
          view: 'generic',
        },
        title: '派活',
        type: 'sub-agent',
      },
    ])
  })

  it('工作区有文件就是一件产物，一份文件都没有就没有', () => {
    const registry = registryWith(workspaceEntry)

    expect(registry.matchWorkspace([{ path: 'video/a.md', version: 1 }])).toEqual([
      {
        id: 'workspace',
        source: { fileCount: 1, kind: 'workspace' },
        title: '文件',
        type: 'workspace',
      },
    ])
    expect(registry.matchWorkspace([])).toEqual([])
  })

  it('几个来源合成一份列表：按路径命中的文件、按任一路径命中的、工作区、工具帧', () => {
    const registry = registryWith(workspaceEntry, editingEntry, shotsEntry, agentEntry)

    const artifacts = composeArtifacts(
      registry,
      [{ path: 'video_shot.json', version: 1 }],
      [agentFrame],
      false,
    )

    expect(artifacts.map((artifact) => artifact.id)).toEqual([
      'file:video_shot.json',
      'editing',
      'workspace',
      'frame:call_frames',
    ])
  })

  it('按任一路径认领：列着的文件在任一份就是一件产物，id 是类型，来源带上在的那几份', () => {
    const registry = registryWith(editingEntry)

    for (const paths of [['video_shot.json'], ['film.icml', 'notes.md']]) {
      expect(registry.matchAnyPath(paths.map((path) => ({ path, version: 1 })))).toEqual([
        {
          id: 'editing',
          source: { kind: 'paths', paths: paths.filter((path) => path !== 'notes.md') },
          title: '剪辑',
          type: 'editing',
        },
      ])
    }
    expect(
      registry.matchAnyPath([
        { path: 'video_shot.json', version: 1 },
        { path: 'film.icml', version: 2 },
      ]),
    ).toEqual([
      {
        id: 'editing',
        source: { kind: 'paths', paths: ['video_shot.json', 'film.icml'] },
        title: '剪辑',
        type: 'editing',
      },
    ])
    expect(registry.matchAnyPath([{ path: 'notes.md', version: 1 }])).toEqual([])
  })

  it('只读时去掉登记为只读不显示的类型，别的照常', () => {
    const registry = registryWith(shotsEntry, editingEntry, workspaceEntry)
    const files = [{ path: 'video_shot.json', version: 1 }]

    expect(composeArtifacts(registry, files, [], true).map((artifact) => artifact.id)).toEqual([
      'file:video_shot.json',
      'workspace',
    ])
    expect(composeArtifacts(registry, files, [], false).map((artifact) => artifact.id)).toEqual([
      'file:video_shot.json',
      'editing',
      'workspace',
    ])
  })

  it('常驻类型是按路径、按任一路径与按工作区命中的那些，按登记顺序给', () => {
    const registry = registryWith(agentEntry, workspaceEntry, editingEntry, shotsEntry)

    expect(registry.standing().map((entry) => entry.type)).toEqual([
      'workspace',
      'editing',
      'storyboard',
    ])
  })

  it('模式里的 * 只认一段路径，不跨目录', () => {
    const registry = registryWith(patternEntry('canvas/*.canvas.json'))

    expect(
      matchedPaths(registry, [
        'canvas/a.canvas.json',
        'canvas/sub/b.canvas.json',
        'a.canvas.json',
        'canvas/a.canvas.json.bak',
      ]),
    ).toEqual(['canvas:canvas/a.canvas.json'])
  })

  it('模式里的 ** 跨目录，后面跟 / 时也认一层目录都没有的', () => {
    const registry = registryWith(patternEntry('canvas/**/*.json'))

    expect(matchedPaths(registry, ['canvas/a.json', 'canvas/x/y/b.json', 'other/c.json'])).toEqual([
      'canvas:canvas/a.json',
      'canvas:canvas/x/y/b.json',
    ])
  })

  it('模式里 * 以外的字符按字面认', () => {
    const registry = registryWith(patternEntry('notes/(v1).md'))

    expect(matchedPaths(registry, ['notes/(v1).md', 'notes/v1.md', 'notesX(v1)Xmd'])).toEqual([
      'canvas:notes/(v1).md',
    ])
  })

  it('确切路径优先于也认得它的模式，不管谁先登记', () => {
    const jsonView = patternEntry('**/*.json', 'json-view')

    for (const registry of [
      registryWith(jsonView, shotsEntry),
      registryWith(shotsEntry, jsonView),
    ]) {
      expect(matchedPaths(registry, ['video_shot.json', 'frames/extraction.json'])).toEqual([
        'storyboard:video_shot.json',
        'json-view:frames/extraction.json',
      ])
    }
  })

  it('两个模式都认得同一份文件时，先登记的生效', () => {
    const registry = registryWith(patternEntry('canvas/*', 'first'), patternEntry('**', 'second'))

    expect(matchedPaths(registry, ['canvas/a.json', 'b.json'])).toEqual([
      'first:canvas/a.json',
      'second:b.json',
    ])
  })

  it('按模式命中的类型也是常驻类型', () => {
    const registry = registryWith(agentEntry, patternEntry('canvas/*.json'), workspaceEntry)

    expect(registry.standing().map((entry) => entry.type)).toEqual(['canvas', 'workspace'])
  })

  it('按路径查归属：确切路径、模式、任一路径依次认，id 和产物的一样；都不认时没有', () => {
    const registry = registryWith(
      editingEntry,
      patternEntry('**/*.json', 'json-view'),
      shotsEntry,
      workspaceEntry,
    )

    expect(registry.ownerOf('video_shot.json')).toEqual({
      document: true,
      id: 'file:video_shot.json',
      title: '分镜',
      type: 'storyboard',
    })
    expect(registry.ownerOf('frames/a.json')).toEqual({
      document: true,
      id: 'file:frames/a.json',
      title: 'frames/a.json',
      type: 'json-view',
    })
    expect(registry.ownerOf('film.icml')).toEqual({
      document: true,
      id: 'editing',
      title: '剪辑',
      type: 'editing',
    })
    expect(registry.ownerOf('notes.md')).toBeUndefined()
  })

  it('任一路径登记了目录时，目录下的其他文件也归它，但不算它的文档，也不让它出现', () => {
    const registry = registryWith({
      ...editingEntry,
      match: { anyPath: ['edit/index.html'], dir: 'edit' },
    })

    expect(registry.ownerOf('edit/index.html')).toMatchObject({ document: true, id: 'editing' })
    expect(registry.ownerOf('edit/beats/a.json')).toEqual({
      document: false,
      id: 'editing',
      title: '剪辑',
      type: 'editing',
    })
    expect(registry.ownerOf('editing.md')).toBeUndefined()
    expect(registry.matchAnyPath([{ path: 'edit/beats/a.json', version: 1 }])).toEqual([])
  })

  it('能新建的类型是登记了 create 的那些，按登记顺序给', () => {
    const create = { agentCreatedNotice: '', run: () => Promise.resolve('') }
    const registry = registryWith(shotsEntry, { ...editingEntry, create }, workspaceEntry, {
      ...patternEntry('canvas/*.json'),
      create,
    })

    expect(registry.creatable().map((entry) => entry.type)).toEqual(['editing', 'canvas'])
  })

  it('没登记过的类型解析不出渲染器', () => {
    expect(registryWith(shotsEntry).resolve('media-grid')).toBeUndefined()
  })
})
