#!/usr/bin/env node
// ui-verify-stack.mjs - project が宣言した ui_verify の up / down を起動・待機・片付けする汎用ランナー。
//
// dev-flow は DB や dev server の種類を知らない。skill-config.json の "dev-flow".ui_verify に
// project が宣言した up（run: 一回限り / serve: 常駐、宣言順）を実行し、serve の ready を待つだけ。
// 宣言コマンドは呼び出し元と同じ sandbox 内で実行される（本スクリプトを excludedCommands に入れない）。
//
// プロセスモデル（sandbox の実測に基づく）:
//   - Bash 呼び出しを越えて生きるのは nohup / setsid した子だけでなく、detached で起こした子全般。
//   - ただし別の Bash 呼び出しからは kill できない（Seatbelt が別 sandbox 実体への signal を EPERM にする。
//     ps / pgrep / pkill も sysmond に届かず使えない）。
//   → up は detached な supervisor を 1 本起こし、service はすべて supervisor の子（各自 process group）にする。
//     止めるときは state dir に stop file を置き、supervisor が自分の子を process group ごと止める。
//     teardown が呼ばれなくても ready から ttl_sec で supervisor が自ら片付ける（ready 前は up_ceiling_sec + ttl_sec）。
//
// non-blocking / fail-open contract（旧 ui-verify-server と同じ）:
//   - up / wait / down / status は常に exit 0 + stdout に JSON 1 行。usage error のみ exit 2。
//   - down は冪等（state が無ければ no-op）。
//   - up / wait は 1 回の Bash 呼び出しに収まる --wait-sec だけ待ち、まだ起動中なら phase:"starting" を返す。
//     呼び出し側は wait_ceiling_sec（up の timeout_sec 合計 + 余裕）まで wait を繰り返す。
//
// Usage:
//   ui-verify-stack up --worktree <abs> --state-dir <abs> [--issue <n>] [--config <json>] [--wait-sec <n=480>]
//   ui-verify-stack wait --state-dir <abs> [--wait-sec <n=480>]
//   ui-verify-stack down --state-dir <abs> [--timeout-sec <n=60>]
//   ui-verify-stack status --state-dir <abs>
//   ui-verify-stack login --state-dir <abs> --session <name>
//   ui-verify-stack smoke --state-dir <abs> --session <name>
//
// login / smoke は LLM を挟まない決定的な手順。宣言された agent-browser の argv をシェルを通さず
// 実行し、smoke は open → wait networkidle → errors / console（level=error、console_ignore で除外）
// → screenshot の結果を ui-verifier と同じ UIVERIFY 形で返す。LLM の ui-verifier は scenario だけに使う。
// agent-browser のセッション（daemon）は Bash 呼び出しをまたいで残る（--session で分離）。
// login / smoke の失敗のうち、アプリの変更と無関係な環境起因のもの（stack が使えない・agent-browser が
// 無い・URL に接続できない）は出力に env_failure:true を付ける。workflow はこれを findings ではなく
// failed_open（fail-open で skip）に振り分ける。ページに届いた後の失敗はアプリ起因として従来どおり返す。
//   （内部）ui-verify-stack supervise --state-dir <abs>

import { spawn, execFileSync } from 'node:child_process';
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expandUiVerifyPlaceholders, uiVerifyPorts, validateUiVerifyConfig,
} from '../../_lib/ui-verify.mjs';

const SELF = fileURLToPath(import.meta.url);
const STOP_GRACE_MS = 10_000;
// 状態確認（ready / stop file / supervisor の生死）の間隔。UI_VERIFY_POLL_MS は test が stack の
// up → down を速く回すためだけのもの。未設定・不正値なら 500ms（実運用の既定）。
const DEFAULT_POLL_MS = 500;
export const POLL_MS = Number(process.env.UI_VERIFY_POLL_MS) > 0 ? Number(process.env.UI_VERIFY_POLL_MS) : DEFAULT_POLL_MS;
const PORT_PROBE_LIMIT = 50;
// up / wait が 1 回で待つ秒数。workflow の 1 回の Bash 呼び出し（上限 600 秒）に、前回 stack の停止
// （最大 30 秒）や port 割り当てを足しても収まる値にする。
export const DEFAULT_WAIT_SEC = 480;
// up 全体の総上限 = up の timeout_sec 合計 + この余裕（step 間の起動・停止のオーバーヘッド分）。
export const UP_CEILING_MARGIN_SEC = 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// state dir
// ---------------------------------------------------------------------------

