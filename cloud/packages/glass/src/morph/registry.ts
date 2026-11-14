/** Lets the stretch ask a morphing glass root for its rest box, without a dependency on the engine. */
export interface MorphStatus {
  /** In the fast phase the glass is not at its size yet, so a pull has nothing to measure. */
  growing(): boolean;
  restRect(): DOMRect | null;
}

const statuses = new WeakMap<Element, MorphStatus>();

export function registerMorph(el: Element, status: MorphStatus) {
  statuses.set(el, status);
  return () => {
    if (statuses.get(el) === status) statuses.delete(el);
  };
}

export const morphStatus = (el: Element) => statuses.get(el);
