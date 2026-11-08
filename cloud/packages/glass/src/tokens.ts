/**
 * Theme types and the web palette: the iOS Paper palette (PraxisChat/PraxisChat/DesignSystem/Tokens.swift)
 * with the owner's design v2 main-area sets (`M` in Chat Screen.dc.html) over it: paper is mBg's middle stop,
 * ink mInk, ink2 mMute, ink3 the source's placeholder; dark surfaces and fills follow mBubble/mBtn.
 * Runtime styling reads CSS custom properties from apps/web/src/styles/tokens.css; these
 * constants exist so tests can prove the CSS stays on this palette.
 */
export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export interface PaperPalette {
  paper: string;
  surface: string;
  ink: string;
  ink2: string;
  ink3: string;
  fill1: string;
  fill2: string;
  success: string;
  danger: string;
}

export const PAPER_LIGHT: PaperPalette = {
  paper: '#f9f8f5',
  surface: '#ffffff',
  ink: '#1c1c1c',
  ink2: '#6b6b68',
  ink3: '#8a8a86',
  fill1: '#f4f2ec',
  fill2: '#e9e6df',
  success: '#17653f',
  danger: '#b3382e',
};

export const PAPER_DARK: PaperPalette = {
  paper: '#1a1a1d',
  surface: '#222226',
  ink: '#ececea',
  ink2: '#9a9a96',
  ink3: '#8a8a86',
  fill1: '#222226',
  fill2: '#2d2d31',
  success: '#4cc38a',
  danger: '#ff7a6e',
};
