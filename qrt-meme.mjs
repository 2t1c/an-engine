#!/usr/bin/env node
// qrt-meme.mjs — the memes our QRT templates ride on: the donor's own clip, attached again.
//
// Ported from 2t1c/genius (qrt-meme.mjs at aba3896, owner 2026-10-02: "port into PI"). learnings/qrt/memes.json is a
// snapshot of Genius's meme pools; `scan` rebuilds it only where Genius's QRT library (learnings/qrt/library.json)
// lives. PI's changes: the clip uploads through clip-thread.mjs, the page is any PI account (--account is required),
// and learnings/qrt/meme-uses.json logs PI's own uses (the 14-day cooldown is retired, owner 2026-10-07).
//
//   node qrt-meme.mjs scan                                   # rebuild learnings/qrt/memes.json from the library's donors
//   node qrt-meme.mjs show [--template S2]                   # the meme templates and their pools
//   node qrt-meme.mjs upload --template S2 --account <page> [--tid <donor tweet id>]
//                                                            # upload the template's next meme; prints the media id
//   node qrt-meme.mjs attach --draft <id> --template S2 --account <page> [--tid <id>] [--dry]
//                                                            # upload it and put it on the draft (text and quote untouched)
//
// The operator, 2026-09-30: "please understand and remember to attach the same meme/gif that some of the original QRT
// had — part of the reason why the QRT works is because of the meme/gif" (their example: @HussainIbarra's "POV: You
// realize bro just dropped the secrets to becoming hyper successful in life:" over a 10-second movie clip, 158K views).
// The library says the same: 21 of the 22 "pov:" QRTs in it carry a clip. On these templates the clip IS the joke;
// the text is its caption. So a meme template goes out with a meme from its own donors, never as bare text.
//
// Which templates are meme templates is a judgment made by looking at the donors' clips (2026-09-30; `drop` is a donor
// whose clip turned out to be content, T099's scrolling page was content too): a reaction clip
// from a film, a show or a viral video that says nothing about the quoted post (the crying man, Ratatouille's critic,
// Narcos, Gollum, the celebration crowd). A clip OF the thing (Altman on stage, a chart, a screen recording) is content:
// it only fits its own post, so those templates still need the post's own media (qrt-pick's "rides on a clip or image").
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { templateFit } from './qrt-score.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MEMES_FILE = path.join(HERE, 'learnings', 'qrt', 'memes.json');
export const USES_FILE = path.join(HERE, 'learnings', 'qrt', 'meme-uses.json');
// Owner, 2026-10-07: "retire this rule 14 days is too long". 0 = no cooldown: a clip can ride again right away, and
// the pick is the best clip every time. The days stay a parameter so a caller can still ask for one.
export const MEME_COOLDOWN_DAYS = 0;
export const MEME_MAX_SECONDS = 60;
export const POOL_SIZE = 6;

