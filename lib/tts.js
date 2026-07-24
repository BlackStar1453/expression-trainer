/**
 * Main-process Edge TTS (v2, the 'edge' provider).
 *
 * Synthesises text to an mp3 Buffer through Microsoft's Edge neural voices via
 * the maintained `msedge-tts` package — NO API key required.
 *
 * 常驻连接（与 lib/claude-cli.js 的「保温」同思路）：真机实测建立 WS 连接要
 * ~5-8s（慢网络下是绝对大头），而连接就绪后单句合成仅 1-2s，且同一连接可
 * 连续合成。因此连接建好后**缓存复用**：首句慢、后续句秒级。闲置被服务端
 * 断开时自动重连并重试一次。每个阶段有独立超时护栏，失败由渲染层回退到
 * 离线 Web Speech —— UI 永不因网络挂起。
 *
 * Edge's SSML prosody rate accepts a bare relative number (0.5 = half speed,
 * 1.5 = 1.5x), matching Web Speech's `utterance.rate`, so the same rate value
 * flows through both providers unchanged.
 */
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const { DEFAULT_EDGE_VOICE, clampRate, escapeXml } = require('./tts-helpers');

// 建连给足余量（受限网络实测 ~7.4s）。
// 合成阶段不再用总时长超时，改用「流停滞」检测：只要音频块还在到达就继续等
// （慢网络长句合法地慢），5s 收不到任何数据才判死（死连接被服务端断开时正是
// 这种表现）——比总时长上限既更快发现死连接、又不误杀慢而活的流。
// 另设 30s 兜底硬上限防极端悬挂。
const CONNECT_TIMEOUT_MS = 12000;
const SYNTH_STALL_MS = 5000;
const SYNTH_CAP_MS = 30000;

/** 常驻连接缓存：{ tts, voice }；null = 未连接 */
let cached = null;

function invalidate() {
  if (cached) {
    try { cached.tts.close(); } catch (_) { /* socket may already be closed */ }
    cached = null;
  }
}

/** app 退出时调用，杀掉常驻连接 */
function shutdown() { invalidate(); }

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/** 取可用连接：同 voice 复用缓存；换 voice 或无缓存则新建（含建连超时） */
async function getClient(voice, connectTimeoutMs) {
  if (cached && cached.voice === voice) return cached.tts;
  invalidate(); // 换语音：旧连接直接废弃
  const tts = new MsEdgeTTS();
  try {
    // voice 进 SSML 属性，同样转义（正常语音名是 no-op）
    await withTimeout(
      tts.setMetadata(escapeXml(voice), OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3),
      connectTimeoutMs,
      'edge connect'
    );
  } catch (e) {
    try { tts.close(); } catch (_) { /* 超时后迟到连上的 socket 也要关掉 */ }
    throw e;
  }
  cached = { tts, voice };
  return tts;
}

/** 在活连接上合成单句为 mp3 Buffer（停滞检测 + 硬上限兜底） */
function streamToBuffer(tts, escapedText, rate, stallMs, capMs) {
  return new Promise((resolve, reject) => {
    let stream;
    try {
      ({ audioStream: stream } = tts.toStream(escapedText, { rate }));
    } catch (e) {
      return reject(e);
    }

    const chunks = [];
    let done = false;
    let stallTimer = null;
    const finishFail = (err) => {
      if (done) return;
      done = true;
      clearTimeout(stallTimer);
      clearTimeout(capTimer);
      reject(err);
    };
    const capTimer = setTimeout(
      () => finishFail(new Error(`edge synth exceeded hard cap ${capMs}ms`)),
      capMs
    );
    const resetStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () => finishFail(new Error(`edge synth stalled: no data for ${stallMs}ms`)),
        stallMs
      );
    };
    resetStall();

    stream.on('data', (c) => { chunks.push(c); resetStall(); });
    stream.on('end', () => {
      if (done) return;
      done = true;
      clearTimeout(stallTimer);
      clearTimeout(capTimer);
      const buf = Buffer.concat(chunks);
      if (!buf.length) reject(new Error('edge tts returned empty audio'));
      else resolve(buf);
    });
    stream.on('error', (err) => finishFail(err));
  });
}

async function _synthEdge(text, opts = {}) {
  const clean = String(text == null ? '' : text).trim();
  if (!clean) throw new Error('empty text');

  const voice = opts.voice || DEFAULT_EDGE_VOICE;
  const rate = clampRate(opts.rate);
  const override = Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : null;
  const connectMs = override || CONNECT_TIMEOUT_MS;
  const stallMs = override || SYNTH_STALL_MS;

  // msedge-tts 把输入原样拼进 SSML —— 必须先做 XML 转义，
  // 否则含 & / < 的句子（如 "R&D"）会让 Edge 拒绝合成，
  // 被回退路径误判成「网络不可用」。
  const escaped = escapeXml(clean);

  const hadCached = !!(cached && cached.voice === voice);
  let phase = 'connect';
  try {
    const tts = await getClient(voice, connectMs);
    phase = 'synth';
    return await streamToBuffer(tts, escaped, rate, stallMs, SYNTH_CAP_MS);
  } catch (err) {
    invalidate();
    // 全新连接在建连阶段就失败 → 真离线/被墙，立刻抛给渲染层走本地回退，
    // 不再多等一轮。其余情况值得重试一次：
    //   - 用的是缓存连接（很可能被服务端闲置断开，停滞检测 5s 内就能发现）
    //   - 连接成功但合成阶段失败（网络抖动，重连后大概率成功）
    if (!hadCached && phase === 'connect') throw err;
    const tts = await getClient(voice, connectMs);
    try {
      return await streamToBuffer(tts, escaped, rate, stallMs, SYNTH_CAP_MS);
    } catch (err2) {
      invalidate();
      throw err2;
    }
  }
}

// 串行队列：同一条 WS 连接一次只跑一个合成请求。
// 渲染层的「预合成」可能在多张卡片同时到达时并发调用，msedge-tts 在同一连接上
// 并发 toStream 的行为不可靠（消息按 requestId 复用同一 socket），排队最稳。
let queueTail = Promise.resolve();

/**
 * @param {string} text
 * @param {{voice?:string, rate?:number, timeoutMs?:number}} [opts]
 *   timeoutMs 若提供，覆盖建连上限与停滞阈值（供检查脚本用）
 * @returns {Promise<Buffer>} mp3 audio bytes (non-empty)
 */
function synthEdge(text, opts = {}) {
  const run = () => _synthEdge(text, opts);
  const p = queueTail.then(run, run);
  queueTail = p.catch(() => {}); // 队列不因单个失败而断链
  return p;
}

module.exports = { synthEdge, shutdown, CONNECT_TIMEOUT_MS, SYNTH_STALL_MS, SYNTH_CAP_MS };
