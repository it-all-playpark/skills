#!/usr/bin/env node
// tools/sync-inlines.mjs
// Inline-sync generator: rewrites BEGIN/END inline marker zones in workflow files.
// Usage: node tools/sync-inlines.mjs [--write|--check] [--root <dir>]
//    or: node tools/sync-inlines.mjs --add <canonical> --into <workflow> --after <anchor> [--root <dir>]
//
// Named exports (pure functions):
//   stripComments(src)              - remove JS comments for forbidden-token scanning
//   checkForbiddenTokens(src, lbl)  - error if import/require/Date.now/Math.random in code
//   transformCanonical(src, lbl)    - strip 'export ' prefix, normalize trailing newline
//   scanMarkers(wfSrc, wfLabel)     - parse BEGIN/END markers, return [{source, beginLine, endLine}]
//   insertMarkerPair(wfSrc, source, anchor, wfLabel)
//                                   - insert a new BEGIN/END marker pair after a unique
//                                     literal anchor line; rejects anchors inside an
//                                     existing inline region (nested markers)
//   syncRepo(root, {write})         - orchestrate all workflow files

import { readFileSync, writeFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const BEGIN_RE = /^\/\/ ==== BEGIN inline: (\S+) .*====$/;
const END_RE   = /^\/\/ ==== END inline: (\S+) ====$/;

// ─────────────────────────────────────────────────────────────────────────────
// stripComments(src): remove // line comments and /* */ block comments from JS source.
//
// Rules:
//   - String literals (', ", `) are traversed verbatim — // and /* inside are NOT stripped.
//   - Template literals: handled as string context up to the matching closing backtick.
//     ${ } expressions inside template literals are NOT recursed into (not needed for current
//     canonicals; a comment in the code makes this limitation explicit).
//   - Regex literals are not parsed as regex context. This is acceptable for current canonicals;
//     add a focused fixture before relying on regex literals containing comment-like tokens.
//   - After comment removal, the positions of remaining code are preserved (comments -> spaces).
//
// NOTE: canonicals with ${ } containing a nested backtick are NOT supported. The current 8
// canonical files do not have this pattern. If one is added, this function will need updating.
// ─────────────────────────────────────────────────────────────────────────────
export function stripComments(src) {
  let result = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    // String literals: ', ", `
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      result += ch;
      i++;
      while (i < n) {
        const c = src[i];
        result += c;
        if (c === '\\') {
          // escape: consume next char verbatim
          i++;
          if (i < n) { result += src[i]; i++; }
        } else if (c === quote) {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }
    // Line comment: // ... (to end of line, preserve newline)
    if (ch === '/' && i + 1 < n && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // Block comment: /* ... */
    if (ch === '/' && i + 1 < n && src[i + 1] === '*') {
      i += 2;
      while (i + 1 < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;  // skip */
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// checkForbiddenTokens(src, label): scan comment-stripped source for forbidden patterns.
// Throws an Error with label + pattern name if any forbidden token is found.
// ─────────────────────────────────────────────────────────────────────────────
export function checkForbiddenTokens(src, label) {
  const stripped = stripComments(src);
  if (/^\s*import[\s{(]/m.test(stripped)) {
    throw new Error(`${label}: canonical contains 'import' statement (forbidden in inline)`);
  }
  if (/\brequire\s*\(/.test(stripped)) {
    throw new Error(`${label}: canonical contains 'require()' call (forbidden in inline)`);
  }
  if (/\bDate\.now\b/.test(stripped)) {
    throw new Error(`${label}: canonical contains 'Date.now' (forbidden in inline)`);
  }
  if (/\bMath\.random\b/.test(stripped)) {
    throw new Error(`${label}: canonical contains 'Math.random' (forbidden in inline)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// transformCanonical(src, label): apply the single transformation rule:
//   Strip leading 'export ' from function/const/let/var/class/async function declarations.
//   After stripping, any remaining /^export\b/m triggers an error (export default, export {}).
//   Normalize trailing whitespace to exactly one newline.
// ─────────────────────────────────────────────────────────────────────────────
export function transformCanonical(src, label) {
  // Apply the transformation: strip 'export ' prefix from declarations
  const transformed = src.replace(
    /^export (?=(async )?(function|const|let|var|class)\b)/gm,
    '',
  );
  // Check for remaining export keywords (export default, export {}, export * from)
  if (/^export\b/m.test(transformed)) {
    throw new Error(
      `${label}: canonical contains unsupported 'export' form (export default / export { } / export * from)`,
    );
  }
  // Normalize trailing newline: trim trailing whitespace/newlines, then add exactly one \n
  return transformed.trimEnd() + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// collectTopLevelDeclNames(src): collect declaration names that will share the
// workflow file's top-level scope after inline generation. This intentionally
// only considers column-0 declarations; nested declarations stay scoped.
// ─────────────────────────────────────────────────────────────────────────────
export function collectTopLevelDeclNames(src) {
  const stripped = stripComments(src);
  const names = [];
  for (const line of stripped.split('\n')) {
    let match = line.match(/^(?:async\s+function|function)\s+([A-Za-z_$][\w$]*)\b/);
    if (match) {
      names.push(match[1]);
      continue;
    }
    match = line.match(/^class\s+([A-Za-z_$][\w$]*)\b/);
    if (match) {
      names.push(match[1]);
      continue;
    }
    match = line.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/);
    if (match) {
      names.push(match[1]);
    }
  }
  return names;
}

function validateInlineDeclCollisions(wfFile, inlineRegions) {
  const seen = new Map();
  for (const region of inlineRegions) {
    for (const name of collectTopLevelDeclNames(region.transformed)) {
      const firstSource = seen.get(name);
      if (firstSource) {
        throw new Error(
          `${wfFile}: top-level declaration collision '${name}' in ${firstSource} and ${region.source}`,
        );
      }
      seen.set(name, region.source);
    }
  }
}

function validateGeneratedWorkflowSyntax(wfFile, src) {
  const parseableSrc = src
    .replace(/^export\s+(?=(async\s+)?(function|const|let|var|class)\b)/gm, '')
    .replace(/^export\s+default\s+/gm, '');
  try {
    // Workflow bodies may contain top-level await/return. Wrapping in an async
    // function validates syntax without executing the generated workflow.
    // eslint-disable-next-line no-new-func
    new Function(`return (async () => {\n${parseableSrc}\n});`);
  } catch (err) {
    throw new Error(`${wfFile}: generated workflow syntax error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// scanMarkers(wfSrc, wfLabel): parse BEGIN/END marker pairs in a workflow file source.
// Returns: [{source: string (canonical relative path), beginLine: number, endLine: number}]
// Line numbers are 0-indexed (index into wfSrc.split('\n')).
// Errors on: missing END, unexpected END, path mismatch, duplicate canonical in same file.
// ─────────────────────────────────────────────────────────────────────────────
export function scanMarkers(wfSrc, wfLabel) {
  const lines = wfSrc.split('\n');
  const markers = [];
  const seen = new Set();
  let openPath = null;
  let openLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const beginMatch = line.match(BEGIN_RE);
    const endMatch = line.match(END_RE);

    if (beginMatch) {
      const path = beginMatch[1];
      if (openPath !== null) {
        throw new Error(
          `${wfLabel}: nested BEGIN inline at line ${i + 1} (already inside '${openPath}')`,
        );
      }
      if (seen.has(path)) {
        throw new Error(
          `${wfLabel}: duplicate inline '${path}' — same canonical inlined twice in one file`,
        );
      }
      openPath = path;
      openLine = i;
    } else if (endMatch) {
      const path = endMatch[1];
      if (openPath === null) {
        throw new Error(
          `${wfLabel}: unexpected END inline '${path}' at line ${i + 1} — no matching BEGIN missing`,
        );
      }
      if (path !== openPath) {
        throw new Error(
          `${wfLabel}: BEGIN/END path mismatch — BEGIN '${openPath}' closed by END '${path}'`,
        );
      }
      seen.add(path);
      markers.push({ source: path, beginLine: openLine, endLine: i });
      openPath = null;
      openLine = -1;
    }
  }

  if (openPath !== null) {
    throw new Error(
      `${wfLabel}: no matching END for BEGIN inline '${openPath}' — END missing`,
    );
  }

  return markers;
}

// ─────────────────────────────────────────────────────────────────────────────
// insertMarkerPair(wfSrc, source, anchor, wfLabel): insert a new BEGIN/END inline
// marker pair immediately after a literal anchor line.
//
// Rules:
//   - `anchor` must match exactly one line in wfSrc (via `line === anchor` after
//     split('\n')). 0 or >1 matches throw.
//   - The anchor line must not fall inside an existing BEGIN..END region (checked
//     via scanMarkers): the range is [beginLine, endLine) — the END line itself
//     is "outside" and may be used as an anchor (i.e. inserting a new region
//     immediately after an existing one is allowed).
//   - Does not fill the region body or validate the canonical; callers run the
//     existing pipeline (scanMarkers -> checkForbiddenTokens -> transformCanonical
//     -> validateInlineDeclCollisions -> validateGeneratedWorkflowSyntax) via
//     syncWorkflowSource on the returned source.
//
// Returns: new wfSrc string with the marker pair inserted (region body empty).
// ─────────────────────────────────────────────────────────────────────────────
export function insertMarkerPair(wfSrc, source, anchor, wfLabel) {
  const lines = wfSrc.split('\n');
  const matchIndices = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === anchor) matchIndices.push(i);
  }
  if (matchIndices.length === 0) {
    throw new Error(`${wfLabel}: --after anchor not found (expected exactly 1 matching line): ${JSON.stringify(anchor)}`);
  }
  if (matchIndices.length > 1) {
    throw new Error(`${wfLabel}: --after anchor matched ${matchIndices.length} lines, expected exactly 1: ${JSON.stringify(anchor)}`);
  }
  const anchorIndex = matchIndices[0];

  // Reject anchors inside an existing inline region (nested markers). Let any
  // scanMarkers error on malformed existing marker structure propagate as-is.
  const markers = scanMarkers(wfSrc, wfLabel);
  for (const marker of markers) {
    if (anchorIndex >= marker.beginLine && anchorIndex < marker.endLine) {
      throw new Error(
        `${wfLabel}: --after anchor (line ${anchorIndex + 1}) is inside existing inline region '${marker.source}' (BEGIN line ${marker.beginLine + 1} - END line ${marker.endLine + 1}) — nested markers are not allowed`,
      );
    }
  }

  const beginLine = `// ==== BEGIN inline: ${source} (生成区間 — 直接編集禁止。_lib を編集して tools/sync-inlines.mjs --write) ====`;
  const endLine = `// ==== END inline: ${source} ====`;
  lines.splice(anchorIndex + 1, 0, beginLine, endLine);
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// syncWorkflowSource(root, wfFile, wfSrc): fill all BEGIN/END inline regions in a
// single workflow file source against canonicals under root/_lib, running the
// full validation pipeline (forbidden tokens -> transform -> decl collisions ->
// generated syntax) before returning. Shared by syncRepo (multi-file
// orchestration) and the --add CLI mode (single newly-inserted marker pair).
//
// Returns: { newSrc, changed, markerSources }
//   markerSources preserves scan order (top-to-bottom); the reverse-order splice
//   processing used internally is an implementation detail.
// ─────────────────────────────────────────────────────────────────────────────
function syncWorkflowSource(root, wfFile, wfSrc) {
  const markers = scanMarkers(wfSrc, wfFile);

  if (markers.length === 0) {
    validateGeneratedWorkflowSyntax(wfFile, wfSrc);
    return { newSrc: wfSrc, changed: false, markerSources: [] };
  }

  // Build new file content by replacing each marker zone
  const lines = wfSrc.split('\n');
  const inlineRegions = [];
  // We need to process in reverse order to preserve line indices
  const sortedMarkers = [...markers].sort((a, b) => b.beginLine - a.beginLine);

  for (const marker of sortedMarkers) {
    const canonicalPath = join(root, marker.source);
    if (!existsSync(canonicalPath)) {
      throw new Error(
        `${wfFile}: canonical '${marker.source}' not found at '${canonicalPath}'`,
      );
    }
    const canonicalSrc = readFileSync(canonicalPath, 'utf8');
    // Check forbidden tokens in canonical BEFORE transforming
    checkForbiddenTokens(canonicalSrc, marker.source);
    // Transform: strip export prefix, normalize trailing newline
    const transformed = transformCanonical(canonicalSrc, marker.source);
    inlineRegions.push({ source: marker.source, transformed });
    // Replace: keep BEGIN line, replace body, keep END line
    const beginLine = lines[marker.beginLine];
    const endLine = lines[marker.endLine];
    // New region: BEGIN line + newline + transformed content + END line
    // transformed already ends with \n, so join with no extra separator
    const newRegion = [beginLine, ...transformed.split('\n').slice(0, -1), endLine];
    lines.splice(marker.beginLine, marker.endLine - marker.beginLine + 1, ...newRegion);
  }

  const newSrc = lines.join('\n');
  validateInlineDeclCollisions(wfFile, inlineRegions);
  validateGeneratedWorkflowSyntax(wfFile, newSrc);

  return {
    newSrc,
    changed: newSrc !== wfSrc,
    markerSources: markers.map(m => m.source),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// syncRepo(root, {write}): orchestrate sync across all workflow files in root.
// Returns: { results: [{file, source, changed}], ... }
// ─────────────────────────────────────────────────────────────────────────────
export function syncRepo(root, { write }) {
  const wfDir = join(root, '.claude', 'workflows');
  const wfFiles = readdirSync(wfDir)
    .filter(f => f.endsWith('.js'))
    .sort();

  const results = [];

  for (const wfFile of wfFiles) {
    const wfPath = join(wfDir, wfFile);
    const wfSrc = readFileSync(wfPath, 'utf8');
    const { newSrc, changed, markerSources } = syncWorkflowSource(root, wfFile, wfSrc);

    if (markerSources.length === 0) {
      results.push({ file: wfFile, source: null, changed: false });
      continue;
    }

    for (const source of markerSources) {
      results.push({ file: wfFile, source, changed });
    }

    if (changed && write) {
      writeFileSync(wfPath, newSrc, 'utf8');
    }
  }

  return { results };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entry point: only runs when directly executed (not when imported).
//
// Compares realpath(process.argv[1]) against realpath(this file) so bare-form
// invocation (direct execve of the script path — e.g. exec-proxy subagent
// Bash calls, or invocation via a symlink) still resolves to the same file
// as `node tools/sync-inlines.mjs`. Falls back to the previous strict-path
// equality if realpath fails (e.g. argv[1] does not exist on disk).
// ─────────────────────────────────────────────────────────────────────────────
const isMain = (() => {
  if (!process.argv[1]) return false;
  const thisFile = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(thisFile);
  } catch {
    return thisFile === process.argv[1];
  }
})();

const USAGE = 'Usage: sync-inlines.mjs [--write|--check] [--root <dir>]\n' +
  '   or: sync-inlines.mjs --add <canonical> --into <workflow> --after <anchor> [--root <dir>]\n';

if (isMain) {
  const args = process.argv.slice(2);
  let write = false;
  let check = false;
  let root = null;
  let add = null;
  let into = null;
  let after = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--write') { write = true; }
    else if (args[i] === '--check') { check = true; }
    else if (args[i] === '--root' && i + 1 < args.length) { root = args[++i]; }
    else if (args[i] === '--add' && i + 1 < args.length) { add = args[++i]; }
    else if (args[i] === '--into' && i + 1 < args.length) { into = args[++i]; }
    else if (args[i] === '--after' && i + 1 < args.length) { after = args[++i]; }
    else {
      process.stderr.write(`Unknown flag: ${args[i]}\n${USAGE}`);
      process.exit(2);
    }
  }

  const addMode = add !== null || into !== null || after !== null;

  if (addMode) {
    if (write || check) {
      process.stderr.write(`--add cannot be combined with --write/--check.\n${USAGE}`);
      process.exit(2);
    }
    if (add === null || into === null || after === null) {
      process.stderr.write(`--add requires --into and --after.\n${USAGE}`);
      process.exit(2);
    }
    if (!add.startsWith('_lib/') || !add.endsWith('.mjs')) {
      process.stderr.write(`--add canonical must be a repo-root-relative path starting with '_lib/' and ending with '.mjs': ${add}\n${USAGE}`);
      process.exit(2);
    }
    // Reject '..' segments: join(root, add) would otherwise resolve outside _lib/ and the
    // non-normalized path would be embedded verbatim as the marker's canonical source,
    // making the marker unresolvable by --write/--check from a different cwd.
    if (add.split('/').includes('..')) {
      process.stderr.write(`--add canonical must not contain '..' path segments: ${add}\n${USAGE}`);
      process.exit(2);
    }
    if (into.includes('/')) {
      process.stderr.write(`--into must be a bare workflow file name (no '/'): ${into}\n${USAGE}`);
      process.exit(2);
    }
  } else if (write === check) {  // both true (xor false) means either both set or neither
    process.stderr.write(`Exactly one of --write or --check is required.\n${USAGE}`);
    process.exit(2);
  }

  if (root === null) {
    root = join(dirname(fileURLToPath(import.meta.url)), '..');
  }

  try {
    if (addMode) {
      const canonicalPath = join(root, add);
      if (!existsSync(canonicalPath)) {
        throw new Error(`canonical '${add}' not found at '${canonicalPath}'`);
      }
      const wfPath = join(root, '.claude', 'workflows', into);
      if (!existsSync(wfPath)) {
        throw new Error(`workflow '${into}' not found at '${wfPath}'`);
      }
      const wfSrc = readFileSync(wfPath, 'utf8');
      const inserted = insertMarkerPair(wfSrc, add, after, into);
      const { newSrc } = syncWorkflowSource(root, into, inserted);
      writeFileSync(wfPath, newSrc, 'utf8');
      process.stdout.write(`added: ${into} (${add})\n`);
    } else {
      const { results } = syncRepo(root, { write });
      if (check) {
        const drifted = results.filter(r => r.changed);
        if (drifted.length > 0) {
          process.stderr.write('sync-inlines: inline sections out of date:\n');
          for (const r of drifted) {
            process.stderr.write(`  ${r.file}: _lib/${r.source}\n`);
          }
          process.exit(1);
        }
        process.exit(0);
      }
      // --write: report what changed
      const changed = results.filter(r => r.changed);
      if (changed.length > 0) {
        for (const r of changed) {
          process.stdout.write(`updated: ${r.file} (${r.source})\n`);
        }
      } else {
        process.stdout.write('sync-inlines: all inline sections are up to date.\n');
      }
    }
  } catch (err) {
    process.stderr.write(`sync-inlines error: ${err.message}\n`);
    process.exit(1);
  }
}
