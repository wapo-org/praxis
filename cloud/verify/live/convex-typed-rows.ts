import {defineSuite} from '@praxis/verify';

export default defineSuite({
  id: 'convex-typed-rows',
  issue: 'PRA-127',
  title: 'Hosted Convex typed rows and owner isolation',
  steps: [
    {
      id: 'deploy',
      kind: 'manual',
      checklist: 'Deploy the PR wapo-org/praxis#30 schema (`chats`, `messages`, `runs`, `turns`, `sandboxes`, `outputs`) with `npx convex deploy`. The deploy succeeds and the dashboard lists every owner-first index.',
      instruction: 'Deploy the schema to the isolated development deployment and attach the successful deploy output and active index list.',
      evidence: 'file',
      needs: {},
    },
    {
      id: 'chat-crud-paging',
      kind: 'manual',
      checklist: 'Sign in through the web client. Create, read, rename and delete a chat, send messages and page them. Each change persists across a reload.',
      instruction: 'Attach the hosted chat CRUD and message paging results.',
      evidence: 'file',
      needs: {},
    },
    {
      id: 'owner-isolation',
      kind: 'manual',
      checklist: 'Owner B reads owner A\'s chat, message and run IDs through `chats.get`, `messages.page` and `runs.get`. Every call returns nothing, and an unauthenticated call fails.',
      instruction: 'Attach the authenticated owner isolation and unauthenticated rejection results.',
      evidence: 'file',
      needs: {},
    },
    {
      id: 'purge',
      kind: 'manual',
      checklist: 'Run `account:purge` for a disposable owner. All six typed tables and the workflow journal have zero rows for that owner, and the other owner\'s rows are intact.',
      instruction: 'Attach the hosted account purge results.',
      evidence: 'file',
      needs: {},
    },
    {
      id: 'commit',
      kind: 'manual',
      checklist: 'Commit messages concurrently to one chat with `messages.commit` (server credential). Sequences are contiguous with no gaps or duplicates, a retried message keeps its sequence, and a wrong credential is rejected.',
      instruction: 'Attach the hosted concurrent commit and retry results.',
      evidence: 'file',
      needs: {},
    },
  ],
});
