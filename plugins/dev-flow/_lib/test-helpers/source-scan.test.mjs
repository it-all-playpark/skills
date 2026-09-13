import { test } from 'vitest';
import assert from 'node:assert/strict';
import { neutralizeRegexLiterals, blankStringLiterals } from './source-scan.mjs';

test('neutralizeRegexLiterals: regex literal 本文が同長のプレースホルダに置換され、通常の文字列は残る', () => {
  const src = `const r = /hasn'?t/i; const s = "x";`;
  const out = neutralizeRegexLiterals(src);
  assert.equal(out.length, src.length, '出力長は入力長と同じであること');
  assert.ok(!out.includes("hasn'?t"), 'regex literal 本文が消えていること');
  assert.ok(out.includes('_'.repeat("/hasn'?t/i".length)), 'regex literal 全体が同長のプレースホルダに置換されていること');
  assert.ok(out.includes('"x"'), '通常の文字列リテラルは残ること');
});

test('neutralizeRegexLiterals: 除算は regex とみなされず不変', () => {
  const src = 'const v = a / b / c;';
  const out = neutralizeRegexLiterals(src);
  assert.equal(out, src, '除算式は変更されないこと');
});

test('blankStringLiterals: 文字列リテラル内の brace が空白化され残る brace 総数が減る', () => {
  const src = `log('⚠️ {"ok": true}') ; x = {`;
  const out = blankStringLiterals(src);
  assert.equal(out.length, src.length, '出力長は入力長と同じであること');
  const braceCount = (out.match(/\{/g) || []).length;
  assert.equal(braceCount, 1, '文字列内の { は空白化され、コード上の { のみ残ること');
});

test('blankStringLiterals: 入れ子テンプレートリテラルも含めて空白化され出力長は不変', () => {
  const src = 'f(`a ${cond ? `b}` : `c`} d`) + `{`';
  const out = blankStringLiterals(src);
  assert.equal(out.length, src.length, '出力長は入力長と同じであること');
  const braceCount = (out.match(/\{/g) || []).length;
  assert.equal(braceCount, 0, 'テンプレートリテラル内の { はすべて空白化されること');
});

test('blankStringLiterals: 複数行テンプレート内の改行は保持される', () => {
  const src = 'const t = `line1\nline2\nline3`;\nconst x = 1;';
  const out = blankStringLiterals(src);
  assert.equal(out.split('\n').length, src.split('\n').length, '改行数（行数）が保持されること');
});

test('blankStringLiterals: エスケープされたクオートを正しく閉じ後続コードは空白化されない', () => {
  const src = "x = 'it\\'s {'; y = { a: 1 };";
  const out = blankStringLiterals(src);
  assert.equal(out.length, src.length, '出力長は入力長と同じであること');
  assert.ok(out.includes('y = { a: 1 };'), '文字列リテラル終了後のコードは空白化されないこと');
});
