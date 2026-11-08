import { useState } from 'react'
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { zTaskInputsOutput } from '@/shared/api/generated/zod.gen'
import { renderWithProviders } from '@/testing/render'
import type { Task } from '../tasks.api'
import { TaskCard } from './task-card'

const makeTask = (products: Task['inputs']['products']): Task => ({
  id: 'task-gallery',
  title: '秋季新品鞋款视频创作需求单',
  status: 'confirmed',
  priority: 0,
  deadline: null,
  creatorUserId: 'creator',
  assigneeUserIds: [],
  createdAt: '2026-09-21T08:00:00Z',
  updatedAt: '2026-09-21T08:00:00Z',
  inputs: zTaskInputsOutput.parse({
    video_spec: {
      aspect_ratio: null,
      duration_seconds: null,
      platform: 'douyin',
      video_type: 'product_showcase',
      content_type: 'short_video',
    },
    products,
    reference_image_oss_urls: {
      model: ['https://example.com/model.jpg'],
      outfit: ['https://example.com/outfit.jpg'],
      prop: ['https://example.com/prop.jpg'],
    },
    reference_video_oss_url: null,
  }),
})

const product = (
  styleNo: string,
  images: string[] = [],
  name = '',
): Task['inputs']['products'][number] => ({
  style_no: styleNo,
  name,
  brand: '',
  category: '',
  color_name: '',
  image_oss_urls: images,
})

function CardActions({ task }: { task: Task }) {
  const [action, setAction] = useState<string>('尚未打开')
  return (
    <>
      <TaskCard
        onClick={() => setAction('正在查看需求')}
        onRename={() => setAction('正在重命名')}
        task={task}
      />
      <p role="status">{action}</p>
    </>
  )
}

describe('TaskCard', () => {
  it('使用商品首图，保留原需求单名称和款号，不将其他商品图或参考图用作封面', async () => {
    const task = makeTask([
      product(
        'LOAFER-01',
        ['https://example.com/shoe.jpg', 'https://example.com/back.jpg'],
        '乐福鞋',
      ),
    ])
    await renderWithProviders(<TaskCard onClick={() => {}} task={task} />)

    const cover = within(screen.getByRole('button', { name: `查看需求：${task.title}` })).getByRole(
      'img',
      { name: '乐福鞋 商品图' },
    )
    expect(cover).toHaveAttribute('src', 'https://example.com/shoe.jpg')
    expect(screen.getByText(task.title)).toBeVisible()
    expect(
      screen.getByRole('button', { name: `查看需求：${task.title}` }),
    ).toHaveAccessibleDescription(/LOAFER-01/)
    expect(screen.getByRole('button', { name: `查看需求：${task.title}` })).toBeVisible()
    expect(screen.queryByRole('button', { name: '更多操作' })).not.toBeInTheDocument()
  })

  it('商品无图时明确占位，即使存在模特、穿搭和道具参考图也不代替商品图', async () => {
    await renderWithProviders(<TaskCard onClick={() => {}} task={makeTask([product('SHOE-01')])} />)

    expect(screen.getByText('暂无商品图')).toBeVisible()
    expect(screen.getByRole('img', { name: '需求单商品图，暂无商品图' })).not.toHaveAttribute('src')
    expect(screen.getAllByRole('img')).toHaveLength(4)
  })

  it('商品图加载失败时显示明确占位，不自动换成其他图片', async () => {
    await renderWithProviders(
      <TaskCard
        onClick={() => {}}
        task={makeTask([
          product('SHOE-01', ['https://example.com/broken.jpg', 'https://example.com/another.jpg']),
        ])}
      />,
    )

    const card = screen.getByRole('button', { name: '查看需求：秋季新品鞋款视频创作需求单' })
    fireEvent.error(within(card).getByRole('img', { name: 'SHOE-01 商品图' }))

    expect(within(card).getByText('图片加载失败')).toBeVisible()
    expect(within(card).queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getAllByRole('img')).toHaveLength(4)
  })

  it('左右滚动参考图时不打开需求详情', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<CardActions task={makeTask([product('SHOE-01')])} />)
    const strip = screen.getByLabelText('商品与参考图')
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 300 },
      scrollBy: {
        configurable: true,
        value: ({ left }: { left: number }) => {
          strip.scrollLeft += left
          fireEvent.scroll(strip)
        },
      },
    })
    fireEvent.load(screen.getByRole('img', { name: '模特参考图' }))

    await user.click(screen.getByRole('button', { name: '向右滚动参考图' }))
    expect(strip.scrollLeft).toBe(100)
    expect(screen.getByRole('status')).toHaveTextContent('尚未打开')
    await user.click(screen.getByRole('button', { name: '向左滚动参考图' }))
    expect(strip.scrollLeft).toBe(0)
    expect(screen.getByRole('status')).toHaveTextContent('尚未打开')
  })

  it('更多操作无需悬停即可打开，重命名不会同时打开详情', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<CardActions task={makeTask([product('SHOE-01')])} />)

    const more = screen.getByRole('button', { name: '更多操作' })
    expect(more).toBeVisible()
    await user.click(more)
    expect(screen.getByRole('menuitem', { name: '重命名' })).toBeVisible()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('status')).toHaveTextContent('尚未打开')
    await user.click(more)
    await user.click(screen.getByRole('menuitem', { name: '重命名' }))

    expect(screen.getByRole('status')).toHaveTextContent('正在重命名')
  })
})
