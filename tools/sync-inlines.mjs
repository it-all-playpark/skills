// tools/sync-inlines.mjs
// Inline-sync generator: rewrites BEGIN/END inline marker zones in workflow files.
// Usage: node tools/sync-inlines.mjs [--write|--check] [--root <dir>]
//
// Named exports (pure functions):
//   stripComments(src)              - remove JS comments for forbidden-token scanning
//   checkForbiddenTokens(src, lbl)  - error if import/require/Date.now/Math.random in code
//   transformCanonical(src, lbl)    - strip 'export ' prefix, normalize trailing newline
//   scanMarkers(wfSrc, wfLabel)     - parse BEGIN/END markers, return [{source, beginLine, endLine}]
//   syncRepo(root, {write})         - orchestrate all workflow files

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
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
    const markers = scanMarkers(wfSrc, wfFile);

    if (markers.length === 0) {
      results.push({ file: wfFile, source: null, changed: false });
      continue;
    }

    // Build new file content by replacing each marker zone
    const lines = wfSrc.split('\n');
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
      // Replace: keep BEGIN line, replace body, keep END line
      const beginLine = lines[marker.beginLine];
      const endLine = lines[marker.endLine];
      // New region: BEGIN line + newline + transformed content + END line
      // transformed already ends with \n, so join with no extra separator
      const newRegion = [beginLine, ...transformed.split('\n').slice(0, -1), endLine];
      lines.splice(marker.beginLine, marker.endLine - marker.beginLine + 1, ...newRegion);
    }

    const newSrc = lines.join('\n');
    const changed = newSrc !== wfSrc;

    for (const marker of markers) {
      results.push({ file: wfFile, source: marker.source, changed });
    }

    if (changed && write) {
      writeFileSync(wfPath, newSrc, 'utf8');
    }
  }

  return { results };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entry point: only runs when directly executed (not when imported)
// ─────────────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const args = process.argv.slice(2);
  let write = false;
  let check = false;
  let root = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--write') { write = true; }
    else if (args[i] === '--check') { check = true; }
    else if (args[i] === '--root' && i + 1 < args.length) { root = args[++i]; }
    else {
      process.stderr.write(`Unknown flag: ${args[i]}\nUsage: sync-inlines.mjs [--write|--check] [--root <dir>]\n`);
      process.exit(2);
    }
  }

  if (write === check) {  // both true (xor false) means either both set or neither
    process.stderr.write('Usage: sync-inlines.mjs [--write|--check] [--root <dir>]\nExactly one of --write or --check is required.\n');
    process.exit(2);
  }

  if (root === null) {
    root = join(dirname(fileURLToPath(import.meta.url)), '..');
  }

  try {
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
  } catch (err) {
    process.stderr.write(`sync-inlines error: ${err.message}\n`);
    process.exit(1);
  }
}
