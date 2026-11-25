// donor-routes.mjs — two ways a recent health thread reaches the picker that the substance screen used to
// close (owner, 2026-09-28).
//
// 1. NO NAMED SUPPLEMENT. preflight's screen drops a thread whose words name nothing we can sell, and on
//    R2026-09-27 that was 56 of the 154 threads under 30 days with 500k+ views. The owner: "Yes to jev picks
//    and Off niche is defined as completely outside of the health niche". So a recent thread the swipe DB's
//    calibrated niche tag (tag-niche.mjs, where Health merges Health, Fitness and Mental Health) calls Health
//    is offered the pods of its topic, and Jev's registered donor-writeability decision picks the one whose
//    buying criterion is the natural next question. That product rides as needsBridge: the writer builds the
//    bridge the donor never wrote. No pod fits, or the thread is outside Health: it stays out.
// 2. SPANISH. 12 of those 56 were Spanish, and Jev's donor screen refuses a non-English donor. The owner:
//    "Yes, health ones": a Health thread whose only screen flag is its language passes, marked to be
//    recreated in English.

// THE ROUTE'S RULE, in one place for review. Jev's donor-writeability answers say, per offered pod, whether
// its criterion is "the natural next question" after the thread (a noul). That decision swaps below 0.5,
// its bar for a thread that NAMES its product; a thread that names none never raises the question, so on
// the 23 recent Health threads of 2026-09-28 every pod read 0.03-0.21. Their ORDER still made sense: waking
// to pee at night -> magnesium 0.21, "6 SEÑALES de testosterona" -> zinc 0.21, Haaland's sleep -> magnesium
// 0.15, "90% of heart attacks" -> CoQ10 / nitric oxide 0.13; the first-aid and intimate threads (a fish bone,
// silica gel, a fever at 2am, period sex) topped out at 0.10 or lower. So the route takes Jev's top pod when
// it reaches podFloor, and never takes a thread that is not recreatable as text or only works with media.
// podFloor was set from those 23 threads, not calibrated: revisit it once the route's covers have results.
export const JEV_ROUTE = Object.freeze({ podFloor: 0.12 });

// The pod topics each donor topic may borrow (preflight classifyTopic -> pods.json topics).
export const TOPIC_NEIGHBOURS = Object.freeze({
  fitness: ['fitness', 'muscle', 'performance', 'recovery', 'protein'],
  sleep: ['sleep', 'cortisol', 'stress'], stress: ['stress', 'cortisol', 'sleep'],
  heart: ['heart', 'circulation', 'omega'], brain: ['brain', 'focus', 'memory'],
  skin: ['skin', 'beauty', 'hair', 'aging'], energy: ['energy', 'mitochondria'],
  testosterone: ['testosterone', 'performance'], joint: ['joint', 'inflammation', 'recovery'],
  bloodsugar: ['weight', 'inflammation'], liver: ['inflammation'], gut: ['gut', 'immune'],
});

// The fleet's topic classifier (pick-product.mjs classifyTopic, topics.json) reads English, so on a Spanish
// health thread it finds nothing (`general`, offered the best earners) or half a word: on 2026-10-02
// "6 SEÑALES de que tienes una TESTOSTERONA altísima" classified as `energy` off "energía" and was offered
// NAD, not zinc. For a thread that reads as Spanish, these hints name the subject instead: the hook first,
// then the whole thread, first match in this order.
export const SPANISH_TOPICS = Object.freeze([
  ['testosterone', /testosteron|erecci[oó]n|libido/i],
  ['sleep', /\bsue[nñ]o\b|dormir|insomnio/i],
  ['heart', /coraz[oó]n|infarto|presi[oó]n arterial|colesterol/i],
  ['brain', /cerebro|demencia|memoria|alzheimer|neur[oó]log/i],
  ['stress', /estr[eé]s|ansiedad|cortisol/i],
  ['bloodsugar', /insulina|glucosa|az[uú]car en (?:la )?sangre|diabetes/i],
  ['gut', /intestin|digesti[oó]n|hinchaz[oó]n|microbiota/i],
  ['liver', /h[ií]gado/i],
  ['joint', /articulaci|rodilla|inflamaci[oó]n/i],
  ['fitness', /m[uú]sculo|entrenamiento|gimnasio|ejercicio/i],
  ['skin', /\bpiel\b|arrugas|cabello/i],
  ['energy', /energ[ií]a|cansancio|fatiga/i],
]);