// The meme templates: what the donor's clip looks like, and the opening that finds the template's other donors in the
// library (their clips join the pool). Hand-kept: a new meme template is added here after looking at its donors.
const OWN_CLIPS = {
  S2: { look: 'a film scene: a man shouting across a table', opening: /^pov:\s*you realize bro/i },
  S3: { look: 'someone in bed, realizing', opening: /^did bro (really )?just/i },
  S5: { look: 'a man laughing in disbelief', opening: /^why didn.t i find this/i },
  S7: { look: 'Gollum', opening: /^me after discovering/i },
  S10: { look: 'a man doubled over', opening: /^pov:\s*(you )?realiz/i },
  S11: { look: 'an orangutan staring', opening: /^me watching .* and realizing/i },
  T062: { look: 'the pov clip', opening: /^pov:\s*you /i },
  O19: { look: 'a man crying', opening: /^[^\n]{3,60} right now:?\s*$/i, drop: ['2070492725221494901'] },
  O9: { look: 'a celebration crowd', opening: /^bro just dropped a masterclass/i },
  O10: { look: 'Iron Man at his hologram', opening: /^from all (the )?.* i.ve seen, this is the best/i },
  T019: { look: 'a man doubled over', opening: /when i could.ve just read this|only to find this gem/i },
  T020: { look: 'Ratatouille: the critic\'s flashback', opening: /^you realizing you.ve been/i },
  T021: { look: 'two women, face to face', opening: /^me in the mirror/im },
  T034: { look: 'a man chugging in a car', opening: /watching .* (right now|rn)/i },
  T035: { look: 'a machine chewing through things', opening: /^\S+ with every /i },
  T036: { look: 'a girl running through a field', opening: /^life before this tweet/i },
  T045: { look: 'a film trader on the phone', opening: null },
  T047: { look: 'Limitless', opening: /^\S+ in (19|20)\d\d:\s*$/im },
  T048: { look: 'a man in a car with a Fendi bag', opening: /\bago is \$[\d,.]+[kmb]? today/i },
  T049: { look: 'a man waking up, close up', opening: /^✅/ },
  T055: { look: 'the "must be SHAKING" clip', opening: /must be SHAKING right now/ },
  T061: { look: 'Narcos: Pablo', opening: /^wait,? so (this guy|.*) basically/i },
  T074: { look: 'Narcos: Pablo waiting', opening: /^call me crazy but/i },
  T083: { look: 'a film man in a hat', opening: /^be [A-Z]/ },
  T085: { look: 'a celebration crowd', opening: null },
  T134: { look: 'a man strutting', opening: /^pretty sure .* is having the best week of (his|her|their) life/i },
  // Owner, 2026-10-07: three shelf formats that came with their own clip.
  HB1: { look: 'a man reads his phone, the mine bursts into diamonds', opening: /^this should be the (final|last) thing you read before/i },
  MA1: { look: 'Bruce Almighty: Jim Carrey typing like mad', opening: /^me after reading this,/i },
  MR1: { look: 'the Endgame funeral line-up', opening: /^how (mfs|people) who haven.t .* be moving/i },
  // @Become_Viral's network (owner, 2026-10-07: "Add this template", "merge the new formats"); its "final thing you
  // read" line is HB1 above.
  BV1: { look: 'a cartoon miner breaking through to a wall of diamonds', opening: /^pov:\s*when you read this/i },
  BV5: { look: 'a Limitless and Wolf of Wall Street montage', opening: /^pov:.*\bbut then you find this\b/i },
  PO1: { look: 'a tearful DiCaprio, vindicated', opening: /^all those years of refusing to .* (is|are) (about to )?pay(ing)? off/i },
};
// The owner's shelf (learnings/qrt/shelf.json, 2026-10-05): a format built on one of the clips above rides on that clip's
// pool (`alias`); it has no donors of its own to scan. Five formats ride on Iron Man alone, so a thread never carries
// two of them (echo-qrt.mjs chooseTemplates).
const SHELF_CLIPS = { V6: 'O10', V7: 'S5', V8: 'O9', V14: 'T019', V15: 'O9', H4: 'O10', R5: 'O10', HV1: 'T020', HV2: 'T020', I1: 'S11', I8: 'T021', 'O10.2': 'O10', 'O10.6': 'O10', DB1: 'O19', DB2: 'T034', DB8: 'T036' };
export const MEME_TEMPLATES = Object.freeze({
  ...OWN_CLIPS,
  ...Object.fromEntries(Object.entries(SHELF_CLIPS).map(([id, base]) => [id, { look: OWN_CLIPS[base].look, opening: null, alias: base }])),
});
/** The clip pool a meme template rides on: its own, or its alias's (a shelf format built on another template's clip). */
export const memePoolOf = (id) => MEME_TEMPLATES[String(id || '')]?.alias || String(id || '');

export const isMemeTemplate = (id) => Object.prototype.hasOwnProperty.call(MEME_TEMPLATES, String(id || ''));

/** PURE. A library row is a donor of meme template `id`: it is the catalog's donor, or opens the same way, with a clip. */
export function donorOf(id, row, catalogDonorUrl = null) {
  const m = MEME_TEMPLATES[id];
  if (!m || !row) return false;
  if (catalogDonorUrl && row.url === catalogDonorUrl) return true;
  if ((m.drop || []).includes(String(row.id || ''))) return false;
  if (!/video|gif/i.test(String(row.media || ''))) return false;
  return !!m.opening && m.opening.test(String(row.text || '').replace(/[’‘]/g, "'"));
}

/** PURE. The pool's candidate rows for template `id`, best first: the catalog's donor, then by views; at most `n`. */
export function poolRowsOf(id, rows, catalogDonorUrl = null, n = POOL_SIZE) {
  const hits = rows.filter((r) => donorOf(id, r, catalogDonorUrl));
  hits.sort((a, b) => (b.url === catalogDonorUrl) - (a.url === catalogDonorUrl) || (b.views || 0) - (a.views || 0));
  return hits.slice(0, n);
}

/** PURE. The clip to attach from `pool` (memes.json entries): among the ones this page hasn't used within the cooldown,
 *  a clip whose donor kept the template's frame (`fit` ≥ 0.8: the same meme on the same line) first, then the most
 *  viewed; when all are cooling down, the one used longest ago. `tid` forces a donor. Null when the pool is empty. */
