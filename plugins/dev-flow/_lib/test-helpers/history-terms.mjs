// history-terms.mjs — docs / 手書きコメントの「経緯記述」検出辞書（rules hygiene と workflow コメント hygiene が共用）
export const HISTORY_PATTERNS = [
  { name: 'issue-number', re: /issue\s*#\d+/ },
  { name: 'bare-issue-number', re: /(^|[^\w&])#\d{2,4}\b/ },
  { name: '旧', re: /(^|[^復新])旧([:：\s]|版|仕様|の)/ },
  { name: '廃止', re: /廃止/ },
  { name: '従来', re: /従来/ },
  { name: '置換済', re: /置換(した|済み)/ },
  { name: 'A/B実測', re: /A\/B\s*実測/ },
];

// text に一致した pattern 名の配列を返す（一致なしは []）
export function findHistoryTerms(text) {
  return HISTORY_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}
