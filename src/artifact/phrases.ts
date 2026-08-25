import { foldCase, normalizeText } from '../types/normalize.js';

/**
 * Phrase matching for safety and condition profiles.
 *
 * Profiles contain PHRASES, not regular expressions. A phrase matches when its words appear as a
 * contiguous run of whole words in the target text, after normalizing whitespace and case.
 *
 * Two reasons, and the second one is the important one:
 *   - a safety rule a reviewer cannot read is not a safety rule
 *   - an over-permissive pattern in a safety profile FAILS OPEN, and failing open is the one
 *     failure mode the profile exists to prevent
 *
 * Whole-word matching is what makes "delete" refuse "Delete Member" while ignoring "Undeleted
 * items", which a naive substring check gets wrong in the dangerous direction.
 */
function words(text: string): string[] {
  return foldCase(normalizeText(text))
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== '');
}

export function phraseMatches(text: string, phrase: string): boolean {
  const haystack = words(text);
  const needle = words(phrase);
  if (needle.length === 0) return false;
  if (needle.length > haystack.length) return false;

  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let all = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

export function anyPhraseMatches(text: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => phraseMatches(text, phrase));
}
