import { createLocalAdapters } from '../local-memory.js';
import type { AdapterBundle } from '../contracts.js';
/** Compatibility factory. M1's implementation remains the single memory adapter. */
export function createMemoryAdapters():AdapterBundle { return createLocalAdapters(); }
