import path from 'node:path';
import ts from 'typescript';
import {
  DISABLED_RULES,
  RULES,
  TEST_FILE,
  TYPESCRIPT_EXTENSIONS,
  importSpecifiers,
  lineOf,
  matchesPackage,
  resolveRelative,
  scriptKind,
  walk,
} from './check-rules-ast.mjs';
import {narratingCommentLines} from './check-rules-comments.mjs';
import {checkApiImportsAgent, checkTenantIdBoundary, checkWebEffects, isWebComponentFile} from './check-rules-boundaries.mjs';

export {DISABLED_RULES, RULES, isSourceFile} from './check-rules-ast.mjs';
export {checkDocFile} from './check-rules-boundaries.mjs';

export const FILE_LENGTH_MAX = 400;
const NARRATING_REMEDY = 'comment only repeats the next line: delete it, or say why (an invariant, a constraint, a trap)';

const PROTOCOL_ALLOWED = ['zod'];
const PROTOCOL_TEST_ALLOWED = ['zod', 'vitest'];
const AGENT_BANNED = ['hono', '@hono', '@vercel', 'convex', '@upstash'];
const WEB_BANNED = [
  'hono',
  '@hono',
  '@upstash',
  '@vercel/functions',
  '@vercel/node',
  '@vercel/blob',
  '@vercel/kv',
  'convex/server',
  '@praxis/api',
  '@praxis/agent',
  '@praxis/credentials',
  'openai',
  '@anthropic-ai',
  '@openrouter',
  'langchain',
  '@langchain',
  'deepagents',
  'ioredis',
  'redis',
];
const BANNED_MODULES = ['child_process', 'vm', 'worker_threads'];
const PUBLIC_CONVEX_BUILDERS = new Set([
  'query',
  'mutation',
  'action',
  'queryGeneric',
  'mutationGeneric',
  'actionGeneric',
  'authedQuery',
  'authedMutation',
  'authedAction',
]);
const OWNER_ARG_NAMES = new Set(['userId', 'ownerId']);
const NUMBERED_ENV_KEY = /_\d+$/;

function checkProtocolImports(file, source, report) {
  const allowed = TEST_FILE.test(file) ? PROTOCOL_TEST_ALLOWED : PROTOCOL_ALLOWED;
  for (const { specifier, node } of importSpecifiers(source)) {
    if (specifier.startsWith('.')) {
      if (resolveRelative(file, specifier).startsWith('packages/protocol/')) continue;
      report(RULES.protocolImports, node, `import "${specifier}" leaves packages/protocol`);
      continue;
    }
    if (matchesPackage(specifier, allowed)) continue;
    report(RULES.protocolImports, node, `import "${specifier}": protocol may import only zod`);
  }
}

function checkAgentImports(file, source, report) {
  for (const { specifier, node } of importSpecifiers(source)) {
    if (specifier.startsWith('.')) {
      const target = resolveRelative(file, specifier);
      if (!target.startsWith('apps/') && !target.startsWith('convex/')) continue;
      report(RULES.agentImports, node, `import "${specifier}" reaches into ${target.split('/')[0]}/`);
      continue;
    }
    if (!matchesPackage(specifier, AGENT_BANNED)) continue;
    report(RULES.agentImports, node, `import "${specifier}": agent talks to runtimes through ports only`);
  }
}

function checkWebImports(file, source, report) {
  for (const { specifier, node } of importSpecifiers(source)) {
    if (specifier.startsWith('.')) {
      const target = resolveRelative(file, specifier);
      const isServerCode = target.startsWith('apps/api/') || target.startsWith('convex/');
      if (!isServerCode || target.startsWith('convex/_generated/')) continue;
      report(RULES.webImports, node, `import "${specifier}" pulls server code into the web client`);
      continue;
    }
    if (!matchesPackage(specifier, WEB_BANNED)) continue;
    report(RULES.webImports, node, `import "${specifier}": web client must not import server SDKs`);
  }
}

function isEnvObject(node) {
  if (ts.isIdentifier(node)) return node.text === 'env';
  return ts.isPropertyAccessExpression(node) && node.name.text === 'env';
}

function isBuiltKey(node) {
  if (ts.isTemplateExpression(node)) return true;
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;
}

function checkCredentialsPool(source, report) {
  const remedy = 'use a @praxis/credentials pool';
  walk(source, (node) => {
    if (ts.isPropertyAccessExpression(node) && isEnvObject(node.expression)) {
      if (!NUMBERED_ENV_KEY.test(node.name.text)) return;
      report(RULES.credentialsPool, node, `numbered env key ${node.name.text}: ${remedy}`);
      return;
    }
    if (!ts.isElementAccessExpression(node) || !isEnvObject(node.expression)) return;
    const key = node.argumentExpression;
    if (ts.isStringLiteralLike(key) && NUMBERED_ENV_KEY.test(key.text)) {
      report(RULES.credentialsPool, node, `numbered env key ${key.text}: ${remedy}`);
    } else if (isBuiltKey(key)) {
      report(RULES.credentialsPool, node, `env key built at runtime (key rotation): ${remedy}`);
    }
  });
}

