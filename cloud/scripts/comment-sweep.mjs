#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("../node_modules/typescript");

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const CODE_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".swift", ".css"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".build", "dist", "build", "DerivedData", ".turbo", ".next", "PraxisAgent"]);

const DIRECTIVE_RE =
  /@ts-(?:ignore|expect-error|nocheck|check)|eslint-(?:disable|enable)|prettier-ignore|biome-ignore|oxlint-ignore|(?:v8|c8|istanbul)\s+ignore|\/\*\s*(?:global|exported)|\/\/\/\s*<reference|@vitest-environment|swiftlint:|swift-format-ignore|webpackChunkName|@vite-ignore|SPDX-License-Identifier|Copyright\s+(?:\(c\)|©|\d{4})/i;
const MARK_RE = /^\/\/\s*MARK:/;

function parseArgs(argv) {
  const cmd = argv[2];
  const flags = {};
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) flags[k] = true;
      else {
        flags[k] = next;
        i++;
      }
    }
  }
  return { cmd, flags };
}

function walkFiles(roots) {
  const out = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (CODE_EXTS.has(path.extname(ent.name))) {
        out.push(full);
      }
    }
  }
  for (const r of roots) walk(path.resolve(REPO_ROOT, r));
  return out.sort();
}

function resolveRoots(scope) {
  if (!scope || scope === "all") return ["cloud", "PraxisChat"];
  if (scope === "cloud") return ["cloud"];
  if (scope === "ios") return ["PraxisChat"];
  return scope.split(",").map((s) => s.trim()).filter(Boolean);
}

function computeLineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function offsetToLineCol(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid] <= offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return { line: hi + 1, col: offset - lineStarts[hi] };
}

function getLineBounds(src, lineStarts, lineNum1) {
  const start = lineStarts[lineNum1 - 1];
  const nextStart = lineNum1 < lineStarts.length ? lineStarts[lineNum1] : src.length;
  const endNoNl = nextStart > start && src[nextStart - 1] === "\n" ? nextStart - 1 : nextStart;
  return { start, endNoNl, nextStart };
}

function extractTsTokens(filePath, src) {
  const ext = path.extname(filePath);
  const isJsx = ext === ".tsx" || ext === ".jsx";
  const scriptKind =
    ext === ".tsx"
      ? ts.ScriptKind.TSX
      : ext === ".jsx"
        ? ts.ScriptKind.JSX
        : ext === ".js" || ext === ".mjs" || ext === ".cjs"
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;

  const sf = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true, scriptKind);
  const jsxEmptySpans = [];
  if (isJsx) {
    function visit(node) {
      if (ts.isJsxExpression(node) && !node.expression) {
        jsxEmptySpans.push({ start: node.getStart(sf), end: node.getEnd() });
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
  }

  const rawComments = [];
  const seen = new Set();

  function addRange(r) {
    if (seen.has(r.pos)) return;
    seen.add(r.pos);
    const slice = src.slice(r.pos, r.end);
    if (!slice.startsWith("//") && !slice.startsWith("/*")) return;
    rawComments.push({
      start: r.pos,
      end: r.end,
      kind: r.kind === ts.SyntaxKind.SingleLineCommentTrivia ? "line" : "block",
    });
  }

  function walkAst(node) {
    const leading = ts.getLeadingCommentRanges(src, node.pos);
    if (leading) leading.forEach(addRange);
    const trailing = ts.getTrailingCommentRanges(src, node.end);
    if (trailing) trailing.forEach(addRange);
    ts.forEachChild(node, walkAst);
  }
  walkAst(sf);
  const eofLeading = ts.getLeadingCommentRanges(src, sf.endOfFileToken.pos);
  if (eofLeading) eofLeading.forEach(addRange);

  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    isJsx ? ts.LanguageVariant.TSX : ts.LanguageVariant.Standard,
    src
  );
  // Only trust scanner tokens inside empty container spans to avoid regex ambiguity.
  const emptyContainers = [];
  function findEmptyContainers(node) {
    if (
      (ts.isBlock(node) && node.statements.length === 0) ||
      (ts.isObjectLiteralExpression(node) && node.properties.length === 0) ||
      (ts.isArrayLiteralExpression(node) && node.elements.length === 0) ||
      (ts.isCaseClause(node) && node.statements.length === 0) ||
      (ts.isDefaultClause(node) && node.statements.length === 0) ||
      (ts.isJsxExpression(node) && !node.expression)
    ) {
      emptyContainers.push({ start: node.getStart(sf), end: node.getEnd() });
    }
    ts.forEachChild(node, findEmptyContainers);
  }
  findEmptyContainers(sf);

  if (emptyContainers.length > 0) {
    for (const c of emptyContainers) {
      const sub = src.slice(c.start, c.end);
      const subScanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, sub);
      let tok = subScanner.scan();
      while (tok !== ts.SyntaxKind.EndOfFileToken) {
        if (tok === ts.SyntaxKind.SingleLineCommentTrivia || tok === ts.SyntaxKind.MultiLineCommentTrivia) {
          addRange({
            pos: c.start + subScanner.getTokenPos(),
            end: c.start + subScanner.getTextPos(),
            kind: tok === ts.SyntaxKind.SingleLineCommentTrivia ? ts.SyntaxKind.SingleLineCommentTrivia : ts.SyntaxKind.MultiLineCommentTrivia,
          });
        }
        tok = subScanner.scan();
      }
    }
  }
  void scanner;

  rawComments.sort((a, b) => a.start - b.start);

  for (const c of rawComments) {
    if (c.kind !== "block") continue;
    for (const jx of jsxEmptySpans) {
      if (c.start > jx.start && c.end < jx.end) {
        const betweenOpen = src.slice(jx.start + 1, c.start).trim();
        const betweenClose = src.slice(c.end, jx.end - 1).trim();
        if (betweenOpen === "" && betweenClose === "") {
          c.start = jx.start;
          c.end = jx.end;
          c.kind = "jsx";
        }
      }
    }
  }

  return rawComments;
}

