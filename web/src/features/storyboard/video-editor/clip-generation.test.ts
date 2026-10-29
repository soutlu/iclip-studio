import { describe, expect, it } from 'vitest'
import { readyAttachment, type ComposerPart } from '@/shared/ui/composer'
import { VIDEO_CLIP_MODELS } from '@/testing/video-models'
import {
  clipGenerationBlock,
  referenceImageCountOf,
  type ClipGenerationInput,
} from './clip-generation'

const modelById = (id: string) => {
  const model = VIDEO_CLIP_MODELS.find((item) => item.id === id)
  if (model === undefined) throw new Error(`测试模型缺失：${id}`)
  return model
}

describe('clipGenerationBlock', () => {
  it.each<[string, string, ClipGenerationInput, ReturnType<typeof clipGenerationBlock>]>([
    [
      '模型不支持编辑',
      'vendor-a-seedance-2-0',
      { mode: 'edit', seconds: 5, referenceImageCount: 0 },
      { cause: 'selection', message: '该模型不支持视频编辑，无法生成视频；请选择其他模型' },
    ],
    [
      '图生时长不是整数',
      'vendor-a-seedance-2-5',
      { mode: 'image', seconds: 5.5, referenceImageCount: 1 },
      { cause: 'selection', message: '生成时长无效，无法生成视频；请重新选择生成时长' },
    ],
    [
      '图生时长超出模型范围',
      'vendor-a-seedance-2-0',
      { mode: 'image', seconds: 16, referenceImageCount: 1 },
      {
        cause: 'selection',
        message: '图生时长须为 4–15 秒，无法生成视频；请重新选择生成时长',
      },
    ],
    [
      '编辑不足下限',
      'vendor-a-seedance-2-5',
      { mode: 'edit', seconds: 3.999, referenceImageCount: 0 },
      {
        cause: 'selection',
        message: '该模型编辑至少需要 4 秒，无法生成视频；请拖长选区或按住 Shift 选择相邻镜头',
      },
    ],
    [
      '编辑超过上限',
      'wan3.0-video',
      { mode: 'edit', seconds: 15.001, referenceImageCount: 0 },
      { cause: 'selection', message: '该模型编辑最多支持 15 秒，无法生成视频；请缩小选区' },
    ],
    [
      '图生没有引用图片',
      'vendor-a-seedance-2-5',
      { mode: 'image', seconds: 5, referenceImageCount: 0 },
      {
        cause: 'references',
        message: '尚未引用图片，无法生成视频；请在描述中引用至少一张图片',
      },
    ],
    [
      '时长越界时先报时长，再报图片',
      'vendor-a-seedance-2-0',
      { mode: 'image', seconds: 30, referenceImageCount: 0 },
      {
        cause: 'selection',
        message: '图生时长须为 4–15 秒，无法生成视频；请重新选择生成时长',
      },
    ],
  ])('%s', (_name, id, input, expected) => {
    expect(clipGenerationBlock(modelById(id), input)).toEqual(expected)
  })

  it.each<[string, string, ClipGenerationInput]>([
    [
      '毫秒精度的合法编辑下限',
      'vendor-a-seedance-2-5',
      { mode: 'edit', seconds: 4.1 - 0.1, referenceImageCount: 0 },
    ],
    ['编辑不要求引用图片', 'wan3.0-video', { mode: 'edit', seconds: 1, referenceImageCount: 0 }],
    [
      '图生在范围内且引用了图片',
      'vendor-a-seedance-2-0',
      { mode: 'image', seconds: 15, referenceImageCount: 1 },
    ],
  ])('%s时不阻止', (_name, id, input) => {
    expect(clipGenerationBlock(modelById(id), input)).toBeUndefined()
  })
})

describe('referenceImageCountOf', () => {
  it('同一地址只算一张，上传失败的图片不算', () => {
    const image = (url: string): ComposerPart => ({
      kind: 'media',
      media: readyAttachment({ kind: 'image', name: url, url }),
    })
    const failed: ComposerPart = {
      kind: 'media',
      media: {
        ...readyAttachment({ kind: 'image', name: '失败', url: 'https://example.com/c.jpg' }),
        status: 'error',
      },
    }
    expect(
      referenceImageCountOf([
        image('https://example.com/a.jpg'),
        { kind: 'text', text: '参考' },
        image('https://example.com/a.jpg'),
        image('https://example.com/b.jpg'),
        failed,
      ]),
    ).toBe(2)
  })
})
