import {mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const CLOUD_ROOT = fileURLToPath(new URL('../', import.meta.url));
const QUINT = fileURLToPath(new URL('../node_modules/@informalsystems/quint/dist/src/cli.js', import.meta.url));
const SAMPLES_MAX = 500;
const STEPS_MAX = 80;
const SEED = '75075';
const MODELS = {
  credentials: ['OneRetryRound', 'NoSlotStarved', 'HealthyFailover'],
  durable: ['TurnCommitOnce', 'CheckpointReplayStable', 'HandoffBounded', 'HandoffSingleOwner', 'ResumeOnce', 'RewindKeepsUsage', 'CancelFence'],
  streaming: ['ClientTurnDedup', 'StreamCommitAtomic', 'NoCommittedDrop', 'OrderedPrefix', 'StopPrefix', 'ReconnectCoherent'],
  subagents: ['NoOrphanRuns', 'NoOrphanHandles', 'CascadeStop', 'InboxExactlyOnce', 'TerminalCleanup'],
  security: ['TaintMonotonic', 'AtomicSpendCap', 'ChargeOnce', 'ApprovalRequired'],
};

mkdirSync(new URL('../.spec-traces/', import.meta.url), {recursive: true});

for (const [model, invariants] of Object.entries(MODELS)) {
  for (const args of [
    ['typecheck', `specs/${model}.qnt`],
    ['test', `specs/${model}.qnt`, '--backend=typescript'],
    ['run', `specs/${model}.qnt`, '--backend=typescript', `--max-samples=${SAMPLES_MAX}`,
      `--max-steps=${STEPS_MAX}`, `--seed=${SEED}`, `--out-itf=.spec-traces/${model}.itf.json`, '--verbosity=1', '--invariants', ...invariants],
  ]) {
    const result = spawnSync(process.execPath, [QUINT, ...args], {cwd: CLOUD_ROOT, stdio: 'inherit'});
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
