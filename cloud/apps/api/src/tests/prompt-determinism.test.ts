import {expect, it} from 'vitest';
import {buildSystemPrompt} from '../conversation.js';

it('current system prefix has deterministic bytes across discovery order and repeated assembly', () => {
  const input = {skills: [{name: 'z', description: 'last'}, {name: 'a', description: 'second'}, {name: 'a', description: 'first'}], toolNotes: ['z', 'a', 'a']};
  const baseline = buildSystemPrompt(input);
  expect(buildSystemPrompt({...input, skills: [...input.skills].reverse(), toolNotes: [...input.toolNotes].reverse()})).toBe(baseline);
  expect(buildSystemPrompt(input)).toBe(baseline);
  expect(Buffer.byteLength(buildSystemPrompt({}))).toBe(1993);
});