export function statePaths(stateDir) {
  return {
    spec: join(stateDir, 'spec.json'),
    stack: join(stateDir, 'stack.json'),
    stop: join(stateDir, 'stop'),
    logs: join(stateDir, 'logs'),
    supervisorLog: join(stateDir, 'logs', 'supervisor.log'),
    envCopied: join(stateDir, 'env-files-copied.json'),
  };
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(path, obj) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

// 別 sandbox 実体のプロセスへの kill(pid, 0) は EPERM になる。EPERM は「存在する」と読む。
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export function loadUiVerifyConfig(worktree, configPath) {
  if (configPath) {
    const raw = readJson(configPath);
    if (raw == null) return { ok: false, error: `--config を JSON として読めない: ${configPath}` };
    return { ok: true, raw };
  }
  for (const rel of ['skill-config.json', '.claude/skill-config.json']) {
    const j = readJson(join(worktree, rel));
    const v = j && j['dev-flow'] && j['dev-flow'].ui_verify;
    if (v !== undefined && v !== null) return { ok: true, raw: v, source: rel };
  }
  return { ok: false, error: 'skill-config.json / .claude/skill-config.json に "dev-flow".ui_verify が無い' };
}

// ---------------------------------------------------------------------------
// ports
// ---------------------------------------------------------------------------

function canBind(port, host) {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', (e) => res(e.code !== 'EADDRINUSE'));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => res(true)));
  });
}

export async function isPortFree(port) {
  return (await canBind(port, '127.0.0.1')) && (await canBind(port, '::'));
}

export async function allocatePorts(cfg, issue) {
  const wanted = uiVerifyPorts(cfg.base_port, issue, cfg.ports);
  const taken = new Set();
  const out = {};
  for (const name of cfg.ports) {
    let p = wanted[name];
    let found = null;
    for (let i = 0; i < PORT_PROBE_LIMIT && p <= 65535; i += 1, p += 1) {
      if (!taken.has(p) && await isPortFree(p)) { found = p; break; }
    }
    if (found == null) return { ok: false, error: `port ${name} の空きが ${wanted[name]} から ${PORT_PROBE_LIMIT} 個先までに無い` };
    taken.add(found);
    out[name] = found;
  }
  return { ok: true, ports: out };
}

// ---------------------------------------------------------------------------
// spec（ports 確定後に placeholder を展開した実行計画）
// ---------------------------------------------------------------------------

function envName(name) {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

export function resolveSpec(cfg, { worktree, stateDir, ports }) {
  const base = { ports, state_dir: stateDir, worktree };
  const base_url = expandUiVerifyPlaceholders(cfg.base_url, base);
  const vars = { ...base, base_url };
  const x = (s) => expandUiVerifyPlaceholders(s, vars);
  const xEnv = (env) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, x(v)]));
  const injected = { UI_VERIFY_STATE_DIR: stateDir, UI_VERIFY_BASE_URL: base_url };
  for (const [n, p] of Object.entries(ports)) injected[`UI_VERIFY_PORT_${envName(n)}`] = String(p);
  const step = (s) => ({
    ...s,
    command: x(s.command),
    cwd: s.cwd ? join(worktree, s.cwd) : worktree,
    env: { ...injected, ...xEnv(cfg.env), ...xEnv(s.env) },
    ...(s.ready ? { ready: Object.fromEntries(Object.entries(s.ready).map(([k, v]) => [k, x(v)])) } : {}),
  });
  return {
    worktree,
    state_dir: stateDir,
    ports,
    base_url,
    smoke_url: base_url + cfg.smoke_path,
    login: cfg.login ? cfg.login.commands.map((c) => c.map(x)) : null,
    console_ignore: cfg.console_ignore,
    ttl_sec: cfg.ttl_sec,
    up_ceiling_sec: cfg.up.reduce((sum, s) => sum + s.timeout_sec, 0) + UP_CEILING_MARGIN_SEC,
    env_files: cfg.env_files,
    up: cfg.up.map(step),
    down: cfg.down.map(step),
  };
}

// ---------------------------------------------------------------------------
// env files（旧 ui-verify-server と同じ: main repo root から gitignored な path にだけコピー）
// ---------------------------------------------------------------------------

