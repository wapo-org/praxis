import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Highlight } from './SearchPalette';

const html = (text: string, query: string) => renderToStaticMarkup(<Highlight text={text} query={query} />);

it('emphasises meaningful query words at word starts, never stray letters', () => {
  expect(html('Packing list for 3 days in Lisbon', 'how to pack for a trip')).toBe('<strong>Pack</strong>ing list for 3 days in Lisbon');
  expect(html('Trip packing list', 'how to pack for a trip')).toBe('<strong>Trip</strong> <strong>pack</strong>ing list');
  expect(html('Привет мир', 'ПРИВЕТ')).toBe('<strong>Привет</strong> мир');
  expect(html('Regex (help)', '(help')).toBe('Regex <strong>(help</strong>)');
  expect(html('for a while', 'for a')).toBe('for a while');
});
