import { describe, expect, it } from 'vitest'
import { previewPageUrl, zPreviewCommand, zPreviewEvent } from './preview-protocol'

describe('预览页地址', () => {
  it('预览域名下的预览页，令牌编码后写在 # 后面', () => {
    expect(previewPageUrl('https://preview.example.com', 'a/b c')).toBe(
      'https://preview.example.com/final-cut-preview.html#a%2Fb%20c',
    )
  })
})

describe('编辑器发给预览页的命令', () => {
  it.each([
    { type: 'load', html: '<!doctype html>', runtimeSrc: 'https://p.test/runtime.js', seq: 1 },
    {
      type: 'patch',
      seq: 2,
      patches: [
        { op: 'replace', path: '/elements/v1/timing/start', value: 3 },
        { op: 'remove', path: '/elements/v2' },
        { op: 'add', path: '/elements/v3', value: { html: '<video></video>', parentId: 'film' } },
      ],
    },
    { type: 'patch', seq: 3, patches: [] },
    { type: 'unload' },
    { type: 'play' },
    { type: 'pause' },
    { type: 'seek', ms: 0, seq: 1 },
    { type: 'playback', rate: 0.5, muted: true, loop: false },
    { type: 'size', width: 1080, height: 1920 },
    { type: 'retry' },
  ])('合规：%o', (command) => {
    expect(zPreviewCommand.parse(command)).toEqual(command)
  })

  it.each([
    { type: 'load', html: '<!doctype html>', seq: 1 },
    { type: 'load', html: '<!doctype html>', runtimeSrc: 'https://p.test/runtime.js' },
    { type: 'patch', patches: [] },
    { type: 'patch', seq: 1, patches: [{ op: 'move', path: '/elements/v1', from: '/x' }] },
    { type: 'patch', seq: 1, patches: [{ op: 'remove' }] },
    { type: 'patch', seq: 1, patches: '[]' },
    { type: 'seek', ms: -1, seq: 1 },
    { type: 'seek', ms: 0 },
    { type: 'seek', ms: 0, seq: 0.5 },
    { type: 'playback', rate: 0, muted: false, loop: false },
    { type: 'size', width: 0, height: 1920 },
    { type: 'play', extra: true },
    { type: 'eval' },
    'play',
    null,
  ])('不合规：%o', (command) => {
    expect(zPreviewCommand.safeParse(command).success).toBe(false)
  })
})

describe('预览页发给编辑器的消息', () => {
  it.each([
    { type: 'ready' },
    { type: 'loaded', duration: 12.5, seq: 1 },
    { type: 'patched', duration: 9, seq: 2 },
    { type: 'needsLoad', seq: 3 },
    { type: 'time', ms: 1500, seq: 0 },
    { type: 'playing', playing: false },
    { type: 'buffering', buffering: true },
    { type: 'buffered', spans: [{ start: 0, end: 1.5 }] },
    { type: 'mediaSettled' },
    { type: 'clipFailed', failed: true },
  ])('合规：%o', (event) => {
    expect(zPreviewEvent.parse(event)).toEqual(event)
  })

  it.each([
    { type: 'loaded', duration: Number.POSITIVE_INFINITY, seq: 1 },
    { type: 'loaded', duration: 12.5 },
    { type: 'patched', duration: 9, seq: 2, patches: [] },
    { type: 'needsLoad', seq: 1, reason: '<img src=x onerror=alert(1)>' },
    { type: 'needsLoad', seq: '1' },
    { type: 'time', ms: 1.5, seq: 0 },
    { type: 'time', ms: '1500', seq: 0 },
    { type: 'time', ms: 1500 },
    { type: 'playing', playing: 'true' },
    { type: 'buffered', spans: [{ start: -1, end: 1 }] },
    { type: 'buffered', spans: 'all' },
    { type: 'clipFailed', failed: true, message: '<img src=x onerror=alert(1)>' },
    { type: 'navigate', url: 'https://elsewhere.example.com' },
    undefined,
  ])('不合规：%o', (event) => {
    expect(zPreviewEvent.safeParse(event).success).toBe(false)
  })
})
