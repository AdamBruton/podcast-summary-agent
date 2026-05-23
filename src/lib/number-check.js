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
