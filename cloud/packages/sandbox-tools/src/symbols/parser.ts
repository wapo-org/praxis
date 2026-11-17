import {createRequire} from 'node:module';
import {Language, Parser, type Node} from 'web-tree-sitter';
import {fail} from '../support.js';
import {SYMBOL_DEFINITIONS, SYMBOL_PARSE_FAILED, SYMBOL_PARSE_TIMEOUT_MS, type SymbolGrammar} from './constants.js';

const require = createRequire(import.meta.url);
let initialization: Promise<void> | undefined;
const languages = new Map<SymbolGrammar, Promise<Language>>();

async function languageFor(grammar: SymbolGrammar): Promise<Language> {
  initialization ??= Parser.init();
  await initialization;
  let language = languages.get(grammar);
  if (!language) {
    language = Language.load(require.resolve(`@vscode/tree-sitter-wasm/wasm/tree-sitter-${grammar}.wasm`));
    languages.set(grammar, language);
  }
  return language;
}

export interface SymbolRange {
  name: string;
  qualified: string;
  start: number;
  end: number;
  line: number;
}

function definition(node: Node, singleDeclaration: Node | undefined): {name: string; range: Node} | undefined {
  if (SYMBOL_DEFINITIONS.has(node.type)) {
    const name = node.childForFieldName('name');
    if (!name) return undefined;
    return {name: name.text, range: node.parent?.type === 'decorated_definition' ? node.parent : node};
  }
  if (node.type !== 'variable_declarator') return undefined;
  const name = node.childForFieldName('name');
  let value = node.childForFieldName('value');
  const declaration = singleDeclaration;
  if (name?.type !== 'identifier' || !value || !declaration) return undefined;
  while (value?.type === 'parenthesized_expression') value = value.namedChildren.find(child => child?.type !== 'comment') ?? null;
  if (!value) return undefined;
  if (!['arrow_function', 'function_expression', 'generator_function', 'class'].includes(value.type)) return undefined;
  return {name: name.text, range: declaration};
}

/** WASM indices address UTF-16 code units, matching JS slice even when earlier text contains emoji. */
export async function symbolRanges(text: string, grammar: SymbolGrammar): Promise<SymbolRange[]> {
  const language = await languageFor(grammar);
  const parser = new Parser();
  try {
    parser.setLanguage(language);
    const deadline = Date.now() + SYMBOL_PARSE_TIMEOUT_MS;
    const tree = parser.parse(text, null, {progressCallback: () => Date.now() >= deadline});
    if (!tree) fail('timeout', SYMBOL_PARSE_FAILED);
    try {
      const symbols: SymbolRange[] = [];
      const stack: {node: Node; scope: string; declaration?: Node}[] = [{node: tree.rootNode, scope: ''}];
      while (stack.length) {
        if (Date.now() >= deadline) fail('timeout', SYMBOL_PARSE_FAILED);
        const {node, scope, declaration} = stack.pop()!;
        const found = definition(node, declaration);
        const nextScope = found ? (scope ? `${scope}.${found.name}` : found.name) : scope;
        if (found) symbols.push({
          name: found.name, qualified: nextScope, start: found.range.startIndex,
          end: found.range.endIndex, line: found.range.startPosition.row + 1,
        });
        const children = node.namedChildren;
        const single = children.filter(child => child?.type === 'variable_declarator').length === 1 ? node : undefined;
        for (let index = children.length - 1; index >= 0; index--) {
          const child = children[index];
          if (child) stack.push({node: child, scope: nextScope, declaration: single});
        }
      }
      return symbols;
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}
