import {expect, it} from 'vitest';
import fc from 'fast-check';
import {reduceSubagents} from './reducer.js';
import {cleanupSubagent} from './workspace.js';
import {spawn, treeFixture, workspacePort} from './test-fixtures.js';

it('accepts redelivered cleanup without invoking the port or changing cancelled state', async () => {
  let tree = spawn(treeFixture());
  tree = reduceSubagents(tree, {type: 'handle', id: 'child', handle: 'process'});
  tree = reduceSubagents(tree, {type: 'stop', actorId: 'root', id: 'child'});
  const killed: string[] = [];
  const port = {...workspacePort, killHandle: async (_root: string, handle: string) => {
    killed.push(handle);
  }};
  const cancelled = await cleanupSubagent(tree, 'child', port);
  const before = structuredClone(cancelled);
  expect(await cleanupSubagent(cancelled, 'child', port)).toBe(cancelled);
  expect(cancelled).toEqual(before);
  expect(killed).toEqual(['process']);
});
it('cleanup retries preserve bottom-up cancellation for arbitrary branches and handles', async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({min: 1, max: 7}), fc.array(fc.integer({min: 0, max: 3}), {minLength: 7, maxLength: 7}),
    async (depth, handleCounts) => {
      let tree = treeFixture();
      const ids: string[] = [];
      let parent = 'root';
      for (let level = 0; level < depth; level++) {
        const id = `child${level}`;
        tree = spawn(tree, id, parent);
        ids.push(id);
        for (let index = 0; index < handleCounts[level]!; index++) {
          tree = reduceSubagents(tree, {type: 'handle', id, handle: `${id}-${index}`});
        }
        parent = id;
      }
      tree = reduceSubagents(tree, {type: 'stop', actorId: 'root', id: 'root'});
      const expectedHandles = tree.nodes.flatMap(n => n.handles);
      const killed: string[] = [];
      const port = {...workspacePort, killHandle: async (_root: string, handle: string) => {
        killed.push(handle);
      }};
      for (const id of [...ids.reverse(), 'root']) {
        tree = await cleanupSubagent(tree, id, port);
        const before = structuredClone(tree);
        expect(await cleanupSubagent(tree, id, port)).toBe(tree);
        expect(tree).toEqual(before);
        expect(reduceSubagents(tree, {type: 'stop', actorId: id, id})).toEqual(tree);
      }
      expect(tree.nodes.every(n => n.status === 'cancelled' && n.handles.length === 0)).toBe(true);
      expect(killed.sort()).toEqual(expectedHandles.sort());
    }), {numRuns: 500});
});
