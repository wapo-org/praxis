import {describe, expect, it} from 'vitest';
import {parsePorts, UsageError} from './args.js';
import {DEFAULT_API_PORT, DEFAULT_WEB_PORT} from './constants.js';
import {formatStepLine, GATE_STEPS, runGate, selectSteps, tail} from './gate.js';

describe('gate', () => {
  it('runs the AGENTS.md verification list in CI order', () => {
    expect(GATE_STEPS.map(step => step.id)).toEqual(['typecheck', 'test', 'check-rules', 'lint', 'comment-sweep', 'web-build', 'api-build']);
  });

  it('selects named steps and rejects unknown ones', () => {
    expect(selectSteps(['lint', 'typecheck']).map(step => step.id)).toEqual(['typecheck', 'lint']);
    expect(() => selectSteps(['nope'])).toThrow(/Unknown gate step nope/);
  });

  it('prints one line per step with the exit code on failure', () => {
    expect(formatStepLine({id: 'lint', ok: true, ms: 1234, code: 0})).toBe('PASS lint              1.2s');
    expect(formatStepLine({id: 'test', ok: false, ms: 40_000, code: 1})).toBe('FAIL test             40.0s  exit 1');
    expect(tail('a\nb\nc\n', 2)).toBe('b\nc');
  });

  it('keeps running after a failure and reports the whole gate', async () => {
    const lines: string[] = [];
    const report = await runGate({
      only: ['typecheck', 'test', 'lint'],
      runner: async step => ({code: step.id === 'test' ? 1 : 0, output: `${step.id} output`, ms: 5}),
      print: line => lines.push(line),
    });
    expect(report.ok).toBe(false);
    expect(report.steps.map(step => [step.id, step.ok])).toEqual([['typecheck', true], ['test', false], ['lint', true]]);
    expect(lines.filter(line => /^(PASS|FAIL) /.test(line))).toHaveLength(3);
    expect(lines.some(line => line.includes('    | test output'))).toBe(true);
    expect(lines.at(-1)).toMatch(/^gate: FAILED \(2\/3 steps/);
  });

  it('prints a single JSON report with --json', async () => {
    const lines: string[] = [];
    await runGate({only: ['lint'], json: true, runner: async () => ({code: 0, output: '', ms: 1}), print: line => lines.push(line)});
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({type: 'verify.gate', ok: true, steps: [{id: 'lint', ok: true}]});
  });
});

describe('ports', () => {
  it('defaults away from the dev and reviewer ports and validates overrides', () => {
    expect(parsePorts(undefined)).toEqual({web: DEFAULT_WEB_PORT, api: DEFAULT_API_PORT});
    expect(parsePorts('5300,8900')).toEqual({web: 5300, api: 8900});
    for (const bad of ['5300', '5300,5300', 'a,b', '0,8900', '5300,70000']) expect(() => parsePorts(bad)).toThrow(UsageError);
  });
});
