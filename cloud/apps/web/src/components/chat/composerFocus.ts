/**
 * "New chat" lands the caret in the composer, from the button, the shortcut or the phone drawer.
 * Focus is taken synchronously when the composer is mounted, which keeps it inside the user's gesture
 * (iOS only raises the keyboard then); otherwise the next composer to mount takes it.
 */
let input: HTMLTextAreaElement | null = null;
let pending = false;

function focusNow(el: HTMLTextAreaElement) {
  el.focus({ preventScroll: true });
  const end = el.value.length;
  el.setSelectionRange(end, end);
}

export function registerComposerInput(el: HTMLTextAreaElement | null) {
  input = el;
  if (el && pending) {
    pending = false;
    focusNow(el);
  }
}

export function requestComposerFocus() {
  if (input?.isConnected) {
    focusNow(input);
    // The draft's state lands on the next render; keep the caret there once it has.
    const el = input;
    requestAnimationFrame(() => {
      if (el.isConnected && document.activeElement !== el) focusNow(el);
    });
    return;
  }
  pending = true;
}