function extractCssTokens(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      const q = ch;
      i++;
      while (i < n) {
        if (src[i] === "\\") i += 2;
        else if (src[i] === q) {
          i++;
          break;
        } else i++;
      }
    } else if (ch === "/" && src[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i = Math.min(n, i + 2);
      out.push({ start, end: i, kind: "block" });
    } else {
      i++;
    }
  }
  return out;
}

function extractSwiftTokens(src) {
  const out = [];
  const n = src.length;
  let i = 0;

  function skipSwiftString(hashes, multiline) {
    while (i < n) {
      if (src[i] === "\\") {
        let h = 0;
        while (h < hashes && src[i + 1 + h] === "#") h++;
        if (h === hashes) {
          const next = src[i + 1 + h];
          if (next === "(") {
            i += 2 + h;
            let depth = 1;
            while (i < n && depth > 0) {
              const c = src[i];
              if (c === "/" && src[i + 1] === "/") {
                const start = i;
                while (i < n && src[i] !== "\n") i++;
                out.push({ start, end: i, kind: "line" });
              } else if (c === "/" && src[i + 1] === "*") {
                const start = i;
                i += 2;
                let nested = 1;
                while (i < n && nested > 0) {
                  if (src[i] === "/" && src[i + 1] === "*") {
                    nested++;
                    i += 2;
                  } else if (src[i] === "*" && src[i + 1] === "/") {
                    nested--;
                    i += 2;
                  } else i++;
                }
                out.push({ start, end: i, kind: "block" });
              } else if (c === '"') {
                if (src.startsWith('"""', i)) {
                  i += 3;
                  skipSwiftString(0, true);
                } else {
                  i += 1;
                  skipSwiftString(0, false);
                }
              } else if (c === "#" && tryOpenRawString()) {
              } else if (c === "(") {
                depth++;
                i++;
              } else if (c === ")") {
                depth--;
                i++;
              } else {
                i++;
              }
            }
            continue;
          } else {
            i += 2 + h;
            continue;
          }
        }
        i++;
        continue;
      }

      if (multiline) {
        if (src.startsWith('"""', i)) {
          let h = 0;
          while (h < hashes && src[i + 3 + h] === "#") h++;
          if (h === hashes) {
            i += 3 + hashes;
            return;
          }
        }
      } else {
        if (src[i] === '"') {
          let h = 0;
          while (h < hashes && src[i + 1 + h] === "#") h++;
          if (h === hashes) {
            i += 1 + hashes;
            return;
          }
        }
      }
      i++;
    }
  }

  function tryOpenRawString() {
    let j = i;
    while (j < n && src[j] === "#") j++;
    const hashes = j - i;
    if (hashes === 0 || src[j] !== '"') return false;
    if (src.startsWith('"""', j)) {
      i = j + 3;
      skipSwiftString(hashes, true);
    } else {
      i = j + 1;
      skipSwiftString(hashes, false);
    }
    return true;
  }

  while (i < n) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      const start = i;
      while (i < n && src[i] !== "\n") i++;
      out.push({ start, end: i, kind: "line" });
    } else if (ch === "/" && src[i + 1] === "*") {
      const start = i;
      i += 2;
      let depth = 1;
      while (i < n && depth > 0) {
        if (src[i] === "/" && src[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (src[i] === "*" && src[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      out.push({ start, end: i, kind: "block" });
    } else if (ch === '"') {
      if (src.startsWith('"""', i)) {
        i += 3;
        skipSwiftString(0, true);
      } else {
        i += 1;
        skipSwiftString(0, false);
      }
    } else if (ch === "#") {
      if (!tryOpenRawString()) i++;
    } else {
      i++;
    }
  }
  return out;
}

function classifyStyle(raw, kind, ext) {
  if (kind === "jsx") return "jsx";
  if (kind === "block") {
    return raw.startsWith("/**") && !raw.startsWith("/***") ? "jsdoc" : "block";
  }
  if (ext === ".swift" && raw.startsWith("///")) return "swiftdoc";
  return "line";
}

function isWholeLineComment(src, lineStarts, token) {
  const { line } = offsetToLineCol(lineStarts, token.start);
  const { start: lineStart, endNoNl: lineEnd } = getLineBounds(src, lineStarts, line);
  const { line: endLine } = offsetToLineCol(lineStarts, Math.max(token.start, token.end - 1));
  if (endLine !== line) return false;
  const before = src.slice(lineStart, token.start);
  const after = src.slice(token.end, lineEnd);
  return before.trim() === "" && after.trim() === "";
}

function groupTokens(filePath, src) {
  const ext = path.extname(filePath);
  const lineStarts = computeLineStarts(src);
  const tokens =
    ext === ".swift"
      ? extractSwiftTokens(src)
      : ext === ".css"
        ? extractCssTokens(src)
        : extractTsTokens(filePath, src);

  const entries = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const raw = src.slice(t.start, t.end);
    const style = classifyStyle(raw, t.kind, ext);
    const wholeLine =
      t.kind === "line" ? isWholeLineComment(src, lineStarts, t) : isWholeBlockLine(src, lineStarts, t);

    if ((style === "line" || style === "swiftdoc") && wholeLine) {
      const startLoc = offsetToLineCol(lineStarts, t.start);
      const { start: firstLineStart } = getLineBounds(src, lineStarts, startLoc.line);
      const indent = src.slice(firstLineStart, t.start);
      let endToken = t;
      let lastLine = startLoc.line;
      let j = i + 1;
      while (j < tokens.length) {
        const nt = tokens[j];
        const nRaw = src.slice(nt.start, nt.end);
        const nStyle = classifyStyle(nRaw, nt.kind, ext);
        if (nStyle !== style) break;
        const nLoc = offsetToLineCol(lineStarts, nt.start);
        if (nLoc.line !== lastLine + 1) break;
        if (!isWholeLineComment(src, lineStarts, nt)) break;
        const { start: nLineStart } = getLineBounds(src, lineStarts, nLoc.line);
        const nIndent = src.slice(nLineStart, nt.start);
        if (nIndent !== indent) break;
        if (MARK_RE.test(raw.trim()) !== MARK_RE.test(nRaw.trim())) break;
        if (DIRECTIVE_RE.test(raw) !== DIRECTIVE_RE.test(nRaw)) break;
        endToken = nt;
        lastLine = nLoc.line;
        j++;
      }

      const fullOriginal = src.slice(t.start, endToken.end);
      entries.push(buildEntry(filePath, src, lineStarts, t.start, endToken.end, style, true, indent, fullOriginal));
      i = j;
    } else {
      const startLoc = offsetToLineCol(lineStarts, t.start);
      const { start: lineStart } = getLineBounds(src, lineStarts, startLoc.line);
      const indent = wholeLine ? src.slice(lineStart, t.start) : src.slice(lineStart, lineStart + (src.slice(lineStart).match(/^\s*/)?.[0].length || 0));
      entries.push(buildEntry(filePath, src, lineStarts, t.start, t.end, style, wholeLine, indent, raw));
      i++;
    }
  }
  return entries;
}

function isWholeBlockLine(src, lineStarts, token) {
  const startLoc = offsetToLineCol(lineStarts, token.start);
  const endLoc = offsetToLineCol(lineStarts, Math.max(token.start, token.end - 1));
  const { start: sLineStart } = getLineBounds(src, lineStarts, startLoc.line);
  const { endNoNl: eLineEnd } = getLineBounds(src, lineStarts, endLoc.line);
  return src.slice(sLineStart, token.start).trim() === "" && src.slice(token.end, eLineEnd).trim() === "";
}

function cleanText(raw, style) {
  if (style === "line" || style === "swiftdoc") {
    return raw
      .split("\n")
      .map((l) => l.trim().replace(/^\/\/\/?\s?/, ""))
      .join("\n")
      .trim();
  }
  if (style === "jsx") {
    const inner = raw.replace(/^\{\s*\/\*\s?/, "").replace(/\s?\*\/\s*\}$/, "");
    return inner.trim();
  }
  if (style === "jsdoc") {
    return raw
      .replace(/^\/\*\*\s?/, "")
      .replace(/\s?\*\/$/, "")
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, ""))
      .join("\n")
      .trim();
  }
  return raw
    .replace(/^\/\*\s?/, "")
    .replace(/\s?\*\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, ""))
    .join("\n")
    .trim();
}

