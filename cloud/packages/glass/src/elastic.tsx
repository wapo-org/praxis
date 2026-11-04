/**
 * Liquid Glass stretch: every glass element stretches elastically toward the
 * pointer while pressed and dragged, then springs back on release.
 *
 * One shared implementation and one spring (SPRING_VALUE from ./motion.ts).
 * - Transform only, written directly to the element in a rAF-batched loop:
 *   React never re-renders per pointer move.
 * - Growing resistance (tanh curve), scale-only (corners never skew), text
 *   never squashes: secondary-axis scale stays near 1.
 * - Never moves the element's position permanently; the spring returns it to rest.
 * - Click suppression: a real drag (> threshold) swallows the following click.
 * - Typing / text selection / scrolling stay intact: interactive targets are
 *   skipped, selection aborts the drag, touch vertical scroll cancels it via
 *   pointercancel, and pointerdown is never preventDefault'ed.
 * - prefers-reduced-motion disables the effect entirely.
 */
import React from 'react';
import { SPRING_VALUE } from './motion';

export const ELASTIC_THRESHOLD = 6;
export const ELASTIC_MAX_PULL = 26;
export const ELASTIC_MAX_STRETCH = 0.07;
const PULL_RESISTANCE = 120;
const STRETCH_RESISTANCE = 170;
const CLICK_CAPTURE_DELAY = 0;

