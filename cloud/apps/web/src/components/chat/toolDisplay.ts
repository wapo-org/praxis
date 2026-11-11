import type { ActiveToolStep } from '../../state/types';
import { toolRowCopy } from './toolRowCopy';

/** WP-K shared contract: the API's human copy for a tool row. Optional; absent on older events. */
export interface ToolDisplay {
  title: string;
  detail?: string;
  connectorId?: string;
  connectorName?: string;
  /** A lucide icon name or a connector favicon URL. */
  icon?: string;
}

export interface ToolRowDisplay {
  title: string;
  detail: string;
  connectorName?: string;
  icon?: string;
  /** The machine name (`mcp__firecrawl__firecrawl_search_bbc9571288db`); shown only in the expanded detail. */
  technical?: string;
}

const HASH = /_[0-9a-f]{8,}$/i;
const META = /^mcp_(call|describe|search)_tools?$/;
const KEY_ARGS = ['query', 'q', 'url', 'urls', 'path', 'file_path', 'command', 'cmd', 'name', 'title', 'prompt', 'question', 'objective'];

const words = (s: string) => s.replace(/[_./-]+/g, ' ').replace(/\s+/g, ' ').trim();
const capital = (s: string) => s.replace(/^./, (c) => c.toUpperCase());

/** `mcp__<server>__<tool>_<hash>` → { server, tool } with the hash and the repeated server name dropped. */
export function parseMcpName(name: string): { server: string; tool: string } | null {
  const m = /^mcp__([^_].*?)__(.+)$/.exec(name);
  if (!m) return null;
  const server = m[1]!;
  let tool = m[2]!.replace(HASH, '');
  const s = server.toLowerCase().replace(/[^a-z0-9]/g, '');
  const parts = tool.split(/[_-]+/).filter(Boolean);
  // "firecrawl_search" on the Firecrawl server is "search"; "web_search_exa" on Exa is "web search".
  const kept = parts.filter((p, i) => !(p.toLowerCase() === s && parts.length > 1 && (i === 0 || i === parts.length - 1)));
  tool = kept.join(' ');
  return { server, tool };
}

function serverLabel(server: string, serverName?: string) {
  return serverName?.trim() || capital(words(server));
}

function parseArgs(json: string | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(json || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The one argument that says what the call is about, as plain text. */
export function keyArgument(args: Record<string, unknown>): string {
  for (const k of KEY_ARGS) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && typeof v[0] === 'string') return v.join(', ');
  }
  const first = Object.values(args).find((v) => typeof v === 'string' && v.trim() && v.length < 200);
  return typeof first === 'string' ? first.trim() : '';
}

/** A bare id or hash says nothing to a person: it stays in the detail. */
const plainDetail = (s: string) => (/^[0-9a-f-]{8,}$/i.test(s.trim()) ? '' : s);

function readDisplay(step: ActiveToolStep): ToolDisplay | undefined {
  const d = (step.activity as { display?: unknown }).display;
  if (!d || typeof d !== 'object') return undefined;
  const title = (d as ToolDisplay).title;
  return typeof title === 'string' && title.trim() ? (d as ToolDisplay) : undefined;
}

/** Human title and detail for a tool row: K1's `display` when present, else our own humaniser. */
export function toolDisplay(step: ActiveToolStep): ToolRowDisplay {
  const activity = step.activity as ActiveToolStep['activity'] & { originalName?: string };
  const raw = activity.name;
  const technical = activity.originalName || raw;
  const display = readDisplay(step);
  const args = parseArgs(step.argumentsJson);
  if (display) {
    return {
      title: display.title,
      detail: display.detail ?? '',
      connectorName: display.connectorName,
      icon: display.icon,
      technical: technical !== display.title ? technical : undefined,
    };
  }
  const serverName = activity.source?.serverName;
  // The catalogue meta-tools: name the tool they act on, not themselves.
  const meta = META.exec(raw);
  if (meta) {
    const target = typeof args.tool === 'string' ? args.tool : typeof args.name === 'string' ? args.name : '';
    const inner = target ? parseMcpName(target) : null;
    const innerTitle = inner ? `${serverLabel(inner.server)} · ${inner.tool}` : target ? capital(words(target.replace(HASH, ''))) : '';
    const innerArgs = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? (args.arguments as Record<string, unknown>) : {};
    if (meta[1] === 'call') return { title: innerTitle || 'Connector tool', detail: keyArgument(innerArgs), connectorName: inner ? serverLabel(inner.server) : undefined, technical: target || raw };
    if (meta[1] === 'describe') return { title: innerTitle ? `Look up ${innerTitle}` : 'Look up a tool', detail: '', icon: 'book-open', connectorName: inner ? serverLabel(inner.server) : undefined, technical: target || raw };
    return { title: 'Find tools', detail: keyArgument(args), technical: raw };
  }
  const mcp = parseMcpName(raw);
  if (mcp) {
    const server = serverLabel(mcp.server, serverName);
    return { title: `${server} · ${mcp.tool}`, detail: plainDetail(keyArgument(args)), connectorName: server, technical };
  }
  // `mcp_<server>_<tool>` (one underscore): the server is the first word.
  const single = /^mcp_([a-z0-9]+)_(.+)$/i.exec(raw);
  if (single && !META.test(raw)) {
    const server = serverLabel(single[1]!, serverName);
    return { title: `${server} · ${words(single[2]!.replace(HASH, ''))}`, detail: plainDetail(keyArgument(args)), connectorName: server, technical };
  }
  const { title, summary } = toolRowCopy(step);
  const cleanTitle = title.replace(HASH, '').replace(/\s[0-9a-f]{8,}(?=\s|$)/gi, '');
  return { title: cleanTitle, detail: plainDetail(keyArgument(args) || summary), technical: technical !== cleanTitle ? technical : undefined };
}