function buildEntry(filePath, src, lineStarts, start, end, style, wholeLine, indent, original) {
  const relFile = path.relative(REPO_ROOT, filePath);
  const startLoc = offsetToLineCol(lineStarts, start);
  const endLoc = offsetToLineCol(lineStarts, Math.max(start, end - 1));
  const text = cleanText(original, style);
  const category = DIRECTIVE_RE.test(original)
    ? "directive"
    : MARK_RE.test(original.trim())
      ? "mark"
      : "comment";

  const afterLines = [];
  for (let ln = endLoc.line + (wholeLine ? 1 : 0); ln <= Math.min(lineStarts.length, endLoc.line + 2); ln++) {
    const b = getLineBounds(src, lineStarts, ln);
    afterLines.push(src.slice(b.start, b.endNoNl));
  }

  const hash = crypto.createHash("sha1").update(`${relFile}:${start}:${original}`).digest("hex").slice(0, 8);
  return {
    id: `${relFile}:${startLoc.line}:${hash}`,
    file: relFile,
    startLine: startLoc.line,
    endLine: endLoc.line,
    start,
    end,
    style,
    wholeLine,
    indent,
    category,
    lineCount: endLoc.line - startLoc.line + 1,
    charLen: text.length,
    text,
    original,
    afterContext: afterLines.join("\n").slice(0, 220),
  };
}

