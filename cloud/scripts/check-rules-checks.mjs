import path from 'node:path';
import ts from 'typescript';

export const FILE_LENGTH_MAX = 400;

export const RULES = {
  protocolImports: 'R1.protocol-imports',
  agentImports: 'R1.agent-imports',
  webImports: 'R1.web-imports',
  credentialsPool: 'R1.credentials-pool',
  fileLength: 'R3.file-length',
  noAny: 'R4.no-any',
  convexVAny: 'R4.convex-v-any',
  bannedPrimitives: 'R5.banned-primitives',
  clientOwnerArg: 'R5.client-owner-arg',
};

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

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
]);
const OWNER_ARG_NAMES = new Set(['userId', 'ownerId']);
const NUMBERED_ENV_KEY = /_\d+$/;

export function isSourceFile(file) {
  return SOURCE_EXTENSIONS.has(path.extname(file));
}

function matchesPackage(specifier, names) {
  return names.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

function scriptKind(file) {
  const extension = path.extname(file);
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  if (extension === '.jsx') return ts.ScriptKind.JSX;
  return TYPESCRIPT_EXTENSIONS.has(extension) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function importSpecifiers(source) {
  const found = [];
  walk(source, (node) => {
    const isStatic = ts.isImportDeclaration(node) || ts.isExportDeclaration(node);
    if (isStatic && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({ specifier: node.moduleSpecifier.text, node });
      return;
    }
    if (!ts.isCallExpression(node)) return;
    const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
    const first = node.arguments[0];
    if ((isDynamic || isRequire) && first && ts.isStringLiteralLike(first)) {
      found.push({ specifier: first.text, node });
    }
  });
  return found;
}

function resolveRelative(file, specifier) {
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
}

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
export function checkFile(file, text) {
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
  const report = (rule, node, message) => {
    violations.push({ rule, path: file, line: lineOf(source, node), message });
  };

  if (file.startsWith('packages/protocol/')) checkProtocolImports(file, source, report);
  if (file.startsWith('packages/agent/')) checkAgentImports(file, source, report);
  if (file.startsWith('apps/web/src/') && !TEST_FILE.test(file)) checkWebImports(file, source, report);
  if (!file.startsWith('packages/credentials/')) checkCredentialsPool(source, report);
  if (TYPESCRIPT_EXTENSIONS.has(path.extname(file))) checkNoAny(source, report);
  if (file.startsWith('apps/api/')) checkBannedPrimitives(source, report);
  if (file.startsWith('convex/')) {
    checkConvexVAny(source, report);
    checkClientOwnerArg(source, report);
  }
  return violations;
}
