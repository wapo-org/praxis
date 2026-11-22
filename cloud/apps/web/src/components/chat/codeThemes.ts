type Theme = { name: string; type: 'light' | 'dark'; fg: string; bg: string; colors: Record<string, string>; settings: Array<{ scope?: string | string[]; settings: { foreground?: string; fontStyle?: string } }> };

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;
type Ansi = Record<(typeof ANSI)[number], string>;
/** Terminal colours (WP-N2, ```ansi and terminal output), drawn from the same palette as the syntax colours. */
const ansiColors = (normal: Ansi, bright: Ansi) => Object.fromEntries(ANSI.flatMap((name) => [
  [`terminal.ansi${name[0]!.toUpperCase()}${name.slice(1)}`, normal[name]],
  [`terminal.ansiBright${name[0]!.toUpperCase()}${name.slice(1)}`, bright[name]],
]));

function theme(name: string, type: 'light' | 'dark', c: Record<'fg' | 'muted' | 'comment' | 'keyword' | 'string' | 'number' | 'fn' | 'type' | 'tag' | 'attr', string>, colors: Record<string, string>): Theme {
  return {
    name, type, fg: c.fg, bg: 'transparent', colors,
    settings: [
      { settings: { foreground: c.fg } },
      { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: c.comment, fontStyle: 'italic' } },
      { scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.operator.new', 'keyword.control', 'variable.language'], settings: { foreground: c.keyword } },
      { scope: ['string', 'string.template', 'punctuation.definition.string', 'markup.inline.raw'], settings: { foreground: c.string } },
      { scope: ['constant.numeric', 'constant.language', 'constant.character', 'support.constant'], settings: { foreground: c.number } },
      { scope: ['entity.name.function', 'support.function', 'meta.function-call entity.name.function'], settings: { foreground: c.fn } },
      { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class', 'entity.other.inherited-class'], settings: { foreground: c.type } },
      { scope: ['entity.name.tag', 'meta.decorator', 'entity.name.function.decorator', 'punctuation.decorator'], settings: { foreground: c.tag } },
      { scope: ['entity.other.attribute-name', 'support.type.property-name', 'meta.object-literal.key'], settings: { foreground: c.attr } },
      { scope: ['punctuation', 'meta.brace', 'keyword.operator'], settings: { foreground: c.muted } },
      { scope: ['variable.parameter'], settings: { foreground: c.fg, fontStyle: 'italic' } },
    ],
  };
}

export const praxisLight = theme('praxis-light', 'light', {
  fg: '#1f1e1c', muted: '#6b6862', comment: '#97938b', keyword: '#8a3b5e', string: '#3f6b3a',
  number: '#9a5a14', fn: '#2d4f86', type: '#7a4a12', tag: '#8a3b5e', attr: '#5b4a8a',
}, ansiColors(
  { black: '#1f1e1c', red: '#b3382e', green: '#3f6b3a', yellow: '#9a5a14', blue: '#2d4f86', magenta: '#8a3b5e', cyan: '#2f6f73', white: '#6b6862' },
  { black: '#6b6862', red: '#c4473c', green: '#4a7d44', yellow: '#a8671c', blue: '#3a60a0', magenta: '#9c4a6e', cyan: '#3a8287', white: '#97938b' },
));

export const praxisDark = theme('praxis-dark', 'dark', {
  fg: '#e9e6df', muted: '#a29e95', comment: '#7b776f', keyword: '#e39ab8', string: '#a9cf95',
  number: '#e8b46e', fn: '#9cbcf0', type: '#e2bf86', tag: '#e39ab8', attr: '#c2b2ee',
}, ansiColors(
  { black: '#7b776f', red: '#ff7a6e', green: '#a9cf95', yellow: '#e8b46e', blue: '#9cbcf0', magenta: '#e39ab8', cyan: '#8fd1cf', white: '#e9e6df' },
  { black: '#a29e95', red: '#ff9b91', green: '#bfe0ad', yellow: '#f2c98e', blue: '#b6cff6', magenta: '#eeb3cb', cyan: '#a9dfdd', white: '#ffffff' },
));
