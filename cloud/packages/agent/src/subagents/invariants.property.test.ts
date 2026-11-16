import {it, expect} from 'vitest';
import fc from 'fast-check';
import {z} from 'zod';
import type {SubagentTree} from '@praxis/protocol';
import {ToolBoundaryError} from '../boundary/errors.js';
import {reduceSubagents, type SubagentEvent} from './reducer.js';
import {isDescendant, nodeById, terminal} from './permissions.js';
import {treeFixture, createRequest} from './test-fixtures.js';

const ids = ['root', 'a', 'b', 'c', 'd', 'e'] as const;
const idArb = fc.constantFrom(...ids);
const eventArb: fc.Arbitrary<SubagentEvent> = fc.tuple(
  fc.constantFrom('spawn', 'start', 'turn', 'pause', 'stop', 'finalize', 'complete', 'handle', 'cleanup', 'send', 'deliver', 'taint'),
  idArb, idArb, fc.integer({min: 0, max: 3}),
).map(([type, id, actorId, number]): SubagentEvent => {
  switch (type) {
    case 'spawn': return {type, id, actorId, callId: id, request: createRequest};
    case 'stop': return {type, id, actorId};
    case 'handle':
    case 'cleanup': return {type, id, handle: id + number};
    case 'send': return {type, id, actorId, messageId: 'm' + number, text: 'message' + number};
    case 'deliver': return {type, id, messageId: 'm' + number};
    default: return {type, id};
  }
});
function step(tree: SubagentTree, event: SubagentEvent): SubagentTree {
  const before = structuredClone(tree);
  try {
    const result = reduceSubagents(tree, event);
    expect(tree).toEqual(before);
    return result;
  } catch (error) {
    expect(tree).toEqual(before);
    if (!(error instanceof ToolBoundaryError) && !(error instanceof z.ZodError)) throw error;
    return tree;
  }
}
const invariants = {
  NoOrphanRuns(tree: SubagentTree) {
    return tree.nodes.every(n => terminal(n) || n.parent_id === null || !terminal(nodeById(tree, n.parent_id)));
  },
  NoOrphanHandles(tree: SubagentTree) {
    const handles = tree.nodes.flatMap(n => n.handles);
    return new Set(handles).size === handles.length && tree.nodes.every(n => !n.handles.length || !terminal(n));
  },
  CascadeStop(tree: SubagentTree) {
    return tree.nodes.every(n => n.status !== 'cancelling' || tree.nodes.every(d =>
      !isDescendant(tree, n.id, d.id) || terminal(d) || d.status === 'cancelling'));
  },
  InboxExactlyOnce(tree: SubagentTree) {
    return tree.nodes.every(n => new Set(n.inbox.map(m => m.id)).size === n.inbox.length && n.inbox.every((m, index) =>
      m.sequence === index + 1 && (m.disposition !== 'delivered' || !n.inbox.some(p => p.sequence < m.sequence && p.disposition === 'pending'))));
  },
  TerminalCleanup(tree: SubagentTree) {
    return tree.nodes.every(n => !terminal(n) || (n.handles.length === 0 && !n.inbox.some(m => m.disposition === 'pending')));
  },
};
for (const [name, invariant] of Object.entries(invariants)) {
  it(name, () => {
    fc.assert(fc.property(fc.array(eventArb, {maxLength: 150}), events => {
      let tree = treeFixture();
      for (const event of events) {
        tree = step(tree, event);
        expect(invariant(tree)).toBe(true);
      }
    }), {numRuns: 500});
  });
}
it('CascadeStop / TerminalCleanup: fair cleanup leaves no live runs or handles', () => {
  fc.assert(fc.property(fc.array(eventArb, {maxLength: 100}), events => {
    let tree = events.reduce(step, treeFixture());
    tree = step(tree, {type: 'stop', actorId: 'root', id: 'root'});
    for (const node of [...tree.nodes].sort((a, b) => b.depth - a.depth)) {
      for (const handle of node.handles) tree = step(tree, {type: 'cleanup', id: node.id, handle});
      if (nodeById(tree, node.id).status === 'cancelling') tree = step(tree, {type: 'finalize', id: node.id});
    }
    expect(tree.nodes.every(n => terminal(n) && !n.handles.length)).toBe(true);
  }), {numRuns: 500});
});
it('TaintMonotonic across arbitrary lifecycle schedules', () => {
  fc.assert(fc.property(fc.array(eventArb, {maxLength: 100}), events => {
    let tree = treeFixture();
    for (const event of events) {
      const before = tree;
      tree = step(tree, event);
      expect(before.nodes.every(n => !n.tainted || nodeById(tree, n.id).tainted)).toBe(true);
      expect(tree.nodes.every(n => n.parent_id === null || !nodeById(tree, n.parent_id).tainted || n.tainted)).toBe(true);
    }
  }), {numRuns: 500});
});
