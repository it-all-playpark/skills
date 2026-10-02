#!/usr/bin/env node
// gmail-receipts.bats 用: render 済みディレクトリの config.gs + Code.gs を、
// 偽の Gmail / Drive / MailApp / ScriptApp に対して実行し、結果を JSON で出す。
//
// Usage: gas-sim.js <render-dir> <collect|dryRun|setup> <state.json>
//   state.json: {
//     folderId: "存在する Drive ルートフォルダの ID",
//     existing: ["2026/09/既にあるファイル名", ...],
//     triggers: ["既存トリガーの関数名", ...],
//     threads: [{ id, labels: [..], inbox: true,
//                 messages: [{ date: ISO8601, from, subject, body,
//                              attachments: [{ name, inline: false }] }] }]
//   }
// 出力: { files, archived, mails, triggers, logs, threadCalls, error }
// 環境変数 SIM_TICK_MS: Date.now() を呼ぶたびに時計をこの分だけ進める(時間切れの再現用)。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const [dir, fn, stateFile] = process.argv.slice(2);
const tick = Number(process.env.SIM_TICK_MS || 0);
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const threads = state.threads || [];
const archived = [];
const mails = [];
const logs = [];
let threadCalls = 0;
let triggers = (state.triggers || []).map((h) => ({ handler: h }));

const labelNames = [...new Set(threads.flatMap((t) => t.labels))];
const labelId = (name) => `Label_${labelNames.indexOf(name)}`;

// Drive: パス文字列 → 種別。フォルダは末尾 / なし
const drive = new Map([['', 'folder']]);
for (const p of state.existing || []) {
  const parts = p.split('/');
  for (let i = 1; i < parts.length; i++) drive.set(parts.slice(0, i).join('/'), 'folder');
  drive.set(p, 'file');
}
const join = (a, b) => (a ? `${a}/${b}` : b);
const iter = (items) => ({ hasNext: () => items.length > 0, next: () => items.shift() });
function folder(p) {
  return {
    getFoldersByName: (n) => iter(drive.get(join(p, n)) === 'folder' ? [folder(join(p, n))] : []),
    getFilesByName: (n) => iter(drive.get(join(p, n)) === 'file' ? [{}] : []),
    createFolder(n) {
      drive.set(join(p, n), 'folder');
      return folder(join(p, n));
    },
    createFile(blob) {
      if (drive.has(join(p, blob.name))) throw new Error(`duplicate file: ${join(p, blob.name)}`);
      drive.set(join(p, blob.name), 'file');
      return {};
    },
  };
}

const blob = (name, type) => ({
  name,
  type,
  setName(n) {
    this.name = n;
    return this;
  },
  getAs(t) {
    return blob(this.name, t);
  },
});

function message(m) {
  return {
    getDate: () => new Date(m.date),
    getFrom: () => m.from || 'shop@example.com',
    getSubject: () => m.subject || '',
    getBody: () => m.body || '<p>body</p>',
    getAttachments({ includeInlineImages } = {}) {
      return (m.attachments || [])
        .filter((a) => includeInlineImages !== false || !a.inline)
        .map((a) => ({ getName: () => a.name, copyBlob: () => blob(a.name, 'application/pdf') }));
    },
  };
}

const Gmail = {
  Users: {
    Labels: {
      list: () => ({ labels: [{ id: 'INBOX', name: 'INBOX' }, ...labelNames.map((n) => ({ id: labelId(n), name: n }))] }),
    },
    Threads: {
      list(user, { labelIds, maxResults, pageToken }) {
        if (user !== 'me' || !(maxResults > 0 && maxResults <= 500)) throw new Error(`bad list args: ${user} ${maxResults}`);
        const hits = threads.filter((t) =>
          labelIds.every((id) => (id === 'INBOX' ? t.inbox && !archived.includes(t.id) : t.labels.some((n) => labelId(n) === id))),
        );
        const start = Number(pageToken || 0);
        const page = hits.slice(start, start + maxResults);
        const next = start + maxResults < hits.length ? String(start + maxResults) : undefined;
        return { threads: page.length ? page.map((t) => ({ id: t.id })) : undefined, nextPageToken: next };
      },
    },
  },
};

const GmailApp = {
  getThreadById(id) {
    threadCalls++;
    const t = threads.find((x) => x.id === id);
    return { getMessages: () => t.messages.map(message), moveToArchive: () => archived.push(id) };
  },
};

const DriveApp = {
  getFolderById(id) {
    if (id !== state.folderId) throw new Error(`No item with the given ID could be found: ${id}`);
    return folder('');
  },
};

// Asia/Tokyo 固定(UTC+9、夏時間なし)。Code.gs が使う書式だけ受ける
const Utilities = {
  formatDate(d, tz, fmt) {
    if (tz !== 'Asia/Tokyo' || fmt !== 'yyyy-MM-dd') throw new Error(`unsupported formatDate: ${tz} ${fmt}`);
    return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  },
  newBlob: (data, type, name) => blob(name, type),
};

const triggerBuilder = (handler) => ({
  timeBased: () => ({
    everyDays: () => ({
      atHour: (h) => ({ create: () => triggers.push({ handler, hour: h }) }),
    }),
  }),
});

const ctx = {
  Gmail,
  GmailApp,
  DriveApp,
  Utilities,
  Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
  MailApp: { sendEmail: (to, subject, body) => mails.push({ to, subject, body }) },
  ScriptApp: {
    getProjectTriggers: () => [...triggers],
    deleteTrigger: (t) => (triggers = triggers.filter((x) => x !== t)),
    newTrigger: triggerBuilder,
  },
  console: { log: (s) => logs.push(String(s)) },
};
vm.createContext(ctx);
if (tick > 0) vm.runInContext(`{ let t = Date.now(); Date.now = () => (t += ${tick}); }`, ctx);
vm.runInContext(fs.readFileSync(path.join(dir, 'config.gs'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(dir, 'Code.gs'), 'utf8'), ctx);
let error = null;
try {
  vm.runInContext(`${fn}()`, ctx);
} catch (e) {
  error = e.message;
}

const existing = new Set(state.existing || []);
const files = [...drive].filter(([p, kind]) => kind === 'file' && !existing.has(p)).map(([p]) => p).sort();
process.stdout.write(JSON.stringify({ files, archived, mails, triggers, logs, threadCalls, error }) + '\n');