export function pickMeme(pool, uses = [], { account = 'gtx', now = Date.now(), cooldownDays = MEME_COOLDOWN_DAYS, tid = null } = {}) {
  const clips = (pool || []).filter((c) => c.video);
  if (!clips.length) return null;
  if (tid) return clips.find((c) => c.tid === String(tid)) || null;
  const last = new Map();
  for (const u of uses) if (u.account === account) last.set(u.tid, Math.max(last.get(u.tid) || 0, Date.parse(u.at) || 0));
  const cut = now - cooldownDays * 864e5;
  const framed = (c) => ((c.fit ?? 0) >= 0.8 ? 1 : 0);
  const fresh = clips.filter((c) => !(last.get(c.tid) > cut)).sort((a, b) => framed(b) - framed(a) || (b.views || 0) - (a.views || 0));
  if (fresh.length) return fresh[0];
  return [...clips].sort((a, b) => (last.get(a.tid) || 0) - (last.get(b.tid) || 0))[0];
}

/** PURE. What a checked line on template `id` still needs: [] when it isn't a meme template or has its media. */
export const memeFails = ({ template, media }) => (isMemeTemplate(template) && !media ? [`${template} rides on its meme (${MEME_TEMPLATES[template].look}): attach it (node qrt-meme.mjs attach --template ${template})`] : []);

export function loadMemes(file = MEMES_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { memes: {} }; }
}
const loadUses = () => { try { return JSON.parse(fs.readFileSync(USES_FILE, 'utf8')); } catch { return []; } };

/** A tweet's first media, as fxtwitter serves it: { type, video (best mp4), thumb, duration, width, height }. */
export async function mediaOfTweet(url, { fetchImpl = fetch } = {}) {
  const m = String(url).match(/(?:x|twitter)\.com\/([^/]+)\/status\/(\d+)/);
  if (!m) return null;
  const r = await fetchImpl(`https://api.fxtwitter.com/${m[1]}/status/${m[2]}`);
  if (!r.ok) return null;
  const tw = (await r.json()).tweet || {};
  const it = (tw.media?.all || [])[0];
  if (!it) return { text: tw.text || '', views: tw.views ?? null, media: null };
  const mp4 = (it.variants || it.formats || []).filter((v) => /mp4/.test(v.content_type || v.container || '')).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
  return {
    text: tw.text || '', views: tw.views ?? null,
    media: { type: it.type, video: it.type === 'photo' ? null : (mp4?.url || it.url), image: it.type === 'photo' ? it.url : null, thumb: it.thumbnail_url || it.url, duration: it.duration ?? null, width: it.width ?? null, height: it.height ?? null },
  };
}

