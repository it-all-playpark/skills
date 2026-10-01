/**
 * Gmail 自動クリーンアップ
 *
 * 毎日1回、CONFIG.queries に該当し retentionDays を過ぎたスレッドをゴミ箱へ移す
 * (ゴミ箱は30日で Gmail が完全削除する。それまでは復元可能)。
 * CONFIG は deploy 時に config.gs として生成される(gmail-cleanup.sh render)。
 *
 * 安全策:
 *   - 各クエリに `older_than:<retentionDays>d -is:starred` を必ず付ける
 *   - スター付きは対象外
 *   - protectedLabelPrefixes のラベル(とその配下)が付いたスレッドは対象外
 *   - スレッド内の最新メールが retentionDays 以内なら対象外(古いスレッドに新着返信があるケース)
 *
 * セットアップ: setup() を一度だけ手動実行する(権限承認 + 日次トリガー作成)。
 * 動作確認: dryRun() で削除せずに件数と件名サンプルをログに出す。
 */

const BATCH_SIZE = 100; // GmailApp.moveThreadsToTrash の上限
const TIME_BUDGET_MS = 5 * 60 * 1000; // 実行上限6分に対する余裕

function cleanup() {
  run_(false);
}

function dryRun() {
  run_(true);
}

function setup() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'cleanup')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('cleanup').timeBased().everyDays(1).atHour(4).create();
  console.log('日次トリガー(毎日4時台)を作成しました');
}

function run_(dry) {
  const days = CONFIG.retentionDays;
  const startedAt = Date.now();
  const cutoff = new Date(startedAt - days * 24 * 60 * 60 * 1000);
  const queries = CONFIG.queries.map((q) => `${q} older_than:${days}d -is:starred`);
  let total = 0;
  let timedOut = false;

  for (const query of queries) {
    let offset = 0; // 保護して残したスレッドの分だけ検索開始位置をずらす
    let trashed = 0;
    const samples = [];

    while (true) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) {
        timedOut = true;
        break;
      }
      const threads = GmailApp.search(query, offset, BATCH_SIZE);
      if (threads.length === 0) break;

      const targets = threads.filter((t) => isDeletable_(t, cutoff));
      offset += threads.length - targets.length;

      if (dry) {
        targets.slice(0, 10 - samples.length).forEach((t) => samples.push(t.getFirstMessageSubject()));
        trashed += targets.length;
        offset += targets.length; // dry run では消えないので先へ進める
      } else if (targets.length > 0) {
        GmailApp.moveThreadsToTrash(targets);
        trashed += targets.length;
      }
      if (threads.length < BATCH_SIZE) break;
    }

    console.log(`${dry ? '[dry-run] ' : ''}${query}: ${trashed} threads`);
    if (dry && samples.length > 0) console.log('  例: ' + samples.join(' / '));
    total += trashed;
    if (timedOut) break;
  }

  console.log(`${dry ? '[dry-run] ' : ''}合計 ${total} threads${timedOut ? '(時間切れ。残りは次回実行で処理)' : ''}`);
}

function isDeletable_(thread, cutoff) {
  if (thread.hasStarredMessages()) return false;
  if (thread.getLastMessageDate() > cutoff) return false;
  return !thread.getLabels().some((label) => {
    const name = label.getName();
    return CONFIG.protectedLabelPrefixes.some((p) => name === p || name.startsWith(p + '/'));
  });
}
