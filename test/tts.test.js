'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_EDGE_VOICE,
  RATE_MIN,
  RATE_MAX,
  resolveTtsSettings,
  pickEnglishVoice,
  normalizeSpeakText
} = require('../lib/tts-helpers');

// ===== resolveTtsSettings =====

test('resolveTtsSettings: empty/undefined → webspeech defaults', () => {
  const a = resolveTtsSettings(undefined);
  assert.deepEqual(a, { provider: 'webspeech', voice: '', rate: 1.0, lang: 'en-US' });
  const b = resolveTtsSettings({});
  assert.deepEqual(b, { provider: 'webspeech', voice: '', rate: 1.0, lang: 'en-US' });
});

test('resolveTtsSettings: webspeech keeps saved voice + rate', () => {
  const r = resolveTtsSettings({ tts: { provider: 'webspeech', webspeechVoice: 'Samantha', rate: 1.25 } });
  assert.equal(r.provider, 'webspeech');
  assert.equal(r.voice, 'Samantha');
  assert.equal(r.rate, 1.25);
  assert.equal(r.lang, 'en-US');
});

test('resolveTtsSettings: edge uses edgeVoice, not webspeechVoice', () => {
  const r = resolveTtsSettings({ tts: { provider: 'edge', edgeVoice: 'en-GB-RyanNeural', webspeechVoice: 'Samantha' } });
  assert.equal(r.provider, 'edge');
  assert.equal(r.voice, 'en-GB-RyanNeural');
});

test('resolveTtsSettings: edge with no edgeVoice → DEFAULT_EDGE_VOICE', () => {
  const r = resolveTtsSettings({ tts: { provider: 'edge' } });
  assert.equal(r.voice, DEFAULT_EDGE_VOICE);
});

test('resolveTtsSettings: unknown provider falls back to webspeech', () => {
  assert.equal(resolveTtsSettings({ tts: { provider: 'nope' } }).provider, 'webspeech');
});

test('resolveTtsSettings: rate is clamped and NaN-safe', () => {
  assert.equal(resolveTtsSettings({ tts: { rate: 9 } }).rate, RATE_MAX);
  assert.equal(resolveTtsSettings({ tts: { rate: 0.01 } }).rate, RATE_MIN);
  assert.equal(resolveTtsSettings({ tts: { rate: 'abc' } }).rate, 1.0);
});

// ===== pickEnglishVoice =====

const VOICES = [
  { name: 'Ting-Ting', lang: 'zh-CN', voiceURI: 'zh-CN-1' },
  { name: 'Daniel',    lang: 'en-GB', voiceURI: 'en-GB-1' },
  { name: 'Samantha',  lang: 'en-US', voiceURI: 'en-US-sam' },
  { name: 'Alex',      lang: 'en-US', voiceURI: 'en-US-alex' }
];

test('pickEnglishVoice: exact preferred match wins (by voiceURI)', () => {
  assert.equal(pickEnglishVoice(VOICES, 'en-US-sam').name, 'Samantha');
});

test('pickEnglishVoice: exact preferred match wins (by name)', () => {
  assert.equal(pickEnglishVoice(VOICES, 'Daniel').name, 'Daniel');
});

test('pickEnglishVoice: no preferred → first en-US by name (Alex < Samantha)', () => {
  assert.equal(pickEnglishVoice(VOICES, '').name, 'Alex');
});

test('pickEnglishVoice: preferred not in list → deterministic en-US fallback', () => {
  assert.equal(pickEnglishVoice(VOICES, 'no-such-voice').name, 'Alex');
});

test('pickEnglishVoice: no en-US → falls back to any en-* by name', () => {
  const onlyGb = [
    { name: 'Kate', lang: 'en-GB', voiceURI: 'k' },
    { name: 'Daniel', lang: 'en-GB', voiceURI: 'd' }
  ];
  assert.equal(pickEnglishVoice(onlyGb, '').name, 'Daniel');
});

test('pickEnglishVoice: no English voices → null', () => {
  assert.equal(pickEnglishVoice([{ name: 'Ting-Ting', lang: 'zh-CN' }], ''), null);
  assert.equal(pickEnglishVoice([], 'x'), null);
  assert.equal(pickEnglishVoice(null, 'x'), null);
});

test('pickEnglishVoice: matches en without region (lang "en")', () => {
  assert.equal(pickEnglishVoice([{ name: 'Generic', lang: 'en' }], '').name, 'Generic');
});

// ===== normalizeSpeakText =====

test('normalizeSpeakText: collapses whitespace and trims', () => {
  assert.equal(normalizeSpeakText('  hello   world \n\t next '), 'hello world next');
});

test('normalizeSpeakText: strips markdown-ish symbols', () => {
  assert.equal(normalizeSpeakText('**bold** _em_ `code` ## head > quote | x'), 'bold em code head quote x');
});

test('normalizeSpeakText: preserves word-internal apostrophes and hyphens', () => {
  assert.equal(normalizeSpeakText("it's well-known, isn't it?"), "it's well-known, isn't it?");
});

test('normalizeSpeakText: null/undefined/number → safe string', () => {
  assert.equal(normalizeSpeakText(null), '');
  assert.equal(normalizeSpeakText(undefined), '');
  assert.equal(normalizeSpeakText(42), '42');
});
