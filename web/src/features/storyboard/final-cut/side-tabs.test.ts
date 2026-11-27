import { describe, expect, it } from 'vitest'
import { audio, caption, fixtureCatalog, host, video } from '@/testing/final-cut'
import { usedTabs } from './side-tabs'

const used = (...clips: Parameters<typeof usedTabs>[0]) => [...usedTabs(clips, fixtureCatalog)]

describe('右栏导航上带圆点的页签', () => {
  it('只有视频片段时一个都不带（「镜头」不算）', () => {
    expect(used(video())).toEqual([])
  })

  it('字幕、配乐行上的音频、元素、模板片段各让对应的页签带点', () => {
    expect(used(caption())).toEqual(['captions'])
    expect(used(audio())).toEqual(['audio'])
    expect(used(host({ item: 'fixture-overlay' }))).toEqual(['component'])
    expect(used(host({ item: 'fixture-scene' }))).toEqual(['block'])
  })

  it('配音片段、从视频分离出来的原声、组件库里查不到的宿主不算', () => {
    const dub = audio({
      dub: { locale: 'en', caption: 'c1', trimmed: false, text: null, voice: null, speed: 1 },
    })
    const original = audio({ syncOrigin: 'v1' })
    expect(used(dub, original, host({ item: 'missing' }))).toEqual([])
  })
})
