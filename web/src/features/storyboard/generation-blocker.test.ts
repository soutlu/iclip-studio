import { describe, expect, it } from 'vitest'
import { generationBlockerOf, generationNoticeOf, type GenerationFacts } from './generation-blocker'
import { MODELS_PENDING_TEXT } from './video-generation-options'

const ready: GenerationFacts = {
  modelsStatus: 'ready',
  readOnly: false,
  saveState: 'saved',
  uploading: false,
}

/** 后面几条原因全都成立时，叠上这一条。 */
const laterAll: Partial<GenerationFacts> = { modelsStatus: 'unavailable', uploading: true }

describe('generationBlockerOf', () => {
  it('条件都满足时不挡', () => {
    expect(generationBlockerOf(ready)).toBeUndefined()
    expect(generationBlockerOf({ ...ready, saveState: 'idle' })).toBeUndefined()
  })

  // 每一行都叠上排在它后面的原因，说出来的必须是排在最前的那一条。
  it.each<[string, Partial<GenerationFacts>, string]>([
    ['只读', { ...laterAll, readOnly: true, saveState: 'conflict' }, '只读对话，不能出片'],
    ['版本冲突', { ...laterAll, saveState: 'conflict' }, '先处理分镜的版本冲突'],
    ['保存失败', { ...laterAll, saveState: 'error' }, '分镜没存下，先重试保存'],
    ['保存中', { ...laterAll, saveState: 'saving' }, '分镜保存中'],
    ['上传中', laterAll, '图片还在上传'],
    ['模型读不到', { modelsStatus: 'unavailable' }, MODELS_PENDING_TEXT.unavailable],
    ['模型还在读', { modelsStatus: 'loading' }, MODELS_PENDING_TEXT.loading],
  ])('%s', (_, facts, reason) => {
    expect(generationBlockerOf({ ...ready, ...facts })).toBe(reason)
  })
})

describe('generationNoticeOf', () => {
  it('提交失败的原话优先于画幅提醒', () => {
    expect(
      generationNoticeOf({ aspectRatio: '21:9', model: 'wan3.0-video', submitError: '上游拒收' }),
    ).toBe('上游拒收')
  })

  it('模型做不了当前画幅时提醒，做得了或还没选出模型时不说', () => {
    expect(
      generationNoticeOf({ aspectRatio: '21:9', model: 'wan3.0-video', submitError: undefined }),
    ).toBe('wan3.0-video 做不了 21:9')
    expect(
      generationNoticeOf({ aspectRatio: '9:16', model: 'wan3.0-video', submitError: undefined }),
    ).toBeUndefined()
    expect(
      generationNoticeOf({ aspectRatio: '21:9', model: undefined, submitError: undefined }),
    ).toBeUndefined()
  })
})
