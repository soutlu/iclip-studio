import { describe, expect, it } from 'vitest';

import { transcriptOperationSchema, transcriptQuerySchema } from '../contract/schema';
import type { TranscriptOperation } from '../ops/operation';

describe('contract schemas', () => {
  it('roundtrips ops carrying the extended wire detail', () => {
    const ops: TranscriptOperation[] = [
      {
        op: 'reset',
        agentId: 'main',
        snapshot: {
          items: [],
          tasks: [],
          interactions: [],
          attachments: [],
          todos: [],
          prompts: [
            {
              promptId: 'p1',
              status: 'completed',
              userMessageId: 'u1',
              content: [{ type: 'text', text: 'hi' }],
              createdAt: '2026-07-22T00:00:00.000Z',
              finishedAt: '2026-07-22T00:01:00.000Z',
              steeredAt: '2026-07-22T00:00:30.000Z',
            },
          ],
          meta: {},
        },
      },
      {
        op: 'turn.upsert',
        turn: {
          kind: 'turn', turnId: 't1', ordinal: 1, state: 'failed', origin: { kind: 'user' },
          content: [{ type: 'text', text: 'go' }],
          usage: { inputTokens: 12, outputTokens: 5, cachedTokens: 3 },
          durationMs: 1500,
          error: 'boom',
        },
      },
    ];
    for (const op of ops) {
      expect(transcriptOperationSchema.parse(op)).toEqual(op);
    }
  });

  it('rejects path-hostile agent ids in the transcript query', () => {
    const base = { agent_id: 'main', before_turn: undefined, after_turn: undefined, page_size: undefined };
    expect(transcriptQuerySchema.safeParse({ ...base, agent_id: 'sub-1' }).success).toBe(true);
    expect(transcriptQuerySchema.safeParse({ ...base, agent_id: '01HF7YAT31J7SMRT1QXGJWKR8D' }).success).toBe(true);
    for (const hostile of ['../main', '..\\main', '..', 'a/b', 'a\\b', '.', 'a\0b', 'x'.repeat(200)]) {
      expect(transcriptQuerySchema.safeParse({ ...base, agent_id: hostile }).success).toBe(false);
    }
  });
});
