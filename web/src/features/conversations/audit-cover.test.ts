import { describe, expect, it } from 'vitest'
import { auditCoverUrl } from './audit-cover'

const OSS_IMAGE = 'https://bucket.oss-ap-southeast-1.aliyuncs.com/products/shirt.jpg'
const OSS_VIDEO = 'https://bucket.oss-ap-southeast-1.aliyuncs.com/masters/cut.mp4'
const PRODUCT_THUMB = `${OSS_IMAGE}?x-oss-process=image/resize,s_160/format,webp`
const FIRST_FRAME = `${OSS_VIDEO}?x-oss-process=video/snapshot,t_0,f_jpg,w_256,h_0,m_fast`

const preview = (imageUrl: string | null) => ({ title: '夏季上新', requirement: '', imageUrl })

describe('auditCoverUrl', () => {
  it('有商品图就用商品图的缩略图，成片首帧让位', () => {
    expect(
      auditCoverUrl({ taskId: 't1', latestMasterUrl: OSS_VIDEO }, preview(OSS_IMAGE), 'ready'),
    ).toBe(PRODUCT_THUMB)
  })

  it('商品图不是 OSS 地址时原样用，不追加处理参数', () => {
    const local = 'https://example.com/shirt.webp'
    expect(auditCoverUrl({ taskId: 't1', latestMasterUrl: null }, preview(local), 'ready')).toBe(
      local,
    )
  })

  it('需求单没有商品图、或没挂需求单时，用最新成片的首帧', () => {
    expect(
      auditCoverUrl({ taskId: 't1', latestMasterUrl: OSS_VIDEO }, preview(null), 'ready'),
    ).toBe(FIRST_FRAME)
    expect(auditCoverUrl({ taskId: null, latestMasterUrl: OSS_VIDEO }, undefined, 'ready')).toBe(
      FIRST_FRAME,
    )
  })

  it('成片不是 OSS 地址截不出首帧，按没有封面算', () => {
    expect(
      auditCoverUrl(
        { taskId: null, latestMasterUrl: 'https://example.com/cut.webm' },
        undefined,
        'ready',
      ),
    ).toBeNull()
  })

  it('既没有商品图也没有成片时没有封面', () => {
    expect(auditCoverUrl({ taskId: null, latestMasterUrl: null }, undefined, 'ready')).toBeNull()
    expect(
      auditCoverUrl({ taskId: 't1', latestMasterUrl: null }, preview(null), 'ready'),
    ).toBeNull()
  })

  it('需求单预览还在读时先不放首帧，免得预览一到又换图', () => {
    expect(
      auditCoverUrl({ taskId: 't1', latestMasterUrl: OSS_VIDEO }, undefined, 'loading'),
    ).toBeNull()
  })

  it.each(['error', 'forbidden', 'ready'] as const)(
    '需求单预览读不到（%s）时退到成片首帧',
    (state) => {
      expect(auditCoverUrl({ taskId: 't1', latestMasterUrl: OSS_VIDEO }, undefined, state)).toBe(
        FIRST_FRAME,
      )
    },
  )
})
