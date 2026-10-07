import { describe, expect, it } from 'vitest'
import {
  generationBlockerOf,
  generationNoticeOf,
  generationStatusOf,
  type GenerationFacts,
} from './generation-blocker'
import { MODELS_PENDING_TEXT } from './video-generation-options'

const ready: GenerationFacts = {
  modelsStatus: 'ready',
  readOnly: false,
  saveState: 'saved',
  uploading: false,
}

/** 后面几条原因全都成立时，叠上这一条。 */
const laterAll: Partial<GenerationFacts> = { modelsStatus: 'loading', uploading: true }

describe('generationBlockerOf', () => {
  it('条件都满足时不挡', () => {
    expect(generationBlockerOf(ready)).toBeUndefined()
    expect(generationBlockerOf({ ...ready, saveState: 'idle' })).toBeUndefined()
  })

  // 每一行都叠上排在它后面的原因，说出来的必须是排在最前的那一条；一直挡着的排在暂态前面。
  it.each<[string, Partial<GenerationFacts>, string, boolean]>([
    ['只读', { ...laterAll, readOnly: true, saveState: 'conflict' }, '只读任务，不能出片', false],
    ['版本冲突', { ...laterAll, saveState: 'conflict' }, '先处理分镜的版本冲突', false],
    ['保存失败', { ...laterAll, saveState: 'error' }, '分镜没存下，先重试保存', false],
    [
      '模型读不到',
      { saveState: 'saving', uploading: true, modelsStatus: 'unavailable' },
      MODELS_PENDING_TEXT.unavailable,
      false,
    ],
    ['保存中', { ...laterAll, saveState: 'saving' }, '分镜保存中', true],
    ['上传中', laterAll, '图片还在上传', true],
    ['模型还在读', { modelsStatus: 'loading' }, MODELS_PENDING_TEXT.loading, true],
  ])('%s', (_, facts, reason, transient) => {
    expect(generationBlockerOf({ ...ready, ...facts })).toEqual({ reason, transient })
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

describe('generationStatusOf', () => {
  const persistent = { reason: '只读任务，不能出片', transient: false }
  const saving = { reason: '分镜保存中', transient: true }

  it('一直挡着的原因上状态行，压过错误提醒', () => {
    expect(generationStatusOf(persistent, '上游拒收')).toEqual({
      hiddenReason: undefined,
      line: { text: '只读任务，不能出片', tone: 'blocked' },
    })
  })

  it('暂态原因不上状态行，只留给主按钮当说明；同时有错误提醒时状态行写提醒', () => {
    expect(generationStatusOf(saving, undefined)).toEqual({
      hiddenReason: '分镜保存中',
      line: undefined,
    })
    expect(generationStatusOf(saving, 'wan3.0-video 做不了 21:9')).toEqual({
      hiddenReason: '分镜保存中',
      line: { text: 'wan3.0-video 做不了 21:9', tone: 'error' },
    })
  })

  it('没被挡住时只有错误提醒，什么都没有就不出状态行', () => {
    expect(generationStatusOf(undefined, '上游拒收')).toEqual({
      hiddenReason: undefined,
      line: { text: '上游拒收', tone: 'error' },
    })
    expect(generationStatusOf(undefined, undefined)).toEqual({
      hiddenReason: undefined,
      line: undefined,
    })
  })

  it('不拦出片的提醒排在最后：没有置灰原因与错误时才上状态行；暂态原因照样只给主按钮', () => {
    const hint = '涂鸦滑板场缺失，参考描述生成'
    expect(generationStatusOf(undefined, undefined, hint)).toEqual({
      hiddenReason: undefined,
      line: { text: hint, tone: 'hint' },
    })
    expect(generationStatusOf(saving, undefined, hint)).toEqual({
      hiddenReason: '分镜保存中',
      line: { text: hint, tone: 'hint' },
    })
    expect(generationStatusOf(undefined, '上游拒收', hint).line).toEqual({
      text: '上游拒收',
      tone: 'error',
    })
    expect(generationStatusOf(persistent, undefined, hint).line?.tone).toBe('blocked')
  })
})
