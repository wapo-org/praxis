/*
 * Adapted from T3 Code WorkLog, TimelineWorkEntryRow, TimelineToolActivityIcon,
 * TimelineWorkGroupRows and MessagesTimeline (T3 Tools Inc.).
 * MIT License — Copyright (c) 2026 T3 Tools Inc.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { ActiveToolStep } from '../../state/types';
import { humanLabel, toolDisplay } from './toolDisplay';
import { countStepResults, extractDomain } from './toolSources';
import { computeElapsedMs, formatDuration } from './useActivityClock';

export type WorkIcon = 'read' | 'edit' | 'command' | 'search' | 'web' | 'question' | 'tool';

const TENSE_VERBS: Array<{
  running: RegExp;
  done: RegExp;
  toRunning: string;
  toDone: string;
  toFailed: string;
}> = [
  {
    running: /^Searching the web\b/i,
    done: /^Searched the web\b/i,
    toRunning: 'Searching the web',
    toDone: 'Searched the web',
    toFailed: "Couldn't search the web",
  },
  {
    running: /^Looking up\b/i,
    done: /^(?:Looked|Look) up\b/i,
    toRunning: 'Looking up',
    toDone: 'Looked up',
    toFailed: "Couldn't look up",
  },
  {
    running: /^Searching\b/i,
    done: /^(?:Searched|Search)\b/i,
    toRunning: 'Searching',
    toDone: 'Searched',
    toFailed: "Couldn't search",
  },
  {
    running: /^Reading\b/i,
    done: /^Read\b/i,
    toRunning: 'Reading',
    toDone: 'Read',
    toFailed: "Couldn't read",
  },
  {
    running: /^Running\b/i,
    done: /^(?:Ran|Run)\b/i,
    toRunning: 'Running',
    toDone: 'Ran',
    toFailed: 'Failed to run',
  },
  {
    running: /^Executing\b/i,
    done: /^(?:Executed|Execute)\b/i,
    toRunning: 'Executing',
    toDone: 'Executed',
    toFailed: 'Failed to execute',
  },
  {
    running: /^Fetching\b/i,
    done: /^(?:Fetched|Fetch)\b/i,
    toRunning: 'Fetching',
    toDone: 'Fetched',
    toFailed: "Couldn't fetch",
  },
  {
    running: /^Browsing\b/i,
    done: /^(?:Browsed|Browse)\b/i,
    toRunning: 'Browsing',
    toDone: 'Browsed',
    toFailed: "Couldn't browse",
  },
  {
    running: /^Crawling\b/i,
    done: /^(?:Crawled|Crawl)\b/i,
    toRunning: 'Crawling',
    toDone: 'Crawled',
    toFailed: "Couldn't crawl",
  },
  {
    running: /^Scraping\b/i,
    done: /^(?:Scraped|Scrape)\b/i,
    toRunning: 'Scraping',
    toDone: 'Scraped',
    toFailed: "Couldn't scrape",
  },
  {
    running: /^Editing\b/i,
    done: /^(?:Edited|Edit)\b/i,
    toRunning: 'Editing',
    toDone: 'Edited',
    toFailed: "Couldn't edit",
  },
  {
    running: /^Writing\b/i,
    done: /^(?:Wrote|Write)\b/i,
    toRunning: 'Writing',
    toDone: 'Wrote',
    toFailed: "Couldn't write",
  },
  {
    running: /^Updating\b/i,
    done: /^(?:Updated|Update)\b/i,
    toRunning: 'Updating',
    toDone: 'Updated',
    toFailed: "Couldn't update",
  },
  {
    running: /^Deleting\b/i,
    done: /^(?:Deleted|Delete)\b/i,
    toRunning: 'Deleting',
    toDone: 'Deleted',
    toFailed: "Couldn't delete",
  },
  {
    running: /^Creating\b/i,
    done: /^(?:Created|Create)\b/i,
    toRunning: 'Creating',
    toDone: 'Created',
    toFailed: "Couldn't create",
  },
  {
    running: /^Checking\b/i,
    done: /^(?:Checked|Check)\b/i,
    toRunning: 'Checking',
    toDone: 'Checked',
    toFailed: "Couldn't check",
  },
  {
    running: /^Finding\b/i,
    done: /^(?:Found|Find)\b/i,
    toRunning: 'Finding',
    toDone: 'Found',
    toFailed: "Couldn't find",
  },
  {
    running: /^Asking\b/i,
    done: /^(?:Asked|Ask)\b/i,
    toRunning: 'Asking',
    toDone: 'Asked',
    toFailed: "Couldn't ask",
  },
  {
    running: /^Loading\b/i,
    done: /^(?:Loaded|Load)\b/i,
    toRunning: 'Loading',
    toDone: 'Loaded',
    toFailed: "Couldn't load",
  },
  {
    running: /^Getting\b/i,
    done: /^(?:Got|Get)\b/i,
    toRunning: 'Getting',
    toDone: 'Got',
    toFailed: "Couldn't get",
  },
  {
    running: /^Opening\b/i,
    done: /^(?:Opened|Open)\b/i,
    toRunning: 'Opening',
    toDone: 'Opened',
    toFailed: "Couldn't open",
  },
];

export function formatTraceTitle(
  baseTitle: string,
  state: 'running' | 'done' | 'failed' | 'denied',
): string {
  for (const rule of TENSE_VERBS) {
    if (rule.running.test(baseTitle)) {
      if (state === 'running') return baseTitle;
      if (state === 'failed') return baseTitle.replace(rule.running, rule.toFailed);
      return baseTitle.replace(rule.running, rule.toDone);
    }
    if (rule.done.test(baseTitle)) {
      if (state === 'running') return baseTitle.replace(rule.done, rule.toRunning);
      if (state === 'failed') return baseTitle.replace(rule.done, rule.toFailed);
      if (state === 'done') return baseTitle.replace(rule.done, rule.toDone);
      return baseTitle;
    }
  }
  return baseTitle;
}

export function workEntry(step: ActiveToolStep) {
  const name = step.activity.name.toLowerCase();
  const category = step.activity.presentation?.category;
  const display = toolDisplay(step);
  const known: Partial<Record<string, WorkIcon>> = {
    command: 'command',
    webSearch: 'web',
    webFetch: 'web',
    readFile: 'read',
    edit: 'edit',
  };
  // The human title decides the glyph when the machine name is a hashed connector id.
  const basis = `${name} ${display.title.toLowerCase()}`;
  const icon: WorkIcon =
    known[category ?? ''] ??
    (/read|view|open_file|look_at/.test(name)
      ? 'read'
      : /edit|write|patch/.test(name)
        ? 'edit'
        : /exec|terminal|command|shell/.test(name)
          ? 'command'
          : /search|grep|find/.test(basis)
            ? 'search'
            : /web|browse|fetch|crawl|scrape/.test(basis)
              ? 'web'
              : /elicit|question|ask_user/.test(name)
                ? 'question'
                : 'tool');
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(step.argumentsJson || '{}');
    if (parsed && typeof parsed === 'object') args = parsed;
  } catch {
    /* Incomplete arguments are still expandable below. */
  }
  const first = (keys: string[]) =>
    keys.map((k) => args[k]).find((v) => typeof v === 'string') as string | undefined;
  const command = icon === 'command' ? first(['command', 'cmd', 'script']) : undefined;
  const path =
    icon === 'read' || icon === 'edit'
      ? first(['path', 'file_path', 'filename', 'file'])
      : undefined;
  const question = icon === 'question' ? first(['question', 'message', 'prompt']) : undefined;
  const preview = humanLabel(command ?? path ?? display.detail);
  const status = step.completion?.status;
  const failed = status === 'failed';
  const warning = status === 'denied';
  const contentText =
    Array.isArray(step.completion?.content) && step.completion.content.length
      ? JSON.stringify(step.completion.content)
      : '';
  const rawPreview = step.completion?.preview || '';
  const output =
    rawPreview ||
    contentText ||
    step.completion?.summary ||
    '';
  let answer = output;
  if (icon === 'question') {
    try {
      const value = JSON.parse(output);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const fields = Object.entries(value).filter(([, v]) =>
          ['string', 'number', 'boolean'].includes(typeof v),
        );
        if (fields.length) answer = fields.map(([k, v]) => `${k}: ${v}`).join('; ');
      }
    } catch {
      /* Plain answer text needs no transformation. */
    }
  }
  const input = step.argumentsJson && step.argumentsJson !== '{}' ? step.argumentsJson : '';
  const progress = step.progressLines.join('\n');
  const blocks = [input ? `Tool input\n${input}` : '', progress, output].filter(Boolean);

  const rowState: 'running' | 'done' | 'failed' | 'denied' = failed
    ? 'failed'
    : warning
      ? 'denied'
      : step.running
        ? 'running'
        : 'done';
  const baseTitle = question ? (step.running ? 'Asking' : 'Asked') : display.title;
  const title = formatTraceTitle(baseTitle, rowState);
  const normalizedPreview = humanLabel(question ?? preview);
  const quoted = !!question || !!args.title || /^(Searching|Searched|Couldn't search)( the web)?$/i.test(title);
  const connector =
    /^(Searching|Searched|Couldn't search)( the web)?$/i.test(title) && normalizedPreview
      ? ' for '
      : ' ';

  const descParts: string[] = [];
  const count = countStepResults(step);
  if (count !== undefined) {
    descParts.push(`${count} ${count === 1 ? 'result' : 'results'}`);
  } else {
    const rawUrl = first(['url']);
    const domain = rawUrl ? extractDomain(rawUrl) : '';
    if (domain && !title.toLowerCase().includes(domain.toLowerCase()) && !normalizedPreview.includes(domain)) {
      descParts.push(domain);
    }
  }
  if (!step.running) {
    const ms = computeElapsedMs(step.startedAt, step.finishedAt);
    if (ms !== null) {
      descParts.push(formatDuration(ms));
    }
  }

  return {
    icon,
    title,
    connector,
    preview: normalizedPreview,
    mono: !!(command || path),
    quoted,
    answer: icon === 'question' ? answer : '',
    failed,
    warning,
    description: descParts.join(' · '),
    connectorName: display.connectorName,
    displayIcon: display.icon,
    technical: display.technical,
    input,
    progress,
    output: output === progress ? '' : output,
    body: [...new Set(blocks)].join('\n\n'),
  };
}