function copyEnvFiles(spec, paths, log) {
  const copied = [];
  if (!spec.env_files.length) return copied;
  let mainRoot = null;
  try {
    const common = execFileSync('git', ['-C', spec.worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
    mainRoot = dirname(common);
  } catch { /* 下で warning */ }
  for (const rel of spec.env_files) {
    if (!mainRoot) { log(`warning: main repo root を解決できず env-file ${rel} を skip`); continue; }
    const src = join(mainRoot, rel);
    if (!existsSync(src)) { log(`warning: env-file not found: ${src}`); continue; }
    try {
      execFileSync('git', ['-C', spec.worktree, 'check-ignore', '-q', rel]);
    } catch {
      log(`warning: env-file '${rel}' は worktree で gitignore されていないためコピーしない（secret を commit する経路になる）`);
      continue;
    }
    const dest = join(spec.worktree, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    copied.push(dest);
  }
  writeJsonAtomic(paths.envCopied, copied);
  return copied;
}

function removeCopiedEnvFiles(paths) {
  const list = readJson(paths.envCopied);
  if (!Array.isArray(list)) return;
  for (const f of list) rmSync(f, { force: true });
  rmSync(paths.envCopied, { force: true });
}

// ---------------------------------------------------------------------------
// supervisor
// ---------------------------------------------------------------------------

function checkReadyOnce(ready, logPath) {
  if (ready.http) {
    return fetch(ready.http, { redirect: 'manual', signal: AbortSignal.timeout(3000) })
      .then((r) => r.status < 400)
      .catch(() => false);
  }
  if (ready.tcp) {
    const m = /^(?:(.+):)?(\d+)$/.exec(ready.tcp);
    if (!m) return Promise.resolve(false);
    return new Promise((res) => {
      const sock = net.connect({ host: m[1] || '127.0.0.1', port: Number(m[2]) });
      sock.setTimeout(2000);
      sock.once('connect', () => { sock.destroy(); res(true); });
      sock.once('timeout', () => { sock.destroy(); res(false); });
      sock.once('error', () => res(false));
    });
  }
  let text = '';
  try { text = readFileSync(logPath, 'utf8'); } catch { /* not yet */ }
  return Promise.resolve(new RegExp(ready.log, 'm').test(text));
}

// step は detached（setsid）で起こすので pid == pgid。group 宛てに送れば孫（next-server 等）まで届く。
// reap 済み pid の再利用に当たらないよう、pid 単体宛ては送らない。
function killGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch { /* 既に居ない */ }
}

export async function supervise(stateDir) {
  const paths = statePaths(stateDir);
  const spec = readJson(paths.spec);
  const log = (msg) => process.stderr.write(`[ui-verify-stack ${new Date().toISOString()}] ${msg}\n`);
  if (!spec) { log('spec.json が無い'); return; }

  const startedAt = Date.now();
  // ttl_sec は ready から数える（起動にかかった時間で検証の時間を削らない）。ready までは各 step の
  // timeout_sec（合計 up_ceiling_sec）で上限があるので、ready 前の期限はその上に ttl_sec を足した保険。
  let deadline = startedAt + (spec.up_ceiling_sec + spec.ttl_sec) * 1000;
  const state = {
    phase: 'starting',
    supervisor_pid: process.pid,
    started_at: new Date(startedAt).toISOString(),
    deadline: new Date(deadline).toISOString(),
    ports: spec.ports,
    base_url: spec.base_url,
    smoke_url: spec.smoke_url,
    steps: [...spec.up, ...spec.down].map((s, i) => ({
      name: s.name, kind: s.kind, stage: i < spec.up.length ? 'up' : 'down', status: 'pending',
      log: join(paths.logs, `${String(i).padStart(2, '0')}-${s.name}.log`),
    })),
  };
  const save = () => writeJsonAtomic(paths.stack, state);
  const stepState = (name) => state.steps.find((s) => s.name === name);
  save();

  const children = new Map(); // name -> { child, exited: Promise<number|null> }
  let shuttingDown = null;

  // 停止要求（stop file）と ttl は up の途中でも見る。見ないと up timeout 直後の down が止められず、
  // 停止要求の後に残りの step が起動してしまう。
  const stopRequested = () => {
    if (existsSync(paths.stop)) return 'requested';
    if (Date.now() >= deadline) return 'ttl';
    return null;
  };
  const watchStop = () => {
    let timer = null;
    let cancelled = false;
    const promise = new Promise((res) => {
      const tick = () => {
        if (cancelled) return;
        const r = stopRequested();
        if (r) res(r); else timer = setTimeout(tick, POLL_MS);
      };
      tick();
    });
    return { promise, cancel: () => { cancelled = true; clearTimeout(timer); } };
  };

  const launch = (s) => {
    const st = stepState(s.name);
    const fd = openSync(st.log, 'a');
    const child = spawn('bash', ['-c', s.command], {
      cwd: s.cwd, env: { ...process.env, ...s.env }, detached: true, stdio: ['ignore', fd, fd],
    });
    closeSync(fd);
    const exited = new Promise((res) => {
      child.once('exit', (code, sig) => res(code ?? (sig ? 128 : null)));
      child.once('error', () => res(127));
    });
    st.pid = child.pid;
    st.status = 'running';
    save();
    return { child, exited };
  };

  const stopChild = async (name) => {
    const c = children.get(name);
    if (!c || c.child.exitCode !== null || c.child.signalCode !== null) return;
    killGroup(c.child.pid, 'SIGTERM');
    const done = await Promise.race([c.exited.then(() => true), sleep(STOP_GRACE_MS).then(() => false)]);
    if (!done) { killGroup(c.child.pid, 'SIGKILL'); await Promise.race([c.exited, sleep(2000)]); }
    // 親（bash -c）が先に抜けても process group の残り（孫）を確実に止める
    killGroup(c.child.pid, 'SIGKILL');
  };

  // interruptible（up の step）は停止要求 / ttl で打ち切る。down の step は stop file がある状態で
  // 走るので打ち切らない。戻り値: { ok, stop? }（stop は打ち切り理由）。
  const runOnce = async (s, { interruptible = false } = {}) => {
    const st = stepState(s.name);
    const c = launch(s);
    children.set(s.name, c);
    const watch = interruptible ? watchStop() : null;
    let timeoutTimer = null;
    const code = await Promise.race([
      c.exited,
      new Promise((res) => { timeoutTimer = setTimeout(() => res('timeout'), s.timeout_sec * 1000); }),
      ...(watch ? [watch.promise.then((reason) => ({ stop: reason }))] : []),
    ]);
    clearTimeout(timeoutTimer);
    if (watch) watch.cancel();
    if (code && typeof code === 'object') {
      await stopChild(s.name);
      st.status = 'failed';
      st.error = `stopped (${code.stop})`;
      children.delete(s.name);
      save();
      return { ok: false, stop: code.stop };
    }
    if (code === 'timeout') {
      await stopChild(s.name);
      st.status = 'failed';
      st.error = `timeout after ${s.timeout_sec}s`;
    } else {
      killGroup(c.child.pid, 'SIGKILL'); // run が残した背景プロセスを残さない
      st.exit_code = code;
      st.status = code === 0 ? 'done' : 'failed';
      if (code !== 0) st.error = `exit ${code}`;
    }
    children.delete(s.name);
    save();
    return { ok: st.status === 'done' };
  };

  const serve = async (s) => {
    const st = stepState(s.name);
    const c = launch(s);
    children.set(s.name, c);
    let exitCode;
    c.exited.then((code) => {
      exitCode = code;
      if (st.status === 'ready' && !shuttingDown) { st.status = 'exited'; st.exit_code = code; save(); }
    });
    const until = Date.now() + s.timeout_sec * 1000;
    while (Date.now() < until && !shuttingDown) {
      const stop = stopRequested();
      if (stop) {
        st.status = 'failed'; st.error = `stopped before ready (${stop})`;
        save();
        return { ok: false, stop };
      }
      if (exitCode !== undefined) {
        st.status = 'failed'; st.exit_code = exitCode; st.error = `exited before ready (exit ${exitCode})`;
        save();
        return { ok: false, phase: 'start' };
      }
      if (await checkReadyOnce(s.ready, st.log)) { st.status = 'ready'; save(); return { ok: true }; }
      await sleep(POLL_MS);
    }
    st.status = 'failed';
    st.error = shuttingDown ? 'stopped before ready' : `ready timeout after ${s.timeout_sec}s`;
    save();
    return { ok: false, phase: 'ready' };
  };

  const shutdown = (reason, finalPhase) => {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      state.stop_reason = reason;
      if (state.phase !== 'failed') state.phase = 'stopping';
      save();
      for (const name of [...children.keys()].reverse()) await stopChild(name);
      for (const s of spec.down) {
        // down の失敗は記録のみ（片付けは best-effort で続ける）
        try { await runOnce(s); } catch (e) { stepState(s.name).status = 'failed'; stepState(s.name).error = String(e); }
      }
      removeCopiedEnvFiles(paths);
      state.phase = finalPhase ?? 'stopped';
      state.stopped_at = new Date().toISOString();
      save();
    })();
    return shuttingDown;
  };

  process.on('SIGTERM', () => { shutdown('signal').then(() => process.exit(0)); });
  process.on('SIGINT', () => { shutdown('signal').then(() => process.exit(0)); });
  process.on('SIGHUP', () => {}); // 起動元の shell が終わっても生き続ける

  try {
    copyEnvFiles(spec, paths, log);
    for (const s of spec.up) {
      if (shuttingDown) break;
      const pending = stopRequested();
      if (pending) { await shutdown(pending); return; }
      const r = s.kind === 'run' ? await runOnce(s, { interruptible: true }) : await serve(s);
      if (r.stop) { await shutdown(r.stop); return; }
      if (!r.ok) {
        const st = stepState(s.name);
        state.phase = 'failed';
        state.failed_step = s.name;
        state.failed_phase = s.kind === 'run' ? 'setup' : (st.error && st.error.startsWith('exited') ? 'start' : 'ready');
        state.error = `${s.name}: ${st.error}`;
        save();
        await shutdown('failed', 'failed');
        return;
      }
    }
    if (!shuttingDown) {
      const readyAt = Date.now();
      deadline = readyAt + spec.ttl_sec * 1000;
      state.phase = 'ready';
      state.ready_at = new Date(readyAt).toISOString();
      state.deadline = new Date(deadline).toISOString();
      save();
    }
  } catch (e) {
    state.phase = 'failed';
    state.error = `supervisor error: ${e && e.message ? e.message : e}`;
    save();
    await shutdown('failed', 'failed');
    return;
  }

  while (!shuttingDown) {
    const stop = stopRequested();
    if (stop) { await shutdown(stop); break; }
    await sleep(POLL_MS);
  }
  await shuttingDown;
}

