import ts from 'typescript';
import {RULES, TEST_FILE, importSpecifiers, matchesPackage, resolveRelative, walk} from './check-rules-ast.mjs';

const WEB_COMPONENTS = 'apps/web/src/components/';
const EFFECT_HOOKS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect']);
const TIMER_CALLS = new Set(['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback']);
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self']);
const EFFECT_REMEDY =
  'move it into a `use*` hook under apps/web/src/hooks/ (or lib/, state/) and call that hook from the component';

const AGENT_PACKAGE = ['@praxis/agent'];
const TENANT_SDKS = [
  '@upstash',
  '@composio',
  'composio-core',
  'mem0ai',
  'modal',
  'posthog-node',
  'posthog-js',
  'ioredis',
  'redis',
];
const OWNER_NAMES = new Set(['userId', 'ownerId']);
const TENANT_DERIVATION = 'deriveTenantId';
const TENANT_SCOPES = ['apps/api/', 'convex/', 'packages/'];

/** Only these basenames may be added as markdown outside cloud/docs/. */
const DOC_NAMES = new Set(['README.md', 'AGENTS.md', 'ARCHITECTURE.md', 'DEPLOY.md', 'PROTOCOL.md', 'DESIGN.md']);
const DOC_DIRECTORY = 'docs/';
const REPO_ROOT_PREFIX = '../';

export function isWebComponentFile(file) {
  return file.startsWith(WEB_COMPONENTS) && !TEST_FILE.test(file);
}

function calledName(node) {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return {name: callee.text, owner: null};
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    return {name: callee.name.text, owner: callee.expression.text};
  }
  return null;
}

export function checkWebEffects(source, report) {
  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return;
    const called = calledName(node);
    if (!called) return;
    const isEffect = EFFECT_HOOKS.has(called.name) && (called.owner === null || called.owner === 'React');
    const isTimer = TIMER_CALLS.has(called.name) && (called.owner === null || GLOBAL_OBJECTS.has(called.owner));
    if (!isEffect && !isTimer) return;
    report(RULES.webEffects, node, `raw ${called.name} in components/: ${EFFECT_REMEDY}`);
  });
}

export function checkApiImportsAgent(file, source, report) {
  if (TEST_FILE.test(file)) return;
  const remedy = 'apps/api is the stateless turn worker; the agent runs behind the Convex boundary';
  for (const {specifier, node} of importSpecifiers(source)) {
    const isRelative = specifier.startsWith('.');
    const reachesAgent = isRelative
      ? resolveRelative(file, specifier).startsWith('packages/agent/')
      : matchesPackage(specifier, AGENT_PACKAGE);
    if (reachesAgent) report(RULES.apiImportsAgent, node, `import "${specifier}": ${remedy}`);
  }
}

function isDerivationArgument(node) {
  const call = node.parent;
  return ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === TENANT_DERIVATION;
}

function leavesProcess(node) {
  const parent = node.parent;
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) return parent.arguments?.includes(node) ?? false;
  return ts.isTemplateSpan(parent);
}

export function checkTenantIdBoundary(file, source, report) {
  if (TEST_FILE.test(file) || !TENANT_SCOPES.some((scope) => file.startsWith(scope))) return;
  const usesSdk = importSpecifiers(source).some(({specifier}) => matchesPackage(specifier, TENANT_SDKS));
  if (!usesSdk) return;
  walk(source, (node) => {
    if (!ts.isIdentifier(node) || !OWNER_NAMES.has(node.text)) return;
    if (!leavesProcess(node) || isDerivationArgument(node)) return;
    const remedy = 'pass a TenantId from deriveTenantId(userId, secret) (@praxis/types)';
    report(RULES.tenantIdBoundary, node, `raw ${node.text} next to an external SDK: ${remedy}`);
  });
}

/** `file` is relative to the cloud root; repo-root files arrive as `../NAME.md`. Returns a violation or null. */
export function checkDocFile(file) {
  if (!file.toLowerCase().endsWith('.md')) return null;
  const atRepoRoot = file.startsWith(REPO_ROOT_PREFIX);
  if (!atRepoRoot && file.startsWith(DOC_DIRECTORY)) return null;
  const name = file.slice(file.lastIndexOf('/') + 1);
  if (DOC_NAMES.has(name)) return null;
  const allowed = [...DOC_NAMES].join(', ');
  return {
    rule: RULES.docsCommit,
    path: file,
    line: 1,
    message: `unrequested markdown file: plans and status notes go to Linear (team PRA); only ${allowed} or cloud/docs/** may be committed`,
  };
}