function formatReplacement(entry, newText) {
  const trimmed = newText.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("{/*")) {
    return trimmed;
  }
  switch (entry.style) {
    case "swiftdoc":
      return `/// ${trimmed}`;
    case "jsdoc":
      return `/** ${trimmed} */`;
    case "block":
      return `/* ${trimmed} */`;
    case "jsx":
      return `{/* ${trimmed} */}`;
    case "line":
    default:
      return `// ${trimmed}`;
  }
}

function runExtract(flags) {
  const roots = resolveRoots(flags.scope);
  const files = walkFiles(roots);
  const includeDirectives = Boolean(flags["include-directives"]);
  const includeMarks = Boolean(flags["include-marks"]);

  const allEntries = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    const entries = groupTokens(f, src);
    for (const e of entries) {
      if (!includeDirectives && e.category === "directive") continue;
      if (!includeMarks && e.category === "mark") continue;
      allEntries.push(e);
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    scope: flags.scope || "all",
    count: allEntries.length,
    entries: allEntries,
  };

  if (flags.out) {
    fs.writeFileSync(flags.out, JSON.stringify(manifest, null, 2));
    console.log(`Extracted ${allEntries.length} comments -> ${flags.out}`);
  } else {
    console.log(JSON.stringify(manifest, null, 2));
  }

  if (flags.text) {
    const lines = [];
    for (const e of allEntries) {
      lines.push(`=== [${e.id}] (${e.style}, ${e.wholeLine ? "whole" : "inline"}, ${e.lineCount}L/${e.charLen}c) ===`);
      lines.push(e.original);
      if (e.afterContext.trim()) {
        lines.push(`--- code ---`);
        lines.push(e.afterContext);
      }
      lines.push("");
    }
    fs.writeFileSync(flags.text, lines.join("\n"));
    console.log(`Wrote readable dump -> ${flags.text}`);
  }
}

