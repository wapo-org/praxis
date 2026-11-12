/**
 * Praxis code colours (WP-L3): quiet, ink-first themes on the app's paper neutrals instead of GitHub's.
 * Keywords carry weight in ink, strings and numbers take one muted hue each, comments recede.
 */
type Theme = { name: string; type: 'light' | 'dark'; fg: string; bg: string; settings: Array<{ scope?: string | string[]; settings: { foreground?: string; fontStyle?: string } }> };

function theme(name: string, type: 'light' | 'dark', c: Record<'fg' | 'muted' | 'comment' | 'keyword' | 'string' | 'number' | 'fn' | 'type' | 'tag' | 'attr', string>): Theme {
  return {
    name, type, fg: c.fg, bg: 'transparent',
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
});

export const praxisDark = theme('praxis-dark', 'dark', {
  fg: '#e9e6df', muted: '#a29e95', comment: '#7b776f', keyword: '#e39ab8', string: '#a9cf95',
  number: '#e8b46e', fn: '#9cbcf0', type: '#e2bf86', tag: '#e39ab8', attr: '#c2b2ee',
});
