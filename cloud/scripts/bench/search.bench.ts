import {beforeAll, bench} from 'vitest';
import {searchWorkload, SEARCH_QUERIES} from '../../apps/api/src/tests/search-workload.js';
import {searchChats} from '../../apps/api/src/search.js';

const CHATS_MAX = 2000;
let workload: Awaited<ReturnType<typeof searchWorkload>>;
beforeAll(async () => {
  workload = await searchWorkload(CHATS_MAX);
});
for (const query of SEARCH_QUERIES) {
  bench(`search / ${CHATS_MAX} chats / ${query}`, async () => {
    await searchChats(workload.service, 'u', query);
  }, {time: 100, iterations: 3, warmupIterations: 1});
}
