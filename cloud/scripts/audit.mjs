#!/usr/bin/env node
// Production dependency audit with an expiring, reasoned allowlist; unlisted high/critical advisories fail CI.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ALLOWLIST_PATH = fileURLToPath(new URL('./audit-allowlist.json', import.meta.url));
const FAILING_SEVERITIES = new Set(['high', 'critical']);
const GHSA_PATTERN = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/;

function runAudit() {
  try {
    return parseAuditOutput(execFileSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  } catch (error) {
    // npm audit exits non-zero when it finds anything; the JSON report is still on stdout.
    if (typeof error.stdout === 'string' && error.stdout.length > 0) return parseAuditOutput(error.stdout);
    throw error;
  }
}

function parseAuditOutput(output) {
  const report = JSON.parse(output);
  if (!report || typeof report !== 'object' || !report.vulnerabilities || typeof report.vulnerabilities !== 'object' || report.error) {
    throw new Error('npm audit returned an invalid report');
  }
  return report;
}

function advisories(report) {
  const found = new Map();
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via) {
      if (typeof via === 'string' || !FAILING_SEVERITIES.has(via.severity)) continue;
      const id = GHSA_PATTERN.exec(via.url ?? '')?.[0] ?? String(via.source);
      found.set(id, { id, name: via.name, severity: via.severity, title: via.title });
    }
  }
  return [...found.values()];
}

const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
const today = new Date().toISOString().slice(0, 10);
const problems = [];
for (const entry of allowlist) {
  if (!entry.id || !entry.reason || !entry.expires) problems.push(`allowlist entry needs id, reason and expires: ${JSON.stringify(entry)}`);
  else if (entry.expires < today) problems.push(`allowlist entry ${entry.id} expired on ${entry.expires}; fix the dependency or renew with a reason`);
}

const allowed = new Map(allowlist.map((entry) => [entry.id, entry]));
for (const advisory of advisories(runAudit())) {
  const entry = allowed.get(advisory.id);
  if (entry) console.log(`allowed ${advisory.severity} ${advisory.id} (${advisory.name}): ${entry.reason} [expires ${entry.expires}]`);
  else problems.push(`${advisory.severity} ${advisory.id} in ${advisory.name}: ${advisory.title}`);
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('audit: no unlisted high or critical production advisories');
