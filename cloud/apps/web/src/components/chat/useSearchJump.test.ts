import type { Message } from '@praxis/protocol';
import { describe, expect, it } from 'vitest';
import { extractQueryTerms, resolveMatchedMessage } from './useSearchJump';

function makeMsg(
  id: string,
  role: 'user' | 'assistant',
  parts: Message['parts'],
  sequence = 1,
): Message {
  return {
    type: 'message',
    id,
    chatId: 'chat-1',
    role,
    parts,
    sequence,
    createdAt: '2026-11-13T12:00:00.000Z',
    updatedAt: '2026-11-13T12:00:00.000Z',
  };
}

describe('useSearchJump match resolution', () => {
  it('filters common stop words unless all words are stop words', () => {
    expect(extractQueryTerms('how to pack for a trip')).toEqual(['pack', 'trip']);
    expect(extractQueryTerms('for the')).toEqual(['for', 'the']);
  });

  it('finds a match deep in a long conversation', () => {
    const messages = Array.from({ length: 30 }, (_, i) =>
      makeMsg(
        `m-${i}`,
        i % 2 === 0 ? 'user' : 'assistant',
        [{ type: 'text', text: i === 4 ? 'Discuss quartz lattice thermal conductivity' : `Turn number ${i}` }],
        i + 1,
      ),
    );
    const res = resolveMatchedMessage(messages, {
      title: 'Physics chat',
      query: 'quartz lattice',
      snippet: 'Discuss quartz lattice thermal conductivity',
    });
    expect(res?.message.id).toBe('m-4');
    expect(res?.inActivity).toBe(false);
    expect(res?.phrase).toBe('Discuss quartz lattice thermal conductivity');
  });

  it('flags inActivity when match is inside assistant reasoning or tool output', () => {
    const messages = [
      makeMsg('m-0', 'user', [{ type: 'text', text: 'Check logs' }], 1),
      makeMsg(
        'm-1',
        'assistant',
        [
          { type: 'reasoning', text: 'Inspecting postgres shard replication lag' },
          { type: 'text', text: 'All services healthy.' },
        ],
        2,
      ),
    ];
    const res = resolveMatchedMessage(messages, {
      title: 'Ops check',
      query: 'replication lag',
      snippet: 'Inspecting postgres shard replication lag',
    });
    expect(res?.message.id).toBe('m-1');
    expect(res?.inActivity).toBe(true);
  });

  it('returns null for title-only matches even when the API echoes the first message as a fallback snippet', () => {
    const messages = [
      makeMsg('m-0', 'user', [{ type: 'text', text: 'Good morning, let us start' }], 1),
      makeMsg('m-1', 'assistant', [{ type: 'text', text: 'Sure, ready when you are.' }], 2),
    ];
    const res = resolveMatchedMessage(messages, {
      title: 'Quantum Umbrella Architecture',
      query: 'Quantum Umbrella',
      snippet: 'Good morning, let us start',
    });
    expect(res).toBeNull();
  });

  it('supports semantic matches via snippet when query words differ from message text', () => {
    const messages = [
      makeMsg('m-0', 'user', [{ type: 'text', text: 'Hello' }], 1),
      makeMsg('m-1', 'assistant', [{ type: 'text', text: 'Packing list for 3 days in Lisbon' }], 2),
    ];
    const res = resolveMatchedMessage(messages, {
      title: 'Travel',
      query: 'things to bring abroad',
      snippet: '…Packing list for 3 days in Lisbon…',
    });
    expect(res?.message.id).toBe('m-1');
    expect(res?.phrase).toBe('Packing list for 3 days in Lisbon');
  });
});
