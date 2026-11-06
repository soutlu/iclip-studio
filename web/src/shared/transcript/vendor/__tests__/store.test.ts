import { describe, expect, it } from 'vitest';

import { AgentTranscript } from '../store/agentTranscript';
import type { FrameUpsertOp } from '../ops/operation';

describe('AgentTranscript metadata', () => {
  it('updates metadata when the rest of the tool frame is unchanged', () => {
    const tx = new AgentTranscript('main');
    const op: FrameUpsertOp = {
      op: 'frame.upsert',
      turnId: 't1',
      stepId: 't1.1',
      frame: {
        kind: 'tool',
        frameId: 't1.1.call_1',
        toolCallId: 'call_1',
        name: 'generate_shot_frames',
        state: 'done',
        view: 'media_grid',
        metadata: { items: [] },
      },
    };
    tx.apply([op]);

    const metadata = { items: [{ caption: 'S01', url: 'https://example.com/a.png' }] };
    tx.apply([{ ...op, frame: { ...op.frame, metadata } }]);

    const frame = tx.getTurn('t1')?.steps[0]?.frames[0];
    expect(frame?.kind === 'tool' && frame.metadata).toEqual(metadata);
  });
});
