/**
 * source-scan.mjs — ソース走査ヘルパー共有モジュール
 *
 * dev-flow.js / pr-iterate.js の静的検証テスト（routing test）が共通で必要とする
 * ソース前処理ロジックを集約する。いずれも入力長と出力長が一致することを invariant
 * として保証し、文字位置ベースの assert（index / brace 数など）が崩れないようにする。
 *
 * Export:
 *   - neutralizeRegexLiterals(src): regex literal 本文をプレースホルダへ置換
 *   - blankStringLiterals(src): 文字列/テンプレートリテラルの中身を空白化
 */

/**
 * neutralizeRegexLiterals(src)
 *
 * tools/sync-inlines.mjs の stripComments が regex literal 内のクオートで破綻する
 * 既知の制約の迂回。stripComments の前段に通す。
 *
 * stripComments は regex literal を regex context として解釈しない。dev-flow.js には
 * regex literal 内にクオート文字（例: `hasn'?t`）を含む箇所が実在し、素の
 * stripComments 適用だとそこで false な文字列開始と誤認して以降のコメント除去が
 * 破綻する（文字列内容として素通しされ、後続の実コメント文中の "agent()" 言及まで
 * 生き残ってしまう）。本関数はその既知の限界を迂回するため、stripComments に通す
 * 前に regex literal 本文をプレースホルダへ置換する。
 *
 * 文字列/テンプレートリテラル・コメントは素通しする。式開始位置（直前非空白が
 * 空 / `([{,:=!&|?;` のいずれか / `return`）にある `/` から regex literal を検出し、
 * 本文とフラグを同長の `_` に置換する。出力長は入力長と同一。
 */
export function neutralizeRegexLiterals(src) {
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

/**
 * blankStringLiterals(src)
 *
 * 文字列/テンプレートリテラルの中身（クオート自体は残す）を同長の空白に置換する。
 * prompt 文字列内の `{`/`}`（JSON 例示や `${}` 入れ子）が brace 走査系の静的検証を
 * 誤爆させる問題の対策。regex literal は扱わない — neutralizeRegexLiterals を先に
 * 通してから本関数に渡すこと（regex literal 本文にクオート文字が含まれる場合、
 * 未処理のまま本関数に通すと誤ったクオート対応で破綻し得る）。
 *
 * - '…' / "…" / `…` の中身を空白化する。改行文字（\n）は保持し、行番号・index
 *   対応を崩さない。
 * - エスケープ `\x` は 2 文字とも空白化する。
 * - テンプレートリテラルは `${` … `}` の式部分も含めて丸ごと空白化する。式内の
 *   入れ子テンプレート（`` `a ${cond ? `b` : `c`} d` ``）と式内の `{`/`}`
 *   （brace depth で追跡）を正しく越えて閉じバッククォートを見つける。
 * - コメント（`//` 行末まで、`/* *​/`）は素通しする（stripComments 適用後の入力を
 *   想定するが、適用前でも壊れないよう自前で識別する）。
 *
 * invariant: out.length === src.length（呼び出し側の index ベース assert が
 * 前処理前後で一致し続けるための契約）。
 */
export function blankStringLiterals(src) {
  const n = src.length;
  const out = new Array(n);

  // 1 文字を空白化する（改行は保持）
  const blankChar = (idx) => {
    out[idx] = src[idx] === '\n' ? '\n' : ' ';
  };

  // シングル/ダブルクオート文字列を index i（開きクオート位置）から走査し、
  // クオート自体は out に複製、中身は空白化する。閉じクオート直後の index を返す。
  const scanQuotedString = (i, quote) => {
    out[i] = src[i];
    let j = i + 1;
    while (j < n) {
      const c = src[j];
      if (c === '\\') {
        blankChar(j);
        j++;
        if (j < n) { blankChar(j); j++; }
        continue;
      }
      if (c === quote) {
        out[j] = src[j];
        j++;
        break;
      }
      blankChar(j);
      j++;
    }
    return j;
  };

  // テンプレートリテラルを index i（開きバッククォート位置）から走査する。
  // `${` に入ったら式部分を brace depth で追跡しつつ、式内の入れ子テンプレートは
  // 再帰的に scanTemplate で処理する。式部分自体も空白化対象（regex は扱わない前提）。
  const scanTemplate = (i) => {
    out[i] = src[i];
    let j = i + 1;
    while (j < n) {
      const c = src[j];
      if (c === '\\') {
        blankChar(j);
        j++;
        if (j < n) { blankChar(j); j++; }
        continue;
      }
      if (c === '`') {
        out[j] = src[j];
        j++;
        break;
      }
      if (c === '$' && src[j + 1] === '{') {
        // `${` は素通し（式の一部として扱うが記号自体は残さず空白化する —
        // brace 走査系テストは中身の `{`/`}` が消えていれば良いため統一的に空白化する）
        blankChar(j);
        j++;
        blankChar(j);
        j++;
        let depth = 1;
        while (j < n && depth > 0) {
          const ec = src[j];
          if (ec === '`') {
            j = scanTemplate(j);
            continue;
          }
          if (ec === '"' || ec === "'") {
            j = scanQuotedString(j, ec);
            // 式内の文字列も中身は空白化済み（クオート自体は scanQuotedString が複製）。
            // ただしクオート自体も brace 走査の対象外にするため空白化して上書きする。
            continue;
          }
          if (ec === '{') { depth++; blankChar(j); j++; continue; }
          if (ec === '}') {
            depth--;
            blankChar(j);
            j++;
            continue;
          }
          blankChar(j);
          j++;
        }
        continue;
      }
      blankChar(j);
      j++;
    }
    return j;
  };

  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { out[i] = src[i]; i++; }
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      out[i] = src[i]; out[i + 1] = src[i + 1];
      i += 2;
      while (i + 1 < n && !(src[i] === '*' && src[i + 1] === '/')) { out[i] = src[i]; i++; }
      if (i + 1 < n) { out[i] = src[i]; out[i + 1] = src[i + 1]; i += 2; }
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = scanQuotedString(i, ch);
      continue;
    }
    if (ch === '`') {
      i = scanTemplate(i);
      continue;
    }
    out[i] = ch;
    i++;
  }

  return out.join('');
}
