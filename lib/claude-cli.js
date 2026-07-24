/**
 * Claude Code CLI provider — uses the user's Claude subscription via the local
 * `claude` binary, so no API key is needed.
 *
 * Keeps ONE persistent `claude -p` process warm (stream-json I/O) so only the
 * first request pays the ~10s cold-start; later requests return in ~2-4s.
 * Requests are serialized through a queue (the stream-json session handles one
 * turn at a time). The process is recycled every N calls to bound context
 * growth, and respawned automatically if it dies.
 *
 * Runs in the Electron MAIN process only (spawns a child process).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

let proc = null;
let currentModel = 'sonnet';
let currentBin = 'claude';
let buf = '';
let queue = [];          // [{ text, resolve, reject, timer }]
let active = null;       // in-flight request
let callsSinceStart = 0;

// 软阈值调低到 10：stream-json 会话每轮携带全部历史，纠错/翻译 prompt 较长，
// 真机实测轮次越多单轮越慢（上下文膨胀）。闲时回收+预热已让换进程用户无感，
// 短会话既快又省——多付的只是每 10 轮一个微型 ping。
const MAX_CALLS_BEFORE_RECYCLE = 10;   // 软阈值：响应完且空闲时主动回收+预热（用户无感）
const HARD_MAX_CALLS = 20;             // 硬上限：请求持续排队从未空闲时的兜底回收（会冷一次）
const REQUEST_TIMEOUT_MS = 90000;      // generous: first call is a cold start

const WARMUP_PROMPT = 'Reply with only: ok';   // 微型 ping，把 CLI 首轮开销提前付掉

/** Resolve the `claude` binary. Finder-launched apps don't inherit shell PATH. */
function resolveBin(overridePath) {
  if (overridePath && fs.existsSync(overridePath)) return overridePath;
  const candidates = [
    path.join(os.homedir(), '.local/bin/claude'),
    path.join(os.homedir(), '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return 'claude'; // fall back to PATH lookup
}

function buildArgs(model) {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--no-chrome',
    '--allowedTools', '',
    '--model', model || 'sonnet',
  ];
}

function start() {
  proc = spawn(currentBin, buildArgs(currentModel), { stdio: ['pipe', 'pipe', 'pipe'] });
  buf = '';
  callsSinceStart = 0;
  proc.stdout.on('data', onData);
  proc.stderr.on('data', () => { /* claude logs to stderr; ignore for now */ });
  proc.on('exit', onExit);
  proc.on('error', onError);
}

function onData(d) {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'result' && active) {
      const text = typeof ev.result === 'string' ? ev.result : '';
      finishActive(null, text);
    }
  }
}

function finishActive(err, text) {
  if (!active) return;
  clearTimeout(active.timer);
  const a = active;
  active = null;
  if (err) a.reject(err); else a.resolve(text);
  pump();

  // 闲时主动回收：到软阈值且此刻完全空闲 → 换新进程并立即预热，
  // 下一句话到来时命中的是暖进程（懒回收会让第 21 句撞上 ~10s 冷启动）
  if (!active && queue.length === 0 && proc && callsSinceStart >= MAX_CALLS_BEFORE_RECYCLE) {
    console.log('[LLM] 常驻进程达软阈值，闲时回收并预热新进程');
    try { proc.stdin.end(); } catch { /* ignore */ }
    proc = null;
    enqueueWarmupPing();
  }
}

function onExit() {
  proc = null;
  if (active) {
    // the in-flight request died with the process
    finishActive(new Error('claude process exited unexpectedly'));
  } else {
    pump(); // process died while idle but queue may have items → respawn
  }
}

function onError(e) {
  if (active) finishActive(e);
  else { proc = null; pump(); }
}

function pump() {
  if (active || queue.length === 0) return;
  // 兜底回收：正常路径由 finishActive 的闲时回收处理；只有请求密集到
  // 从未出现空闲时才会走到这里（该次请求会冷一次，属可接受的极端情形）
  if (proc && callsSinceStart >= HARD_MAX_CALLS) {
    try { proc.stdin.end(); } catch { /* ignore */ }
    proc = null;
  }
  if (!proc) start();
  active = queue.shift();
  callsSinceStart++;
  active.timer = setTimeout(() => finishActive(new Error('claude request timed out')), REQUEST_TIMEOUT_MS);
  const msg = { type: 'user', message: { role: 'user', content: active.text } };
  try {
    proc.stdin.write(JSON.stringify(msg) + '\n');
  } catch (e) {
    finishActive(e);
  }
}

/** 把一个微型 ping 排进队列（fire-and-forget，结果丢弃，失败静默） */
function enqueueWarmupPing() {
  return new Promise((resolve) => {
    queue.push({
      text: WARMUP_PROMPT,
      resolve: () => resolve(true),
      reject: () => resolve(false),   // 预热失败不致命：真请求到来时会重试冷启动
      timer: null,
    });
    pump();
  });
}

/**
 * 预热：确保常驻进程存在并完成过一轮往返（spawn + CLI 鉴权/建连都提前付掉）。
 * 已暖/正在处理请求时是 no-op。与 TTS 的 warmup 同思路。
 * @param {Object} [opts] { model, binPath }
 * @returns {Promise<boolean>} 是否就绪（失败不抛）
 */
function warmup(opts = {}) {
  const model = opts.model || currentModel || 'sonnet';
  const bin = resolveBin(opts.binPath);
  // 模型/二进制变了 → 换进程再预热（否则第一句真请求付冷启动）
  if (proc && (model !== currentModel || bin !== currentBin)) {
    try { proc.stdin.end(); } catch { /* ignore */ }
    proc = null;
  }
  currentModel = model;
  currentBin = bin;
  // 已有进程且已完成过至少一轮（或正在跑）→ 无需预热
  if (proc && (callsSinceStart > 0 || active || queue.length > 0)) {
    return Promise.resolve(true);
  }
  return enqueueWarmupPing();
}

/**
 * Send one independent request through the warm process.
 * @param {string} systemText  task instructions (embedded into the user turn)
 * @param {string} userText    the content
 * @param {Object} [opts]      { model, binPath }
 * @returns {Promise<string>}  the model's raw text response
 */
function ask(systemText, userText, opts = {}) {
  const model = opts.model || 'sonnet';
  const bin = resolveBin(opts.binPath);
  // Model or binary change → recycle so the new setting takes effect
  if (proc && (model !== currentModel || bin !== currentBin)) {
    try { proc.stdin.end(); } catch { /* ignore */ }
    proc = null;
  }
  currentModel = model;
  currentBin = bin;
  const text = systemText ? `${systemText}\n\n${userText}` : userText;
  return new Promise((resolve, reject) => {
    queue.push({ text, resolve, reject, timer: null });
    pump();
  });
}

/** Kill the process on app quit. */
function shutdown() {
  if (proc) {
    try { proc.stdin.end(); proc.kill(); } catch { /* ignore */ }
    proc = null;
  }
  queue.forEach(q => { clearTimeout(q.timer); q.reject(new Error('shutdown')); });
  queue = [];
  active = null;
}

module.exports = { ask, warmup, shutdown, resolveBin };
