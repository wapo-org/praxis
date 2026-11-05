/**
 * The elastic stretch: ported from wapo.dp `GlassSurface.tsx`, math verbatim.
 *
 * Hold the glass and pull: it grows toward the pointer in any direction, and
 * the far support point stays put, so the deformation is one-sided. Travel
 * saturates through tanh against an elliptical budget, so the material has mass
 * and never reaches the cursor. Strictly axis-aligned: a sheared rectangle reads
 * as a tilt in depth. Release springs back through zero with overshoot.
 *
 * Deliberate changes from the source (the owner asked for them):
 *  - Any point on the glass starts a pull, over any element. Only a text field
 *    holding text and an active selection refuse: selection wins.
 *  - No pointer capture and no preventDefault on press: capture would retarget
 *    the click away from the button, and a cancelled pointerdown drops focus.
 *  - The pose is written to the `scale` and `translate` CSS properties, which
 *    compose with whatever `transform` framer-motion owns on the same element.
 */
import { animate, frame, motionValue, type MotionValue } from 'framer-motion';
import { MATERIAL_RAMP, STRETCH_BUDGET, type GlassMaterial } from './material';
import { SPRINGS } from './motion';

/** Pointer travel before the stretch engages: plain clicks stay inert. */
export const PULL_ENGAGE_PX = 3;
/** Travel past which the press was a pull, and its click is swallowed. */
export const PULL_CLICK_SLOP_PX = 8;

/** Saturating resistance along the pull: travel asymptotically reaches the budget. */
export function saturatePull(delta: number, budget: number): number {
  return budget * Math.tanh(delta / budget);
}

/** The budget in an arbitrary direction: the radius of the ellipse of per-axis budgets. */
export function directionalBudget(dirX: number, dirY: number, budgetX: number, budgetY: number): number {
  const norm = Math.hypot(dirX / budgetX, dirY / budgetY);
  return norm > 1e-6 ? 1 / norm : Math.min(budgetX, budgetY);
}

export function axisBudget(size: number, material: GlassMaterial): number {
  return Math.max(1, Math.min(STRETCH_BUDGET.cmPx, STRETCH_BUDGET.fraction * size)) * MATERIAL_RAMP[material].stretch;
}

/** The pull for a pointer travel: direction kept exactly, distance saturated. */
export function pullForTravel(dx: number, dy: number, budgetX: number, budgetY: number): { x: number; y: number } {
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-4) return { x: 0, y: 0 };
  const dirX = dx / distance;
  const dirY = dy / distance;
  const pulled = saturatePull(distance, directionalBudget(dirX, dirY, budgetX, budgetY));
  return { x: dirX * pulled, y: dirY * pulled };
}

export interface StretchPose {
  scaleX: number;
  scaleY: number;
  translateX: number;
  translateY: number;
}

/**
 * Each axis grows by its own share of the pull, anchored on the far side. The
 * fixed point sits on the boundary opposite the pointer, scaled by the direction
 * cosines so it is smooth through every angle. No cross-axis squash and no
 * off-diagonal term (see the source's measurements).
 *
 * `originX/Y` is the element's transform-origin relative to its centre, so the
 * far side stays fixed for a menu that grows from a corner too.
 */
export function computeStretch(pullX: number, pullY: number, w: number, h: number, originX = 0, originY = 0): StretchPose | null {
  if (w < 1 || h < 1) return null;
  const distance = Math.hypot(pullX, pullY);
  if (distance < 0.01) return null;
  const scaleX = 1 + Math.abs(pullX) / w;
  const scaleY = 1 + Math.abs(pullY) / h;
  const anchorX = (-pullX / distance) * w * 0.5;
  const anchorY = (-pullY / distance) * h * 0.5;
  return {
    scaleX,
    scaleY,
    translateX: (anchorX - originX) * (1 - scaleX),
    translateY: (anchorY - originY) * (1 - scaleY),
  };
}

/** Elements that must keep their own drag. */
const OWN_DRAG = 'input[type="range"], [data-glass-no-stretch]';
const TEXT_FIELD = 'textarea, input, [contenteditable=""], [contenteditable="true"]';
const NOT_TEXT = /^(checkbox|radio|button|submit|reset|file|color|range|image)$/;

/** A text field with text, or any live selection in the surface: selection wins over stretching. */
export function selectionWins(target: Element, surface: Element): boolean {
  const field = target.closest(TEXT_FIELD);
  if (field && surface.contains(field)) {
    if (field instanceof HTMLInputElement && NOT_TEXT.test(field.type)) return false;
    const text = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.value : field.textContent;
    if (text) return true;
  }
  const selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
  return !!selection && !selection.isCollapsed && selection.toString().length > 0 && !!selection.anchorNode && surface.contains(selection.anchorNode);
}