function checkNoAny(source, report) {
  walk(source, (node) => {
    if (node.kind !== ts.SyntaxKind.AnyKeyword) return;
    report(RULES.noAny, node, 'raw `any`: use a real type, `unknown` plus a parse, or a generic');
  });
}

function isVAnyCall(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const { expression, name } = node.expression;
  return ts.isIdentifier(expression) && expression.text === 'v' && name.text === 'any';
}

function checkConvexVAny(source, report) {
  walk(source, (node) => {
    if (!isVAnyCall(node)) return;
    report(RULES.convexVAny, node, 'v.any() in convex/: declare the validator shape');
  });
}

function checkBannedPrimitives(source, report) {
  for (const { specifier, node } of importSpecifiers(source)) {
    const bare = specifier.replace(/^node:/, '');
    if (!matchesPackage(bare, BANNED_MODULES)) continue;
    report(RULES.bannedPrimitives, node, `import "${specifier}" is banned in apps/api`);
  }
  walk(source, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'eval') {
      report(RULES.bannedPrimitives, node, 'eval() is banned in apps/api');
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
      report(RULES.bannedPrimitives, node, 'new Function is banned in apps/api');
    }
  });
}

function objectLiteralConstants(source) {
  const constants = new Map();
  walk(source, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
    if (ts.isObjectLiteralExpression(node.initializer)) constants.set(node.name.text, node.initializer);
  });
  return constants;
}

function ownerArgIn(expression, constants, seen = new Set()) {
  if (ts.isIdentifier(expression)) {
    const literal = constants.get(expression.text);
    if (!literal || seen.has(expression.text)) return null;
    seen.add(expression.text);
    return ownerArgIn(literal, constants, seen);
  }
  if (!ts.isObjectLiteralExpression(expression)) return null;
  for (const property of expression.properties) {
    if (ts.isSpreadAssignment(property)) {
      const inherited = ownerArgIn(property.expression, constants, seen);
      if (inherited) return inherited;
      continue;
    }
    const name = property.name;
    const hasName = name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name));
    if (hasName && OWNER_ARG_NAMES.has(name.text)) return name.text;
  }
  return null;
}

function argsExpression(definition) {
  for (const property of definition.properties) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'args') return property.name;
    const isArgs = ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'args';
    if (isArgs) return property.initializer;
  }
  return null;
}

function checkClientOwnerArg(source, report) {
  const constants = objectLiteralConstants(source);
  walk(source, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
    if (!PUBLIC_CONVEX_BUILDERS.has(node.expression.text)) return;
    const definition = node.arguments[0];
    if (!definition || !ts.isObjectLiteralExpression(definition)) return;
    const args = argsExpression(definition);
    const owner = args ? ownerArgIn(args, constants) : null;
    if (!owner) return;
    const builder = node.expression.text;
    report(RULES.clientOwnerArg, node, `public ${builder} takes "${owner}": derive the owner from auth, or make it internal`);
  });
}

export function countLines(text) {
  if (text === '') return 0;
  const breaks = text.split('\n').length - 1;
  return text.endsWith('\n') ? breaks : breaks + 1;
}

/** `file` is POSIX-style and relative to the cloud root; returns `{rule, path, line, message}` records. */
export function checkFile(file, text, enabled = []) {
  const violations = [];
  const lines = countLines(text);
  if (lines > FILE_LENGTH_MAX) {
    violations.push({
      rule: RULES.fileLength,
      path: file,
      line: lines,
      lines,
      message: `${lines} lines (max ${FILE_LENGTH_MAX}): extract a cohesive module`,
    });
  }

  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const isOn = (rule) => !(rule in DISABLED_RULES) || enabled.includes(rule);
  const report = (rule, node, message) => {
    violations.push({ rule, path: file, line: lineOf(source, node), message });
  };

  for (const line of narratingCommentLines(source, text)) {
    violations.push({ rule: RULES.narratingComment, path: file, line, message: NARRATING_REMEDY });
  }
  if (file.startsWith('packages/protocol/')) checkProtocolImports(file, source, report);
  if (file.startsWith('packages/agent/')) checkAgentImports(file, source, report);
  if (file.startsWith('apps/web/src/') && !TEST_FILE.test(file)) checkWebImports(file, source, report);
  if (isWebComponentFile(file)) checkWebEffects(source, report);
  if (file.startsWith('apps/api/') && isOn(RULES.apiImportsAgent)) checkApiImportsAgent(file, source, report);
  if (isOn(RULES.tenantIdBoundary)) checkTenantIdBoundary(file, source, report);
  if (!file.startsWith('packages/credentials/')) checkCredentialsPool(source, report);
  if (TYPESCRIPT_EXTENSIONS.has(path.extname(file))) checkNoAny(source, report);
  if (file.startsWith('apps/api/')) checkBannedPrimitives(source, report);
  if (file.startsWith('convex/')) {
    checkConvexVAny(source, report);
    checkClientOwnerArg(source, report);
  }
  return violations;
}
