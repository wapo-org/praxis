import {parse} from 'shell-quote';

export type PolicyDecision = 'allow' | 'approve' | 'deny';
export const SHELL_COMMAND_MAX_CHARACTERS = 16384;
const READ_COMMANDS = new Set(['pwd', 'echo', 'printf', 'true', 'false']);
const DENIED_COMMANDS = new Set(['rm', 'rmdir', 'dd', 'mkfs', 'sh', 'bash', 'dash', 'zsh', 'eval', 'source', '.', 'exec', 'xargs']);
const SEPARATORS = new Set(['|', '||', '&&', ';', '&']);
const REDIRECTS = new Set(['>', '>>', '<', '>&', '<&']);
const SENSITIVE_PATHS = ['/etc', '/dev', '/proc', '/sys', '/root', '/home', '/Users', '/.ssh'];
const SENSITIVE_DIRECTORIES = new Set(['.ssh', '.aws', '.gnupg']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z_0-9]*=/;
export type ShellCommand = {words: string[]; redirects: {operator: string; target: string}[]};
export type ShellAst = {commands: ShellCommand[]; operators: string[]};

// Expansions and unsupported grammar never reach an optimistic interpretation of the token stream.
export function parseShell(command: string): ShellAst | null {
  if (!command || command.length > SHELL_COMMAND_MAX_CHARACTERS) return null;
  const normalized = command;
  if (/[$`#\n\r\0(){}]/.test(normalized) || !balancedQuotes(normalized)) return null;
  try {
    const tokens = parse(normalized);
    const ast: ShellAst = {commands: [], operators: []};
    let current: ShellCommand = {words: [], redirects: []};
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (typeof token === 'string') {
        current.words.push(token);
      } else if ('comment' in token) {
        break;
      } else if (token.op === 'glob') {
        return null;
      } else if (SEPARATORS.has(token.op)) {
        if (!current.words.length) return null;
        ast.commands.push(current);
        ast.operators.push(token.op);
        current = {words: [], redirects: []};
      } else if (REDIRECTS.has(token.op)) {
        const target = tokens[++i];
        if (typeof target !== 'string') return null;
        current.redirects.push({operator: token.op, target});
      } else {
        return null;
      }
    }
    if (!current.words.length) return null;
    ast.commands.push(current);
    return ast;
  } catch {
    return null;
  }
}

function balancedQuotes(command: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (char === '\\' && quote !== "'") {
      if (++i === command.length) return false;
    } else if (char === quote) {
      quote = null;
    } else if (quote === null && (char === "'" || char === '"')) {
      quote = char;
    }
  }
  return quote === null;
}

export function strictest(decisions: PolicyDecision[]): PolicyDecision {
  return decisions.includes('deny') ? 'deny' : decisions.includes('approve') ? 'approve' : 'allow';
}

function classifyCommand(node: ShellCommand): PolicyDecision {
  const words = [...node.words];
  // Environment changes can redirect executables, so wrappers always require approval even for a read command.
  let wrapped = false;
  while (words[0] && ASSIGNMENT.test(words[0])) {
    wrapped = true;
    words.shift();
  }
  while (['env', '/usr/bin/env'].includes(words[0] ?? '')) {
    wrapped = true;
    words.shift();
    while (words[0] && (ASSIGNMENT.test(words[0]) || words[0] === '--' || words[0] === '-i')) words.shift();
  }
  const name = words[0]?.split('/').pop() ?? '';
  if (DENIED_COMMANDS.has(name) || name.startsWith('mkfs.')) return 'deny';
  if (name === 'git' && words.includes('push') && words.some(w => (/^-[^-]*f/.test(w)) || w.startsWith('--force') || w.startsWith('+'))) return 'deny';
  for (const redirect of node.redirects) {
    if (redirect.operator.startsWith('>')) {
      // Dot segments and home-relative paths need worker filesystem resolution and cannot be approved here.
      const target = redirect.target.split('/').filter(p => p !== '' && p !== '.').join('/');
      const absoluteTarget = '/' + target;
      if (target.split('/').some(p => SENSITIVE_DIRECTORIES.has(p))) return 'deny';
      if (redirect.target === '/' || redirect.target.includes('..') || redirect.target.startsWith('~') || SENSITIVE_PATHS.some(p => absoluteTarget === p || absoluteTarget.startsWith(p + '/'))) return 'deny';
    }
  }
  if (wrapped || node.redirects.length || words[0] !== name) return 'approve';
  return READ_COMMANDS.has(name) ? 'allow' : 'approve';
}

export function shellPolicy(command: string): PolicyDecision {
  const ast = parseShell(command);
  if (!ast) return 'deny';
  return strictest(ast.commands.map(classifyCommand));
}
