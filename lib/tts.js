/**
 * Main-process Edge TTS (v2, the 'edge' provider).
 *
 * Synthesises text to an mp3 Buffer through Microsoft's Edge neural voices via
 * the maintained `msedge-tts` package — NO API key required. Reaches Microsoft
 * servers over a WebSocket, so every call is guarded by a hard timeout: the
 * renderer falls back to the always-offline Web Speech API if this rejects, and
 * the UI must never hang on the network.
 *
 * Edge's SSML prosody rate accepts a bare relative number (0.5 = half speed,
 * 1.5 = 1.5x), matching Web Speech's `utterance.rate`, so the same rate value
 * flows through both providers unchanged.
 */
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const { DEFAULT_EDGE_VOICE, clampRate } = require('./tts-helpers');

const DEFAULT_TIMEOUT_MS = 7000;

/**
 * @param {string} text
 * @param {{voice?:string, rate?:number, timeoutMs?:number}} [opts]
 * @returns {Promise<Buffer>} mp3 audio bytes (non-empty)
 */
function synthEdge(text, opts = {}) {
  const clean = String(text == null ? '' : text).trim();
  if (!clean) return Promise.reject(new Error('empty text'));

  const voice = opts.voice || DEFAULT_EDGE_VOICE;
  const rate = clampRate(opts.rate);
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const tts = new MsEdgeTTS();
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { tts.close(); } catch (_) { /* socket may already be closed */ }
      fn(arg);
    };

    const timer = setTimeout(
      () => finish(reject, new Error(`edge tts timeout after ${timeoutMs}ms`)),
      timeoutMs
    );

    (async () => {
      try {
        await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        const { audioStream } = tts.toStream(clean, { rate });
        const chunks = [];
        audioStream.on('data', (c) => chunks.push(c));
        audioStream.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (!buf.length) return finish(reject, new Error('edge tts returned empty audio'));
          finish(resolve, buf);
        });
        audioStream.on('error', (err) => finish(reject, err));
      } catch (err) {
        finish(reject, err);
      }
    })();
  });
}

module.exports = { synthEdge, DEFAULT_TIMEOUT_MS };
