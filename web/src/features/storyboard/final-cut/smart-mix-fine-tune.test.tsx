import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import type { HfAudioFxChain } from '@hyperframes/core/audio-fx'
import { describe, expect, it } from 'vitest'
import { renderWithProviders } from '@/testing/render'
import { MixFineTune } from './smart-mix-fine-tune'

/** 和「智能调音」一样：效果链由外面记着，改动按 `ChainChange` 应用上去。 */
function Harness() {
  const [chain, setChain] = useState<HfAudioFxChain>({ version: 1, nodes: [] })
  return (
    <MixFineTune
      chain={chain}
      envelope={false}
      onChange={(change) => setChain(change)}
      onEditing={() => {}}
      onEnvelope={() => {}}
      onResetEnvelope={() => {}}
    />
  )
}

describe('精细调音 · 三段均衡的频响小图', () => {
  it('画着频响图，读屏读不到；调低频滑杆后图里的线变了', async () => {
    const user = userEvent.setup()
    await renderWithProviders(<Harness />)
    await user.click(screen.getByRole('button', { name: /^精细调音/ }))
    const curve = screen.getByTestId('eq-curve')
    expect(curve.closest('svg')).toHaveAttribute('aria-hidden', 'true')
    const flat = curve.getAttribute('d')

    const bass = screen.getByRole('slider', { name: '低频 200Hz' })
    act(() => bass.focus())
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}')
    expect(bass).toHaveAttribute('aria-valuetext', '+2.0dB')
    expect(screen.getByTestId('eq-curve').getAttribute('d')).not.toBe(flat)
  })
})
