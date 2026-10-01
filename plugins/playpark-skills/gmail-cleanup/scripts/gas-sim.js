#!/usr/bin/env node
// gmail-cleanup.bats 用: render 済みディレクトリの config.gs + Code.gs を、
// 偽の Gmail Advanced Service に対して実行し、検索クエリとゴミ箱へ移したメールを JSON で出す。
//
// Usage: gas-sim.js <render-dir> <cleanup|dryRun> <messages.json>
//   messages.json: [{ id, threadId?, query, starred, ageDays, labels: [..], trashed }]
//   query は「どの CONFIG.queries 要素の検索に引っかかるか」。threadId 省略時は id。
// 環境変数 SIM_TICK_MS: Date.now() を呼ぶたびに時計をこの分だけ進める(時間切れの再現用)。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const [dir, fn, messagesFile] = process.argv.slice(2);
const DAY = 24 * 60 * 60 * 1000;
const tick = Number(process.env.SIM_TICK_MS || 0);
const searched = [];
let listCalls = 0;
let modifyCalls = 0;

const messages = JSON.parse(fs.readFileSync(messagesFile, 'utf8')).map((m) => ({
  threadId: m.id,
  labels: [],
  ...m,
}));
const labelNames = [...new Set(messages.flatMap((m) => m.labels))];
const labelId = (name) => `Label_${labelNames.indexOf(name)}`;

// 本物の Gmail 検索のうち Code.gs が使う形だけを解釈する。知らない形は落とす。
function matches(m, q) {
  const rest = [];
  for (const tok of q.split(' ')) {
    let r;
    if (tok === 'is:starred') { if (!m.starred) return false; }
    else if (tok === '-is:starred') { if (m.starred) return false; }
    else if ((r = tok.match(/^older_than:(\d+)d$/))) { if (!(m.ageDays > Number(r[1]))) return false; }
    else if ((r = tok.match(/^newer_than:(\d+)d$/))) { if (!(m.ageDays <= Number(r[1]))) return false; }
    else rest.push(tok);
  }
  return rest.length === 0 || rest.join(' ') === m.query;
}

const Gmail = {
  Users: {
    Labels: {
      list: () => ({ labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, ...labelNames.map((n) => ({ id: labelId(n), name: n, type: 'user' }))] }),
    },
    Messages: {
      list(user, { q, labelIds, maxResults, pageToken, includeSpamTrash }) {
        if (user !== 'me' || !(maxResults > 0 && maxResults <= 500)) throw new Error(`bad list args: ${user} ${maxResults}`);
        listCalls++;
        if (q) searched.push(q);
        const hits = messages.filter(
          (m) =>
            (includeSpamTrash || !m.trashed) &&
            (!q || matches(m, q)) &&
            (labelIds || []).every((id) => m.labels.some((n) => labelId(n) === id)),
        );
        const start = Number(pageToken || 0);
        const page = hits.slice(start, start + maxResults);
        const next = start + maxResults < hits.length ? String(start + maxResults) : undefined;
        return { messages: page.length ? page.map((m) => ({ id: m.id, threadId: m.threadId })) : undefined, nextPageToken: next };
      },
      batchModify({ ids, addLabelIds }, user) {
        if (user !== 'me' || ids.length > 1000) throw new Error(`bad batchModify args: ${user} ${ids.length}`);
        modifyCalls++;
        if ((addLabelIds || []).includes('TRASH')) messages.filter((m) => ids.includes(m.id)).forEach((m) => (m.trashed = true));
      },
      get: (user, id) => ({ payload: { headers: [{ name: 'Subject', value: `subject-${id}` }] } }),
    },
  },
};

const ctx = { Gmail, console: { log: () => {} } };
vm.createContext(ctx);
if (tick > 0) vm.runInContext(`{ let t = Date.now(); Date.now = () => (t += ${tick}); }`, ctx);
vm.runInContext(fs.readFileSync(path.join(dir, 'config.gs'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(dir, 'Code.gs'), 'utf8'), ctx);
vm.runInContext(`${fn}()`, ctx);

const trashed = messages.filter((m) => m.trashed).map((m) => m.id).sort();
process.stdout.write(JSON.stringify({ searched: [...new Set(searched)], trashed, listCalls, modifyCalls }) + '\n');
