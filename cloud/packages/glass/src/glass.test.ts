import { describe, expect, it } from 'vitest';
import {
  PAPER,
  PAPER_LIGHT,
  PAPER_DARK,
  RHYTHM,
  TYPOGRAPHY,
  MOTION,
  MATERIAL_RAMP,
  negotiateStrategy,
  generateDisplacementMaps,
  BAKED_PROFILES,
} from './index';

describe('@praxis/glass tokens & engine', () => {
  it('matches exact Swift Paper color tokens in light and dark mode', () => {
    expect(PAPER_LIGHT.canvas).toBe('#FBFBF9');
    expect(PAPER_LIGHT.card).toBe('#FFFFFF');
    expect(PAPER_LIGHT.ink).toBe('#15140F');
    expect(PAPER_LIGHT.secondaryInk).toBe('#6E6B62');
    expect(PAPER_LIGHT.hairline).toBe('#E9E6DF');
    expect(PAPER_LIGHT.fill1).toBe('#F4F2EC');
    expect(PAPER_LIGHT.fill2).toBe('#E9E6DF');
    expect(PAPER_LIGHT.tile).toBe('#2A2926');
    expect(PAPER_LIGHT.tileGlyph).toBe('#F4F2EC');
    expect(PAPER_LIGHT.success).toBe('#17653F');
    expect(PAPER_LIGHT.destructive).toBe('#B3382E');

    expect(PAPER_DARK.canvas).toBe('#0B0B0A');
    expect(PAPER_DARK.card).toBe('#151513');
    expect(PAPER_DARK.ink).toBe('#F1EFE9');
    expect(PAPER_DARK.secondaryInk).toBe('#A8A49A');
    expect(PAPER_DARK.hairline).toBe('#2A2926');
    expect(PAPER_DARK.tile).toBe('#DDD9CF');
    expect(PAPER_DARK.tileGlyph).toBe('#151513');
    expect(PAPER_DARK.success).toBe('#4CC38A');
    expect(PAPER_DARK.destructive).toBe('#FF7A6E');
    expect(PAPER.var.canvas).toBe('var(--paper-canvas)');
  });

  it('matches exact Swift Rhythm & Motion spring parameters', () => {
    expect(RHYTHM.margin).toBe(20);
    expect(RHYTHM.turnGap).toBe(32);
    expect(RHYTHM.composerRadius).toBe(28);
    expect(RHYTHM.maxReadingWidth).toBe(680);

    expect(MOTION.press.response).toBe(0.16);
    expect(MOTION.press.dampingFraction).toBe(0.86);
    expect(MOTION.pop.response).toBe(0.36);
    expect(MOTION.pop.dampingFraction).toBe(0.62);
    expect(MOTION.reflow.dampingFraction).toBe(0.92);
    expect(TYPOGRAPHY.sizes.body.fontSize).toBe('17px');
    expect(TYPOGRAPHY.sizes.body.lineHeight).toBe('27px');
  });

  it('generates and caches kube.io displacement and specular maps', () => {
    const maps1 = generateDisplacementMaps({
      width: 256,
      height: 400,
      radius: 24,
      bezel: MATERIAL_RAMP.regular.bezel,
      material: 'regular',
    });
    expect(maps1.displacementUrl).toMatch(/^data:image\//);
    expect(maps1.specularUrl).toMatch(/^data:image\//);

    const maps2 = generateDisplacementMaps({
      width: 256,
      height: 400,
      radius: 24,
      bezel: MATERIAL_RAMP.regular.bezel,
      material: 'regular',
    });
    expect(maps2).toBe(maps1);
    expect(BAKED_PROFILES.regular.length).toBe(41);
    expect(negotiateStrategy()).toMatch(/^(svg-displacement|progressive-frost|reduced-transparency)$/);
  });
});
