/**
 * PraxisChat Exact Design Tokens — ported 1:1 from:
 * - PraxisChat/PraxisChat/DesignSystem/Tokens.swift
 * - PraxisChat/PraxisChat/DesignSystem/Typography.swift
 * - PraxisChat/PraxisChat/DesignSystem/Motion.swift
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export interface PaperPalette {
  canvas: string;
  card: string;
  ink: string;
  mutedInk: string;
  pressedMuted: string;
  secondaryInk: string;
  hairline: string;
  fill1: string;
  fill2: string;
  tile: string;
  tileGlyph: string;
  success: string;
  destructive: string;
}

export const PAPER_LIGHT: PaperPalette = {
  canvas: '#FBFBF9',
  card: '#FFFFFF',
  ink: '#15140F',
  mutedInk: '#8A877E',
  pressedMuted: '#B3AFA3',
  secondaryInk: '#6E6B62',
  hairline: '#E9E6DF',
  fill1: '#F4F2EC',
  fill2: '#E9E6DF',
  tile: '#2A2926',
  tileGlyph: '#F4F2EC',
  success: '#17653F',
  destructive: '#B3382E',
};

export const PAPER_DARK: PaperPalette = {
  canvas: '#0B0B0A',
  card: '#151513',
  ink: '#F1EFE9',
  mutedInk: '#8F8C84',
  pressedMuted: '#6E6B62',
  secondaryInk: '#A8A49A',
  hairline: '#2A2926',
  fill1: '#151513',
  fill2: '#2A2926',
  tile: '#DDD9CF',
  tileGlyph: '#151513',
  success: '#4CC38A',
  destructive: '#FF7A6E',
};

export const PAPER = {
  light: PAPER_LIGHT,
  dark: PAPER_DARK,
  var: {
    canvas: 'var(--paper-canvas)',
    card: 'var(--paper-card)',
    ink: 'var(--paper-ink)',
    mutedInk: 'var(--paper-muted-ink)',
    pressedMuted: 'var(--paper-pressed-muted)',
    secondaryInk: 'var(--paper-secondary-ink)',
    hairline: 'var(--paper-hairline)',
    fill1: 'var(--paper-fill-1)',
    fill2: 'var(--paper-fill-2)',
    tile: 'var(--paper-tile)',
    tileGlyph: 'var(--paper-tile-glyph)',
    success: 'var(--paper-success)',
    destructive: 'var(--paper-destructive)',
  },
} as const;

export const RHYTHM = {
  margin: 20,
  turnGap: 32,
  bubbleToAnswer: 16,
  activityToAnswer: 20,
  composerRadius: 28,
  maxReadingWidth: 680,
  userBubbleMaxWidthPct: 78,
  userBubbleRadius: 20,
  userBubbleTailRadius: 8,
  cardRadius: 20,
  codeBlockRadius: 12,
  trayTileRadius: 16,
} as const;

export const TYPOGRAPHY = {
  fonts: {
    sans: "'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
    mono: "'IBM Plex Mono', 'SF Mono', Menlo, Monaco, Consolas, monospace",
    serif: "'Source Serif 4', 'Newsreader', Georgia, serif",
  },
  sizes: {
    greeting: { fontSize: '30px', lineHeight: '35px', fontWeight: 600, letterSpacing: '-0.015em' },
    agentHeading1: { fontSize: '22px', lineHeight: '29px', fontWeight: 600, letterSpacing: '-0.01em' },
    agentHeading2: { fontSize: '19px', lineHeight: '25px', fontWeight: 600, letterSpacing: '-0.01em' },
    agentHeading3: { fontSize: '17px', lineHeight: '23px', fontWeight: 600, letterSpacing: '-0.005em' },
    navTitle: { fontSize: '15px', lineHeight: '20px', fontWeight: 600, letterSpacing: '-0.01em' },
    body: { fontSize: '17px', lineHeight: '27px', fontWeight: 400 },
    userBubble: { fontSize: '15px', lineHeight: '20px', fontWeight: 400 },
    activity: { fontSize: '13px', lineHeight: '18px', fontWeight: 500 },
    activitySub: { fontSize: '13px', lineHeight: '18px', fontWeight: 400 },
    chip: { fontSize: '13px', lineHeight: '16px', fontWeight: 500 },
    codePill: { fontSize: '13.5px', lineHeight: '18px', fontWeight: 500 },
    codeBlock: { fontSize: '13px', lineHeight: '20px', fontWeight: 400 },
    codeDetail: { fontSize: '11px', lineHeight: '16px', fontWeight: 400 },
    monoLabel: { fontSize: '10px', lineHeight: '13px', fontWeight: 500, letterSpacing: '0.8px', textTransform: 'uppercase' as const },
    footnote: { fontSize: '12px', lineHeight: '16px', fontWeight: 400 },
  },
} as const;

export interface SpringSpec {
  type: 'spring';
  response: number;
  dampingFraction: number;
  stiffness: number;
  damping: number;
  mass: number;
}

function makeSpring(response: number, dampingFraction: number, mass = 1): SpringSpec {
  const omega = (2 * Math.PI) / response;
  const stiffness = Math.round(omega * omega * mass);
  const damping = Number((2 * dampingFraction * omega * mass).toFixed(1));
  return {
    type: 'spring',
    response,
    dampingFraction,
    stiffness,
    damping,
    mass,
  };
}

/**
 * Exact spring tokens from Motion.swift
 */
export const MOTION = {
  press: makeSpring(0.16, 0.86),
  release: makeSpring(0.42, 0.58),
  snap: makeSpring(0.30, 0.72),
  morph: makeSpring(0.42, 0.76),
  pop: makeSpring(0.36, 0.62),
  reflow: makeSpring(0.36, 0.92),
  reveal: makeSpring(0.30, 1.0),
  send: makeSpring(0.38, 0.82),
  exit: { type: 'tween' as const, duration: 0.10, ease: 'easeOut' as const },
  handoff: { type: 'tween' as const, duration: 0.10, ease: 'easeOut' as const },
  reduced: { type: 'tween' as const, duration: 0.15, ease: 'easeOut' as const },
} as const;
