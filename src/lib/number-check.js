// Numeric fidelity guard for extracted candidates.
//
// The extract pass produces both a paraphrased `claim` and a verbatim
// `supporting_quote`. The known failure mode (Krishna Rao $75B → $7.5B):
// the model paraphrases the claim with a 10x error while the quote
// correctly transcribes the original.
//
// Rule: every numeric token in the claim must appear in the supporting_quote.
// If it doesn't, the claim is unreliable and we drop the candidate.

// Words 1-20 → digits. We normalize the quote (verbatim from captions) so
// "nine of the Fortune 10" matches a claim that says "9 of the Fortune 10".
// Larger spelled-out numbers ("one hundred") are rare in spoken interviews
// and not worth the complexity.
const WORD_NUMBERS = {
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14',
  fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18',
  nineteen: '19', twenty: '20',
};
const WORD_NUMBER_RE = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/gi;

function normalizeWordNumbers(text) {
  return String(text || '').replace(WORD_NUMBER_RE, w => WORD_NUMBERS[w.toLowerCase()] || w);
}

// Numeric tokens: integers and decimals as standalone tokens (so we don't
// match "75" inside "175" or "1.75" inside "$1.75M" twice).
// Lookbehind/lookahead exclude adjacent digits and decimal points, so
// "1.75" matches as one token "1.75", and "75" alone matches as "75".
function numericTokens(text) {
  const re = /(?<![\d.])\d+(?:\.\d+)?(?![\d.])/g;
  return Array.from(String(text || '').matchAll(re)).map(m => m[0]);
}

/**
 * @param {string} claim
 * @param {string} quote
 * @returns {{ ok: boolean, missing: string[] }}
 *   ok=true if every numeric token in the claim also appears in the quote
 *   (after word-to-digit normalization of the quote).
 *   missing = array of claim numbers that were NOT found in the quote.
 */
export function verifyNumericFidelity(claim, quote) {
  const claimNums = numericTokens(claim);
  if (claimNums.length === 0) return { ok: true, missing: [] };
  const quoteNums = new Set(numericTokens(normalizeWordNumbers(quote)));
  const missing = claimNums.filter(n => !quoteNums.has(n));
  return { ok: missing.length === 0, missing };
}

// Lowercased word tokens (letters/digits), punctuation stripped. Used to
// measure how much NEW content a corrected quote introduces vs the raw.
function wordTokens(s) {
  return String(s || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

// Count words in `corrected` that aren't accounted for by `raw` (multiset
// difference). Removing/reordering words contributes 0; only genuinely new
// words count. A homophone/proper-noun fix adds ~1; a rewrite adds many.
function newWordCount(raw, corrected) {
  const counts = new Map();
  for (const w of wordTokens(raw)) counts.set(w, (counts.get(w) || 0) + 1);
  let added = 0;
  for (const w of wordTokens(corrected)) {
    const n = counts.get(w) || 0;
    if (n > 0) counts.set(w, n - 1);
    else added++;
  }
  return added;
}

/**
 * Validate an LLM-proposed corrected quote against the raw (verbatim-from-ASR)
 * quote. The corrected copy is for DISPLAY ONLY — the raw quote stays the audit
 * trail and the number-fidelity input. A correction may fix mis-transcribed
 * words/punctuation/proper-nouns and trim filler, but NOT invent or reshape
 * content. Hard gates, any failure → reject (caller falls back to raw):
 *   1. No NEW numerals — every numeric token in `corrected` must already appear
 *      in `raw` (after word→digit normalization). Stops the model "correcting" a
 *      number to match its belief (the $75B↔$7.5B class, in reverse).
 *   2. Claim numbers survive — `corrected` must still satisfy verifyNumericFidelity
 *      against the claim, so the displayed quote keeps backing the claim's numbers.
 *   3. Bounded ADDED content — new-word count ≤ max(`minNewWords`, `addRatio` ×
 *      corrected length). Trimming filler is free (removal adds nothing); only
 *      injected words count, so a rewrite toward the lead-in is caught while a
 *      proper-noun/homophone fix passes.
 *   4. No runaway growth — corrected can't be much longer than raw.
 *
 * @returns {string|null} the corrected string if it passes all gates, else null.
 */
export function validateCorrectedQuote(
  { raw, corrected, claim, minNewWords = 3, addRatio = 0.15, maxGrowth = 1.4 }
) {
  if (typeof corrected !== 'string') return null;
  const c = corrected.trim();
  const r = String(raw || '');
  if (!c || c === r) return null;            // empty or unchanged → use raw

  // 1. no new numerals
  const rawNums = new Set(numericTokens(normalizeWordNumbers(r)));
  for (const n of numericTokens(normalizeWordNumbers(c))) {
    if (!rawNums.has(n)) return null;
  }
  // 2. claim numbers still present
  if (claim != null && !verifyNumericFidelity(claim, c).ok) return null;
  // 3. bounded added content
  const corrWords = wordTokens(c).length;
  const budget = Math.max(minNewWords, Math.ceil(addRatio * corrWords));
  if (newWordCount(r, c) > budget) return null;
  // 4. no runaway growth
  if (c.length > r.length * maxGrowth) return null;

  return c;
}