export function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A press on a scrollbar is the scrollbar's. */
function onScrollbar(event: PointerEvent, target: Element): boolean {
  if (target.scrollHeight <= target.clientHeight && target.scrollWidth <= target.clientWidth) return false;
  const rect = target.getBoundingClientRect();
  return event.clientX > rect.left + target.clientLeft + target.clientWidth || event.clientY > rect.top + target.clientTop + target.clientHeight;
}

/** Can the scroller inside `surface` under `target` still scroll along this touch move? */
export function scrollerTakesMove(target: Element, surface: Element, dx: number, dy: number): boolean {
  if (Math.abs(dx) > Math.abs(dy)) return false; // sideways always stretches
  for (let el: Element | null = target; el && el !== surface; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    const overflow = getComputedStyle(el).overflowY;
    if (overflow !== 'auto' && overflow !== 'scroll') continue;
    const atTop = el.scrollTop <= 0;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    if ((dy > 0 && !atTop) || (dy < 0 && !atBottom)) return true;
  }
  return false;
}

/** The real browser click after a pull must not fire; synthetic row.click() still does. */
export function shouldSwallowClick(event: { isTrusted: boolean }): boolean {
  return event.isTrusted;
}

let swallowUntil = 0;
let swallowerInstalled = false;
function swallowNextClick() {
  swallowUntil = Date.now() + 400;
  if (swallowerInstalled) return;
  swallowerInstalled = true;
  window.addEventListener(
    'click',
    (event) => {
      if (Date.now() >= swallowUntil || !shouldSwallowClick(event)) return;
      swallowUntil = 0;
      event.stopImmediatePropagation();
      event.preventDefault();
    },
    true,
  );
  // A new press means whatever click was pending has passed.
  window.addEventListener('pointerdown', () => { swallowUntil = 0; }, true);
}

export interface StretchOptions {
  material: GlassMaterial;
  /** `press`: a pull from anywhere on the glass. `edge`: only past the edge (menus scrub inside). */
  mode: 'press' | 'edge';
  onHold: (held: boolean) => void;
}

const follow = (value: MotionValue<number>, target: number) =>
  animate(value, target, { type: 'spring', ...SPRINGS.follow, velocity: value.getVelocity() });

