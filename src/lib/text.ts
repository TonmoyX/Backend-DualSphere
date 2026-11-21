import sanitizeHtml from 'sanitize-html';
import { sha256 } from './crypto.js';

/** All user content is stored as plain text — strip every tag. Rendering is escaped client-side too. */
export function cleanText(input: string): string {
  return sanitizeHtml(input, { allowedTags: [], allowedAttributes: {}, disallowedTagsMode: 'discard' })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

export function contentHash(content: string): string {
  return sha256(content.toLowerCase().replace(/\s+/g, ' ').trim());
}

/** Levenshtein distance with O(min(a,b)) memory. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length < b.length) [a, b] = [b, a];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** 0..1, 1 = identical. Truncates long texts to bound CPU. */
export function similarity(a: string, b: string): number {
  const x = a.toLowerCase().slice(0, 600);
  const y = b.toLowerCase().slice(0, 600);
  const max = Math.max(x.length, y.length);
  if (max === 0) return 1;
  return 1 - levenshtein(x, y) / max;
}

const URL_RE = /https?:\/\/\S+/gi;

/** Lightweight spam heuristics. Returns flags + score contribution. */
export function spamSignals(content: string, bannedWords: string[]): { flags: string[]; score: number } {
  const flags: string[] = [];
  let score = 0;
  const lower = content.toLowerCase();
  const links = content.match(URL_RE)?.length ?? 0;
  if (links >= 3) { flags.push('spam:links'); score += 10; }
  const letters = content.replace(/[^a-zA-Z]/g, '');
  if (letters.length > 30 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.8) {
    flags.push('spam:caps'); score += 5;
  }
  if (/(.)\1{9,}/.test(content)) { flags.push('spam:repeat'); score += 5; }
  const hit = bannedWords.find((w) => w && lower.includes(w.toLowerCase()));
  if (hit) { flags.push('spam:keyword'); score += 15; }
  return { flags, score };
}