/** Upload template `id`'s next meme to a social set and log the use: { mediaId, clip }. */
export async function uploadMeme(tf, socialSetId, id, { account, tid = null, draft = null } = {}) {
  if (!account) throw new Error('uploadMeme: name the page (account), so its cooldown is its own');
  const { uploadFromUrl } = await import('./clip-thread.mjs');
  const pool = loadMemes().memes?.[memePoolOf(id)]?.pool || [];
  const clip = pickMeme(pool, loadUses(), { account, tid });
  if (!clip) throw new Error(`no meme in ${memePoolOf(id)}'s pool (node qrt-meme.mjs scan)`);
  const mediaId = await uploadFromUrl(tf, socialSetId, `${id}-${clip.tid}.mp4`, clip.video);
  const uses = loadUses();
  uses.push({ template: id, tid: clip.tid, account, draft, media: mediaId, at: new Date().toISOString() });
  fs.writeFileSync(USES_FILE, JSON.stringify(uses, null, 1) + '\n');
  return { mediaId, clip };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────────────────────────
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const arg = (k, d = null) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : d; };
  if (cmd === 'scan') {
    if (!fs.existsSync(path.join(HERE, 'learnings', 'qrt', 'library.json'))) {
      console.error('scan needs the QRT library (learnings/qrt/library.json), which lives in 2t1c/genius: run it there and copy learnings/qrt/memes.json across');
      process.exit(1);
    }
    const catalog = JSON.parse(fs.readFileSync(path.join(HERE, 'learnings', 'qrt', 'catalog.json'), 'utf8'));
    const rows = JSON.parse(fs.readFileSync(path.join(HERE, 'learnings', 'qrt', 'library.json'), 'utf8')).rows;
    const out = { generated: new Date().toISOString(), note: 'qrt-meme.mjs scan: each meme template\'s donor clips (fxtwitter). The clip is the joke; attach one with the template.', memes: {} };
    for (const id of Object.keys(MEME_TEMPLATES)) {
      if (MEME_TEMPLATES[id].alias) continue;   // a shelf format: it rides on its alias's pool
      const t = catalog.templates.find((x) => x.id === id);
      if (!t) { console.log(`${id}: not in the catalog`); continue; }
      const pool = [];
      for (const row of poolRowsOf(id, rows, t.donor?.url || null)) {
        const got = await mediaOfTweet(row.url).catch(() => null);
        const md = got?.media;
        if (!md?.video || (md.duration && md.duration > MEME_MAX_SECONDS)) continue;
        pool.push({ tid: row.id || row.url.split('/').pop(), url: row.url, handle: row.handle, views: row.views ?? got.views, fit: templateFit(t.skeleton, row.text).fit, text: String(row.text || '').slice(0, 200), ...md });
      }
      out.memes[id] = { look: MEME_TEMPLATES[id].look, skeleton: t.skeleton, pool };
      console.log(`${id} (${MEME_TEMPLATES[id].look}): ${pool.length} clip(s)`);
    }
    fs.writeFileSync(MEMES_FILE, JSON.stringify(out, null, 1) + '\n');
    console.log(`wrote ${path.relative(HERE, MEMES_FILE)}`);
    process.exit(0);
  }

  if (cmd === 'show') {
    const { memes } = loadMemes();
    const only = arg('--template');
    for (const [id, m] of Object.entries(memes)) {
      if (only && id !== only) continue;
      console.log(`${id} · ${m.look} · ${m.skeleton.replace(/\n/g, ' / ').slice(0, 70)}`);
      for (const c of m.pool) console.log(`   ${c.tid} @${c.handle} ${Math.round(c.duration || 0)}s ${(c.views || 0).toLocaleString('en-US')} views · ${c.text.replace(/\n/g, ' / ').slice(0, 60)}`);
    }
    process.exit(0);
  }

  if (cmd === 'upload' || cmd === 'attach') {
    const id = arg('--template');
    const { keyOf } = await import('./qrt-boxes.mjs');
    const account = keyOf(arg('--account'));
    const draftId = arg('--draft');
    if (!isMemeTemplate(id) || !account || (cmd === 'attach' && !draftId)) { console.error(`usage: node qrt-meme.mjs ${cmd} ${cmd === 'attach' ? '--draft <id> ' : ''}--template <meme template> --account <page> [--tid <id>]`); process.exit(1); }
    const { loadEnv, requireEnv, typefully } = await import('./lib.mjs');
    const { ACCOUNTS } = await import('./accounts.mjs');
    const socialSetId = ACCOUNTS[account]?.socialSetId;
    if (!socialSetId) { console.error(`unknown account ${account}`); process.exit(1); }
    if (argv.includes('--dry')) { const c = pickMeme(loadMemes().memes?.[id]?.pool || [], loadUses(), { account, tid: arg('--tid') }); console.log(`[dry] ${id} would attach ${c ? `${c.tid} (@${c.handle}, ${Math.round(c.duration || 0)}s)` : 'nothing: empty pool'}${draftId ? ` to draft ${draftId}` : ''}`); process.exit(0); }
    const env = loadEnv();
    requireEnv(env, ['TYPEFULLY_API_KEY']);
    const tf = typefully(env);
    const { mediaId, clip } = await uploadMeme(tf, socialSetId, id, { account, tid: arg('--tid'), draft: draftId ? Number(draftId) : null });
    console.log(`meme ${clip.tid} (@${clip.handle}, ${Math.round(clip.duration || 0)}s) uploaded: media id ${mediaId}`);
    if (cmd === 'attach') {
      const d = await tf.getDraft(socialSetId, draftId);
      const posts = d.platforms?.x?.posts || [];
      if (!posts.length) { console.error(`draft ${draftId} has no X post`); process.exit(1); }
      const next = posts.map((p, i) => ({ text: p.text, ...(i === 0 ? { media_ids: [mediaId] } : (p.media_ids?.length ? { media_ids: p.media_ids } : {})), ...(p.quote_post_url ? { quote_post_url: p.quote_post_url } : {}) }));
      await tf.patchDraft(socialSetId, draftId, { platforms: { x: { enabled: true, posts: next } } });
      console.log(`draft ${draftId} now carries it · schedule unchanged${d.publish_at ? ` (${d.publish_at})` : ''}`);
    }
    process.exit(0);
  }

  console.error('usage: node qrt-meme.mjs scan | show [--template <id>] | upload --template <id> --account <page> | attach --draft <id> --template <id> --account <page> [--dry]');
  process.exit(1);
}