/** Attach the stretch gesture to a glass root. Returns the detach function. */
export function attachStretch(el: HTMLElement, options: StretchOptions): () => void {
  const { material, mode, onHold } = options;
  const ramp = MATERIAL_RAMP[material];
  const pullX = motionValue(0);
  const pullY = motionValue(0);
  let w = 0;
  let h = 0;
  let originX = 0;
  let originY = 0;
  let gesture: { pointerId: number; startX: number; startY: number; target: Element; engaged: boolean; travel: number; touch: boolean } | null = null;
  let edge: DOMRect | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const write = () => {
    const pose = computeStretch(pullX.get(), pullY.get(), w, h, originX, originY);
    el.style.scale = pose ? `${pose.scaleX.toFixed(5)} ${pose.scaleY.toFixed(5)}` : '';
    el.style.translate = pose ? `${pose.translateX.toFixed(3)}px ${pose.translateY.toFixed(3)}px` : '';
  };
  const schedule = () => frame.render(write);
  const unsubscribeX = pullX.on('change', schedule);
  const unsubscribeY = pullY.on('change', schedule);

  const measure = () => {
    w = el.offsetWidth;
    h = el.offsetHeight;
    const origin = getComputedStyle(el).transformOrigin.split(' ').map(parseFloat);
    originX = (origin[0] ?? w / 2) - w / 2;
    originY = (origin[1] ?? h / 2) - h / 2;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
    el.style.willChange = 'scale, translate';
  };

  const pullTo = (dx: number, dy: number) => {
    const pull = pullForTravel(dx, dy, axisBudget(w, material), axisBudget(h, material));
    follow(pullX, pull.x);
    follow(pullY, pull.y);
  };

  const springBack = () => {
    const release = { type: 'spring' as const, duration: ramp.settle, bounce: ramp.bounce };
    animate(pullX, 0, { ...release, velocity: pullX.getVelocity() });
    animate(pullY, 0, { ...release, velocity: pullY.getVelocity() });
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      el.style.willChange = '';
      settleTimer = null;
    }, ramp.settle * 1000 + 400);
  };

  const stopWindow = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
  };

  const finish = (swallow: boolean) => {
    if (!gesture) return;
    const wasEngaged = gesture.engaged;
    gesture = null;
    stopWindow();
    delete el.dataset.stretching;
    onHold(false);
    if (wasEngaged) springBack();
    else if (settleTimer === null) el.style.willChange = '';
    if (swallow) swallowNextClick();
  };

  function onMove(event: PointerEvent) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    const distance = Math.hypot(dx, dy);
    if (!gesture.engaged) {
      if (distance < PULL_ENGAGE_PX) return;
      if (selectionWins(gesture.target, el)) return finish(false);
      gesture.engaged = true;
      el.dataset.stretching = 'true';
    }
    gesture.travel = Math.max(gesture.travel, distance);
    pullTo(dx, dy);
  }

  function onUp(event: PointerEvent) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    finish(gesture.travel >= PULL_CLICK_SLOP_PX);
  }

  function onCancel(event: PointerEvent) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    finish(false); // the browser took the gesture (a scroll): settle, keep nothing
  }

  const onDown = (event: PointerEvent) => {
    if (gesture || event.button !== 0 || reducedMotion()) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    // The nearest surface owns the pull; a press that opens a menu belongs to the menu.
    if (target.closest('[data-glass-surface]') !== el) return;
    if (target.closest('[data-press-opens]') || target.closest(OWN_DRAG)) return;
    if (onScrollbar(event, target) || selectionWins(target, el)) return;
    if (el.offsetWidth < 24 || el.offsetHeight < 12) return;
    measure();
    gesture = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, target, engaged: false, travel: 0, touch: event.pointerType === 'touch' };
    onHold(true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  /* Touch: let an inner scroller pan; a pull at the limit or sideways stretches instead. */
  const touchStart = { x: 0, y: 0 };
  let touchDecided = false;
  const onTouchStart = (event: TouchEvent) => {
    touchStart.x = event.touches[0]?.clientX ?? 0;
    touchStart.y = event.touches[0]?.clientY ?? 0;
    touchDecided = false;
  };
  const onTouchMove = (event: TouchEvent) => {
    if (!gesture?.touch) return;
    if (!touchDecided) {
      const touch = event.touches[0];
      if (!touch) return;
      const dx = touch.clientX - touchStart.x;
      const dy = touch.clientY - touchStart.y;
      if (Math.hypot(dx, dy) < 2) return;
      touchDecided = true;
      if (scrollerTakesMove(gesture.target, el, dx, dy)) return; // the pan fires pointercancel
    }
    if (event.cancelable) event.preventDefault();
  };

  /* Edge mode: the press usually began on the trigger, before this menu existed. */
  const onEdgeMove = (event: PointerEvent) => {
    if (!event.buttons || reducedMotion()) return releaseEdge();
    const rect = edge ?? el.getBoundingClientRect();
    const dx = event.clientX - Math.min(Math.max(event.clientX, rect.left), rect.right);
    const dy = event.clientY - Math.min(Math.max(event.clientY, rect.top), rect.bottom);
    if (!edge) {
      if (!dx && !dy) return;
      edge = rect;
      measure();
      el.dataset.stretching = 'true';
      onHold(true);
    }
    pullTo(dx, dy);
  };
  const releaseEdge = () => {
    if (!edge) return;
    edge = null;
    delete el.dataset.stretching;
    onHold(false);
    springBack();
  };

  /* A native link or image drag would cancel the pointer. */
  const onDragStart = (event: DragEvent) => {
    if (mode === 'edge' || !(event.target instanceof Element) || !event.target.closest('input, textarea')) event.preventDefault();
  };

  el.addEventListener('dragstart', onDragStart);
  if (mode === 'press') {
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
  } else {
    window.addEventListener('pointermove', onEdgeMove, { passive: true });
    window.addEventListener('pointerup', releaseEdge);
    window.addEventListener('pointercancel', releaseEdge);
  }

  return () => {
    unsubscribeX();
    unsubscribeY();
    stopWindow();
    pullX.stop();
    pullY.stop();
    if (settleTimer) clearTimeout(settleTimer);
    el.removeEventListener('dragstart', onDragStart);
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('touchstart', onTouchStart);
    el.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('pointermove', onEdgeMove);
    window.removeEventListener('pointerup', releaseEdge);
    window.removeEventListener('pointercancel', releaseEdge);
    el.style.scale = '';
    el.style.translate = '';
    el.style.willChange = '';
  };
}
