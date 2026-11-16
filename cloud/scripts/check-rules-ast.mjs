import path from 'node:path';
import ts from 'typescript';

export const RULES = {
  protocolImports: 'R1.protocol-imports',
  agentImports: 'R1.agent-imports',
  webImports: 'R1.web-imports',
  webEffects: 'R1.web-effects',
  apiImportsAgent: 'R1.api-imports-agent',
  credentialsPool: 'R1.credentials-pool',
  fileLength: 'R3.file-length',
  narratingComment: 'R3.narrating-comment',
  noAny: 'R4.no-any',
  convexVAny: 'R4.convex-v-any',
  tenantIdBoundary: 'R4.tenant-id-boundary',
  bannedPrimitives: 'R5.banned-primitives',
  clientOwnerArg: 'R5.client-owner-arg',
  docsCommit: 'R5.docs-commit',
};


/** Off unless named with --enable: each waits for the issue that makes the code comply. */
export const DISABLED_RULES = {
  // Enable when PRA-13 lands (apps/api shrinks to the /api/turn worker and stops importing the agent).
  [RULES.apiImportsAgent]: 'PRA-13',
  // TODO(PRA-36): enable once integrations take a TenantId from deriveTenantId.
  [RULES.tenantIdBoundary]: 'PRA-36',
};

export const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
export const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
export const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;


export function isSourceFile(file) {
  return SOURCE_EXTENSIONS.has(path.extname(file));
}

export function matchesPackage(specifier, names) {
  return names.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

export function scriptKind(file) {
  const extension = path.extname(file);
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  if (extension === '.jsx') return ts.ScriptKind.JSX;
  return TYPESCRIPT_EXTENSIONS.has(extension) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

export function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

export function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

export function importSpecifiers(source) {
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

export function resolveRelative(file, specifier) {
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
}
