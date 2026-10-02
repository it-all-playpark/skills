/**
 * Gmail 領収書の Drive 保存
 *
 * 毎日1回、受信トレイにある CONFIG.label (とその配下) のラベル付きスレッドを
 * Drive の CONFIG.folderId/YYYY/MM/ に保存し、スレッドをアーカイブする。
 * ラベルは Gmail のフィルタで付ける。配下ラベル名が発行元としてファイル名に入る:
 *   領収書/AWS の添付 invoice.pdf → 2026/09/2026-09-12_AWS_invoice.pdf
 * 添付が無いメールは本文を PDF にする(件名.pdf)。インライン画像(ロゴ等)は保存しない。
 * CONFIG は deploy 時に config.gs として生成される(gmail-receipts.sh render)。
 *
 * 同名ファイルが月フォルダにあれば保存しない。途中で止まってアーカイブ前のスレッドが
 * 翌日もう一度処理されても、二重に保存されない。
 *
 * セットアップ: setup() を一度だけ手動実行する(権限承認 + 日次トリガー作成)。
 * 動作確認: dryRun() で保存せずに対象と保存名をログに出す。
 */

const PAGE_SIZE = 100;
const TIME_BUDGET_MS = 4 * 60 * 1000; // 実行上限6分に対し、1スレッドの処理が長引いても収まる余裕
const TRIGGER_HOUR = 0;
const MAX_NAME_LENGTH = 100;

function collect() {
  run_(false);
}

function dryRun() {
  run_(true);
}

// このプロジェクト専用なので既存のトリガーは全部消して作り直す(旧コードの関数名のトリガーも残さない)
function setup() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('collect').timeBased().everyDays(1).atHour(TRIGGER_HOUR).create();
  console.log(`日次トリガー(毎日${TRIGGER_HOUR}時台)を作成しました`);
}

function run_(dry) {
  const startedAt = Date.now();
  const outOfTime = () => Date.now() - startedAt > TIME_BUDGET_MS;
  const prefix = dry ? '[dry-run] ' : '';
  const saved = [];
  let timedOut = false;

  try {
    const root = DriveApp.getFolderById(CONFIG.folderId);
    const labels = targetLabels_();
    if (labels.length === 0) throw new Error(`ラベル「${CONFIG.label}」がありません`);

    const seen = new Set();
    outer: for (const { id, vendor } of labels) {
      for (const threadId of inboxThreadIds_(id)) {
        if (seen.has(threadId)) continue;
        seen.add(threadId);
        if (outOfTime()) {
          timedOut = true;
          break outer;
        }
        const thread = GmailApp.getThreadById(threadId);
        for (const message of thread.getMessages()) {
          saveMessage_(message, vendor, root, dry).forEach((name) => {
            console.log(`${prefix}${name}`);
            saved.push(name);
          });
        }
        if (!dry) thread.moveToArchive();
      }
    }
  } catch (e) {
    if (!dry) {
      MailApp.sendEmail(
        CONFIG.notifyEmail,
        '領収書の保存中にエラーが発生しました',
        [`エラー内容: ${e.message}`, '', `ここまでに保存: ${saved.length} 件`, ...saved].join('\n'),
      );
    }
    throw e;
  }

  const note = timedOut ? '(時間切れ。残りは次回実行で処理)' : '';
  console.log(`${prefix}合計 ${saved.length} 件${note}`);
  if (!dry && saved.length > 0) {
    MailApp.sendEmail(CONFIG.notifyEmail, '領収書を保存しました', [`保存: ${saved.length} 件${note}`, ...saved].join('\n'));
  }
}

// CONFIG.label とその配下のラベル。配下を先に並べる(親と配下の両方が付いたスレッドで発行元を取りこぼさない)
function targetLabels_() {
  const top = CONFIG.label;
  return (Gmail.Users.Labels.list('me').labels || [])
    .filter((l) => l.name === top || l.name.startsWith(top + '/'))
    .map((l) => ({ id: l.id, vendor: l.name.slice(top.length + 1).replace(/\//g, '-') }))
    .sort((a, b) => (a.vendor === '') - (b.vendor === ''));
}

// labelIds は AND なので、そのラベルが付いていて受信トレイにあるスレッドだけが返る
function inboxThreadIds_(labelId) {
  const ids = [];
  let pageToken;
  do {
    const res = Gmail.Users.Threads.list('me', { labelIds: [labelId, 'INBOX'], maxResults: PAGE_SIZE, pageToken });
    (res.threads || []).forEach((t) => ids.push(t.id));
    pageToken = res.nextPageToken;
  } while (pageToken);
  return ids;
}

// 保存したファイル名を返す(同名が既にあるものは含めない)
function saveMessage_(message, vendor, root, dry) {
  const date = Utilities.formatDate(message.getDate(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const [year, month] = date.split('-');
  const head = [date, vendor].filter((s) => s !== '').join('_') + '_';

  const attachments = message.getAttachments({ includeInlineImages: false });
  const files =
    attachments.length > 0
      ? attachments.map((a) => ({ name: head + safeName_(a.getName()), blob: () => a.copyBlob() }))
      : [{ name: head + safeName_(message.getSubject() || '(件名なし)') + '.pdf', blob: () => bodyPdf_(message) }];

  const folder = dry ? findFolder_(findFolder_(root, year), month) : getOrCreateFolder_(getOrCreateFolder_(root, year), month);
  const fresh = files.filter((f) => !(folder && folder.getFilesByName(f.name).hasNext()));
  if (!dry) fresh.forEach((f) => folder.createFile(f.blob().setName(f.name)));
  return fresh.map((f) => `${year}/${month}/${f.name}`);
}

function bodyPdf_(message) {
  const header = [`Date: ${message.getDate()}`, `From: ${message.getFrom()}`, `Subject: ${message.getSubject()}`]
    .map((line) => escapeHtml_(line))
    .join('<br>');
  const html = `<p>${header}</p><hr>${message.getBody()}`;
  return Utilities.newBlob(html, 'text/html', 'message.html').getAs('application/pdf');
}

function safeName_(name) {
  return name.replace(/[\/\\\u0000-\u001f]/g, '_').trim().slice(0, MAX_NAME_LENGTH);
}

function escapeHtml_(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function findFolder_(parent, name) {
  if (!parent) return null;
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : null;
}

function getOrCreateFolder_(parent, name) {
  return findFolder_(parent, name) || parent.createFolder(name);
}