// ---------------------------------------------------------------------------
// up / down / status
// ---------------------------------------------------------------------------

async function listening(port) {
  return new Promise((res) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    sock.setTimeout(1000);
    sock.once('connect', () => { sock.destroy(); res(true); });
    sock.once('timeout', () => { sock.destroy(); res(false); });
    sock.once('error', () => res(false));
  });
}

export async function down(stateDir, { timeoutSec = 60 } = {}) {
  const paths = statePaths(stateDir);
  const stack = readJson(paths.stack);
  if (!stack) {
    removeCopiedEnvFiles(paths);
    return { ok: true, stopped: false, was_running: false, leftover: [] };
  }
  const pid = stack.supervisor_pid;
  const wasRunning = isAlive(pid) && !['stopped', 'failed'].includes(stack.phase);
  if (isAlive(pid)) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(paths.stop, new Date().toISOString());
    const until = Date.now() + timeoutSec * 1000;
    while (isAlive(pid) && Date.now() < until) await sleep(POLL_MS);
  }
  removeCopiedEnvFiles(paths);
  const alive = isAlive(pid);
  const leftover = [];
  for (const [name, port] of Object.entries(stack.ports ?? {})) {
    if (await listening(port)) leftover.push(`${name}:${port}`);
  }
  const after = readJson(paths.stack) ?? stack;
  return {
    ok: !alive,
    stopped: wasRunning && !alive,
    was_running: wasRunning,
    leftover,
    ...(alive ? { error: `supervisor (pid ${pid}) が ${timeoutSec}s 以内に止まらなかった。stop file は残すので ttl で止まる` } : {}),
    ...(after.stop_reason ? { stop_reason: after.stop_reason } : {}),
  };
}

