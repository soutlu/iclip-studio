import { cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrandTemplate } from '@/shared/api/brand-templates'
import { renderWithProviders } from '@/testing/render'
import { BrandPlaceholder } from './film-menus'

afterEach(cleanup)

describe('片头片尾模板预览', () => {
  it.each([
    ['intro', '片头'],
    ['outro', '片尾'],
  ] as const)('%s 菜单使用淡入之后的精确截帧', async (position, label) => {
    const template: BrandTemplate = {
      id: 'ba000001-0000-4000-8000-000000000001',
      name: `品牌${label}`,
      kind: position,
      brand: '示例品牌',
      url: 'https://media.oss-cn-shenzhen.aliyuncs.com/brand.mp4',
      width: 1920,
      height: 1080,
      durationMs: 3000,
      hasAudio: false,
      createdAt: '2026-10-15T00:00:00Z',
      disabledAt: null,
    }
    const user = userEvent.setup()
    await renderWithProviders(
      <BrandPlaceholder
        brands={{
          templates: [template],
          reason: undefined,
          intro: null,
          outro: null,
          onSelect: vi.fn(),
          onRemove: vi.fn(),
        }}
        position={position}
        style={{}}
      />,
    )
    await user.click(screen.getByRole('button', { name: `添加${label}` }))
    const option = await screen.findByRole('menuitem', { name: `${template.name}，3.0 秒` })
    const poster = within(option).getByRole('presentation')
    expect(poster).toHaveAttribute('src', expect.stringContaining('video/snapshot,t_500,'))
    expect(poster).not.toHaveAttribute('src', expect.stringContaining('m_fast'))
  })
})
