/**
 * Theme types and the iOS Paper palette (PraxisChat/PraxisChat/DesignSystem/Tokens.swift).
 * Runtime styling reads CSS custom properties from apps/web/src/styles/tokens.css; these
 * constants exist so tests can prove the CSS stays on the iOS palette.
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
  paper: '#fbfbf9',
  surface: '#ffffff',
  ink: '#15140f',
  ink2: '#6e6b62',
  ink3: '#8a877e',
  fill1: '#f4f2ec',
  fill2: '#e9e6df',
  success: '#17653f',
  danger: '#b3382e',
};

export const PAPER_DARK: PaperPalette = {
  paper: '#0b0b0a',
  surface: '#151513',
  ink: '#f1efe9',
  ink2: '#a8a49a',
  ink3: '#8f8c84',
  fill1: '#151513',
  fill2: '#2a2926',
  success: '#4cc38a',
  danger: '#ff7a6e',
};
