import { createLocalAdapters } from '../local-memory.js';
import type { AdapterBundle } from '../contracts.js';
/** Compatibility wrapper delegating to createLocalAdapters. */
export function createMemoryAdapters():AdapterBundle { return createLocalAdapters(); }
