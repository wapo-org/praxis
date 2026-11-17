import {defineSuite} from '@praxis/verify';

export default defineSuite({
  id: 'subagent-workspaces',
  issue: 'PRA-116',
  title: 'Confined Modal child workspaces and immutable handoffs',
  steps: [
    {
      id: 'modal-confinement', kind: 'manual', needs: {}, evidence: 'file',
      checklist: 'Verify real Modal process, path, symlink, cross-child and network confinement.',
      instruction: 'Use a provisioned Linux image with bwrap and Python; at most two boots total, terminate each in finally and confirm poll is terminal. Run prepareSubagent before launch; prove shell absolute paths, traversal, symlink races, parent/sibling access, inherited secrets and network access fail. Attach sandbox IDs, image digest, assertions and confirmed termination evidence. Namespace failure blocks launch and does not count as successful confinement.',
    },
    {
      id: 'snapshot-verification', kind: 'manual', needs: {}, evidence: 'file',
      checklist: 'Verify immutable checks/artifacts on Modal, including mutation and explicit export authority.',
      instruction: 'Reuse the confinement sandbox within the same two-boot budget. Capture a content-addressed snapshot, mutate live files during checks and verify only snapshot bytes are returned. Tamper/remove snapshot files or manifest and require failure. Confirm configured check IDs only, read-only mounts, executable bits and text-only checks. Export only with independent authority and reverified snapshot hashes; terminate the sandbox in finally.',
    },
    {
      id: 'durable-stop-resume', kind: 'manual', needs: {}, evidence: 'file',
      checklist: 'Verify PRA-114 CAS races and PRA-58 child-owned provider/browser/process termination.',
      instruction: 'Attach authenticated Convex evidence that Stop/resume during verification rejects stale CAS results and persists revision/digest only on success. Register owned provider/browser/process handles; interrupt/kill/probe each, keep uncertain kills cancelling, repeat cleanup and finalize bottom-up with zero handles. Prove sibling/shared sandbox survives and late results cannot revive the child.',
    },
  ],
});
