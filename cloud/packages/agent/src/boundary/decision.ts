import type {Mode} from '@praxis/protocol';
import {isSideEffect, type ToolClassification} from './policy.js';
import type {PolicyDecision} from './shell.js';

// An allow classification certifies workspace confinement with no secrets or network effects.
export function boundaryDecision(mode: Mode, policy: ToolClassification, tainted: boolean): PolicyDecision {
  if (policy.decision === 'deny') return 'deny';
  const sideEffect = isSideEffect(policy.capabilities);
  switch (mode) {
    case 'ask':
    case 'plan':
      return sideEffect ? 'deny' : policy.decision;
    case 'build':
    case 'auto':
      if (policy.capabilities.includes('external-egress')) return 'approve';
      if (tainted && sideEffect) return 'approve';
      if (mode === 'auto' && (policy.destructive || policy.untrustedWrite)) return 'approve';
      return policy.decision;
  }
}
