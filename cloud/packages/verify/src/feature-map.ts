import {readFileSync, readdirSync} from 'node:fs';
import {z} from 'zod';
import {FEATURE_MAP_PATH, LIVE_SUITES_DIR} from './constants.js';

const Id = z.string().regex(/^[a-z0-9][a-z0-9.-]*$/, 'lower-case id: letters, digits, dots, dashes');
const LinearIssue = z.string().regex(/^PRA-\d+$/, 'a Linear PRA-n identifier');

export const CoverageSchema = z.discriminatedUnion('command', [
  z.object({command: z.literal('gate')}).strict(),
  z.object({command: z.literal('web'), flows: z.array(Id).min(1)}).strict(),
  z.object({command: z.literal('api'), checks: z.array(Id).min(1)}).strict(),
  z.object({command: z.literal('ios')}).strict(),
  z.object({command: z.literal('live'), suite: Id}).strict(),
]);

export const FeatureSchema = z.object({
  id: Id,
  title: z.string().min(1),
  /** The Linear issue that owns the behaviour; a regression is filed there. */
  issue: LinearIssue,
  surfaces: z.array(z.enum(['web', 'api', 'ios'])).min(1),
  covers: z.array(CoverageSchema).min(1),
}).strict();

export const FeatureMapSchema = z.object({
  $schema: z.literal('praxis-verify/feature-map@1'),
  features: z.array(FeatureSchema).min(1),
}).strict();

export type FeatureMap = z.infer<typeof FeatureMapSchema>;
export type Coverage = z.infer<typeof CoverageSchema>;

/** What exists in code; `map --check` holds the map and the code to the same set of names. */
export interface Implementations {
  flows: readonly string[];
  checks: readonly string[];
  suites: readonly string[];
}

export function loadFeatureMap(path = FEATURE_MAP_PATH): FeatureMap {
  return FeatureMapSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function liveSuiteIds(directory = LIVE_SUITES_DIR): string[] {
  return readdirSync(directory).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts')).map(name => name.slice(0, -3)).sort();
}

function referenced(map: FeatureMap) {
  const flows = new Set<string>(), checks = new Set<string>(), suites = new Set<string>();
  for (const feature of map.features) {
    for (const cover of feature.covers) {
      if (cover.command === 'web') cover.flows.forEach(flow => flows.add(flow));
      if (cover.command === 'api') cover.checks.forEach(check => checks.add(check));
      if (cover.command === 'live') suites.add(cover.suite);
    }
  }
  return {flows, checks, suites};
}

/** Both directions: a mapped name with no code is a lie, code with no mapped feature is unowned. */
export function checkFeatureMap(map: FeatureMap, implemented: Implementations): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const feature of map.features) {
    if (seen.has(feature.id)) problems.push(`duplicate feature id ${feature.id}`);
    seen.add(feature.id);
  }
  const used = referenced(map);
  const kinds = [
    ['web flow', used.flows, implemented.flows],
    ['api check', used.checks, implemented.checks],
    ['live suite', used.suites, implemented.suites],
  ] as const;
  for (const [kind, mapped, code] of kinds) {
    for (const name of mapped) if (!code.includes(name)) problems.push(`${kind} ${name} is in the feature map but has no implementation`);
    for (const name of code) if (!mapped.has(name)) problems.push(`${kind} ${name} is implemented but no feature in the map covers it`);
  }
  return problems;
}
