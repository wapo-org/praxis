import {describe, expect, it} from 'vitest';
import {annotateSnapshot, parseTarget} from './refs.js';

const SNAPSHOT = [
  '- main:',
  '  - heading "Fixture" [level=1]',
  '  - link "Docs":',
  '    - /url: "#a"',
  '  - link "Docs":',
  '  - textbox "Say \\"hi\\""',
  '  - button "Sign in"',
  '  - button',
  '  - status',
].join('\n');

describe('snapshot refs', () => {
  it('numbers named actionable nodes in document order and records role, name and nth', () => {
    const {text, refs} = annotateSnapshot(SNAPSHOT);
    expect(text.split('\n')).toEqual([
      '- main:',
      '  - heading "Fixture" [level=1]',
      '  - link "Docs" [ref=e1]:',
      '    - /url: "#a"',
      '  - link "Docs" [ref=e2]:',
      '  - textbox "Say \\"hi\\"" [ref=e3]',
      '  - button "Sign in" [ref=e4]',
      '  - button',
      '  - status',
    ]);
    expect(refs).toEqual({
      e1: {role: 'link', name: 'Docs', nth: 0},
      e2: {role: 'link', name: 'Docs', nth: 1},
      e3: {role: 'textbox', name: 'Say "hi"', nth: 0},
      e4: {role: 'button', name: 'Sign in', nth: 0},
    });
  });

  it('gives the same refs for the same tree, which is what makes them deterministic', () => {
    expect(annotateSnapshot(SNAPSHOT)).toEqual(annotateSnapshot(SNAPSHOT));
  });

  it('parses refs and role:name targets and rejects anything else', () => {
    expect(parseTarget('e12')).toEqual({kind: 'ref', ref: 'e12'});
    expect(parseTarget('button:Sign in')).toEqual({kind: 'role', role: 'button', name: 'Sign in'});
    expect(parseTarget('link:a:b')).toEqual({kind: 'role', role: 'link', name: 'a:b'});
    for (const bad of ['e0', 'Sign in', ':x', '#login', 'Button:x']) expect(() => parseTarget(bad)).toThrow(/target must be/);
  });
});
