/**
 * Lexicon module (English)
 * Loads data/english-lexicon.json and scans transcribed English text for
 * fillers / hedges / vague words — all offline, no AI. Powers Mode A's
 * real-time local highlighting and stats.
 */

const fs = require('fs');
const path = require('path');

let lexicon = { fillers: [], hedges: [], vagueToPrecise: {} };

/**
 * Load the English lexicon from disk. Called once at app startup (main.js).
 */
function loadLexicon() {
  const lexiconPath = path.join(__dirname, '..', 'data', 'english-lexicon.json');

  if (fs.existsSync(lexiconPath)) {
    const raw = JSON.parse(fs.readFileSync(lexiconPath, 'utf-8'));
    lexicon = {
      fillers: raw.fillers || [],
      hedges: raw.hedges || [],
      vagueToPrecise: raw.vague_to_precise || {}
    };
    console.log(
      `[lexicon] loaded: ${lexicon.fillers.length} fillers, ` +
      `${lexicon.hedges.length} hedges, ` +
      `${Object.keys(lexicon.vagueToPrecise).length} vague words`
    );
  } else {
    console.warn('[lexicon] english-lexicon.json not found; using empty tables');
  }
}

/**
 * Find all whole-word (case-insensitive) occurrences of a word/phrase in text.
 * Uses non-letter boundaries so "good" won't match inside "goodbye", and
 * treats internal whitespace flexibly so "you know" matches across any spacing.
 * @returns {{ word: string, position: number }[]}
 */
function findMatches(text, phrase) {
  const escaped = phrase
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  const re = new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`, 'gi');

  const matches = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.push({ word: phrase, position: m.index });
    if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-width loops
  }
  return matches;
}

/**
 * Analyze a chunk of English text.
 * @param {string} text
 * @returns {Object|null} analysis result, or null for empty input
 */
function analyzeText(text) {
  if (!text || !text.trim()) {
    return null;
  }

  const totalWords = text.trim().split(/\s+/).length;

  // Fillers
  const fillers = [];
  lexicon.fillers.forEach(w => fillers.push(...findMatches(text, w)));

  // Hedges
  const hedges = [];
  lexicon.hedges.forEach(w => hedges.push(...findMatches(text, w)));

  // Vague words → precise alternatives.
  // Match longer keys first ("very good" before "good") and skip overlaps so a
  // phrase and its sub-word aren't both counted.
  const vagueWords = [];
  const consumed = [];
  const vagueKeys = Object.keys(lexicon.vagueToPrecise).sort((a, b) => b.length - a.length);
  vagueKeys.forEach(key => {
    findMatches(text, key).forEach(match => {
      const start = match.position;
      const end = start + key.length;
      if (consumed.some(r => start < r.end && end > r.start)) return; // overlaps a longer match
      consumed.push({ start, end });
      vagueWords.push({
        word: key,
        position: start,
        alternatives: lexicon.vagueToPrecise[key]
      });
    });
  });

  // Expression density: share of words that aren't fillers/hedges
  const meaningfulWords = totalWords - fillers.length - hedges.length;
  const density = totalWords > 0 ? (meaningfulWords / totalWords) : 1;

  return {
    totalWords,
    fillers,
    hedges,
    vagueWords,
    density: Math.round(density * 100),
    suggestions: generateSuggestions(vagueWords, fillers, hedges)
  };
}

/**
 * Build lightweight replacement suggestions (Chinese UI copy, English content).
 */
function generateSuggestions(vagueWords, fillers, hedges) {
  const suggestions = [];

  vagueWords.forEach(item => {
    suggestions.push({
      type: 'vague',
      original: item.word,
      alternatives: item.alternatives.slice(0, 3),
      message: `「${item.word}」→ 试试更精准的：${item.alternatives.slice(0, 3).join(' / ')}`
    });
  });

  if (fillers.length >= 3) {
    const topFillers = [...new Set(fillers.map(f => f.word))].slice(0, 3);
    suggestions.push({
      type: 'filler',
      message: `填充词偏多（${fillers.length} 次）：${topFillers.join(' / ')}。试试用停顿替代`
    });
  }

  if (hedges.length >= 2) {
    suggestions.push({
      type: 'hedge',
      message: `犹豫表达较多（${hedges.length} 次）。试试去掉 "I think / maybe"，直接陈述`
    });
  }

  return suggestions;
}

/**
 * Expose the raw lexicon so other layers (e.g. the renderer via IPC) can reuse
 * a single source of truth for highlighting.
 */
function getLexicon() {
  return {
    fillers: lexicon.fillers,
    hedges: lexicon.hedges,
    vagueWords: Object.keys(lexicon.vagueToPrecise)
  };
}

module.exports = { loadLexicon, analyzeText, getLexicon };
