import { expect, it } from 'vitest';
import { parseMarkdownBlocks } from './markdownBlocks';
it('preserves GFM table alignment, escaped pipes and rectangular rows', () => {
  expect(
    parseMarkdownBlocks('| Name | Count |\n| :--- | ---: |\n| a\\|b | 2 |\n| c |')[0],
  ).toMatchObject({
    headers: ['Name', 'Count'],
    alignments: ['left', 'right'],
    rows: [
      ['a|b', '2'],
      ['c', ''],
    ],
  });
});
it('retains ordered list numbering', () => {
  expect(parseMarkdownBlocks('3. Third\n4. Fourth')[0]).toMatchObject({
    ordered: true,
    start: 3,
  });
});
