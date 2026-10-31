import React from 'react';
import type { GlassMaterialControls } from '../glass-store';
export type GlassDropdownAlign = 'start' | 'center' | 'end';
export type GlassDropdownSide = 'top' | 'bottom' | 'auto';
export type GlassDropdownSubmenuMode = 'morph' | 'cascade';

export interface SubLevelInfo {
  id: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
}

export interface GlassDropdownContextValue {
  portal: boolean;
  searchable: boolean;
  open: boolean;
  setOpen: (next: boolean) => void;
  submenuMode: GlassDropdownSubmenuMode;
  align: GlassDropdownAlign;
  side: GlassDropdownSide;
  sideOffset: number;
  closeOnSelect: boolean;
  materialControls: GlassMaterialControls;
  registerTriggerEl: (el: HTMLElement | null) => void;
  getTriggerEl: () => HTMLElement | null;
  registerContentEl: (el: HTMLDivElement | null) => void;
  getContentEl: () => HTMLDivElement | null;
  focusTrigger: () => void;
  menuId: string;
  triggerId: string;
  activeSubPath: string[];
  morphDirection: 1 | -1;
  pushSub: (depth: number, subId: string) => void;
  popSub: (toDepth?: number) => void;
  startScrub: () => void;
  endScrub: () => void;
  isScrubbing: () => boolean;
}

export const GlassDropdownContext =
  React.createContext<GlassDropdownContextValue | null>(null);

export function useGlassDropdownContext(
  component: string,
): GlassDropdownContextValue {
  const ctx = React.useContext(GlassDropdownContext);
  if (!ctx) {
    throw new Error(
      `GlassDropdown.${component} must be used within <GlassDropdown>`,
    );
  }
  return ctx;
}

export interface PanelHighlightContextValue {
  highlightedId: string | null;
  setHighlightedId: (id: string | null) => void;
  layoutScopeId: string;
}

export const PanelHighlightContext =
  React.createContext<PanelHighlightContextValue | null>(null);
export const DepthContext = React.createContext<number>(0);

export interface SubContextValue {
  subId: string;
  depth: number;
  isOpen: boolean;
  openSide: 'left' | 'right';
  setOpenSide: (side: 'left' | 'right') => void;
  registerSubTriggerEl: (el: HTMLButtonElement | null) => void;
  getSubTriggerEl: () => HTMLButtonElement | null;
  label?: React.ReactNode;
  icon?: React.ReactNode;
  subtitle?: React.ReactNode;
}

export const SubContext = React.createContext<SubContextValue | null>(null);

export const SUB_MARKER = Symbol.for('praxis.GlassDropdown.Sub');
export const SUB_TRIGGER_MARKER = Symbol.for('praxis.GlassDropdown.SubTrigger');
export const SUB_CONTENT_MARKER = Symbol.for('praxis.GlassDropdown.SubContent');
export const ACTION_GRID_MARKER = Symbol.for('praxis.GlassDropdown.ActionGrid');
export const SEARCH_MARKER = Symbol.for('praxis.GlassDropdown.Search');

export function assignForwardedRef<T>(
  ref: React.ForwardedRef<T>,
  node: T | null,
): void {
  if (typeof ref === 'function') {
    ref(node);
  } else if (ref) {
    ref.current = node;
  }
}

export function containsSearch(children: React.ReactNode): boolean {
  return React.Children.toArray(children).some(
    (child) =>
      React.isValidElement(child) &&
      ((child.type as { [SEARCH_MARKER]?: boolean })[SEARCH_MARKER] ||
        containsSearch(
          (child.props as { children?: React.ReactNode }).children,
        )),
  );
}
