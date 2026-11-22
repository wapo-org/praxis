export const SYMBOL_PARSE_TIMEOUT_MS = 1_000;
export const SYMBOL_CANDIDATES_MAX = 50;
export const SYMBOL_GRAMMARS = {
  '.py': 'python', '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
} as const;
export type SymbolGrammar = typeof SYMBOL_GRAMMARS[keyof typeof SYMBOL_GRAMMARS];
export const SYMBOL_DEFINITIONS = new Set([
  'function_definition', 'class_definition', 'function_declaration', 'generator_function_declaration',
  'class_declaration', 'abstract_class_declaration', 'method_definition', 'method_signature',
  'abstract_method_signature', 'function_signature',
]);
export const SYMBOL_UNSUPPORTED = 'No symbol grammar for this file. Use edit_file with old_text and new_text instead.';
export const SYMBOL_PARSE_FAILED = 'Symbol parsing exceeded its budget. Use edit_file with old_text and new_text instead.';
export const SYMBOL_DESCRIPTION = 'Replace a Python, TypeScript or JavaScript function/class by name or dotted path; returns diagnostics.';
