import type { ActiveToolStep } from '../../state/types';
import { safeLink } from '../../lib/links';
import { deepParse, parseLoose } from './JsonView';

export interface TraceSource {
  url: string;
  title: string;
  domain: string;
}

export function extractDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function addSource(
  map: Map<string, TraceSource>,
  rawUrl: unknown,
  rawTitle?: unknown,
) {
  if (typeof rawUrl !== 'string') return;
  const safe = safeLink(rawUrl);
  if (!safe || (!safe.startsWith('http://') && !safe.startsWith('https://'))) return;
  const domain = extractDomain(safe);
  const title =
    typeof rawTitle === 'string' && rawTitle.trim()
      ? rawTitle.trim()
      : domain || safe;
  const existing = map.get(safe);
  if (!existing) {
    map.set(safe, { url: safe, title, domain });
  } else if (existing.title === existing.domain && title !== domain) {
    existing.title = title;
  }
}

function collectFromExaText(text: string, map: Map<string, TraceSource>) {
  let pendingTitle: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^---+$/.test(line)) {
      pendingTitle = undefined;
      continue;
    }
    const titleMatch = /^Title:\s*(.+)$/i.exec(line);
    if (titleMatch) {
      pendingTitle = titleMatch[1]?.trim();
      continue;
    }
    const urlMatch = /^URL:\s*(\S+)/i.exec(line);
    if (urlMatch) {
      addSource(map, urlMatch[1], pendingTitle);
      pendingTitle = undefined;
    }
  }
}

function collectFromValue(
  value: unknown,
  map: Map<string, TraceSource>,
  depth = 0,
) {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    const parsed = parseLoose(value);
    if (parsed.kind === 'json') {
      collectFromValue(parsed.value, map, depth + 1);
    } else {
      collectFromExaText(parsed.text, map);
    }
    return;
  }
  if (typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const rec = item as Record<string, unknown>;
        if (typeof rec.url === 'string') {
          addSource(map, rec.url, rec.title ?? rec.name);
        }
      }
      collectFromValue(item, map, depth + 1);
    }
    return;
  }
  const obj = value as Record<string, unknown>;
  const keys = ['web', 'results', 'sources', 'items', 'links', 'pages', 'citations', 'data', 'text', 'content'];
  for (const key of keys) {
    if (key in obj) {
      collectFromValue(obj[key], map, depth + 1);
    }
  }
  if (typeof obj.url === 'string' && ('title' in obj || 'excerpt' in obj || 'description' in obj)) {
    addSource(map, obj.url, obj.title ?? obj.name);
  }
}

function stepCandidatePayloads(step: ActiveToolStep): unknown[] {
  const payloads: unknown[] = [];
  if (Array.isArray(step.completion?.content)) {
    for (const part of step.completion.content) {
      if (part && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string') {
        payloads.push(deepParse((part as { text: string }).text));
      } else {
        payloads.push(deepParse(part));
      }
    }
  }
  if (step.completion?.preview) {
    const parsed = parseLoose(step.completion.preview);
    payloads.push(parsed.kind === 'json' ? deepParse(parsed.value) : parsed.text);
  }
  if (step.completion?.summary && !payloads.length) {
    payloads.push(step.completion.summary);
  }
  return payloads;
}

export function extractToolSources(steps: ActiveToolStep[]): TraceSource[] {
  const map = new Map<string, TraceSource>();

  for (const step of steps) {
    if (step.completion?.status === 'failed' || step.completion?.status === 'denied') {
      continue;
    }

    for (const payload of stepCandidatePayloads(step)) {
      collectFromValue(payload, map);
    }

    if (step.completion && step.completion.status === 'succeeded') {
      try {
        const args = JSON.parse(step.argumentsJson || '{}') as Record<string, unknown>;
        if (typeof args.url === 'string') {
          addSource(map, args.url);
        }
        if (Array.isArray(args.urls)) {
          for (const u of args.urls) {
            if (typeof u === 'string') addSource(map, u);
          }
        }
      } catch {
        // Ignore partial/malformed argument JSON.
      }
    }
  }

  return Array.from(map.values());
}

function countInValue(value: unknown, depth = 0): number | undefined {
  if (depth > 6 || value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const parsed = parseLoose(value);
    if (parsed.kind === 'json') return countInValue(parsed.value, depth + 1);
    const exaMatches = parsed.text.match(/^URL:\s*https?:\/\//gim);
    return exaMatches && exaMatches.length > 0 ? exaMatches.length : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const c = countInValue(item, depth + 1);
      if (c !== undefined) return c;
    }
    return undefined;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const data = obj.data && typeof obj.data === 'object' ? (obj.data as Record<string, unknown>) : undefined;
    for (const candidate of [data?.web, obj.web, obj.results, obj.sources, obj.items, obj.files, obj.matches]) {
      if (Array.isArray(candidate) && candidate.length > 0) {
        return candidate.length;
      }
    }
    if (typeof obj.text === 'string') {
      return countInValue(obj.text, depth + 1);
    }
  }
  return undefined;
}

/** Counts structured results returned by a tool step (for TraceDescription). */
export function countStepResults(step: ActiveToolStep): number | undefined {
  if (step.running || step.completion?.status === 'failed' || step.completion?.status === 'denied') {
    return undefined;
  }
  for (const payload of stepCandidatePayloads(step)) {
    const count = countInValue(payload);
    if (count !== undefined) return count;
  }
  return undefined;
}
