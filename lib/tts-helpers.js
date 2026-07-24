/**
 * Pure, dependency-free TTS helpers shared by BOTH worlds:
 *   - Node (main process lib/tts.js, and node:test) via `module.exports`
 *   - Renderer (<script src="../lib/tts-helpers.js">) via `window.TtsHelpers`
 *
 * Keeping the logic in ONE place means settings.js (populating dropdowns),
 * src/tts.js (choosing a voice at speak time) and lib/tts.js (edge defaults)
 * all agree on defaults, clamping and voice selection.
 *
 * No browser globals are touched at load time, so requiring this in Node is safe.
 */
(function (factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.TtsHelpers = api;
  else if (typeof globalThis !== 'undefined') globalThis.TtsHelpers = api;
})(function () {
  'use strict';

  // Default neural voice used by the 'edge' provider when nothing is saved.
  const DEFAULT_EDGE_VOICE = 'en-US-AriaNeural';

  // Sensible baseline; provider defaults to the always-offline Web Speech API.
  const DEFAULT_TTS = {
    provider: 'webspeech',
    rate: 1.0,
    lang: 'en-US',
    webspeechVoice: '',            // voiceURI/name; '' = auto-pick at speak time
    edgeVoice: DEFAULT_EDGE_VOICE
  };

  // Curated en-* Edge neural voices for the settings dropdown. Edge's live voice
  // list needs network; this static list keeps the picker usable offline.
  const EDGE_VOICES = [
    { value: 'en-US-AriaNeural',    label: 'Aria · 美式女声' },
    { value: 'en-US-JennyNeural',   label: 'Jenny · 美式女声' },
    { value: 'en-US-GuyNeural',     label: 'Guy · 美式男声' },
    { value: 'en-US-AndrewNeural',  label: 'Andrew · 美式男声' },
    { value: 'en-US-EmmaNeural',    label: 'Emma · 美式女声' },
    { value: 'en-GB-SoniaNeural',   label: 'Sonia · 英式女声' },
    { value: 'en-GB-RyanNeural',    label: 'Ryan · 英式男声' },
    { value: 'en-AU-NatashaNeural', label: 'Natasha · 澳式女声' }
  ];

  const RATE_MIN = 0.5;
  const RATE_MAX = 2.0;

  function clampRate(value) {
    let r = Number(value);
    if (!Number.isFinite(r)) r = DEFAULT_TTS.rate;
    return Math.min(RATE_MAX, Math.max(RATE_MIN, r));
  }

  /**
   * Resolve the persisted settings object into a concrete TTS config for the
   * active provider. Accepts the full settings object (reads `.tts`).
   * @param {object} rawSettings  what get-settings returns (may lack `.tts`)
   * @returns {{provider:'webspeech'|'edge', voice:string, rate:number, lang:string}}
   */
  function resolveTtsSettings(rawSettings) {
    const t = (rawSettings && typeof rawSettings === 'object' && rawSettings.tts) || {};
    const provider = t.provider === 'edge' ? 'edge' : 'webspeech';
    const rate = clampRate(t.rate);
    const lang = typeof t.lang === 'string' && t.lang ? t.lang : DEFAULT_TTS.lang;
    const voice = provider === 'edge'
      ? (typeof t.edgeVoice === 'string' && t.edgeVoice ? t.edgeVoice : DEFAULT_EDGE_VOICE)
      : (typeof t.webspeechVoice === 'string' ? t.webspeechVoice : '');
    return { provider, voice, rate, lang };
  }

  function isEnglish(voice) {
    return voice && typeof voice.lang === 'string' && /^en([-_]|$)/i.test(voice.lang);
  }

  /**
   * Deterministically choose an English (en-*) voice from a getVoices() list.
   * Order: exact `preferred` match (voiceURI or name) → en-US (name-sorted) →
   * any en-* (name-sorted). Returns null when the list has no English voice.
   * @param {Array<{lang:string,name:string,voiceURI?:string}>} voicesList
   * @param {string} [preferred]  saved voiceURI or name
   */
  function pickEnglishVoice(voicesList, preferred) {
    const enVoices = (Array.isArray(voicesList) ? voicesList : []).filter(isEnglish);
    if (enVoices.length === 0) return null;

    if (preferred) {
      const exact = enVoices.find(v => v.voiceURI === preferred || v.name === preferred);
      if (exact) return exact;
    }

    const byName = (a, b) => String(a.name).localeCompare(String(b.name));
    const enUS = enVoices.filter(v => /^en[-_]us/i.test(v.lang));
    const pool = enUS.length ? enUS : enVoices;
    return pool.slice().sort(byName)[0];
  }

  /**
   * Normalise text before handing it to a speech engine: strip markdown-ish
   * symbols a TTS engine would read aloud awkwardly, collapse whitespace, trim.
   * Word-internal punctuation (apostrophes, hyphens) is preserved.
   */
  function normalizeSpeakText(text) {
    return String(text == null ? '' : text)
      .replace(/[*_`~#>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  return {
    DEFAULT_TTS,
    DEFAULT_EDGE_VOICE,
    EDGE_VOICES,
    RATE_MIN,
    RATE_MAX,
    clampRate,
    resolveTtsSettings,
    pickEnglishVoice,
    normalizeSpeakText
  };
});
