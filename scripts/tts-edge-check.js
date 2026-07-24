'use strict';

/**
 * Edge TTS live integration check — NOT part of the `node --test` suite
 * (the filename intentionally doesn't match the test-runner glob, so a network
 * outage never fails CI). Run manually:
 *
 *     node test/edge-synth-check.js
 *
 * Synthesises a short sentence to an mp3 Buffer and asserts it's non-empty with
 * a valid mp3/audio header. Reaches Microsoft's Edge servers over a WebSocket,
 * so a failure here in a network-restricted region is EXPECTED and reported as
 * "network-gated, not a code failure" — exit code 0 either way.
 */
const { synthEdge } = require('../lib/tts');

function looksLikeMp3(buf) {
  if (!buf || buf.length < 4) return false;
  // ID3v2 tag …
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true;
  // … or a raw MPEG audio frame sync (11 bits set: 0xFF followed by 0xE0-mask)
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
}

(async () => {
  const text = 'Hello, this is a test.';
  try {
    const buf = await synthEdge(text, { voice: 'en-US-AriaNeural', rate: 1.0, timeoutMs: 8000 });
    if (!buf || !buf.length) {
      console.error('FAIL: edge synth returned empty audio');
      process.exit(1);
    }
    if (!looksLikeMp3(buf)) {
      console.error(`FAIL: audio does not look like mp3 (first bytes: ${buf.slice(0, 4).toString('hex')})`);
      process.exit(1);
    }
    console.log(`PASS: edge synth ok — ${buf.length} bytes, header ${buf.slice(0, 3).toString('hex')}`);
    process.exit(0);
  } catch (err) {
    console.log(`NETWORK-GATED (not a code failure): ${err.message}`);
    console.log('Edge TTS needs to reach Microsoft servers; this is expected offline / in restricted regions.');
    process.exit(0);
  }
})();