function runApply(flags) {
  if (!flags.manifest || !flags.patches) {
    console.error("Usage: apply --manifest <manifest.json> --patches <patches.json> [--dry-run]");
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(flags.manifest, "utf8"));
  const patches = JSON.parse(fs.readFileSync(flags.patches, "utf8"));
  const dryRun = Boolean(flags["dry-run"]);

  const byFile = new Map();
  for (const e of manifest.entries) {
    if (!Object.prototype.hasOwnProperty.call(patches, e.id)) continue;
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file).push({ entry: e, patch: patches[e.id] });
  }

  let modifiedFiles = 0;
  let deletedCount = 0;
  let rewrittenCount = 0;

  for (const [relFile, ops] of byFile.entries()) {
    const absFile = path.resolve(REPO_ROOT, relFile);
    let src = fs.readFileSync(absFile, "utf8");
    const origSrc = src;

    ops.sort((a, b) => b.entry.start - a.entry.start);

    for (const { entry, patch } of ops) {
      const actual = src.slice(entry.start, entry.end);
      if (actual !== entry.original) {
        throw new Error(`Offset mismatch in ${relFile} for ${entry.id}. Re-run extract.`);
      }

      const isDelete = patch === null || patch === "" || (typeof patch === "object" && patch.action === "delete");
      if (isDelete) {
        if (entry.wholeLine) {
          let delStart = entry.start;
          while (delStart > 0 && (src[delStart - 1] === " " || src[delStart - 1] === "\t")) {
            delStart--;
          }
          let delEnd = entry.end;
          if (src[delEnd] === "\r" && src[delEnd + 1] === "\n") delEnd += 2;
          else if (src[delEnd] === "\n") delEnd += 1;
          else if (delStart > 0 && src[delStart - 1] === "\n") delStart -= 1;

          src = src.slice(0, delStart) + src.slice(delEnd);
          const aroundStart = Math.max(0, delStart - 4);
          const aroundEnd = Math.min(src.length, delStart + 4);
          const before = src.slice(0, aroundStart);
          const mid = src.slice(aroundStart, aroundEnd).replace(/\n{3,}/g, "\n\n");
          const after = src.slice(aroundEnd);
          src = before + mid + after;
        } else {
          let delStart = entry.start;
          while (delStart > 0 && (src[delStart - 1] === " " || src[delStart - 1] === "\t")) {
            delStart--;
          }
          // Preserve one space around mid-line block comments.
          const leftCh = delStart > 0 ? src[delStart - 1] : "\n";
          const rightCh = src[entry.end] ?? "\n";
          const pad = leftCh !== "\n" && rightCh !== "\n" && rightCh !== "\r" ? " " : "";
          src = src.slice(0, delStart) + pad + src.slice(entry.end);
        }
        deletedCount++;
      } else {
        const text = typeof patch === "string" ? patch : patch.text;
        const formatted = formatReplacement(entry, text);
        src = src.slice(0, entry.start) + formatted + src.slice(entry.end);
        rewrittenCount++;
      }
    }

    if (src !== origSrc) {
      src = src.replace(/^\n+/, "");
      modifiedFiles++;
      if (!dryRun) {
        fs.writeFileSync(absFile, src, "utf8");
      }
    }
  }

  console.log(
    `${dryRun ? "[DRY RUN] " : ""}Files: ${modifiedFiles}, deleted: ${deletedCount}, rewritten: ${rewrittenCount}`
  );
}

function runCheck(flags) {
  const roots = resolveRoots(flags.scope);
  const files = walkFiles(roots);
  const maxChars = Number(flags["max-chars"] || 130);
  const maxLines = Number(flags["max-lines"] || 1);

  const violations = [];
  let total = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const e of groupTokens(f, src)) {
      if (e.category !== "comment") continue;
      total++;
      if (e.lineCount > maxLines || e.charLen > maxChars) {
        violations.push(e);
      }
    }
  }
  console.log(`Checked ${files.length} files (${total} comments). Violations (>${maxLines}L or >${maxChars}c): ${violations.length}`);
  for (const v of violations.slice(0, 40)) {
    console.log(`  ${v.file}:${v.startLine} (${v.lineCount}L, ${v.charLen}c) -> ${v.text.split("\n")[0].slice(0, 90)}`);
  }
  if (violations.length > 40) console.log(`  ... and ${violations.length - 40} more`);
  process.exit(violations.length > 0 ? 2 : 0);
}

const { cmd, flags } = parseArgs(process.argv);
if (cmd === "extract") runExtract(flags);
else if (cmd === "apply") runApply(flags);
else if (cmd === "check") runCheck(flags);
else {
  console.error(
    "Usage:\n" +
      "  node cloud/scripts/comment-sweep.mjs extract --out manifest.json [--text dump.txt] [--scope all|cloud|ios]\n" +
      "  node cloud/scripts/comment-sweep.mjs apply --manifest manifest.json --patches patches.json [--dry-run]\n" +
      "  node cloud/scripts/comment-sweep.mjs check [--scope all|cloud|ios] [--max-chars 130] [--max-lines 1]"
  );
  process.exit(1);
}
