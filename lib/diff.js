/**
 * Word-level diff for the Mode B shadowing loop.
 * Compares a target English sentence against what the learner actually read
 * aloud (ASR transcript), marks each TARGET word as spoken-correctly or missed,
 * and returns a match score. Pure functions — no Electron, fully unit-testable.
 *
 * "Correct" means the word appears in the right relative order (longest common
 * subsequence), so a dropped or wrong word shows as a miss without shifting the
 * rest out of alignment.
 */

/** Lowercase, strip punctuation, split into word tokens. */
function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * @param {string} target  the reference English sentence
 * @param {string} spoken  the learner's ASR transcript
 * @returns {{tokens: {word:string, ok:boolean}[], score:number, matched:number, total:number}}
 */
function diffWords(target, spoken) {
  const t = tokenize(target);
  const s = tokenize(spoken);
  if (t.length === 0) return { tokens: [], score: 0, matched: 0, total: 0 };

  // LCS DP table
  const m = t.length, n = s.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = t[i - 1] === s[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack: mark which target words are part of the LCS
  const ok = new Array(m).fill(false);
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (t[i - 1] === s[j - 1]) { ok[i - 1] = true; i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--; else j--;
  }

  const matched = ok.filter(Boolean).length;
  return {
    tokens: t.map((w, idx) => ({ word: w, ok: ok[idx] })),
    score: Math.round((matched / m) * 100),
    matched,
    total: m
  };
}

module.exports = { tokenize, diffWords };
