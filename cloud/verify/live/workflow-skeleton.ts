import {defineSuite} from '@praxis/verify';
import {cleanOwners, HOSTED_NEEDS} from './convex-typed-rows/fixture.js';
import {verifyDeletion} from './workflow-skeleton/deletion.js';
import {verifyCancellation, verifyCompletion} from './workflow-skeleton/run-checks.js';

export default defineSuite({
  id: 'workflow-skeleton',
  issue: 'PRA-125',
  title: 'Hosted Convex workflow skeleton and deletion purge',
  steps: [
    {
      id: 'completion',
      kind: 'auto',
      checklist: '`runs.start` with a real Auth v2 session (via `getAuthUserId`) creates a run and workflow; the three stub turns complete and the run settles `completed`.',
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
    {
      id: 'deletion',
      kind: 'auto',
      checklist: 'Account deletion mid-run (`account:begin`, then `account:purge` to `done`): `runs.start` and stub commits are rejected; no `runs`, `turnFlags`, workflow `workflows`/`steps` or `users` rows remain for the owner.',
      needs: HOSTED_NEEDS,
      run: verifyDeletion,
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