// Spanish function words; six in one thread is Spanish, not an English thread quoting a name.
const ES_WORDS = /(?<![\p{L}])(?:que|de|del|la|las|los|el|una|para|con|por|tu|tus|tienes|es|est[aá]s?|cuando|como|m[aá]s|muy)(?![\p{L}])/giu;

/** PURE. Whether a thread reads as Spanish. */
export function looksSpanish(text = '') {
  return (String(text).match(ES_WORDS) || []).length >= 6;
}

/** PURE. The topic a routed donor's pods come from: the classifier's, unless the thread reads as Spanish
 *  or the classifier found nothing (`general`), when the first Spanish hint in the hook, then the thread,
 *  names it. No hint keeps the classifier's topic. */
export function routeTopic(topic, hook = '', text = '') {
  if (topic && topic !== 'general' && !looksSpanish(`${hook}\n${text}`)) return topic;
  const hint = (t) => SPANISH_TOPICS.find(([, re]) => re.test(String(t)))?.[0];
  return hint(hook) || hint(text) || topic || 'general';
}

/** PURE. The pods Jev may choose from for a donor on `topic`: live, with a criterion, sellable, on that
 *  topic or its neighbours, best measured EPC first. A topic with no pod (or `general`) is offered the
 *  best-earning pods. */
export function topicPods(pods = [], topic, { sellable = () => true, epcOf = () => 0, max = 6 } = {}) {
  const live = pods.filter((p) => p && p.status !== 'retired' && p.criterion && p.asin && sellable(p.asin));
  const byEpc = (a, b) => (epcOf(b.asin) - epcOf(a.asin)) || String(a.id).localeCompare(String(b.id));
  const wanted = new Set(TOPIC_NEIGHBOURS[topic] || [topic]);
  const onTopic = live.filter((p) => (p.topics || []).some((t) => wanted.has(t))).sort(byEpc);
  const pool = onTopic.length ? onTopic : live.slice().sort(byEpc);
  const seen = new Set();
  return pool.filter((p) => !seen.has(p.asin) && seen.add(p.asin)).slice(0, max)
    .map((p) => ({ id: p.id, asin: p.asin, substance: p.substance, criterion: p.criterion }));
}

/** PURE. The off-niche exception (owner 2026-09-28, on @BeBetterMan_'s tax, aura and IQ threads: "we accept
 *  BebetterMan as he is an exception to the rule"). The handle behind a donor's tweet URL, when it is on
 *  the exception list; null otherwise. Case-insensitive, like X handles. */
export function offNicheException(tweetUrl = '', handles = []) {
  const h = (String(tweetUrl).match(/(?:x|twitter)\.com\/([^/?#]+)\/status\//i) || [])[1];
  if (!h) return null;
  return handles.find((x) => String(x).toLowerCase() === h.toLowerCase()) || null;
}

/** PURE. The language a Health donor is recreated from, when the donor screen's ONLY flags are its language
 *  ('language:spanish'); null when anything else was flagged or the thread is not Health. */
export function translationOf(reasons = [], niche = '') {
  if (niche !== 'Health' || !reasons.length || !reasons.every((r) => /^language:[a-z-]+$/i.test(String(r)))) return null;
  return String(reasons[0]).slice('language:'.length).toLowerCase();
}

/** PURE. The route's pick from Jev's donor-writeability answers: the top pod when it reaches podFloor and
 *  the thread is recreatable as text without its media. { pod, reason } — pod null when nothing fits. */
export function routePick(answers = {}, pods = [], { podFloor = JEV_ROUTE.podFloor, recreatableLow, flagAt } = {}) {
  const n = (k) => answers?.[k]?.noul;
  if (Number.isFinite(n('media_or_poll')) && Number.isFinite(flagAt) && n('media_or_poll') >= flagAt) return { pod: null, reason: 'media_or_poll' };
  if (Number.isFinite(n('recreatable')) && Number.isFinite(recreatableLow) && n('recreatable') < recreatableLow) return { pod: null, reason: 'not_recreatable' };
  const scored = pods.map((p, i) => ({ p, s: n(`pod_${'abcdef'[i]}`) })).filter((x) => Number.isFinite(x.s));
  if (!scored.length) return { pod: null, reason: 'not read' };
  const best = scored.reduce((a, b) => (b.s > a.s ? b : a));
  return best.s >= podFloor ? { pod: best.p, reason: null, score: best.s } : { pod: null, reason: `best pod ${best.p.id} ${best.s.toFixed(2)} under ${podFloor}` };
}
