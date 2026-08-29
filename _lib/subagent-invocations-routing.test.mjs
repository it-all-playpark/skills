import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripComments } from '../tools/sync-inlines.mjs';

// dev-flow.js 内の全 agent() 呼び出しが trackedAgent() 経由になっているかを静的検証する
// routing test（issue #445）。wrapper（`async function trackedAgent(prompt, opts) { ...
// return agent(prompt, opts) }`）の内部呼び出しのみが bare `agent(` として残ることを保証する。
//
// stripComments は regex literal を regex context として解釈しない（tools/sync-inlines.mjs
// の doc コメント記載の既知の制約）。dev-flow.js には regex literal 内にクオート文字
// （例: `hasn'?t`）を含む箇所が実在し、素の stripComments 適用だとそこで false な文字列
// 開始と誤認して以降のコメント除去が破綻する（文字列内容として素通しされ、後続の実コメント
// 文中の "agent()" 言及まで生き残ってしまう）。本テストはその既知の限界を
// 迂回するため、stripComments に通す前に regex literal 本文をプレースホルダへ
// 置換する neutralizeRegexLiterals を通す（tools/sync-inlines.mjs 本体は変更しない
// — 生成区間ガード対象外の read-only 検証ロジックとしてテスト側にのみ実装する）。
function neutralizeRegexLiterals(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    // 文字列・テンプレートリテラルはクオート対応を崩さないよう素通しする
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        const c = src[i];
        out += c;
        if (c === '\\') {
          i++;
          if (i < n) { out += src[i]; i++; }
        } else if (c === quote) {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }
    // line comment はそのまま素通し（stripComments が後段で除去する）
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { out += src[i]; i++; }
      continue;
    }
    // block comment もそのまま素通し
    if (ch === '/' && src[i + 1] === '*') {
      out += '/*';
      i += 2;
      while (i + 1 < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i]; i++; }
      if (i + 1 < n) { out += '*/'; i += 2; }
      continue;
    }
    // regex literal 候補: '/' が直前トークンから見て式開始位置にある場合のみ対象化する
    if (ch === '/') {
      const prevTrim = out.replace(/\s+$/, '');
      const prevChar = prevTrim.slice(-1);
      const isRegexOpenerContext = prevChar === '' || '([{,:=!&|?;'.includes(prevChar) || /return$/.test(prevTrim);
      if (isRegexOpenerContext) {
        let j = i + 1;
        let inClass = false;
        while (j < n) {
          const c = src[j];
          if (c === '\\') { j += 2; continue; }
          if (c === '\n') break; // regex literal は改行を跨がない
          if (c === '[') { inClass = true; j++; continue; }
          if (c === ']') { inClass = false; j++; continue; }
          if (c === '/' && !inClass) { j++; break; }
          j++;
        }
        while (j < n && /[a-z]/i.test(src[j])) j++;
        out += '_'.repeat(j - i);
        i = j;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

const HERE = dirname(fileURLToPath(import.meta.url));

// dev-flow.js と pr-iterate.js の両方に対して同一 assert を適用する（issue #445 F3）。
const TARGETS = [
  { name: 'dev-flow.js', path: join(HERE, '..', '.claude', 'workflows', 'dev-flow.js') },
  { name: 'pr-iterate.js', path: join(HERE, '..', '.claude', 'workflows', 'pr-iterate.js') },
];

for (const { name, path } of TARGETS) {
  const rawSrc = readFileSync(path, 'utf8');
  const sanitizedSrc = neutralizeRegexLiterals(rawSrc);
  const strippedSrc = stripComments(sanitizedSrc);

  test(`${name}: bare agent( 呼び出しは trackedAgent wrapper 内の 2 箇所のみ（issue #527: 契約違反リトライで初回 + リトライの 2 箇所）`, () => {
    const bareAgentCallRe = /(?<![A-Za-z0-9_$])agent\s*\(/g;
    const matches = [...strippedSrc.matchAll(bareAgentCallRe)];
    assert.equal(
      matches.length,
      2,
      `bare agent( の総出現数が 2 件ではない（${matches.length} 件）。新規 agent() call site は ` +
      `trackedAgent() 経由で呼ぶこと`,
    );
  });

  test(`${name}: 残る bare agent( 呼び出しはすべて trackedAgent wrapper 本体の内側にある（issue #527）`, () => {
    const wrapperMarker = 'async function trackedAgent(prompt, opts) {';
    const wrapperStart = strippedSrc.indexOf(wrapperMarker);
    assert.ok(wrapperStart !== -1, 'trackedAgent wrapper 定義が見つからない');
    const nextFnIdx = strippedSrc.indexOf('async function', wrapperStart + wrapperMarker.length);
    const wrapperEnd = nextFnIdx === -1 ? strippedSrc.length : nextFnIdx;

    const bareAgentCallRe = /(?<![A-Za-z0-9_$])agent\s*\(/g;
    const matches = [...strippedSrc.matchAll(bareAgentCallRe)];
    for (const m of matches) {
      assert.ok(
        m.index >= wrapperStart && m.index < wrapperEnd,
        `bare agent( 呼び出し（index ${m.index}）が trackedAgent wrapper 本体の外にある — call site は trackedAgent() 経由で呼ぶこと`,
      );
    }
  });

  test(`${name}: 成功 telemetry handoff に subagent_invocations キーが存在する`, () => {
    assert.ok(
      strippedSrc.includes('subagent_invocations'),
      'telemetry object に subagent_invocations キーが見つからない',
    );
  });
}

// pr-iterate.js は telemetry handoff（buildJournalHandoffPayload）と終端 return object の 2 箇所に
// subagent_invocations を出力する（dev-flow.js は telemetry handoff のみ）。上の whole-file assert
// では両方揃っていることまでは保証できないため、各ブロックを個別に scope して検証する。
{
  const rawSrc = readFileSync(join(HERE, '..', '.claude', 'workflows', 'pr-iterate.js'), 'utf8');
  const strippedSrc = stripComments(neutralizeRegexLiterals(rawSrc));

  test('pr-iterate.js: telemetry handoff（buildJournalHandoffPayload）に subagent_invocations キーが存在する', () => {
    const telemetryIdx = strippedSrc.indexOf('const telemetryHandoff = buildJournalHandoffPayload({');
    assert.ok(telemetryIdx !== -1, 'telemetry handoff object（buildJournalHandoffPayload）が見つからない');
    const telemetryEnd = strippedSrc.indexOf('\n})', telemetryIdx);
    assert.ok(telemetryEnd !== -1, 'telemetry handoff object の終端が見つからない');
    const telemetryBlock = strippedSrc.slice(telemetryIdx, telemetryEnd);
    assert.ok(
      telemetryBlock.includes('subagent_invocations'),
      'telemetry handoff object に subagent_invocations キーが見つからない',
    );
  });

  test('pr-iterate.js: 終端 return object に subagent_invocations キーが存在する', () => {
    const returnIdx = strippedSrc.lastIndexOf('\nreturn {');
    assert.ok(returnIdx !== -1, '終端 return object が見つからない');
    const returnBlock = strippedSrc.slice(returnIdx);
    assert.ok(
      returnBlock.includes('subagent_invocations'),
      '終端 return object に subagent_invocations キーが見つからない',
    );
  });
}
