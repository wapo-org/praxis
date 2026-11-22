import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {formatReport, replaySession} from './io-replay.js';
import {SERVER_TOKEN} from '../tests/workflow-fixture.js';

/** `IO_REPLAY_TURNS=50 npm --prefix cloud run io:replay` prints the figure recorded on PRA-6; CI replays a short session. */
const TURNS = Number.parseInt(process.env.IO_REPLAY_TURNS ?? '4', 10);

describe('I/O replay script (PRA-26)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('CONVEX_CLOUD_URL', 'https://test.convex.cloud');
    vi.stubEnv('PRAXIS_CONVEX_SERVER_TOKEN', SERVER_TOKEN);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('replays a scripted session and reports documents and bytes read and written', async () => {
    const report = await replaySession(TURNS);
    process.stdout.write(`${formatReport(report)}\n`);
    expect(report.turn.documentsWritten).toBeGreaterThanOrEqual(TURNS);
    expect(report.client.documentsRead).toBeGreaterThan(TURNS);
    expect(report.client.documentsWritten).toBe(0);
    expect(report.total.bytesRead).toBe(report.turn.bytesRead + report.client.bytesRead);
  }, 600_000);
});
