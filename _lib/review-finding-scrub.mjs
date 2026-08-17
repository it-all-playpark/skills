// review-finding-scrub: pr-reviewer が返す blocking finding（review.blocking[].description/suggestion）を
// fix agent へのプロンプトに埋め込む前に決定論スクラブする純関数群。issue #503。
//
// 背景: pr-reviewer の suggestion がメタレベル指示（『今後の fix prompt には〜と書くな』
// 『分類器に検知されるため〜』等）を含むと、fix_loop 経路（pr-iterate.js の issuesText 組み立て）
// で無加工のまま fix agent への実行指示に変換されてしまう。_lib/block-routing.mjs の
// scrubBlockingDetail（issue #448、guard 迂回コマンド列の遮断）と同 precedent の、別脅威モデル向け
// チョークポイント。
//
// W7 正当化クラス: incentive-structural（永続・撤去禁止）。suggestion は fix prompt へ構造的に
// 埋め込まれるため、メタ指示が実行指示化される incentive/構造要因はモデル能力に非依存
// （賢いモデルほど巧妙なメタ指示を書き分け得るため、モデル世代が進んでも撤去しない）。
//
// backtick-span を redact しない理由（#448 との設計上の分岐）: #448 の対象（blocking_reason.detail）は
// guard 迂回コマンド列であり backtick 内容が常にノイズだったが、review suggestion は
// `parseInput` のようなコード識別子を正当に含む object-level 指示が大半を占める。backtick-span を
// 一律 redact すると fix agent が対象を特定できず fix 品質が壊滅するため、コマンド系パターン
// （subshell / URL / && 連結行 / 行頭コマンド）と、閉じたメタ語彙の文単位 redaction のみを行う。
//
// 設計根拠（文単位の丸ごと置換を選ぶ理由）: メタ指示を含む文は丸ごと [REDACTED-META] に置換する
// （内容の伝播遮断）。trigger 語だけを抜いて指示本体の文を残す方式は採らない —
// 遮断機構自体が「どの語を避ければ通るか」を教える回避装置になってしまうため。
//
// fail-toward-redaction: この repo は meta-repo であり、正当な object-level suggestion が
// 『prompt』『迂回』等の語に言及し得る（例: 本 issue 自身の修正指示）。誤検知は redaction 側に
// 倒す。severity/file/line は常に保持されるため、redaction されても fix agent は対象を特定できる。
//
// INLINE COPY POLICY: 本ファイルは tools/sync-inlines.mjs --write で pr-iterate.js へ全文 inline
// 生成される。直接 workflow 側を編集しない。全文一致は _lib/workflow-inlines.sync.test.mjs が CI 保証。

const SUBSHELL_SPAN_RE = /\$\([^)]*\)/g
const URL_RE = /https?:\/\/\S+/g
const CHAINED_LINE_RE = /^.*&&.*$/gm
const COMMAND_PREFIX_RE = /^(git|gh|sh|bash|node|npm|curl|wget|ssh|scp|rsync)\s.*$/gm

// 閉じた高精度メタ語彙。分類器/hook/guard の存在・検知・回避手順そのものへの言及、および
// 「将来の prompt/システムプロンプトに何を書くか」という meta-level な指示の定型を対象にする。
const META_VOCAB_RE = /分類器|classifier|excludedCommands|起動形|bare ?形|システムプロンプト|system prompt|(プロンプト|prompt)\s*(に|へ|には)[^。]*(書|記載|含め)|検知[^。]*(回避|されな|されるため)|回避手順|迂回|(guard|hook|ガード)[^。]*(無効|外|迂回)|(agent|subagent|エージェント)\s*(への|に対する)指示/i

// 『。』と改行で文に分割し、メタ語彙にマッチする文だけを丸ごと [REDACTED-META] に置換して再結合する。
function scrubMetaSentences(text) {
  const parts = text.split(/(。|\n)/)
  const out = parts.map((part) => {
    if (part === '。' || part === '\n') return part
    return META_VOCAB_RE.test(part) ? '[REDACTED-META]' : part
  })
  return out.join('')
}

export function scrubReviewFindingText(text) {
  let scrubbed = String(text)
  scrubbed = scrubbed.replace(SUBSHELL_SPAN_RE, '[REDACTED-CMD]')
  scrubbed = scrubbed.replace(URL_RE, '[REDACTED-CMD]')
  scrubbed = scrubbed.replace(CHAINED_LINE_RE, '[REDACTED-CMD]')
  scrubbed = scrubbed.replace(COMMAND_PREFIX_RE, '[REDACTED-CMD]')
  scrubbed = scrubMetaSentences(scrubbed)
  scrubbed = scrubbed.replace(/\s+/g, ' ').trim()
  scrubbed = scrubbed.slice(0, 500)
  return scrubbed === '' ? '[REDACTED]' : scrubbed
}

// pr-iterate.js の fix_loop 経路（issue #503 対象）で issuesText を組み立てる。現行フォーマット
// （`- [${severity}] ${file}:${line} ${description} → ${suggestion}`）を維持しつつ、description/
// suggestion のみをスクラブする。severity/file/line は構造フィールドなので素通しする。
export function buildFixIssuesText(blocking) {
  return blocking
    .map((x) => `- [${x.severity}] ${x.file ?? ''}${x.line ? ':' + x.line : ''} ${scrubReviewFindingText(x.description)}${x.suggestion ? ' → ' + scrubReviewFindingText(x.suggestion) : ''}`)
    .join('\n')
}