export async function up({ worktree, stateDir, issue, configPath, waitSec = DEFAULT_WAIT_SEC }) {
  const paths = statePaths(stateDir);
  const fail = (phase, error, extra = {}) => ({ ok: false, phase, error, state_dir: stateDir, ...extra });

  // up は state dir を作り直す。worktree そのもの（やその親）を渡されたら消さずに止める。
  if (`${worktree}/`.startsWith(`${stateDir.replace(/\/+$/, '')}/`)) {
    return fail('config', `--state-dir (${stateDir}) が worktree と同じかその親になっている`);
  }
  const loaded = loadUiVerifyConfig(worktree, configPath);
  if (!loaded.ok) return fail('config', loaded.error);
  const v = validateUiVerifyConfig(loaded.raw);
  if (!v.ok) return fail('config', v.error);

  // 前回 run の残り（同じ state dir）を先に止める（#1496: teardown されずに残った dev server）
  if (existsSync(paths.stack)) {
    const prev = await down(stateDir, { timeoutSec: 30 });
    if (!prev.ok) return fail('config', `前回の stack が止まらない: ${prev.error}`);
  }
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(paths.logs, { recursive: true });

  const alloc = await allocatePorts(v.config, issue);
  if (!alloc.ok) return fail('config', alloc.error);
  const spec = resolveSpec(v.config, { worktree, stateDir, ports: alloc.ports });
  writeJsonAtomic(paths.spec, spec);

  const fd = openSync(paths.supervisorLog, 'a');
  const sup = spawn(process.execPath, [SELF, 'supervise', '--state-dir', stateDir], {
    detached: true, stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  sup.unref();

  return awaitStack(stateDir, spec, { waitSec, supervisorPid: sup.pid, upStartedAt: Date.now() });
}

// up の続きを待つ。1 回の Bash 呼び出し（上限 600 秒）に収まるよう waitSec で区切り、まだ起動中なら
// phase:"starting" を返す（停止は要求しない）。呼び出し側（workflow）は wait_ceiling_sec に達するまで
// wait を繰り返す。総上限は up の timeout_sec 合計 + 余裕で、超えたら stop を要求して phase:"timeout"。
export async function wait(stateDir, { waitSec = DEFAULT_WAIT_SEC } = {}) {
  const paths = statePaths(stateDir);
  const spec = readJson(paths.spec);
  if (!spec) return { ok: false, phase: 'start', error: 'stack が無い（先に up する）', state_dir: stateDir };
  return awaitStack(stateDir, spec, { waitSec });
}

async function awaitStack(stateDir, spec, { waitSec, supervisorPid = null, upStartedAt = null }) {
  const paths = statePaths(stateDir);
  const until = Date.now() + waitSec * 1000;
  const ceiling = spec.up_ceiling_sec;
  const summary = (stack) => ({
    state_dir: stateDir,
    base_url: spec.base_url,
    smoke_url: spec.smoke_url,
    ports: spec.ports,
    port: Object.values(spec.ports)[0],
    wait_ceiling_sec: ceiling,
    ...(stack && stack.failed_step ? { step: stack.failed_step } : {}),
  });
  const fail = (phase, error, extra = {}) => ({ ok: false, phase, error, ...summary(null), ...extra });
  for (;;) {
    const stack = readJson(paths.stack);
    if (stack && stack.phase === 'ready') return { ok: true, phase: 'ready', ...summary(stack) };
    if (stack && stack.phase === 'failed') {
      const st = stack.steps.find((s) => s.name === stack.failed_step);
      return fail(stack.failed_phase ?? 'start', stack.error ?? 'unknown', { ...summary(stack), log: st ? st.log : paths.supervisorLog });
    }
    if (stack && ['stopping', 'stopped'].includes(stack.phase)) {
      return fail('timeout', `ready 前に停止した（${stack.stop_reason ?? 'unknown'}）`, summary(stack));
    }
    const pid = supervisorPid ?? (stack ? stack.supervisor_pid : null);
    if (pid != null && !isAlive(pid)) {
      return fail('start', 'supervisor が ready 前に終了した', { ...summary(stack), log: paths.supervisorLog });
    }
    const startedAt = stack ? Date.parse(stack.started_at) : upStartedAt;
    if (Number.isFinite(startedAt) && Date.now() - startedAt >= ceiling * 1000) {
      writeFileSync(paths.stop, new Date().toISOString());
      return fail('timeout', `ready まで総上限 ${ceiling}s を超えた（stop を要求済み）`, summary(stack));
    }
    if (Date.now() >= until) return { ok: false, phase: 'starting', ...summary(stack) };
    await sleep(POLL_MS);
  }
}

// ---------------------------------------------------------------------------
// login / smoke（agent-browser を argv で直接呼ぶ。シェルを経由しない）
// ---------------------------------------------------------------------------

const BROWSER_TIMEOUT_MS = 90_000;

// 接続そのものができない（宛先に届かない）ことを示す Chromium の net error。届いた後の失敗
// （ERR_EMPTY_RESPONSE / ERR_CONNECTION_RESET / timeout 等）はアプリが応答を壊した可能性があるので含めない。
const UNREACHABLE_RE = /net::ERR_(CONNECTION_REFUSED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|ADDRESS_INVALID|UNSAFE_PORT|INTERNET_DISCONNECTED)\b/;

function browser(session, argv, { json = false } = {}) {
  const bin = process.env.UI_VERIFY_AGENT_BROWSER || 'agent-browser';
  const args = ['--session', session, ...(json ? ['--json'] : []), ...argv];
  try {
    const stdout = execFileSync(bin, args, { encoding: 'utf8', timeout: BROWSER_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stdout };
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EACCES') {
      return { ok: false, stdout: '', error: `agent-browser を実行できない（${bin}: ${e.code}）`, env: true };
    }
    const detail = `${e.stderr ?? ''}${e.stdout ?? ''}`.trim() || (e.message ?? String(e));
    return { ok: false, stdout: e.stdout ?? '', error: detail.slice(0, 500), ...(UNREACHABLE_RE.test(detail) ? { env: true } : {}) };
  }
}

// agent-browser の console / errors 出力から error レベルの文言を取り出す。
// --json の形に依存しすぎないよう、{type|level, text|message} を持つ object を再帰的に拾う。
// JSON でなければ "[error] ..." 形式の行を拾う。errors（page error）は level を問わず error 扱い。
export function extractErrorMessages(raw, { allErrors = false } = {}) {
  const out = [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  if (parsed !== undefined) {
    const walk = (v) => {
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (!v || typeof v !== 'object') return;
      const text = v.text ?? v.message ?? v.description;
      const level = String(v.type ?? v.level ?? '').toLowerCase();
      if (typeof text === 'string' && (allErrors || level === 'error')) { out.push(text); return; }
      Object.values(v).forEach(walk);
    };
    walk(parsed);
    return out;
  }
  for (const line of String(raw).split('\n')) {
    const m = /^\s*\[(error|pageerror)\]\s*(.*)$/i.exec(line);
    if (m) out.push(m[2]);
    else if (allErrors && line.trim()) out.push(line.trim());
  }
  return out;
}

function readyStack(stateDir) {
  const paths = statePaths(stateDir);
  const spec = readJson(paths.spec);
  const stack = readJson(paths.stack);
  // stack が使えないのは環境起因（ttl 切れ・down 済み・supervisor 不在）
  if (!spec || !stack) return { ok: false, error: 'stack が無い（先に up する）' };
  if (stack.phase !== 'ready') return { ok: false, error: `stack が ready でない（phase=${stack.phase}）` };
  if (!isAlive(stack.supervisor_pid)) return { ok: false, error: `stack の supervisor (pid ${stack.supervisor_pid}) が居ない` };
  return { ok: true, spec };
}

const ENV_FAILURE = { env_failure: true };

export function login(stateDir, session) {
  const st = readyStack(stateDir);
  if (!st.ok) return { ok: false, error: st.error, ...ENV_FAILURE };
  const cmds = st.spec.login;
  if (!cmds) return { ok: true, skipped: true, ran: 0, total: 0 };
  for (const [i, argv] of cmds.entries()) {
    const r = browser(session, argv);
    if (!r.ok) {
      return { ok: false, ran: i, total: cmds.length, failed: { index: i, command: argv.join(' ') }, error: r.error, ...(r.env ? ENV_FAILURE : {}) };
    }
  }
  return { ok: true, ran: cmds.length, total: cmds.length };
}

export function smoke(stateDir, session) {
  const result = (ok, checks, consoleErrors, screenshots, summary, extra = {}) => ({
    ok, mode: 'smoke', checks, console_errors: consoleErrors.slice(0, 20), screenshots, summary, ...extra,
  });
  const st = readyStack(stateDir);
  if (!st.ok) return result(false, [], [], [], st.error, ENV_FAILURE);
  const { spec } = st;
  const checks = [];

  if (spec.login) {
    const l = login(stateDir, session);
    checks.push({ action: 'login', result: l.ok ? 'pass' : 'fail', evidence: l.ok ? `${l.ran} commands` : `${l.failed ? l.failed.command : ''}: ${l.error}` });
    if (!l.ok) {
      return result(false, checks, [], [], `login 失敗: ${l.failed ? `${l.failed.command}: ` : ''}${l.error}`, l.env_failure ? ENV_FAILURE : {});
    }
  }
  // login 中の出力は smoke の判定に混ぜない
  browser(session, ['console', '--clear']);
  browser(session, ['errors', '--clear']);

  const open = browser(session, ['open', spec.smoke_url]);
  checks.push({ action: `open ${spec.smoke_url}`, result: open.ok ? 'pass' : 'fail', ...(open.ok ? {} : { evidence: open.error }) });
  if (!open.ok) return result(false, checks, [], [], `load 失敗: ${spec.smoke_url}（${open.error}）`, open.env ? ENV_FAILURE : {});
  // load（open）は済んでいるので networkidle 待ちの失敗は非致命（常時 polling するページは idle にならない）。
  // fail にすると workflow が major finding にするため skip にし、理由を evidence に残す。
  const wait = browser(session, ['wait', '--load', 'networkidle']);
  checks.push({ action: 'wait --load networkidle', result: wait.ok ? 'pass' : 'skip', ...(wait.ok ? {} : { evidence: `networkidle 待ちは失敗（非致命。load は成功）: ${wait.error}` }) });

  const ignore = (spec.console_ignore ?? []).map((re) => new RegExp(re));
  const keep = (m) => !ignore.some((re) => re.test(m));
  const errs = browser(session, ['errors'], { json: true });
  const cons = browser(session, ['console'], { json: true });
  const collected = [
    ...(errs.ok ? extractErrorMessages(errs.stdout, { allErrors: true }) : []),
    ...(cons.ok ? extractErrorMessages(cons.stdout) : []),
  ];
  const consoleErrors = [...new Set(collected)].filter(keep);
  const ignored = collected.length - consoleErrors.length;

  const shot = join(stateDir, 'smoke.png');
  const ss = browser(session, ['screenshot', shot]);
  const screenshots = ss.ok ? [shot] : [];

  const unread = [errs.ok ? null : 'errors', cons.ok ? null : 'console'].filter(Boolean);
  const summary = `smoke ${spec.smoke_url}: load ${wait.ok ? 'ok' : 'ok（networkidle 待ちは失敗）'}, console error ${consoleErrors.length} 件`
    + (ignored ? `（console_ignore で ${ignored} 件除外）` : '')
    + (collected.length - ignored > 20 ? `（先頭 20 件のみ）` : '')
    + (unread.length ? `, ${unread.join(' / ')} の取得失敗` : '')
    + (ss.ok ? '' : ', screenshot 失敗');
  return result(true, checks, consoleErrors, screenshots, summary);
}

export function status(stateDir) {
  const stack = readJson(statePaths(stateDir).stack);
  if (!stack) return { ok: true, running: false };
  return { ok: true, running: isAlive(stack.supervisor_pid) && !['stopped', 'failed'].includes(stack.phase), ...stack };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const key = {
      '--worktree': 'worktree', '--state-dir': 'stateDir', '--issue': 'issue', '--config': 'configPath',
      '--wait-sec': 'waitSec', '--timeout-sec': 'timeoutSec', '--session': 'session',
    }[a];
    if (!key || i + 1 >= argv.length) return { error: `Unknown or incomplete option: ${a}` };
    opts[key] = argv[i + 1];
    i += 1;
  }
  return { opts };
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  const usage = (msg) => { process.stderr.write(`${msg}\n`); process.exit(2); };
  if (!['up', 'wait', 'down', 'status', 'login', 'smoke', 'supervise'].includes(sub)) usage('subcommand (up|wait|down|status|login|smoke) required');
  const { opts, error } = parseArgs(rest);
  if (error) usage(error);
  if (!opts.stateDir) usage('--state-dir is required');
  const stateDir = resolve(opts.stateDir);
  const print = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

  if (sub === 'supervise') { await supervise(stateDir); process.exit(0); }
  if (sub === 'status') { print(status(stateDir)); return; }
  if (sub === 'login' || sub === 'smoke') {
    if (!opts.session) usage('--session is required');
    print(sub === 'login' ? login(stateDir, opts.session) : smoke(stateDir, opts.session));
    return;
  }
  if (sub === 'wait') {
    print(await wait(stateDir, { waitSec: opts.waitSec ? Number(opts.waitSec) : DEFAULT_WAIT_SEC }));
    process.exit(0);
  }
  if (sub === 'down') {
    print(await down(stateDir, { timeoutSec: opts.timeoutSec ? Number(opts.timeoutSec) : 60 }));
    return;
  }
  if (!opts.worktree) usage('--worktree is required');
  print(await up({
    worktree: resolve(opts.worktree),
    stateDir,
    issue: opts.issue ?? 0,
    configPath: opts.configPath ? resolve(opts.configPath) : null,
    waitSec: opts.waitSec ? Number(opts.waitSec) : DEFAULT_WAIT_SEC,
  }));
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  main().catch((e) => {
    process.stdout.write(`${JSON.stringify({ ok: false, phase: 'start', error: `ui-verify-stack crashed: ${e && e.message ? e.message : e}` })}\n`);
    process.exit(0);
  });
}