export interface ElasticPose {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

export const ELASTIC_REST: ElasticPose = { x: 0, y: 0, scaleX: 1, scaleY: 1 };

/** Pure pose for a pointer offset from the element centre (px). */
export function elasticPoseForOffset(dx: number, dy: number): ElasticPose {
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return { ...ELASTIC_REST };
  const pull = ELASTIC_MAX_PULL * Math.tanh(dist / PULL_RESISTANCE);
  const stretch = ELASTIC_MAX_STRETCH * Math.tanh(dist / STRETCH_RESISTANCE);
  const ux = dx / dist;
  const uy = dy / dist;
  return {
    x: ux * pull,
    y: uy * pull,
    scaleX: 1 + stretch * Math.abs(ux),
    scaleY: 1 + stretch * Math.abs(uy),
  };
}

export function elasticTransform(pose: ElasticPose): string {
  if (pose.x === 0 && pose.y === 0 && pose.scaleX === 1 && pose.scaleY === 1) return 'none';
  const n = (v: number) => Math.round(v * 1000) / 1000;
  return `translate(${n(pose.x)}px, ${n(pose.y)}px) scale(${n(pose.scaleX)}, ${n(pose.scaleY)})`;
}

/** One semi-implicit Euler step of the shared spring toward the rest pose. */
export function stepElasticSpring(
  pose: ElasticPose,
  velocity: ElasticPose,
  dt: number,
  target: ElasticPose = ELASTIC_REST,
): { pose: ElasticPose; velocity: ElasticPose; settled: boolean } {
  const step = (value: number, vel: number, goal: number) => {
    const accel = -SPRING_VALUE.stiffness * (value - goal) - SPRING_VALUE.damping * vel;
    const nextVel = vel + accel * dt;
    return { value: value + nextVel * dt, vel: nextVel };
  };
  const sx = step(pose.x, velocity.x, target.x);
  const sy = step(pose.y, velocity.y, target.y);
  const ssx = step(pose.scaleX, velocity.scaleX, target.scaleX);
  const ssy = step(pose.scaleY, velocity.scaleY, target.scaleY);
  const settled =
    Math.abs(sx.value) < 0.05 &&
    Math.abs(sy.value) < 0.05 &&
    Math.abs(ssx.value - 1) < 0.0008 &&
    Math.abs(ssy.value - 1) < 0.0008 &&
    Math.hypot(sx.vel, sy.vel) < 2;
  return {
    pose: { x: sx.value, y: sy.value, scaleX: ssx.value, scaleY: ssy.value },
    velocity: { x: sx.vel, y: sy.vel, scaleX: ssx.vel, scaleY: ssy.vel },
    settled,
  };
}

const INTERACTIVE = 'input, textarea, select, [contenteditable="true"], [data-no-elastic]';

function reducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Ref callback giving a glass element the shared elastic stretch.
 * Attach to the element that may transform (never the backdrop-filter element
 * itself: wrap GlassSurface so its own framer-motion transform is untouched).
 */
export function useElasticStretch<T extends HTMLElement>(options?: { disabled?: boolean }) {
  const disabled = options?.disabled ?? false;
  return React.useCallback(
    (node: T | null) => {
      if (!node) return;
      if (disabled) return;
      attachElastic(node);
      return () => detachElastic(node);
    },
    [disabled],
  );
}

interface DragSession {
  node: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  centerX: number;
  centerY: number;
  dragging: boolean;
  pose: ElasticPose;
  velocity: ElasticPose;
  frame: number;
  framePending: boolean;
  lastClientX: number;
  lastClientY: number;
  lastStamp: number;
}

const sessions = new WeakMap<HTMLElement, number>();

function attachElastic(node: HTMLElement) {
  if (sessions.has(node)) return;
  sessions.set(node, 1);
  node.addEventListener('pointerdown', onPointerDown);
}

function detachElastic(node: HTMLElement) {
  sessions.delete(node);
  node.removeEventListener('pointerdown', onPointerDown);
}

const active = new Map<number, DragSession>();

function onPointerDown(event: PointerEvent) {
  const node = event.currentTarget as HTMLElement;
  if (reducedMotion()) return;
  if (event.defaultPrevented) return;
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const target = event.target as Element | null;
  if (target?.closest?.(INTERACTIVE)) return;
  // A drag that starts on a native scroll container with touch should scroll.
  // We never preventDefault, so the browser takes over and fires pointercancel.
  const rect = node.getBoundingClientRect();
  const session: DragSession = {
    node,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    centerX: rect.left + rect.width / 2,
    centerY: rect.top + rect.height / 2,
    dragging: false,
    pose: { ...ELASTIC_REST },
    velocity: { x: 0, y: 0, scaleX: 0, scaleY: 0 },
    frame: 0,
    framePending: false,
    lastClientX: event.clientX,
    lastClientY: event.clientY,
    lastStamp: 0,
  };
  active.set(event.pointerId, session);
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
}

function onPointerMove(event: PointerEvent) {
  const session = active.get(event.pointerId);
  if (!session) return;
  // Natural text selection wins over stretching.
  const selection = window.getSelection?.();
  if (selection && selection.toString().length > 0) {
    if (session.dragging) finishDrag(session, false);
    cleanupSession(session);
    return;
  }
  session.lastClientX = event.clientX;
  session.lastClientY = event.clientY;
  session.lastStamp = performance.now();
  if (!session.dragging) {
    const moved = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
    if (moved < ELASTIC_THRESHOLD) return;
    session.dragging = true;
    session.node.style.willChange = 'transform';
  }
  if (session.framePending) return;
  session.framePending = true;
  session.frame = requestAnimationFrame(() => {
    session.framePending = false;
    if (!active.has(session.pointerId)) return;
    session.pose = elasticPoseForOffset(
      session.lastClientX - session.centerX,
      session.lastClientY - session.centerY,
    );
    session.node.style.transform = elasticTransform(session.pose);
  });
}

function onPointerUp(event: PointerEvent) {
  const session = active.get(event.pointerId);
  if (!session) return;
  if (session.dragging) {
    suppressNextClick();
    finishDrag(session, true);
  }
  cleanupSession(session);
}

function onPointerCancel(event: PointerEvent) {
  const session = active.get(event.pointerId);
  if (!session) return;
  // Browser took the gesture (scroll): spring back, keep the click.
  if (session.dragging) finishDrag(session, true);
  cleanupSession(session);
}

function finishDrag(session: DragSession, spring: boolean) {
  cancelAnimationFrame(session.frame);
  session.framePending = false;
  const node = session.node;
  if (!spring) {
    node.style.transform = 'none';
    node.style.willChange = '';
    return;
  }
  let pose = { ...session.pose };
  let velocity = { ...session.velocity };
  let last = performance.now();
  const step = (now: number) => {
    const dt = Math.min(1 / 30, Math.max(0, (now - last) / 1000) || 1 / 60);
    last = now;
    const next = stepElasticSpring(pose, velocity, dt);
    pose = next.pose;
    velocity = next.velocity;
    if (next.settled) {
      node.style.transform = 'none';
      node.style.willChange = '';
      return;
    }
    node.style.transform = elasticTransform(pose);
    session.frame = requestAnimationFrame(step);
  };
  session.frame = requestAnimationFrame(step);
}

function cleanupSession(session: DragSession) {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerCancel);
  active.delete(session.pointerId);
}

/**
 * A real drag must not fire the click. A single permanent capture-phase
 * listener swallows the first click within 600 ms of a drag's pointerup,
 * so React handlers never run for that gesture. The listener is installed
 * once and never stacks, so it cannot leak between gestures.
 */
let ignoreClickUntil = 0;
let clickSwallowerInstalled = false;

function suppressNextClick() {
  ignoreClickUntil = Date.now() + 600;
  if (clickSwallowerInstalled) return;
  clickSwallowerInstalled = true;
  const swallow = (event: Event) => {
    if (Date.now() >= ignoreClickUntil) return;
    ignoreClickUntil = 0;
    event.stopImmediatePropagation();
    event.preventDefault();
  };
  window.addEventListener('click', swallow, true);
  void CLICK_CAPTURE_DELAY;
}
