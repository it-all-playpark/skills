#!/usr/bin/env node
// gmail-cleanup.bats 用: render 済みディレクトリの config.gs + Code.gs を、
// 偽の GmailApp に対して実行し、検索クエリとゴミ箱へ移したスレッドを JSON で出す。
//
// Usage: gas-sim.js <render-dir> <cleanup|dryRun> <threads.json>
//   threads.json: [{ id, query, starred, ageDays, labels: [..] }]
//   query は「どの CONFIG.queries 要素の検索に引っかかるか」。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const [dir, fn, threadsFile] = process.argv.slice(2);
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const trashed = new Set();
const searched = [];

const threads = JSON.parse(fs.readFileSync(threadsFile, 'utf8')).map((t) => ({
  ...t,
  hasStarredMessages: () => !!t.starred,
  getLastMessageDate: () => new Date(now - t.ageDays * DAY),
  getLabels: () => (t.labels || []).map((name) => ({ getName: () => name })),
  getFirstMessageSubject: () => `subject-${t.id}`,
}));

const GmailApp = {
  search(query, offset, max) {
    searched.push(query);
    return threads
      .filter((t) => !trashed.has(t.id) && query.startsWith(t.query + ' '))
      .slice(offset, offset + max);
  },
  moveThreadsToTrash(ts) {
    ts.forEach((t) => trashed.add(t.id));
  },
};

const ctx = { GmailApp, console: { log: () => {} } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(dir, 'config.gs'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(dir, 'Code.gs'), 'utf8'), ctx);
vm.runInContext(`${fn}()`, ctx);

process.stdout.write(JSON.stringify({ searched: [...new Set(searched)], trashed: [...trashed].sort() }) + '\n');
