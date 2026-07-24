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

const MAX_CALLS_BEFORE_RECYCLE = 20;   // recycle process to bound context growth
const REQUEST_TIMEOUT_MS = 90000;      // generous: first call is a cold start

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
  // Recycle to bound context growth
  if (proc && callsSinceStart >= MAX_CALLS_BEFORE_RECYCLE) {
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

module.exports = { ask, shutdown, resolveBin };
