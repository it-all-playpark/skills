/**
 * Gmail 自動クリーンアップ
 *
 * 毎日1回、CONFIG.queries に該当し retentionDays を過ぎたメールをゴミ箱へ移す
 * (ゴミ箱は30日で Gmail が完全削除する。それまでは復元可能)。
 * CONFIG は deploy 時に config.gs として生成される(gmail-cleanup.sh render)。
 *
 * Gmail API の Advanced Service (appsscript.json の enabledAdvancedServices) で ID だけを扱う。
 * GmailApp でスレッドごとに状態を問い合わせると 1スレッドあたり RPC 3回かかり、
 * 溜まったアカウントでは6分の実行上限を超えて落ちるため。
 *
 * 安全策:
 *   - 各クエリに `older_than:<retentionDays>d -is:starred` を必ず付ける
 *   - 次のどれかに当たるメールを1通でも含むスレッドは丸ごと残す(先に threadId を集めて除外する)
 *     - スター付き
 *     - retentionDays 以内(古いスレッドに新着返信があるケース)
 *     - protectedLabelPrefixes のラベル(とその配下)
 *   - 残すスレッドの収集が時間内に終わらなければ、何もゴミ箱へ移さない
 *
 * セットアップ: setup() を一度だけ手動実行する(権限承認 + 日次トリガー作成)。
 * 動作確認: dryRun() で削除せずに件数と件名サンプルをログに出す。
 */

const PAGE_SIZE = 500; // Gmail.Users.Messages.list の上限
const MODIFY_BATCH = 1000; // Gmail.Users.Messages.batchModify の上限
const TIME_BUDGET_MS = 4 * 60 * 1000; // 実行上限6分に対し、1回の API 呼び出しが長引いても収まる余裕

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
  const outOfTime = () => Date.now() - startedAt > TIME_BUDGET_MS;
  const prefix = dry ? '[dry-run] ' : '';

  const keep = keepThreadIds_(days, outOfTime);
  if (keep === null) {
    console.log(`${prefix}残すスレッドの収集が時間内に終わらなかったため、何もしませんでした`);
    return;
  }

  let total = 0;
  let timedOut = false;
  for (const q of CONFIG.queries) {
    const query = `${q} older_than:${days}d -is:starred`;
    const ids = [];
    timedOut = !listMessages_({ q: query }, outOfTime, (m) => {
      if (!keep.has(m.threadId)) ids.push(m.id);
    });

    let trashed = 0;
    if (dry) {
      trashed = ids.length;
      const samples = ids.slice(0, 10).map(subject_);
      if (samples.length > 0) console.log('  例: ' + samples.join(' / '));
    } else {
      // 集めた分は時間切れでも移す(batchModify は1回が軽い)
      for (let i = 0; i < ids.length; i += MODIFY_BATCH) {
        const chunk = ids.slice(i, i + MODIFY_BATCH);
        Gmail.Users.Messages.batchModify({ ids: chunk, addLabelIds: ['TRASH'] }, 'me');
        trashed += chunk.length;
      }
    }
    console.log(`${prefix}${query}: ${trashed} messages`);
    total += trashed;
    if (timedOut) break;
  }

  console.log(`${prefix}合計 ${total} messages${timedOut ? '(時間切れ。残りは次回実行で処理)' : ''}`);
}

// 残すスレッドの threadId 集合。時間内に集めきれなければ null(不完全な集合で消さない)。
function keepThreadIds_(days, outOfTime) {
  const keep = new Set();
  const add = (m) => keep.add(m.threadId);
  const searches = [{ q: 'is:starred' }, { q: `newer_than:${days}d` }];
  protectedLabelIds_().forEach((id) => searches.push({ labelIds: [id] }));
  for (const params of searches) {
    // ゴミ箱・迷惑メールにある新しい返信やスター付きも「残す理由」に数える
    if (!listMessages_({ ...params, includeSpamTrash: true }, outOfTime, add)) return null;
  }
  return keep;
}

function protectedLabelIds_() {
  const labels = Gmail.Users.Labels.list('me').labels || [];
  return labels
    .filter((l) => CONFIG.protectedLabelPrefixes.some((p) => l.name === p || l.name.startsWith(p + '/')))
    .map((l) => l.id);
}

// 全ページを走査して各メール {id, threadId} を onMessage に渡す。時間切れなら false。
function listMessages_(params, outOfTime, onMessage) {
  let pageToken;
  do {
    if (outOfTime()) return false;
    const res = Gmail.Users.Messages.list('me', { ...params, maxResults: PAGE_SIZE, pageToken });
    (res.messages || []).forEach(onMessage);
    pageToken = res.nextPageToken;
  } while (pageToken);
  return true;
}

function subject_(id) {
  const msg = Gmail.Users.Messages.get('me', id, { format: 'metadata', metadataHeaders: ['Subject'] });
  const header = ((msg.payload && msg.payload.headers) || []).find((h) => h.name === 'Subject');
  return header ? header.value : '(件名なし)';
}
