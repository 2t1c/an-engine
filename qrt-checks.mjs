// qrt-checks.mjs — the hard stops a QRT line must clear, and the article material they read.
//
// Ported from 2t1c/genius (qrt-fill.mjs at aba3896, owner 2026-10-02: "port into PI"). cold-qrt.mjs uses only these two
// pure parts of Genius's qrt-fill.mjs: `codeChecks` (a quotation found word for word in the article, no em dash, no
// banned word, no "It's not X. It's Y.") and `materialOf` (an article's material file, read the way the checks read it).
// The rest of qrt-fill.mjs is Genius's Jev saver and writer, which PI does not port: structure first makes the saver's
// supported/honest reading advice only (owner in Genius, 2026-09-29: "Overselling and unsupported claims are okay"), and
// PI writes in the chat.
import { voiceQuotesOf } from './qrt-score.mjs';

const str = (s) => String(s ?? '');
const clip = (s, n) => { const t = str(s).trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** PURE. A piece's material: an X Article's body (after "# Article body") or a long-form's text, its title, headings,
 *  verbatim quotes and clips. The checks read a quotation against `body` and `quotes`. */
export function materialOf(raw, file = '') {
  const s = str(raw);
  const isArticle = s.includes('\n# Article body');
  const body = isArticle ? s.slice(s.indexOf('\n# Article body') + 15).trim() : s.split('\n---\n')[0].replace(/^# .*\n+/, '').trim();
  const prose = body.replace(/<typ:[^>]+>/g, '').split('\n---\n')[0];
  const fm = {};
  const m = s.match(/^---\n([\s\S]*?)\n---/);
  if (m) for (const x of m[1].matchAll(/^([a-z_]+):\s*(.+)$/gm)) fm[x[1]] = x[2].trim();
  const title = isArticle ? (body.match(/^# (.+)$/m)?.[1] || '') : (prose.split('\n').find((l) => l.trim()) || '');
  const headings = isArticle ? [...body.matchAll(/^## (.+)$/gm)].map((x) => x[1].trim()) : [];
  // Verbatim quotes: an article's receipts table (quote | speaker · show · at), else every quoted passage in the post.
  const quotes = [];
  for (const x of s.matchAll(/^\| "([^|]+?)"[^|]*\| ([^|]+)\|$/gm)) quotes.push({ text: x[1].trim(), who: x[2].trim() });
  if (!quotes.length) for (const x of prose.matchAll(/"([^"\n]{12,})"/g)) quotes.push({ text: x[1].trim(), who: '' });
  const speaker = (prose.match(/^— ([^(\n]+?) \(/m)?.[1] || fm.episodes || '').trim();
  const media = [...body.matchAll(/<typ:media media_id="([^"]+)"/g)].map((x) => x[1]);
  const clipIds = new Set([...s.matchAll(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g)].map((x) => x[1])
    .filter((id) => new RegExp(`${id}[^\\n]{0,160}(clip|\\d+:\\d\\d)|(clip|Clip)[^\\n]{0,160}${id}`).test(s)));
  const clips = media.filter((id) => clipIds.has(id)).concat(isArticle ? [] : [...clipIds]);
  const words = (prose.match(/[A-Za-z0-9'’]+/g) || []).length;
  return {
    file, kind: isArticle ? 'X Article' : 'Long-form', title: title.replace(/^#+\s*/, ''), thesis: fm.thesis || '', headings, quotes, speaker,
    clips: [...new Set(clips)], hasNumbers: /\d/.test(prose), readMinutes: Math.max(1, Math.round(words / 250)), words, body: prose,
  };
}

export const BANNED = Object.freeze(['brutal', 'brutally', 'quietly', 'delve', 'navigating', 'leveraging']);
const norm = (t) => str(t).toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** PURE. The mechanical checks on a filled QRT: quotations found word for word in the material, no em-dash, no
 *  banned word, no "It's not X. It's Y.". Returns the failures (empty = pass). */
export function codeChecks(text, mat, { template = '' } = {}) {
  const fails = [];
  const hay = ` ${norm(`${mat.body}\n${mat.quotes.map((q) => q.text).join('\n')}\n${mat.title}\n${(mat.transcripts || []).join('\n')}`)} `;
  // A template whose quotation marks are its structure ("[modern gatekeeping belief]" people 20 years ago:) quotes a
  // belief, not the piece, so its quoted words are the fill, not a citation.
  for (const x of voiceQuotesOf(template) ? [] : str(text).matchAll(/["“]([^"”\n]{8,})["”]/g)) {
    for (const frag of x[1].split(/\.{3}|…/).map((f) => f.trim()).filter((f) => f.split(/\s+/).length >= 3)) {
      if (!hay.includes(` ${norm(frag)} `)) fails.push(`quote not in the material: "${clip(frag, 60)}"`);
    }
  }
  if (/—/.test(text)) fails.push('em-dash');
  for (const w of BANNED) if (new RegExp(`\\b${w}\\b`, 'i').test(text)) fails.push(`banned word "${w}"`);
  if (/\b(it'?s|this is|that'?s) not [^.!?\n]{1,60}[.!?]\s+(it'?s|this is|that'?s) /i.test(text)) fails.push('"It\'s not X. It\'s Y."');
  return fails;
}
