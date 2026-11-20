import {defineSuite, type StepContext} from '@praxis/verify';
import {cleanOwners, hostedFixture, HOSTED_NEEDS} from './convex-typed-rows/fixture.js';
import {verifyDeletion} from './workflow-skeleton/deletion.js';
import {verifyCancellation, verifyCompletion} from './workflow-skeleton/run-checks.js';
import {OAUTH_PURGE_CHECKLIST, SEEDED_OAUTH_PURGE_ID, verifySeededOAuthEmailPurge} from './workflow-skeleton/oauth-purge.js';
import {adminActionCaller, capacityStep, CHECKLIST, redeliveryStep} from './workflow-skeleton/redelivery-capacity.js';

function ownerStep(id: string, checklist: string, step: typeof redeliveryStep) {
  return {
    id, kind: 'auto' as const, checklist, needs: HOSTED_NEEDS,
    async run(context: StepContext) {
      const {live, owners: [, owner], reader, runId} = await hostedFixture(context);
      await owner.refresh();
      const adminAction = adminActionCaller(live.convexUrl, context.secret('CONVEX_DEPLOY_KEY'));
      const {status, summary, checks} = await step({runId, owner, adminAction, reader, log: context.log}).run();
      context.attach('checks.json', JSON.stringify(checks, null, 2));
      return {status, summary};
    },
  };
}

export default defineSuite({
  id: 'workflow-skeleton',
  issue: 'PRA-125',
  title: 'Hosted Convex workflow skeleton and deletion purge',
  steps: [
    {
      id: 'completion',
      kind: 'auto',
      checklist: '`runs.start` with a real Auth v2 session (via `getAuthUserId`) creates a run and workflow; each turn runs through the signed hosted `/api/turn` worker and commits once, and the run settles `completed`.',
      needs: HOSTED_NEEDS,
      run: verifyCompletion,
    },
    {
      id: 'cancellation',
      kind: 'auto',
      checklist: '`runs.cancel` mid-run settles `cancelled`; a late `turns.run` returns `stopped`.',
      needs: HOSTED_NEEDS,
      run: verifyCancellation,
    },
    ownerStep('turn-redelivery', CHECKLIST.redelivery, redeliveryStep),
    ownerStep('workpool-capacity', CHECKLIST.capacity, capacityStep),
    {
      id: 'deletion',
      kind: 'auto',
      checklist: 'Account deletion mid-run (`account:begin`, then `account:purge` to `done`): `runs.start` is rejected and a worker `turns.commit` returns a conflict; no `runs`, `turnFlags`, workflow `workflows`/`steps` or `users` rows remain for the owner.',
      needs: HOSTED_NEEDS,
      run: verifyDeletion,
    },
    {
      id: SEEDED_OAUTH_PURGE_ID,
      kind: 'auto',
      checklist: OAUTH_PURGE_CHECKLIST,
      needs: HOSTED_NEEDS,
      run: verifySeededOAuthEmailPurge,
    },
    {
      id: 'oauth-provider-purge',
      kind: 'manual',
      checklist: OAUTH_PURGE_CHECKLIST,
      needs: {},
      evidence: 'file',
      instruction: 'Attach evidence that a consenting disposable identity created through hosted OAuth had an oauthEmails row before account deletion and zero matching rows after purge.',
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
