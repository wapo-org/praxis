/** Roles a user can act on; only these get refs, so a snapshot stays short and every ref is a real target. */
export const ACTIONABLE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'option', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'tab', 'slider', 'spinbutton', 'treeitem',
]);

/** A ref is a position in the accessibility tree, not a DOM handle: same page, same refs, in any process. */
export interface RefTarget {
  role: string;
  name: string;
  /** 0-based index among elements with the same role and accessible name. */
  nth: number;
}

export type Target = {kind: 'ref'; ref: string} | {kind: 'role'; role: string; name: string};

const NODE = /^(\s*)- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?/;
const REF = /^e[1-9]\d*$/;

function unquote(name: string): string {
  return name.replace(/\\(.)/g, '$1');
}

/** Appends `[ref=eN]` to every named actionable node, numbering in document order. */
export function annotateSnapshot(snapshot: string): {text: string; refs: Record<string, RefTarget>} {
  const refs: Record<string, RefTarget> = {};
  const seen = new Map<string, number>();
  let next = 1;
  const lines = snapshot.split('\n').map(line => {
    const node = NODE.exec(line);
    if (!node || node[3] === undefined || !ACTIONABLE_ROLES.has(node[2]!)) return line;
    const role = node[2]!;
    const name = unquote(node[3]);
    const key = `${role}\u0000${name}`;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    const ref = `e${next++}`;
    refs[ref] = {role, name, nth};
    const at = node[0].length;
    return `${line.slice(0, at)} [ref=${ref}]${line.slice(at)}`;
  });
  return {text: lines.join('\n'), refs};
}

/** `e3` is a ref from the last snapshot; `role:name` targets by accessible name with no snapshot needed. */
export function parseTarget(argument: string): Target {
  if (REF.test(argument)) return {kind: 'ref', ref: argument};
  const colon = argument.indexOf(':');
  if (colon > 0 && /^[a-z]+$/.test(argument.slice(0, colon))) return {kind: 'role', role: argument.slice(0, colon), name: argument.slice(colon + 1)};
  throw new Error(`target must be a ref like e3 or role:name like button:Sign in, got ${argument}`);
}
