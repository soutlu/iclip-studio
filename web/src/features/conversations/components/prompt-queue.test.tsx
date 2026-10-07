import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderWithTooltip } from '@/testing/render'
import { PromptQueue } from './prompt-queue'

const prompt = {
  media: [
    { kind: 'image' as const, url: 'https://cdn.example/uploads/look.png' },
    { kind: 'video' as const, url: 'https://cdn.example/uploads/pace.mp4' },
  ],
  promptId: 'p-queued',
  text: '照这两个参考再来一版',
}

describe('PromptQueue', () => {
  it.each(['look.png', 'pace.mp4'])(
    '点排队附件 %s 进灯箱，Esc 关掉后焦点回到那个附件',
    async (name) => {
      renderWithTooltip(
        <PromptQueue
          canSteer={false}
          onDiscard={() => {}}
          onSteer={() => {}}
          prompts={[prompt]}
          readOnly={false}
        />,
      )
      const attachment = screen.getByRole('button', { name })

      await userEvent.click(attachment)
      expect(await screen.findByRole('dialog', { name })).toBeInTheDocument()

      await userEvent.keyboard('{Escape}')
      expect(screen.queryByRole('dialog', { name })).not.toBeInTheDocument()
      await waitFor(() => expect(attachment).toHaveFocus())
    },
  )
})
