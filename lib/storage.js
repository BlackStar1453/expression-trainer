/**
 * Learning-corpus storage.
 * Each session is persisted to userData/learning-data/ as BOTH structured JSON
 * and an AI-friendly Markdown mirror, plus a rolling INDEX.md and a growing
 * tag registry (tags.json). The MD + INDEX are meant to be fed to an LLM later
 * for review, so they are written to read cleanly on their own.
 */

const fs = require('fs');
const path = require('path');

let baseDir = null;

function initStorage(dir) {
  baseDir = dir;
  fs.mkdirSync(path.join(baseDir, 'sessions'), { recursive: true });
}

function getBaseDir() { return baseDir; }

function pad(n) { return String(n).padStart(2, '0'); }

function stamp(d = new Date()) {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const fileStamp = `${date}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return { date, time, fileStamp };
}

/** Tag frequencies across a session's corrections, most frequent first. */
function tagFreq(corrections) {
  const m = {};
  (corrections || []).forEach(c => (c.tags || []).forEach(t => { m[t] = (m[t] || 0) + 1; }));
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}

/** AI-friendly Markdown mirror of one session (pure — safe to unit-test). */
function buildSessionMarkdown(s) {
  const L = [];
  L.push(`# 英语表达训练 · Mode ${s.mode || 'A'} · ${s.date} ${s.time}`, '');
  L.push(`- 时长：${s.durationSec || 0}s ｜ 词数：${s.totalWords || 0} ｜ 填充词：${s.fillers || 0} ｜ 犹豫词：${s.hedges || 0} ｜ 纠错点：${(s.corrections || []).length}`);
  const topTags = tagFreq(s.corrections).map(([t, n]) => `${t}×${n}`).join('、') || '无';
  L.push(`- 高频问题：${topTags}`, '');

  if (s.mode === 'B' && (s.cards || []).length) {
    L.push('## 中译英学习卡片', '');
    s.cards.forEach((c, i) => {
      L.push(`### ${i + 1}.${(c.tags || []).length ? ` [${c.tags.join(', ')}]` : ''}`);
      L.push(`- 中文：${c.zh || ''}`);
      L.push(`- 英文：${c.en || ''}`);
      if (c.note) L.push(`- 讲解：${c.note}`);
      if (c.shadow) L.push(`- 跟读：最佳匹配度 ${c.shadow.bestScore ?? '-'}% ｜ 次数 ${c.shadow.attempts ?? 0}`);
      L.push('');
    });
    return L.join('\n');
  }

  if (s.fullText) {
    L.push('## 原文', '', s.fullText, '');
  }
  L.push('## 纠错记录', '');
  if (!(s.corrections || []).length) {
    L.push('本场无明显问题。');
  } else {
    s.corrections.forEach((c, i) => {
      const tag = (c.tags || []).length ? ` [${c.tags.join(', ')}]` : '';
      L.push(`### ${i + 1}.${tag}`);
      L.push(`- 原：${c.original}`);
      L.push(`- 改：${c.corrected}`);
      if (c.explanation) L.push(`- 说明：${c.explanation}`);
      L.push('');
    });
  }
  return L.join('\n');
}

/** One INDEX.md line for a session (pure). */
function buildIndexLine(s, jsonFile) {
  const items = s.mode === 'B' ? (s.cards || []) : (s.corrections || []);
  const topTags = tagFreq(s.mode === 'B' ? s.cards : s.corrections)
    .map(([t, n]) => `${t}×${n}`).join(', ') || '无';
  const count = s.mode === 'B' ? `${items.length}卡片` : `${items.length}纠错`;
  return `- [${s.date} ${s.time}](sessions/${jsonFile}) · Mode ${s.mode || 'A'} · ${s.totalWords || 0}词 · ${count} · ${topTags}`;
}

/** Distinct tag names in the registry (for reuse-first prompting). */
function loadTags() {
  if (!baseDir) return [];
  const p = path.join(baseDir, 'tags.json');
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return Object.keys(data.tags || {});
  } catch {
    return [];
  }
}

/** Merge a session's tags into the growing registry. */
function mergeTags(items, when) {
  const p = path.join(baseDir, 'tags.json');
  let data = { tags: {} };
  if (fs.existsSync(p)) {
    try { data = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { data = { tags: {} }; }
  }
  data.tags = data.tags || {};
  (items || []).forEach(c => (c.tags || []).forEach(t => {
    if (!data.tags[t]) data.tags[t] = { count: 0, firstSeen: when, lastSeen: when };
    data.tags[t].count += 1;
    data.tags[t].lastSeen = when;
  }));
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

/**
 * Persist one session. Returns the written paths.
 * @param {Object} session  { mode, corrections|cards, fullText, durationSec, totalWords, fillers, hedges, vagueWords }
 */
function saveSession(session) {
  if (!baseDir) throw new Error('storage not initialized');
  const d = new Date();
  const { date, time, fileStamp } = stamp(d);
  const s = {
    ...session,
    date: session.date || date,
    time: session.time || time,
    timestamp: session.timestamp || d.getTime()
  };

  const jsonFile = `${fileStamp}.json`;
  const jsonPath = path.join(baseDir, 'sessions', jsonFile);
  const mdPath = path.join(baseDir, 'sessions', `${fileStamp}.md`);

  fs.writeFileSync(jsonPath, JSON.stringify(s, null, 2));
  fs.writeFileSync(mdPath, buildSessionMarkdown(s));

  const indexPath = path.join(baseDir, 'INDEX.md');
  const head = fs.existsSync(indexPath)
    ? ''
    : '# 学习索引\n\n> 每行一场训练。AI 复习时先读本文件，再按需读单场 .md。\n\n';
  fs.appendFileSync(indexPath, head + buildIndexLine(s, jsonFile) + '\n');

  mergeTags(s.mode === 'B' ? s.cards : s.corrections, s.timestamp);

  return { jsonPath, mdPath };
}

module.exports = {
  initStorage, getBaseDir, saveSession, loadTags,
  buildSessionMarkdown, buildIndexLine, tagFreq
};
