// The JavaScript half of the host bindings. Runs once per context before
// the user's code (compiled to bytecode once per runner and cached).
//
// It receives the native `__host` object (see `HostFunction`), keeps it in
// a closure, removes it from the global object and installs the public
// globals on top of it. It evaluates to an object of internal entry points
// the Swift side calls (timers, result serialization, error description).
//
// Keep the native surface small and string/bytes based: everything
// structured crosses the boundary as JSON text.
enum Prelude {
    static let filename = "prelude.js"

    static let source = #"""
(function (host) {
'use strict';
const G = globalThis;
const { defineProperty, keys: objectKeys, getOwnPropertyDescriptor, getPrototypeOf, freeze } = Object;
const isArray = Array.isArray;
const stringify = JSON.stringify, parseJSON = JSON.parse;
const hide = (obj, name, value) => defineProperty(obj, name, { value, writable: true, configurable: true, enumerable: false });
const toU8 = (x) => x instanceof Uint8Array ? x
  : x instanceof ArrayBuffer ? new Uint8Array(x)
  : new Uint8Array(x.buffer, x.byteOffset, x.byteLength);

// ---------- inspect (a small util.inspect) ----------
const MAX_DEPTH = 2, MAX_ITEMS = 100, MAX_NESTED_STRING = 1000, LINE_WIDTH = 72;
const IDENT = /^[A-Za-z_$][\w$]*$/;
function quote(s) {
  let more = '';
  if (s.length > MAX_NESTED_STRING) { more = '... ' + (s.length - MAX_NESTED_STRING) + ' more characters'; s = s.slice(0, MAX_NESTED_STRING); }
  return "'" + s.replace(/[\\']/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + "'" + more;
}
function ctorName(v) {
  try {
    const p = getPrototypeOf(v);
    if (p === null) return null;
    const c = p.constructor;
    return typeof c === 'function' && typeof c.name === 'string' ? c.name : '';
  } catch { return ''; }
}
function fnLabel(f) {
  let isClass = false;
  try { isClass = /^class\b/.test(Function.prototype.toString.call(f)); } catch {}
  const name = typeof f.name === 'string' && f.name ? f.name : '';
  if (isClass) return '[class ' + (name || '(anonymous)') + ']';
  return name ? '[Function: ' + name + ']' : '[Function (anonymous)]';
}
function errorText(e) {
  let head;
  try { head = String(e); } catch { head = 'Error'; }
  const stack = typeof e.stack === 'string' ? e.stack.replace(/\s+$/, '') : '';
  return stack ? head + '\n' + stack : head;
}
function list(prefix, parts, open, close) {
  if (parts.length === 0) return prefix + open + close;
  const one = prefix + open + ' ' + parts.join(', ') + ' ' + close;
  if (one.length <= LINE_WIDTH && one.indexOf('\n') < 0) return one;
  return prefix + open + '\n' + parts.map(p => '  ' + p.split('\n').join('\n  ')).join(',\n') + '\n' + close;
}
function inspect(v, depth, seen) {
  switch (typeof v) {
    case 'string': return quote(v);
    case 'number': return Object.is(v, -0) ? '-0' : String(v);
    case 'bigint': return v + 'n';
    case 'boolean': case 'undefined': return String(v);
    case 'symbol': return v.toString();
    case 'function': return fnLabel(v);
  }
  if (v === null) return 'null';
  if (seen.indexOf(v) >= 0) return '[Circular]';
  try {
    if (v instanceof Error) return depth === 0 ? errorText(v) : '[' + String(v) + ']';
    if (v instanceof Date) return isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (v instanceof Promise) return 'Promise {}';
    if (v instanceof WeakMap || v instanceof WeakSet) return ctorName(v) + ' { <items unknown> }';
    if (v instanceof ArrayBuffer) return 'ArrayBuffer { byteLength: ' + v.byteLength + ' }';
    if (v instanceof DataView) return 'DataView { byteLength: ' + v.byteLength + ', byteOffset: ' + v.byteOffset + ' }';
  } catch { return '[Object]'; }
  const array = isArray(v);
  if (depth > MAX_DEPTH) return array ? '[Array]' : '[' + (ctorName(v) || 'Object') + ']';
  seen.push(v);
  try {
    const parts = [];
    const more = (n) => parts.push('... ' + n + ' more item' + (n === 1 ? '' : 's'));
    if (array || ArrayBuffer.isView(v)) {
      const n = v.length, shown = Math.min(n, MAX_ITEMS);
      for (let i = 0; i < shown; i++) parts.push(inspect(v[i], depth + 1, seen));
      if (n > shown) more(n - shown);
      return list(array ? '' : ctorName(v) + '(' + n + ') ', parts, '[', ']');
    }
    if (v instanceof Map || v instanceof Set) {
      const map = v instanceof Map;
      let i = 0;
      for (const item of v) {
        if (i++ >= MAX_ITEMS) { more(v.size - MAX_ITEMS); break; }
        parts.push(map ? inspect(item[0], depth + 1, seen) + ' => ' + inspect(item[1], depth + 1, seen) : inspect(item, depth + 1, seen));
      }
      return list((map ? 'Map(' : 'Set(') + v.size + ') ', parts, '{', '}');
    }
    const ks = objectKeys(v), shown = Math.min(ks.length, MAX_ITEMS);
    for (let i = 0; i < shown; i++) {
      const k = ks[i], d = getOwnPropertyDescriptor(v, k);
      const val = d && (d.get || d.set)
        ? (d.get && d.set ? '[Getter/Setter]' : d.get ? '[Getter]' : '[Setter]')
        : inspect(d ? d.value : undefined, depth + 1, seen);
      parts.push((IDENT.test(k) ? k : quote(k)) + ': ' + val);
    }
    if (ks.length > shown) more(ks.length - shown);
    const name = ctorName(v);
    const prefix = name === null ? '[Object: null prototype] ' : (name && name !== 'Object' ? name + ' ' : '');
    return list(prefix, parts, '{', '}');
  } catch { return '[Object]'; } finally { seen.pop(); }
}
const str = (a) => typeof a === 'string' ? a : inspect(a, 0, []);
function format(args) {
  let out = '', i = 0;
  const first = args[0];
  if (typeof first === 'string' && args.length > 1 && first.indexOf('%') >= 0) {
    i = 1;
    out = first.replace(/%[sdifjoOc%]/g, (m) => {
      if (m === '%%') return '%';
      if (i >= args.length) return m;
      const a = args[i++];
      switch (m) {
        case '%s': return typeof a === 'string' ? a : typeof a === 'bigint' ? a + 'n'
          : (typeof a === 'object' && a !== null) || typeof a === 'symbol' ? inspect(a, 1, []) : String(a);
        case '%d': case '%i': {
          if (typeof a === 'bigint') return a + 'n';
          if (typeof a === 'symbol') return 'NaN';
          const n = Number(a);
          return String(m === '%i' ? Math.trunc(n) : n);
        }
        case '%f': return typeof a === 'symbol' ? 'NaN' : String(parseFloat(a));
        case '%j': try { return stringify(a); } catch { return '[Circular]'; }
        case '%o': case '%O': return inspect(a, 0, []);
        default: return '';
      }
    });
  } else if (args.length) { out = str(first); i = 1; }
  for (; i < args.length; i++) out += ' ' + str(args[i]);
  return out;
}
function logUncaught(e) {
  host.log(3, 'Uncaught ' + (e instanceof Error ? errorText(e) : inspect(e, 0, [])));
}

// ---------- console ----------
const consoleObject = {};
['log', 'info', 'warn', 'error', 'debug'].forEach((name, level) => {
  consoleObject[name] = { [name](...args) { host.log(level, format(args)); } }[name];
});
const counts = new Map(), labels = new Map();
Object.assign(consoleObject, {
  trace(...args) {
    const stack = (new Error().stack || '').split('\n').slice(1).join('\n').replace(/\s+$/, '');
    host.log(4, 'Trace' + (args.length ? ': ' + format(args) : '') + (stack ? '\n' + stack : ''));
  },
  dir(v) { host.log(0, inspect(v, 0, [])); },
  table(v) { host.log(0, inspect(v, 0, [])); },
  assert(cond, ...args) { if (!cond) host.log(3, 'Assertion failed' + (args.length ? ': ' + format(args) : '')); },
  count(label = 'default') { label = String(label); const n = (counts.get(label) || 0) + 1; counts.set(label, n); host.log(0, label + ': ' + n); },
  countReset(label = 'default') { counts.delete(String(label)); },
  time(label = 'default') { labels.set(String(label), performance.now()); },
  timeLog(label = 'default', ...args) {
    const t = labels.get(String(label));
    if (t !== undefined) host.log(0, label + ': ' + (performance.now() - t).toFixed(3) + 'ms' + (args.length ? ' ' + format(args) : ''));
  },
  timeEnd(label = 'default') {
    const t = labels.get(String(label));
    if (t !== undefined) { labels.delete(String(label)); host.log(0, label + ': ' + (performance.now() - t).toFixed(3) + 'ms'); }
  },
  group(...args) { if (args.length) host.log(0, format(args)); },
  groupCollapsed(...args) { if (args.length) host.log(0, format(args)); },
  groupEnd() {},
});
hide(G, 'console', consoleObject);

// ---------- timers ----------
const timers = new Map();
let timerSeq = 0;
function addTimer(fn, ms, args, repeat) {
  if (typeof fn !== 'function') throw new TypeError('The "callback" argument must be a function');
  const id = ++timerSeq;
  timers.set(id, { fn, args, repeat });
  host.timerSet(id, +ms || 0, repeat);
  return id;
}
function setTimeout(fn, ms, ...args) { return addTimer(fn, ms, args, false); }
function setInterval(fn, ms, ...args) { return addTimer(fn, ms, args, true); }
function clearTimeout(id) { id = +id; if (timers.delete(id)) host.timerClear(id); }
function clearInterval(id) { clearTimeout(id); }
function fireTimer(id) {
  const t = timers.get(id);
  if (!t) return false;
  if (!t.repeat) timers.delete(id);
  try { t.fn.apply(undefined, t.args); } catch (e) { logUncaught(e); }
  return t.repeat && timers.has(id);
}
hide(G, 'setTimeout', setTimeout);
hide(G, 'setInterval', setInterval);
hide(G, 'clearTimeout', clearTimeout);
hide(G, 'clearInterval', clearInterval);

// ---------- encoding ----------
class TextEncoder {
  get encoding() { return 'utf-8'; }
  encode(input = '') { return host.utf8Encode(String(input).toWellFormed()); }
  encodeInto(input, dest) {
    const s = String(input).toWellFormed();
    const bytes = host.utf8Encode(s);
    if (bytes.length <= dest.length) { dest.set(bytes); return { read: s.length, written: bytes.length }; }
    let read = 0, written = 0;
    for (const ch of s) {
      const cp = ch.codePointAt(0), n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      if (written + n > dest.length) break;
      written += n; read += ch.length;
    }
    dest.set(bytes.subarray(0, written));
    return { read, written };
  }
}
const UTF8_LABELS = ['utf-8', 'utf8', 'unicode-1-1-utf-8'];
class TextDecoder {
  #fatal; #ignoreBOM;
  constructor(label = 'utf-8', options = {}) {
    if (!UTF8_LABELS.includes(String(label).trim().toLowerCase())) throw new RangeError('The "' + label + '" encoding is not supported (only utf-8)');
    this.#fatal = !!(options && options.fatal);
    this.#ignoreBOM = !!(options && options.ignoreBOM);
  }
  get encoding() { return 'utf-8'; }
  get fatal() { return this.#fatal; }
  get ignoreBOM() { return this.#ignoreBOM; }
  decode(input) {
    if (input === undefined) return '';
    if (!(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input)) throw new TypeError('The "input" argument must be an ArrayBuffer or ArrayBufferView');
    return host.utf8Decode(toU8(input), this.#fatal, this.#ignoreBOM);
  }
}
hide(G, 'TextEncoder', TextEncoder);
hide(G, 'TextDecoder', TextDecoder);

// ---------- structuredClone ----------
function structuredClone(value) {
  const memo = new Map();
  const fail = (what) => { throw new DOMException(what + ' could not be cloned.', 'DataCloneError'); };
  const ERRORS = { EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError };
  function clone(v) {
    if (typeof v === 'symbol') fail(String(v));
    if (typeof v === 'function') fail(fnLabel(v));
    if (v === null || typeof v !== 'object') return v;
    if (memo.has(v)) return memo.get(v);
    let out;
    if (isArray(v)) {
      out = new Array(v.length); memo.set(v, out);
      for (const k of objectKeys(v)) out[k] = clone(v[k]);
      return out;
    }
    if (v instanceof Map) { out = new Map(); memo.set(v, out); for (const [k, x] of v) out.set(clone(k), clone(x)); return out; }
    if (v instanceof Set) { out = new Set(); memo.set(v, out); for (const x of v) out.add(clone(x)); return out; }
    if (v instanceof Error) {
      out = new (ERRORS[v.name] || Error)(v.message); memo.set(v, out);
      if ('cause' in v) out.cause = clone(v.cause);
      if (typeof v.stack === 'string') defineProperty(out, 'stack', { value: v.stack, writable: true, configurable: true });
      return out;
    }
    if (v instanceof Date) out = new Date(v.getTime());
    else if (v instanceof RegExp) out = new RegExp(v.source, v.flags);
    else if (v instanceof ArrayBuffer) out = v.slice(0);
    else if (ArrayBuffer.isView(v)) {
      const buf = clone(v.buffer);
      out = v instanceof DataView ? new DataView(buf, v.byteOffset, v.byteLength) : new v.constructor(buf, v.byteOffset, v.length);
    }
    else if (v instanceof Boolean || v instanceof Number || v instanceof String || v instanceof BigInt) out = Object(v.valueOf());
    else if (v instanceof Promise || v instanceof WeakMap || v instanceof WeakSet || v instanceof WeakRef) fail((ctorName(v) || 'Object') + ' object');
    else {
      out = {}; memo.set(v, out);
      for (const k of objectKeys(v)) out[k] = clone(v[k]);
      return out;
    }
    memo.set(v, out);
    return out;
  }
  return clone(value);
}
hide(G, 'structuredClone', structuredClone);

// ---------- crypto ----------
hide(G, 'crypto', freeze({
  getRandomValues(ta) {
    if (!ArrayBuffer.isView(ta) || ta instanceof DataView || ta instanceof Float32Array || ta instanceof Float64Array
        || (typeof Float16Array === 'function' && ta instanceof Float16Array))
      throw new DOMException('The data argument must be an integer-type TypedArray', 'TypeMismatchError');
    if (ta.byteLength > 65536)
      throw new DOMException('The byte length (' + ta.byteLength + ') exceeds 65536', 'QuotaExceededError');
    toU8(ta).set(host.randomBytes(ta.byteLength));
    return ta;
  },
  randomUUID() {
    const b = host.randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  },
}));

// ---------- URLSearchParams / URL ----------
const LINK = Symbol('link'), RESET = Symbol('reset');
const formEncode = (s) => encodeURIComponent(String(s).toWellFormed())
  .replace(/[!'()~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/g, '+');
function percentDecode(s) {
  try { return decodeURIComponent(s); } catch {
    // Keep malformed escapes literally, decode the rest as UTF-8.
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 0x25 && /^[0-9a-fA-F]{2}$/.test(s.substr(i + 1, 2))) { bytes.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
      else if (c < 0x80) bytes.push(c);
      else { const cp = s.codePointAt(i); for (const b of host.utf8Encode(String.fromCodePoint(cp).toWellFormed())) bytes.push(b); if (cp > 0xffff) i++; }
    }
    return host.utf8Decode(new Uint8Array(bytes), false, true);
  }
}
const formDecode = (s) => percentDecode(s.replace(/\+/g, ' '));
class URLSearchParams {
  #list = [];
  constructor(init = '') {
    if (init instanceof URLSearchParams) this.#list = init.#list.map(p => [p[0], p[1]]);
    else if (typeof init === 'object' && init !== null) {
      if (typeof init[Symbol.iterator] === 'function') {
        for (const pair of init) {
          const p = [...pair];
          if (p.length !== 2) throw new TypeError('Each query pair must be an iterable [name, value] tuple');
          this.#list.push([String(p[0]), String(p[1])]);
        }
      } else for (const k of objectKeys(init)) this.#list.push([k, String(init[k])]);
    } else this[RESET](String(init));
  }
  [RESET](s) {
    this.#list = [];
    if (s.startsWith('?')) s = s.slice(1);
    for (const part of s.split('&')) {
      if (!part) continue;
      const i = part.indexOf('=');
      this.#list.push(i < 0 ? [formDecode(part), ''] : [formDecode(part.slice(0, i)), formDecode(part.slice(i + 1))]);
    }
  }
  #changed() { if (this[LINK]) this[LINK](this.toString()); }
  get size() { return this.#list.length; }
  append(n, v) { this.#list.push([String(n), String(v)]); this.#changed(); }
  delete(n, v) { n = String(n); this.#list = this.#list.filter(p => !(p[0] === n && (v === undefined || p[1] === String(v)))); this.#changed(); }
  get(n) { n = String(n); const p = this.#list.find(p => p[0] === n); return p ? p[1] : null; }
  getAll(n) { n = String(n); return this.#list.filter(p => p[0] === n).map(p => p[1]); }
  has(n, v) { n = String(n); return this.#list.some(p => p[0] === n && (v === undefined || p[1] === String(v))); }
  set(n, v) {
    n = String(n); v = String(v);
    const i = this.#list.findIndex(p => p[0] === n);
    if (i < 0) this.#list.push([n, v]);
    else { this.#list[i][1] = v; this.#list = this.#list.filter((p, j) => j <= i || p[0] !== n); }
    this.#changed();
  }
  sort() { this.#list.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); this.#changed(); }
  forEach(cb, thisArg) { for (const [k, v] of this.#list) cb.call(thisArg, v, k, this); }
  keys() { return this.#list.map(p => p[0])[Symbol.iterator](); }
  values() { return this.#list.map(p => p[1])[Symbol.iterator](); }
  entries() { return this.#list.map(p => [p[0], p[1]])[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
  toString() { return this.#list.map(p => formEncode(p[0]) + '=' + formEncode(p[1])).join('&'); }
}
function parseURL(input, base) {
  const json = host.parseURL(String(input), base === undefined ? undefined : String(base));
  return json === undefined ? null : parseJSON(json);
}
class URL {
  #p; #params = null;
  constructor(url, base) {
    const p = parseURL(url instanceof URL ? url.href : url, base === undefined ? undefined : base instanceof URL ? base.href : base);
    if (!p) throw new TypeError('Invalid URL: ' + url);
    this.#p = p;
  }
  static canParse(url, base) { try { return parseURL(url, base) !== null; } catch { return false; } }
  static parse(url, base) { try { return new URL(url, base); } catch { return null; } }
  #update(changes) {
    const p = { ...this.#p, ...changes };
    const auth = p.username || p.password ? p.username + (p.password ? ':' + p.password : '') + '@' : '';
    const next = parseURL(p.protocol + (p.hasAuthority ? '//' + auth + p.host : '') + p.pathname + p.search + p.hash);
    if (next) this.#p = next; // invalid updates are ignored, as in browsers
    if (this.#params) this.#params[RESET](this.#p.search);
  }
  get href() { return this.#p.href; }
  set href(v) {
    const p = parseURL(v);
    if (!p) throw new TypeError('Invalid URL: ' + v);
    this.#p = p;
    if (this.#params) this.#params[RESET](p.search);
  }
  get origin() { return this.#p.origin; }
  get protocol() { return this.#p.protocol; }
  set protocol(v) { v = String(v).split(':')[0]; if (v) this.#update({ protocol: v + ':' }); }
  get username() { return this.#p.username; }
  set username(v) { this.#update({ username: encodeURIComponent(String(v)) }); }
  get password() { return this.#p.password; }
  set password(v) { this.#update({ password: encodeURIComponent(String(v)) }); }
  get host() { return this.#p.host; }
  set host(v) { this.#update({ host: String(v) }); }
  get hostname() { return this.#p.hostname; }
  set hostname(v) { this.#update({ host: String(v) + (this.#p.port ? ':' + this.#p.port : '') }); }
  get port() { return this.#p.port; }
  set port(v) { v = String(v); this.#update({ host: this.#p.hostname + (v ? ':' + v : '') }); }
  get pathname() { return this.#p.pathname; }
  set pathname(v) { v = String(v); this.#update({ pathname: v.startsWith('/') || !this.#p.hasAuthority ? v : '/' + v }); }
  get search() { return this.#p.search; }
  set search(v) { v = String(v); this.#update({ search: v === '' || v === '?' ? '' : v.startsWith('?') ? v : '?' + v }); }
  get hash() { return this.#p.hash; }
  set hash(v) { v = String(v); this.#update({ hash: v === '' || v === '#' ? '' : v.startsWith('#') ? v : '#' + v }); }
  get searchParams() {
    if (!this.#params) {
      this.#params = new URLSearchParams(this.#p.search);
      defineProperty(this.#params, LINK, { value: (q) => this.#update({ search: q ? '?' + q : '' }) });
    }
    return this.#params;
  }
  toString() { return this.#p.href; }
  toJSON() { return this.#p.href; }
}
hide(G, 'URLSearchParams', URLSearchParams);
hide(G, 'URL', URL);

// ---------- AbortController / AbortSignal ----------
const ABORT = Symbol('abort'), CONSTRUCT = Symbol('construct');
class AbortSignal {
  #aborted = false; #reason = undefined; #listeners = [];
  onabort = null;
  constructor(key) { if (key !== CONSTRUCT) throw new TypeError('Illegal constructor'); }
  get aborted() { return this.#aborted; }
  get reason() { return this.#reason; }
  throwIfAborted() { if (this.#aborted) throw this.#reason; }
  addEventListener(type, fn, options) { if (type === 'abort' && typeof fn === 'function') this.#listeners.push({ fn, once: !!(options && options.once) }); }
  removeEventListener(type, fn) { this.#listeners = this.#listeners.filter(l => l.fn !== fn); }
  [ABORT](reason) {
    if (this.#aborted) return;
    this.#aborted = true;
    this.#reason = reason === undefined ? new DOMException('This operation was aborted', 'AbortError') : reason;
    const event = { type: 'abort', target: this };
    const listeners = this.#listeners;
    this.#listeners = listeners.filter(l => !l.once);
    if (typeof this.onabort === 'function') { try { this.onabort(event); } catch (e) { logUncaught(e); } }
    for (const l of listeners) { try { l.fn.call(this, event); } catch (e) { logUncaught(e); } }
  }
  static abort(reason) { const s = new AbortSignal(CONSTRUCT); s[ABORT](reason); return s; }
  static timeout(ms) {
    const s = new AbortSignal(CONSTRUCT);
    setTimeout(() => s[ABORT](new DOMException('The operation timed out.', 'TimeoutError')), ms);
    return s;
  }
  static any(signals) {
    const s = new AbortSignal(CONSTRUCT);
    for (const x of signals) {
      if (x.aborted) { s[ABORT](x.reason); break; }
      x.addEventListener('abort', () => s[ABORT](x.reason), { once: true });
    }
    return s;
  }
}
class AbortController {
  #signal = new AbortSignal(CONSTRUCT);
  get signal() { return this.#signal; }
  abort(reason) { this.#signal[ABORT](reason); }
}
hide(G, 'AbortSignal', AbortSignal);
hide(G, 'AbortController', AbortController);

// ---------- Headers / Response / fetch ----------
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;
class Headers {
  #map = new Map();
  constructor(init) {
    if (init === undefined || init === null) return;
    if (typeof init !== 'object') throw new TypeError('Headers must be an object, an array of pairs or a Headers instance');
    if (typeof init[Symbol.iterator] === 'function') {
      for (const pair of init) {
        const p = [...pair];
        if (p.length !== 2) throw new TypeError('Each header must be a [name, value] pair');
        this.append(p[0], p[1]);
      }
    } else for (const k of objectKeys(init)) this.append(k, init[k]);
  }
  #name(n) {
    n = String(n).toLowerCase();
    if (!HEADER_NAME.test(n)) throw new TypeError('Invalid header name: ' + n);
    return n;
  }
  #value(v) {
    v = String(v).trim();
    if (/[\r\n\0]/.test(v)) throw new TypeError('Invalid header value');
    return v;
  }
  append(n, v) { n = this.#name(n); v = this.#value(v); const cur = this.#map.get(n); this.#map.set(n, cur === undefined ? v : cur + ', ' + v); }
  set(n, v) { this.#map.set(this.#name(n), this.#value(v)); }
  get(n) { const v = this.#map.get(String(n).toLowerCase()); return v === undefined ? null : v; }
  has(n) { return this.#map.has(String(n).toLowerCase()); }
  delete(n) { this.#map.delete(String(n).toLowerCase()); }
  forEach(cb, thisArg) { for (const [k, v] of this.entries()) cb.call(thisArg, v, k, this); }
  entries() { return [...this.#map].sort((a, b) => a[0] < b[0] ? -1 : 1)[Symbol.iterator](); }
  keys() { return [...this.entries()].map(p => p[0])[Symbol.iterator](); }
  values() { return [...this.entries()].map(p => p[1])[Symbol.iterator](); }
  [Symbol.iterator]() { return this.entries(); }
  getSetCookie() { const v = this.get('set-cookie'); return v === null ? [] : [v]; }
}
function bodyBytes(body, headers) {
  const contentType = (t) => { if (!headers.has('content-type')) headers.set('content-type', t); };
  if (typeof body === 'string') { contentType('text/plain;charset=UTF-8'); return host.utf8Encode(body.toWellFormed()); }
  if (body instanceof URLSearchParams) { contentType('application/x-www-form-urlencoded;charset=UTF-8'); return host.utf8Encode(body.toString()); }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return toU8(body).slice();
  if (typeof body === 'object') {
    const s = stringify(body);
    if (s === undefined) throw new TypeError('Request body is not JSON-serializable');
    contentType('application/json');
    return host.utf8Encode(s);
  }
  return host.utf8Encode(String(body));
}
const FROM_HOST = Symbol('fromHost');
class Response {
  #status; #statusText; #headers; #url = ''; #redirected = false; #bytes;
  constructor(body = null, init = {}) {
    this.#status = init.status === undefined ? 200 : init.status | 0;
    if (this.#status < 200 || this.#status > 599) throw new RangeError('Response status must be between 200 and 599');
    this.#statusText = init.statusText === undefined ? '' : String(init.statusText);
    this.#headers = new Headers(init.headers);
    this.#bytes = body === null || body === undefined ? new Uint8Array(0) : bodyBytes(body, this.#headers);
  }
  static [FROM_HOST](r) {
    const res = new Response(null, { headers: r.headers });
    res.#status = r.status; res.#statusText = r.statusText; res.#url = r.url; res.#redirected = !!r.redirected; res.#bytes = r.body;
    return res;
  }
  static json(data, init = {}) {
    const headers = new Headers(init.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new Response(stringify(data), { ...init, headers });
  }
  get status() { return this.#status; }
  get ok() { return this.#status >= 200 && this.#status < 300; }
  get statusText() { return this.#statusText; }
  get headers() { return this.#headers; }
  get url() { return this.#url; }
  get redirected() { return this.#redirected; }
  get type() { return 'basic'; }
  get bodyUsed() { return false; }
  async text() { return host.utf8Decode(this.#bytes, false, false); }
  async json() { return parseJSON(host.utf8Decode(this.#bytes, false, false)); }
  async arrayBuffer() { return this.#bytes.slice().buffer; }
  async bytes() { return this.#bytes.slice(); }
  async blob() { throw new TypeError('Blob is not supported here; use arrayBuffer() or bytes()'); }
  async formData() { throw new TypeError('FormData is not supported here'); }
  clone() {
    return Response[FROM_HOST]({ status: this.#status, statusText: this.#statusText, headers: [...this.#headers],
                                 url: this.#url, redirected: this.#redirected, body: this.#bytes.slice() });
  }
}
async function fetch(input, init) {
  init = init === undefined || init === null ? {} : init;
  let url;
  if (input instanceof URL) url = input.href;
  else if (input !== null && typeof input === 'object' && 'url' in input) {
    url = String(input.url);
    init = { method: input.method, headers: input.headers, body: input.body, ...init };
  } else url = String(input);
  const method = init.method === undefined ? 'GET' : String(init.method).toUpperCase();
  const headers = new Headers(init.headers);
  let body;
  if (init.body !== undefined && init.body !== null) {
    if (method === 'GET' || method === 'HEAD') throw new TypeError('Request with ' + method + ' method cannot have a body.');
    body = bodyBytes(init.body, headers);
  }
  const signal = init.signal;
  if (signal && signal.aborted) throw signal.reason;
  const request = host.fetch(stringify({ url, method, headers: [...headers] }), body);
  if (!signal) return Response[FROM_HOST](await request);
  return await new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    request.then(r => { signal.removeEventListener('abort', onAbort); resolve(Response[FROM_HOST](r)); },
                 e => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}
hide(G, 'Headers', Headers);
hide(G, 'Response', Response);
hide(G, 'fetch', fetch);

// ---------- fs / kv ----------
const MAX_FILE = 10 * 1024 * 1024;
const maxBytes = (opts) => {
  const n = opts && opts.maxBytes !== undefined ? Math.floor(+opts.maxBytes) : MAX_FILE;
  return n > 0 ? Math.min(n, MAX_FILE) : MAX_FILE;
};
hide(G, 'fs', freeze({
  list() { return host.fsList(); },
  async readText(path, opts) { return host.fsRead(String(path), maxBytes(opts), true); },
  async readBytes(path, opts) { return host.fsRead(String(path), maxBytes(opts), false); },
}));
hide(G, 'kv', freeze({
  get(key) { const s = host.kvGet(String(key)); return s === undefined ? undefined : parseJSON(s); },
  set(key, value) {
    if (value === undefined) { host.kvDelete(String(key)); return; }
    const s = stringify(value);
    if (s === undefined) throw new TypeError('kv values must be JSON-serializable');
    host.kvSet(String(key), s);
  },
  delete(key) { return host.kvDelete(String(key)); },
  keys() { return parseJSON(host.kvKeys()); },
}));

// ---------- tools.* (code mode) ----------
function installTools(json) {
  const tools = {};
  for (const name of parseJSON(json)) {
    const call = { [name]: async (args) => host.callTool(name, stringify(args === undefined || args === null ? {} : args)) }[name];
    // `__proto__` would invoke the prototype setter instead of installing
    // the tool (and a hostile `mcp__...` name could swap a namespace's
    // prototype), so it is dropped; namespaced `__proto__` parts only skip
    // the namespace alias and keep their direct key.
    if (name !== '__proto__') tools[name] = call;
    const m = /^mcp__(.+?)__(.+)$/.exec(name);
    if (m && m[1] !== '__proto__' && m[2] !== '__proto__') {
      if (tools[m[1]] === undefined) tools[m[1]] = {};
      if (typeof tools[m[1]] === 'object') tools[m[1]][m[2]] = call;
    }
  }
  for (const k of objectKeys(tools)) if (typeof tools[k] === 'object') freeze(tools[k]);
  hide(G, 'tools', freeze(tools));
}

// ---------- results & errors for the host ----------
const STRING_CAP = 4096;
let stringsCut = false;
function plain(v, depth, seen, top) {
  switch (typeof v) {
    case 'string':
      if (top || v.length <= STRING_CAP) return v;
      stringsCut = true;
      return v.slice(0, STRING_CAP) + '…[truncated ' + (v.length - STRING_CAP) + ' chars]';
    case 'number': return Number.isFinite(v) ? v : String(v);
    case 'bigint': return v.toString();
    case 'boolean': return v;
    case 'undefined': return undefined;
    case 'symbol': return v.toString();
    case 'function': return fnLabel(v);
  }
  if (v === null) return null;
  if (seen.has(v)) return '[Circular]';
  if (depth > 32) return '[Object]';
  if (v instanceof Error) {
    const o = { name: String(v.name), message: String(v.message) };
    if (typeof v.stack === 'string' && v.stack) o.stack = plain(v.stack, depth + 1, seen, false);
    return o;
  }
  if (typeof v.toJSON === 'function') {
    try { return plain(v.toJSON(), depth + 1, seen, false); } catch { return '[Unserializable]'; }
  }
  if (v instanceof RegExp) return String(v);
  if (v instanceof Promise) return '[Promise]';
  seen.add(v);
  try {
    const items = (arr) => {
      const n = Math.min(arr.length, 10000), out = new Array(n);
      for (let i = 0; i < n; i++) { const p = plain(arr[i], depth + 1, seen, false); out[i] = p === undefined ? null : p; }
      if (arr.length > n) { out.push('…[' + (arr.length - n) + ' more items]'); stringsCut = true; }
      return out;
    };
    if (isArray(v)) return items(v);
    if (v instanceof DataView) return { byteLength: v.byteLength };
    if (ArrayBuffer.isView(v)) return items(Array.from(v.length > 10001 ? v.subarray(0, 10001) : v, x => Number(x)));
    if (v instanceof ArrayBuffer) return { byteLength: v.byteLength };
    if (v instanceof Set) return items([...v]);
    if (v instanceof Map) {
      const entries = [...v];
      if (entries.every(e => typeof e[0] === 'string')) {
        const out = {};
        for (const [k, x] of entries) { const p = plain(x, depth + 1, seen, false); if (p !== undefined) out[k] = p; }
        return out;
      }
      return items(entries);
    }
    const out = {};
    for (const k of objectKeys(v)) { const p = plain(v[k], depth + 1, seen, false); if (p !== undefined) out[k] = p; }
    return out;
  } finally { seen.delete(v); }
}
// "1"/"0" (nested strings were cut) followed by the JSON text, or
// undefined for an undefined result.
function serialize(v) {
  stringsCut = false;
  const p = plain(v, 0, new Set(), true);
  if (p === undefined) return undefined;
  return (stringsCut ? '1' : '0') + stringify(p);
}
function describeError(e) {
  if (e !== null && typeof e === 'object' && ('message' in e || e instanceof Error)) {
    let name = 'Error', message = '', stack;
    try { name = String(e.name === undefined ? 'Error' : e.name); } catch {}
    try { message = String(e.message === undefined ? '' : e.message); } catch {}
    try { if (typeof e.stack === 'string') stack = e.stack; } catch {}
    return stringify({ name, message, stack });
  }
  return stringify({ name: 'Error', message: typeof e === 'string' ? e : 'Uncaught ' + inspect(e, 0, []) });
}

delete G.__host;
return { fireTimer, serialize, describeError, installTools, logUncaught };
})(globalThis.__host)
"""#
}
