import {defineSuite, type AutoStep, type StepContext} from '@praxis/verify';
import {CHECKLIST, crudIsolationSteps, type CrudFixture} from './convex-typed-rows/crud-isolation.js';
import {cleanOwners, hostedFixture, HOSTED_NEEDS} from './convex-typed-rows/fixture.js';
import {verifyCommit, verifyPurge} from './convex-typed-rows/service-steps.js';

type ClientSteps = ReturnType<typeof crudIsolationSteps>;
type ClientCheck = ClientSteps[number]['id'];
const clientChecks = new WeakMap<StepContext['state'], ClientSteps>();

async function fixtureChecks(context: StepContext): Promise<ClientSteps> {
  const previous = clientChecks.get(context.state);
  if (previous) return previous;
  const {live, owners: [a, b], runId} = await hostedFixture(context);
  const fixture: CrudFixture = {...live, a, b, runId, log: line => context.log(line)};
  const checks = crudIsolationSteps(fixture);
  clientChecks.set(context.state, checks);
  return checks;
}

function clientStep(id: ClientCheck, checklist: string): AutoStep {
  return {
    id, kind: 'auto', checklist, needs: HOSTED_NEEDS,
    async run(context) {
      const checks = await fixtureChecks(context);
      const step = checks.find(check => check.id === id);
      if (!step) throw new Error(`Missing client check ${id}`);
      const {status, summary, checks: results} = await step.run();
      context.attach('checks.json', JSON.stringify(results, null, 2));
      return {status, summary};
    },
  };
}

export default defineSuite({
  id: 'convex-typed-rows',
  issue: 'PRA-127',
  title: 'Hosted Convex typed rows and owner isolation',
  steps: [
    {
      id: 'deploy',
      kind: 'manual',
      checklist: 'Deploy the PR wapo-org/praxis#30 schema (`chats`, `messages`, `runs`, `turns`, `sandboxes`, `outputs`) with `npx convex deploy`. The deploy succeeds and the dashboard lists every owner-first index.',
      instruction: 'Run `praxis-env npx convex deploy -y` from cloud on the designated dev deployment. Attach the successful deploy output and all ten owner-first indexes.',
      evidence: 'file',
      needs: {},
    },
    {
      id: 'preview-chat',
      kind: 'manual',
      checklist: CHECKLIST.crud,
      instruction: 'Attach Playwright evidence of create, rename, delete and reload on a web preview targeting this deployment. If no preview targets it, attach the deployment comparison and use the suite’s authenticated client checks.',
      evidence: 'file',
      needs: {},
    },
    clientStep('owner-chat-lifecycle', CHECKLIST.crud),
    clientStep('owner-message-paging', CHECKLIST.crud),
    clientStep('owner-run-read', CHECKLIST.crud),
    clientStep('foreign-owner-reads', CHECKLIST.isolation),
    clientStep('same-client-chat-id', CHECKLIST.isolation),
    clientStep('unauthenticated-calls', CHECKLIST.isolation),
    clientStep('owner-chat-delete', CHECKLIST.crud),
    {
      id: 'commit',
      kind: 'auto',
      checklist: 'Commit messages concurrently to one chat with `messages.commit` (server credential). Sequences are contiguous with no gaps or duplicates, a retried message keeps its sequence, and a wrong credential is rejected.',
      needs: HOSTED_NEEDS,
      run: verifyCommit,
    },
    {
      id: 'purge',
      kind: 'auto',
      checklist: 'Run `account:purge` for a disposable owner. All six typed tables and the workflow journal have zero rows for that owner, and the other owner\'s rows are intact.',
      needs: HOSTED_NEEDS,
      run: verifyPurge,
    },
    {
      id: 'cleanup',
      kind: 'auto',
      cleanup: true,
      checklist: 'Purge both disposable owners at the end of the hosted run.',
      needs: HOSTED_NEEDS,
      run: cleanOwners,
    },
  ],
});
