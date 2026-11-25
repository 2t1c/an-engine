// Per-account config. Adding a new account = adding a block here. The engine is generic.
// SLOT CONFIG. Posting times are NOT set here any more. Every account's two daily slots come from
// accountSlots() in slots.mjs, which spreads the fleet across the operator's two windows (06:00-07:30
// and 13:00-15:30 Saigon, 2026-08-19). The per-account `recreateSlots` overrides that used to live
// here were removed on 2026-08-20: they silently won over the new windows (`acc.recreateSlots ||
// accountSlots(...)`), leaving six of twelve configured slots outside the windows and five accounts
// still posting once a day. An override is still honoured if one is ever re-added for a deliberate
// experiment — but it must be a decision, not a leftover.
// (historical: the retired fleet default was 11:00 UTC / 6pm
// Saigon, daily-winners SLOT_TIMES). fill-account follows the same field. Two fields used to
// duplicate this (`postHour`, `harvestHour`) and both drifted to fiction — postHour said 19:00
// Saigon for every account long after the queues moved, harvestHour said 21:00 while the actual
// harvest cron runs 08:00 Saigon (n8n typefully-harvest.yml) — so they were deleted 2026-08-18
// rather than re-synced. A copy that nothing validates WILL go stale; add a second slot field
// again only with a test that pins it to this one.
// The one disclaimer every account shared until 2026-08-23. Kept ONLY so the gates and nightly QC
// still recognize the boilerplate on drafts written before the rewrite (checks.mjs disclaimerTexts);
// it is never posted again. The rewrite exists because nine accounts posting one identical, exactly
// searchable sentence is the cheapest network fingerprint there is — same reason every closing below
// now has its own shape instead of the shared "Copy the link to this thread..." template.
const LEGACY_DISCLAIMER = `DISCLAIMER:\n\nThis thread may contain affiliate links. It is not intended to prevent, diagnose, or treat disease. Consult a licensed practitioner before starting any new health protocol.`;

export const ACCOUNTS = {
  julian: {
    name: 'Julian',
    sex: 'm', // persona sex: the voice is first person, so a product titled for the other sex reads wrong in "The X I use" (R2026-10-03; scripts/product-allocation.mjs)
    handle: 'CoachJulianNiko',
    socialSetId: 310136,
    // 3PM SLOT PILOT (operator 2026-08-15 -> review 2026-09-14). Magnus's 2/day window showed the
    // 3pm Saigon slot averaging 1.91M views vs 266k at 9pm (4 virals vs 1), but hour was welded to
    // post-ORDER there — 3pm was always the day's FIRST post — so that read proves nothing on its own.
    // This pilot un-welds them: 1/day ONLY, 3pm, so the hour is the only thing that changed.
    // Julian is the deliberate ADVERSARIAL arm: the one mature page where 9pm currently BEATS 6pm
    // (mean 263k vs 128k), and the only mature page carrying no other experiment flag. A 3pm win here
    // is the strongest evidence available; a loss kills the idea cheaply.
    // Judge on MEDIAN + viral rate, never mean — the top 10% of posts carry 83% of fleet views, so one
    // lucky thread makes any arm look like a winner. Needs ~30 posts (~30 days) to move a median.
    // Revert: delete this line (falls back to the fleet default SLOT_TIMES, 11:00 UTC / 6pm Saigon).
    niches: ['Health', 'Fitness', 'Mental Health', 'Psychology'],
    weeklyFloor: 750_000,   // last-7-day recreation floor (750K 2026-07-12; weekly is dispatch-only under the 1/day cadence — same bar as the daily engine)
    allTimeFloor: 2_000_000,  // all-time queue floor
    slots: 7, weeklyTopTier: 5, evergreenSlots: 1, weeklyMax: 4, allTimeSlots: 2, backfillMax: 3, // weekly = up to 3 top recent (>=weeklyFloor) + 1 evergreen + 1 variation-of-best; daily-winners backfills the rest. weeklyMax/allTimeSlots/backfillMax are legacy (all-time dropped from the weekly slate 2026-07-11).
    tz: 'Asia/Saigon',
    levantaSubidPrefix: 'x-thread-julian',
    // THREADS CROSS-POST — the shared rationale. Fourteen other blocks point here; this is the
    // place that has to stay true.
    //
    // ROSTER. Pilot on Julian alone (operator 2026-08-20, @coachjulianniko) -> 5 accounts on
    // 2026-09-06 -> 15 on 2026-09-07/08. The remaining nine stay OFF, and deliberately: they have
    // no Threads profile connected in Typefully, so `platforms.threads` is null and this flag would
    // be SILENTLY INERT on them — configured as enabled, minting nothing, surfacing in no error.
    // Connect the profile in the Typefully UI first, then add the line. Nothing in code can check
    // this for you: the scaffold pins that a crossPost entry names a real platform, not that the
    // account has that platform connected.
    //
    // WHY IT IS WORTH ANYTHING. Levanta reports on SUBIDS and never on referrers, so the only way
    // Threads is separable from X is that its copy carries its OWN minted links — the X subid plus
    // "-th" (platforms.mjs' convention, minted by cross-post-links.mjs at CREATE). With the Meta
    // insights API out of scope by decision (no followers, views or reach, ever), that subid split
    // is the ONLY signal this channel has.
    //
    // TWO WAYS TO DESTROY THE MEASUREMENT, both silent, both easy:
    //   1. MAKING THE COPY IDENTICAL TO X. Any write that patches `platforms` with `{ existing }`
    //      and no `platformPosts` re-uses X's links on the copy. buildPlatforms' precedence is
    //      `platformPosts || existing[p].posts || posts`, so this looks like a no-op and is not:
    //      once a shared link publishes, those Threads clicks merge into X's subid and NO report
    //      can ever separate them again. Repairs reach the copy through rebuildCrossPosts
    //      (platforms.mjs); qc reports the damage as `collapsed`; crosspost-backfill.mjs repairs
    //      drafts that have not published yet. After publication it is unrecoverable.
    //   2. TURNING ON TYPEFULLY'S COMPOSER AUTO-SYNC. The UI offers to keep a cross-post in step
    //      with X automatically. It does that by copying X's text — including X's links — over the
    //      copy, which is failure 1 applied to every draft at once, from outside this repo where no
    //      test can see it. Leave it OFF on every account. This is the "never-sync rule".
    //
    // One exception that is NOT a fault: a Harvest variation (v1/v2/v3) carries its PARENT's links
    // on purpose, so its revenue merges into the parent's subid. Those drafts read as `collapsed`
    // for ever and should. Do not "fix" them — see crosspost-backfill.mjs' header.
    crossPost: ['threads'],
    // Fallback when no product thematically fits: the PROVEN sleep single (real conversions, singles-only
    // rule). The old 'Night Before' default was a house-brand SKU checks.mjs STACK_RE later deny-listed as
    // multi-ingredient — the fallback path bypassed that deny on every general-topic slot.
    defaultProduct: { asin: 'B0DZ33GTQ2', title: 'Sports Research Magnesium Glycinate Capsules, High Absorption Chelated Magnesium for Sleep' },
    // Fallback rotation pool (day-rotated with the default when no product thematically fits — pickFallback).
    altProducts: [
      { asin: 'B0DLDZSQ5T', title: 'Nutricost KSM-66 Ashwagandha Root Extract 600mg, 30 Veggie Caps' },
      // B098KLWZHN retired 2026-08-26 (EPC $0.083). Same substance, but the Sports Research triple
      // strength earns $0.593 a click — seven times more — so the fallback points there instead.
      { asin: 'B07DX89ZHN', title: 'Sports Research Omega-3 Fish Oil 1250mg Triple Strength' },
    ],
    // Voice + closing, distilled from Julian's live high performers.
    voice: [
      'Warm, authoritative health educator. Calm and caring, never hypey.',
      'Short sentences. Generous line breaks. One or two sentences per paragraph.',
      'First person, low pressure. Reason before recommendation.',
      'No em dashes. No fake urgency. No "game-changer" hype words.',
      'Mechanism-driven: name the body system, then the simple fix.',
    ].join('\n'),
    // Final tweets appended to every recreation, in order: sign-off then disclaimer (disclaimer is the literal last tweet).
    closing: `What's the one change from this thread you'll actually start this week?\n\nIf it helped you, tap share and send it to someone you love.`,
    closingLegacy: [`If this thread helps even one person you love, it was worth writing. Pass it on to them.\n\nWith the deepest respect and love,\n\nJulian.`, `Copy the link to this thread and send it to someone you love.\n\nWith the deepest respect and love,\n\nJulian.`],
    disclaimer: `Before you go: a few links above are affiliate links, and I may earn a small commission if you buy. Your price does not change. This thread is education, not medical advice, and the FDA has not reviewed these statements. Please clear new supplements with your doctor first.`,
    disclaimerLegacy: [LEGACY_DISCLAIMER],
    // Style anchors (docs/cta-spec.md §4): the plug is TWO beats + the CTA line —
    // (1) a payoff that lands the prior tweet's point, reusing one of its concrete words;
    // (2) a switch: the exact form and how long you have taken it, then two or three plain benefits;
    // (3) a CTA line that is "I" + a recommendation verb and carries its own "(#ad)".
    // The examples below predate that shape and are kept only as VOICE samples for their account.
    // ("{PRODUCT} is the best-absorbing one I've tried:"), never an absolute. "#ad" + link on
    // their own lines. The two plugs MUST use different lead concepts AND different superlative forms.
    plugHeavyExample: `If your mind won't switch off at night, it's often high cortisol.\n\nResearch links magnesium glycinate to lower cortisol, looser muscles, and deeper sleep.\n\n{PRODUCT} is the best-absorbing one I've tried:\n\n#ad\n\n{LINK}`,
    plugLightExample: `Most 3am wakeups trace back to low magnesium.\n\nStudies tie magnesium to calmer nerves, less tension, and deeper sleep.\n\n{PRODUCT} is the only one I keep by my bed:\n\n#ad\n\n{LINK}`,
  },
  rafael: {
    name: 'Rafael Nasri',
    sex: 'm',
    handle: 'RafaelNasriX',
    // Resumed 2026-07-24 (operator call). Was paused 2026-07-20 over a possible shadowban; re-add
    // `paused: true` here to pause again — the flag overrides everything everywhere while set.
    variationMode: true, // skeleton-variation mode 2026-07-24 (operator: "more data") — flip to false to disable
    // Topic universe for the rotation (warm general-health spread; each plugs its own best curated
    // product — sleep/stress -> magnesium, heart -> omega, gut -> probiotic, energy -> its KEEP fit).
    // Distinct from Lorenzo's beauty set (skin/joint) so the two pages widen the skeleton dataset.
    variationTopics: ['sleep', 'stress', 'heart', 'gut', 'energy'],
    socialSetId: 317434,
    // Threads account connected in Typefully (operator 2026-09-06: "create a version of our threads for
    // them too"). publish-thread mints each platform its own link (cross-post-links.mjs, subid -th).
    crossPost: ['threads'],
    // US-EVENING TEST (operator 2026-08-14, Rafael + Lorenzo only): 6pm Saigon (11:00 UTC = 7am ET)
    // PLUS 6am Saigon (23:00 UTC = 7pm ET / 4pm PT). Rationale: X has no time-of-day feature and posts
    // stay eligible 48h, so posting time buys nothing directly — but it decides who is awake to supply
    // the EARLY engagement that starts the score snowball, and US evening is near-empty of big
    // creators (they post business hours). 23:00 UTC is a UTC-day time, and openSlots() is pure UTC,
    // so there is no Saigon day-wrap to handle. Fleet default (1/day 6pm) is unchanged; Magnus is
    // deliberately excluded so his direct-link A/B keeps a stable schedule.
    // Revert: delete this line (falls back to SLOT_TIMES). Judge vs the 1/day pages in the registry.
    niches: ['Health', 'Fitness', 'Mental Health', 'Psychology'],
    weeklyFloor: 750_000,
    allTimeFloor: 2_000_000,
    slots: 7, weeklyTopTier: 5, evergreenSlots: 1, weeklyMax: 4, allTimeSlots: 2, backfillMax: 3,
    tz: 'Asia/Saigon',
    levantaSubidPrefix: 'x-thread-rafael', // distinct prefix → per-account revenue attribution
    // Cloned from Julian per setup decision (warm general health educator).
    defaultProduct: { asin: 'B0DZ33GTQ2', title: 'Sports Research Magnesium Glycinate Capsules, High Absorption Chelated Magnesium for Sleep' },
    // Fallback rotation pool (day-rotated with the default when no product thematically fits — pickFallback).
    altProducts: [
      { asin: 'B09SFFJP1P', title: 'Nutricost Beet Root 2400mg, 180 Capsules' },
      { asin: 'B018GPDCV4', title: 'Nutricost Turmeric Curcumin with BioPerine, 2300mg' },
    ],
    voice: [
      'Warm, authoritative health educator. Calm and caring, never hypey.',
      'Short sentences. Generous line breaks. One or two sentences per paragraph.',
      'First person, low pressure. Reason before recommendation.',
      'No em dashes. No fake urgency. No "game-changer" hype words.',
      'Mechanism-driven: name the body system, then the simple fix.',
    ].join('\n'),
    closing: `Which of these did your doctor never mention to you?\n\nShare it forward, a label-reader you know will thank you.`,
    closingLegacy: [`I write one of these deep dives every week. Follow along so the next one finds you.\n\nStay well,\n\nRafael.`, `Copy the link to this thread and send it to someone who needs it.\n\nStay well,\n\nRafael.`],
    disclaimer: `Quick disclosure: some links in this thread are affiliate links that pay me a commission when you purchase, at no added cost on your end. Nothing here is medical advice, and the statements above carry no FDA review. Ask your physician before starting any supplement.`,
    disclaimerLegacy: [LEGACY_DISCLAIMER],
    plugHeavyExample: `If your mind won't switch off at night, it's often high cortisol.\n\nResearch links magnesium glycinate to lower cortisol, looser muscles, and deeper sleep.\n\n{PRODUCT} is the best-absorbing one I've tried:\n\n#ad\n\n{LINK}`,
    plugLightExample: `Most 3am wakeups trace back to low magnesium.\n\nStudies tie magnesium to calmer nerves, less tension, and deeper sleep.\n\n{PRODUCT} is the only one I keep by my bed:\n\n#ad\n\n{LINK}`,
  },
  // knox: REMOVED 2026-08-19 — account suspended by X, every tweet gone; operator ordered full
  // purge. All 570 Airtable rows archived first: logs/knox-purge-2026-08-19.json.
  magnus: {
    name: 'Magnus',
    sex: 'm',
    handle: 'MagnusLindbrg',
    socialSetId: 314451,
    // Threads account connected in Typefully (operator 2026-09-06: "create a version of our threads for
    // them too"). publish-thread mints each platform its own link (cross-post-links.mjs, subid -th).
    crossPost: ['threads'],
    // CADENCE EXPERIMENT (2026-08-09 -> review 2026-08-22, operator 2026-08-08): 2 posts/day for
    // Magnus ONLY — 3pm + 9pm Saigon (08:00 + 14:00 UTC), 6 hours apart. Theory: X counts each
    // thread tweet as its own post, so clustered posting trips the anti-clutter de-boost; a 6h gap
    // should let two threads/day carry full reach (same reason we prefer shorter threads). Both
    // engines (run-weekly + daily-winners) read this override; fleet default stays 1/day 6pm.
    // Revert: delete this line. Judge with registry impressions/revenue vs the 1/day pages.
    niches: ['Health', 'Fitness', 'Mental Health', 'Psychology'], // shares Julian's pool; the ledger dedup spreads distinct winners across the two pages
    weeklyFloor: 750_000,
    allTimeFloor: 2_000_000,
    slots: 7, weeklyTopTier: 5, evergreenSlots: 1, weeklyMax: 4, allTimeSlots: 2, backfillMax: 3,
    tz: 'Asia/Saigon',
    levantaSubidPrefix: 'x-thread-magnus',
    // DIRECT-LINK A/B (operator 2026-08-11, moved from Julian at operator request): ship the raw
    // Amazon URL instead of Levanta's lvnta.com mobile link, which serves an 'Open in "Amazon"?'
    // tap gate to in-app browsers — one extra tap on every mobile click. Attribution is identical
    // (aa_adgroupid = link id; see recreate.mjs). Levanta's `clicks` metric counts lvnta redirects,
    // so THIS ACCOUNT likely reports ~0 clicks: judge it on conversions per 1k VIEWS, never EPC.
    // Magnus = highest volume (2/day) -> fastest read, at the cost of the 2/day confound.
    // A/B ENDED 2026-08-18: the operator now reads the Levanta dashboard to steer, and the direct
    // rail reports 24-48h behind, so this account's numbers were always the stalest on the fleet.
    // Levanta rail everywhere; the interstitial tap is the accepted cost.
    directLink: false,
    // Distinct default from Julian's magnesium (avoids same-SKU concentration the retro flagged).
    // Creatine held this slot until 2026-08-23, when the operator cut it from the menu (860 clicks ->
    // $24 on the clean-CTA week). Zinc drops held this slot until 2026-09-21, when the operator swept
    // the defaults against the $0.45 floor: zinc restated at $0.361 on 1,554 clicks, so it could not be
    // the product a thread falls back to. NAD+ replaces it, which returns this page to the lane the
    // Wave 3 comments already describe as his ("distinct from Julian (magnesium) + Magnus (NAD+)"):
    // $0.453 restated on 4,153 clicks, in KEEP, in stock. It is the narrowest pass of the four, and it
    // is shared with felicia — whey ($0.560) and the SR L-threonate ($0.908) both out-earn it and both
    // sit in `allow` rather than `keep`, which a default may not use. Promoting either into KEEP is a
    // curation decision for the operator, not something a defaults sweep should do on its own.
    defaultProduct: { asin: 'B0DVFD5Q65', title: 'Nutricost NAD+ Supplement 1,000mg per Serving' },
    // Fallback rotation pool (day-rotated with the default when no product thematically fits — pickFallback).
    // Ginkgo (B01BCULYEC) removed the same day: $0.00 on 86 clicks and not on the allowlist, so it was
    // dead in the rotation and would have gone live the moment PRODUCT_ALLOWLIST=0 flipped it back on.
    altProducts: [
      { asin: 'B09QFSDLL5', title: 'Nutricost Magnesium L-Threonate As Magtein 2000mg, 120 Capsules' },
    ],
    // Magnus = elite performance + longevity coach. Optimization-minded, data-aware, still grounded.
    voice: [
      'Elite performance and longevity coach. Precise, evidence-led, optimization-minded but grounded, never bro-science.',
      'Short, confident sentences. Generous line breaks. One or two sentences per paragraph.',
      'First person. Reason and mechanism before any recommendation.',
      'No em dashes. No hype words. No fake urgency. Calm authority.',
      'Frames health as a system to optimize: name the lever (mitochondria, hormones, recovery, glucose), then the simple input.',
    ].join('\n'),
    closing: `Which habit here would move the needle most for you right now?\n\nHit the share button and fire this at a training partner.`,
    closingLegacy: [`Bookmark this one. You will want it on the hard days.\n\nTo your healthspan,\n\nMagnus.`, `Copy the link to this thread and send it to someone you want around for longer.\n\nTo your healthspan,\n\nMagnus.`],
    disclaimer: `The fine print: buy through an affiliate link here and a small commission comes my way. You pay the same either way. Educational content, not medical advice; no statement here has been checked by the FDA. Run new supplements past your doctor, especially on medication.`,
    disclaimerLegacy: [LEGACY_DISCLAIMER],
    // Style anchors (docs/cta-spec.md §4): the plug is TWO beats + the CTA line —
    // (1) a payoff that lands the prior tweet's point, reusing one of its concrete words;
    // (2) a switch: the exact form and how long you have taken it, then two or three plain benefits;
    // (3) a CTA line that is "I" + a recommendation verb and carries its own "(#ad)".
    // The examples below predate that shape and are kept only as VOICE samples for their account.
    // ("{PRODUCT} is the best-absorbing one I've tried:"), never an absolute. "#ad" + link on
    // their own lines. The two plugs MUST use different lead concepts AND different superlative forms.
    plugHeavyExample: `By 40, steady energy comes down to how much NAD your cells have.\n\nStudies tie NAD to steadier energy, sharper focus, and slower aging.\n\n{PRODUCT} is the best-converting one I've found:\n\n#ad\n\n{LINK}`,
    plugLightExample: `That afternoon crash is really your cells running low on NAD.\n\nResearch links NAD to steadier output, faster recovery, and slower cellular aging.\n\n{PRODUCT} is the only one I still take daily:\n\n#ad\n\n{LINK}`,
  },
  lorenzo: {
    name: 'Lorenzo',
    sex: 'm',
    handle: 'mind_and_beauty',
    // The page is @thelorenzorosi on X since about 2026-10-04; Typefully, the Fuel lanes (routes.json) and
    // the rest of the fleet still key on `handle`. Reads that ask X itself (followers, view search) use xHandle.
    xHandle: 'thelorenzorosi',
    variationMode: true, // staged into skeleton-variation mode 2026-07-17 — keeps the viral FORM, writes new product-fit content (X duplicate-content enforcement); flip to false to disable
    // Topic universe for skeleton-variation rotation (operator-editable, 2026-07-20): without this the
    // rotation is limited to the default product's regex fit (collagen -> joint/skin only — "why are we
    // just writing about joint pain?"). Each rotated topic plugs its own best curated product
    // (keepProductForTopic: learned converter first, else highest-value KEEP fit), so a sleep night
    // plugs magnesium, not collagen. All five fit the mind-and-beauty persona (beauty from within).
    variationTopics: ['skin', 'joint', 'gut', 'sleep', 'stress'],
    socialSetId: 314704,
    // Threads account connected in Typefully (operator 2026-09-06: "create a version of our threads for
    // them too"). publish-thread mints each platform its own link (cross-post-links.mjs, subid -th).
    crossPost: ['threads'],
    // US-EVENING TEST (operator 2026-08-14) — see the same block on `rafael` for the full rationale.
    // 6pm Saigon + 6am Saigon (23:00 UTC = 7pm ET / 4pm PT). Offset 5 min from Rafael's 6am slot so
    // the two pages never compete for the same minute of audience (same convention as the new-page
    // 5pm stagger below). Revert: delete this line.
    niches: ['Health', 'Fitness', 'Mental Health', 'Psychology'], // shares the health/mind pool; cross-account dedup gives each of the 3 pages distinct sources
    weeklyFloor: 750_000,
    allTimeFloor: 2_000_000,
    slots: 7, weeklyTopTier: 5, evergreenSlots: 1, weeklyMax: 4, allTimeSlots: 2, backfillMax: 3,
    tz: 'Asia/Saigon',
    levantaSubidPrefix: 'x-thread-lorenzo',
    // Beauty-from-within default, distinct from Julian (magnesium) + Magnus (NAD+): a collagen.
    // Sleep stays the default lane — on-brand for @mind_and_beauty ("beauty sleep"), and REVO Collagen
    // stays in KEEP for topical skin threads. The SKU changed 2026-08-25: Nutricost Magnesium 180ct was
    // removed fleet-wide after settled 90d Levanta reports measured it at 1.4% CVR / EPC 0.068 on 6,026
    // clicks — under half its own 210mg sibling. (The "15.2% CVR / $0.69 EPC" in the previous note was a
    // stale lifetime figure that the settled window no longer supports.) FF The Night Before is the same
    // sleep-magnesium promise at EPC 0.374, 5.5x the revenue per click. Its CVR looks low (0.9%) because
    // it is the 80%-commission class: rare conversions, ~$88 each — judge it on EPC, never on CVR.
    // RE-POINTED 2026-09-19. The Night Before (B0DP3MT8YJ) is not in the accessible Levanta catalog
    // any more -- no Formulation Factory SKU is -- so it held no products.json row, the weekly stock
    // sync never saw it, and a mint on it would have 404'd mid-run. Same topic, and the fleet's
    // longest-running sleep product: 11,478 clicks at a restated $0.475.
    defaultProduct: { asin: 'B0GT2JKMYZ', title: 'DR Vitamin Solutions Magnesium Glycinate 200mg' },
    // Fallback rotation pool (day-rotated with the default when no product thematically fits — pickFallback).
    altProducts: [
      { asin: 'B0CLYQ9KX2', title: 'Organic Liquid Zinc Drops with Chelated Picolinate and Bisglycinate' },
      { asin: 'B09KVLBB78', title: 'Why Not Natural Organic Vitamin D3 K2 (MK-7) Liquid Drops' },
    ],
    // Lorenzo Laurent = refined mind-and-beauty coach. Beauty as a reflection of inner health.
    voice: [
      'Refined mind-and-beauty coach. Calm, elegant, evidence-led; treats beauty as a reflection of inner health.',
      'Short, graceful sentences. Generous line breaks. One or two sentences per paragraph.',
      'First person, unhurried. Reason and mechanism before any recommendation.',
      'No em dashes. No hype words. No fake urgency.',
      'Frames beauty from within: name the system (skin, gut, hormones, sleep, stress), then the simple input.',
    ].join('\n'),
    closing: `What's the first thing you'd fix about your routine after reading this?\n\nShare it with a friend who's still guessing.`,
    closingLegacy: [`Know someone chasing better skin the hard way? Show them this thread.\n\nWith care,\n\nLorenzo.`, `Copy the link to this thread and send it to a friend who deserves to glow.\n\nWith care,\n\nLorenzo.`],
    disclaimer: `Full transparency: certain links are affiliate links and can earn me a small commission without raising what you pay. Treat this thread as education rather than medical advice. The FDA has not evaluated these claims. Check with your doctor before trying anything new here.`,
    disclaimerLegacy: [LEGACY_DISCLAIMER],
    // Style anchors (docs/cta-spec.md §4): the plug is TWO beats + the CTA line —
    // (1) a payoff that lands the prior tweet's point, reusing one of its concrete words;
    // (2) a switch: the exact form and how long you have taken it, then two or three plain benefits;
    // (3) a CTA line that is "I" + a recommendation verb and carries its own "(#ad)".
    // The examples below predate that shape and are kept only as VOICE samples for their account.
    // ("{PRODUCT} is the best-absorbing one I've tried:"), never an absolute. "#ad" + link on
    // their own lines. The two plugs MUST use different lead concepts AND different superlative forms.
    plugHeavyExample: `Firm skin starts to go when your collagen drops with age.\n\nResearch links collagen peptides to firmer skin, fewer fine lines, and stronger hair.\n\n{PRODUCT} is the best-textured one I've used:\n\n#ad\n\n{LINK}`,
    plugLightExample: `Dull, tired skin often comes down to lost collagen.\n\nStudies tie collagen to a firmer face, smoother skin, and stronger nails.\n\nHands down, {PRODUCT} is my favorite:\n\n#ad\n\n{LINK}`,
  },
  // ---- Wave 3 (staged 2026-08-08): five personas, each a DISTINCT lane + DISTINCT default ASIN ----
  // All start paused (ONBOARDING.md checklist step 5: warm before affiliate volume; premium unconfirmed).
  // Go-live per account = tick Active in the Airtable Accounts table once warmed — no PR needed.
  marcos: {
    name: 'Marcos Romano',
    sex: 'm',
    handle: 'Marc0sRomano',
    // THREADS CROSS-POST (operator 2026-09-07): the profile is connected in Typefully, so this line
    // makes every new draft target X and Threads together. Backfilled onto the drafts already
    // scheduled by cross-post-backfill.mjs — a draft's platforms are fixed at write time, so config
    // alone reaches nothing already booked.
    crossPost: ['threads'],
    // Fuel T0 ON 2026-08-14 (operator) — see the Lucas block. NOTE: verifying this run surfaced that
    // T0 costs $4.80/post (cut from $11.30 on 2026-08-10) and has logged 0 reach on all 76 pings
    // all-time, and is NOT required for the paid T1-T6 ladder (this page climbed T1/T2 having never
    // fired T0). Config/history/charges all agree on $4.80 — no tracking drift. Open decision in
    // IMPROVEMENTS.md — revert is one Airtable field, not a code change.
    // Activated 2026-08-08 (operator): Airtable Active ✓. Fuel Watch + RT Row stay OFF for the
    // first 2 posting days (operator rule: publish clean before any fuel/RT) — enable ~2026-08-11.
    socialSetId: 323862,
    niches: ['Health', 'Fitness', 'Mental Health', 'Psychology'],
    weeklyFloor: 750_000,
    allTimeFloor: 2_000_000,
    slots: 7, weeklyTopTier: 5, evergreenSlots: 1, weeklyMax: 4, allTimeSlots: 2, backfillMax: 3,
    tz: 'Asia/Saigon',
    levantaSubidPrefix: 'x-thread-marcos',
    // Metabolic lane. The berberine single (B0CZMDPWG5) held this until 2026-09-21 and lost it to the
    // $0.45 floor: $0.360 restated on 1,554 clicks. Beet root keeps the lane honest — nitric oxide and
    // blood flow rather than blood sugar, $0.473 on 12,322 clicks, allowlisted and in stock. It is the
    // one above-floor product whose subject is still metabolic; the only above-floor berberine
    // (B07VX8N89N, $0.790) is NOT on the allowlist, so as a default it would never be reached.
    // BRIDGE still routes berberine -> B0CZMDPWG5, so a thread that argues the substance still sells it.
    defaultProduct: { asin: 'B09SFFJP1P', title: 'Nutricost Beet Root 2400mg, 180 Capsules - CCOF Certified Made with Organic Beet Root, Superfood, 60 Servings' },
    // EBOOK TEST (operator 2026-08-08) — ENDED 2026-08-16, FAILED. Marcos + Jasper plugged our own
    // Gumroad ebook instead of Levanta supplements; the test's own bar was >=2000 clicks to judge.
    // Verdict at 1,416 clicks across 11 published posts and 13.6M views: $0.00, ZERO orders. A
    // product with any conversion rate at all would have converted by then — the allowlist
    // supplements run 5-7%, i.e. roughly 70-100 orders on the same traffic. Jasper alone spent
    // 11.67M views on it. fixedProduct + plugStyle removed, so both pages fall back to the normal
    // product picker and the payoff (personal) CTA like the rest of the fleet.
    // Fallback rotation pool (day-rotated with the default when no product thematically fits — pickFallback).
    altProducts: [
      { asin: 'B0DJQ2CCX5', title: 'Nutricost N-Acetyl L-Cysteine (NAC) 600mg' },
      { asin: 'B01F5QSHUS', title: 'Nutricost TMG (Trimethylglycine) 750mg, 120 Capsules' },
    ],
    // Marcos = no-nonsense body-recomposition coach. Blood sugar and appetite mechanics, zero fluff.
    voice: [
      'No-nonsense body recomposition coach. Direct, practical, zero fluff, never preachy.',
      'Short sentences. Generous line breaks. One or two sentences per paragraph.',
      'First person, low pressure. Reason before recommendation.',
      'No em dashes. No fake urgency. No "game-changer" hype words.',
      'Frames fat loss as metabolic mechanics: name the hormone or system (insulin, glucose, appetite), then the simple move.',
    ].join('\n'),
    closing: `So which excuse is left?\n\nClick share and put this in front of a friend who keeps putting it off.`,
    closingLegacy: [`Save it. Reread it Monday morning. Then actually do it.\n\nNo excuses,\n\nMarcos.`, `Copy the link to this thread and send it to someone who needs the push.\n\nNo excuses,\n\nMarcos.`],
    disclaimer: `Straight up: some of these links are affiliate links. If you buy, I earn a little and your total stays the same. None of this is medical advice. The FDA never looked at any of it. Supplements treat nothing. Talk to your doctor first, more so if you are on any meds.`,
    disclaimerLegacy: [LEGACY_DISCLAIMER],
    plugHeavyExample: `That crash after lunch is the glucose spike finishing, not your willpower failing.\n\nBerberine before the two carb-heaviest meals is what flattened it for me: steadier afternoons, fewer 4pm cravings, no nap window.\n\n{PRODUCT} is the one I take (aff link):\n\n{LINK}`,
    plugLightExample: `Appetite follows blood sugar, so that is the lever I pull first.\n\nI wasted a year on fat burners before switching to plain berberine with cinnamon. Smoother energy, smaller portions without trying.\n\n{PRODUCT}.\n\n#ad\n\n{LINK}`,
  },
  lucas: {
    name: 'Lucas Herrera',
    sex: 'm',
    handle: 'CoachLucHerrera',   // matches the Typefully social set exactly; the RT ping renders this verbatim
    // THREADS CROSS-POST (operator 2026-09-07): the profile is connected in Typefully, so this line
    // makes every new draft target X and Threads together. Backfilled onto the drafts already
    // scheduled by cross-post-backfill.mjs — a draft's platforms are fixed at write time, so config
    // alone reaches nothing already booked.
    crossPost: ['threads'],
    // Fuel T0 ON 2026-08-14 (operator, with Clara + Tina). It was genuinely off despite the dashboard
    // reading as active: the Fuel Log showed 0 T0 pulses for this page over the prior 14d while every
    // flagged page fired T0 on EVERY post. What was already on is RT Row + Fuel Watch (real T1+ ladder
    // spend) — only the T0 baseline ping was missing. Flag lives in the Airtable Accounts roster
    // (tblwn2lLoJBuJKvUv, "Fuel T0"), which is authoritative; editing it here does nothing.
    // Activated 2026-08-08 (operator): Airtable Active ✓. Fuel Watch + RT Row stay OFF for the
    // first 2 posting days (operator rule: publish clean before any fuel/RT) — enable ~2026-08-11.
    socialSetId: 323861,
    niches: ['Health', 'Fitness', 'Mental Health', 'Psychology'],
    weeklyFloor: 750_000,
    allTimeFloor: 2_000_000,
    slots: 7, weeklyTopTier: 5, evergreenSlots: 1, weeklyMax: 4, allTimeSlots: 2, backfillMax: 3,
    tz: 'Asia/Saigon',
    levantaSubidPrefix: 'x-thread-lucas',
    // Daily-staple lane default, distinct ASIN: a high-absorption turmeric curcumin single.
    // Default swapped off Turmeric Curcumin (B089P4LGW3) 2026-08-25: it went OUT OF STOCK and had earned
    // $0 on 60 clicks, so his default plug could not sell at all. Turmeric stays curated — 60 clicks is
    // far too little to judge the product, it just cannot be a DEFAULT while unavailable. Organic Liquid
    // Zinc replaces it in the same daily-staple role: 4.0% CVR / EPC 0.306 over 90d settled, the fleet's
    // joint-best conversion, and deliberately under-fed (1,509 clicks vs magnesium's 6,000+) — making it a
    // default is how that reach actually arrives.
    // Zinc lost the slot on 2026-09-21 to the $0.45 floor: the 0.306 figure above was the measured EPC
    // of its day, and restated against today's rate it is $0.361 on 1,554 clicks — under the bar either
    // way. A default must be in KEEP, not merely on the sprint allowlist (test-scaffolds enforces it),
    // which leaves eleven products above the floor and exactly one unclaimed. Sports Research's vegan
    // omega-3 takes the daily-staple role at $0.522 restated, in stock, on no other page. THIN — 92
    // clicks, under the 100-click judging bar — so this slot is a test and should be read as one at the
    // next sweep, not assumed good because it is above the line today.
    defaultProduct: { asin: 'B0842DJJYC', title: 'Sports Research Vegan Omega-3 Fish Oil Alternative' },
    // Fallback rotation pool (day-rotated with the default when no product thematically fits — pickFallback).
    altProducts: [
      { asin: 'B0BQ1DMSPP', title: 'Why Not Natural Vitamin B12 Liquid Plus Folate, Organic Sublingual' },
      { asin: 'B0GT2JKMYZ', title: 'DR Vitamin Solutions Magnesium Glycinate 200mg' },
    ],
    // Lucas = everyday-habits coach. Consistency over intensity; small inputs, compounding payoff.
    voice: [
      'Everyday habits coach. Friendly, encouraging, consistency over intensity, never guilt-tripping.',
      'Short sentences. Generous line breaks. One or two sentences per paragraph.',
      'First person, low pressure. Reason before recommendation.',
      'No em dashes. No fake urgency. No "game-changer" hype words.',
      'Frames health as small compounding habits: name the routine, then the payoff.',
    ].join('\n'),
    closing: `What's the smallest step you could take from this list today?\n\nPass it on with the share button to someone starting over.`,
    closingLegacy: [`Small steps beat big plans. Send this to someone starting over this week.\n\nOne habit at a time,\n\nLucas.`, `Copy the link to this thread and send it to someone starting over on Monday.\n\nOne habit at a time,\n\nLucas.`],
    disclaimer: `Honesty corner: links in this thread may be affiliate links, so a purchase can send a small commission my way at zero added cost to your order. This is education, never medical advice. Nothing here has been assessed by the FDA. Loop in your doctor before starting anything.`,
    disclaimerLegacy: [LEGACY_DISCLAIMER],
    plugHeavyExample: `Waking up stiff is usually quiet inflammation, not age.\n\nResearch links curcumin to calmer joints, easier movement, and faster recovery.\n\n{PRODUCT} is the strongest one I've found:\n\n#ad\n\n{LINK}`,
    plugLightExample: `Small daily habits beat big resets. Turmeric with black pepper is one of mine.\n\nStudies tie curcumin to less soreness, smoother joints, and a healthier gut.\n\n{PRODUCT} is the one I never skip:\n\n#ad\n\n{LINK}`,
  },
  jasper: {
    name: 'Jasper Kasparov',
    sex: 'm',
    handle: 'JasperKasparov',
    // Activated 2026-08-08 (operator): Airtable Active ✓. The launch rule (Fuel Watch + RT Row OFF
    // for the first 2 posting days — publish clean before any fuel/RT) has since been satisfied.
    // Fuel T0 turned ON 2026-08-14 (operator) — Jasper is the 5th page on the T0 baseline RT ping,
    // after Julian/Magnus/Rafael/Lorenzo. All of these flags live in the Airtable Accounts roster
    // (tblwn2lLoJBuJKvUv, field "Fuel T0"), which is authoritative — accounts-sync.mjs treats them as
    // create-only, so flipping them here would do nothing. The n8n RT Bridge reads that roster.
    socialSetId: 323860,
    // Threads account connected in Typefully (operator 2026-09-06: "create a version of our threads for
    // them too"). publish-thread mints each platform its own link (cross-post-links.mjs, subid -th).
    crossPost: ['threads'],
    niches: ['Health', 'Fitness', 'Mental Health', 'Psychology'],
    weeklyFloor: 750_000,
    allTimeFloor: 2_000_000,
    slots: 7, weeklyTopTier: 5, evergreenSlots: 1, weeklyMax: 4, allTimeSlots: 2, backfillMax: 3,
    tz: 'Asia/Saigon',
    levantaSubidPrefix: 'x-thread-jasper',
    // REBUILT 2026-09-20 (operator: "??? remove this for the next run"). All THREE of this page's
    // products were unusable and the default was the worst product in the fleet: B089N5X2LG earned
    // $0.097/click over 310 clicks, a fifth of the $0.45 floor, while both alts sat OFF the
    // selection menu entirely (neither is in ALLOW_ASINS), so the fallback rotation was empty and
    // every fallback landed on the dud.
    //
    // The old default was chosen as "DHA = the brain fat", and the reasoning was right while the
    // SKU was wrong: BRIDGE already routes omega / omega-3 / fish oil / dha / epa to B07DX89ZHN at
    // $0.680, so his own threads that argue fish oil were reaching the good bottle all along and
    // only the fallback was stuck on the bad one. He keeps a fish oil — the one that earns 7x.
    //
    // The default is magnesium L-threonate because this page is Mental Health and Psychology and
    // BRIDGE itself already says `brain fog` -> B09QFSDLL5. $0.540 over 7,021 clicks, and NO other
    // account defaults to it, which is the same spread logic laws.product.spreadFactor applies
    // inside a batch.
    defaultProduct: { asin: 'B09QFSDLL5', title: 'Nutricost Magnesium L-Threonate (Magtein) 2000mg' },
    // EBOOK TEST (operator 2026-08-08) — ENDED 2026-08-16, FAILED: see marcos for the verdict.
    // Fallback rotation pool (day-rotated with the default when no product thematically fits — pickFallback).
    altProducts: [
      { asin: 'B07DX89ZHN', title: 'Sports Research Omega-3 Fish Oil 1250mg' },
      { asin: 'B079K32QB6', title: 'Nutricost KSM-66 Ashwagandha 600mg' },
    ],
    // Jasper = cognitive performance coach. Focus, memory, mental clarity; science-first, never mystical.
    voice: [
      'Sharp cognitive performance coach. Curious, precise, science-first, never mystical.',
      'Short sentences. Generous line breaks. One or two sentences per paragraph.',
      'First person, low pressure. Reason before recommendation.',
      'No em dashes. No fake urgency. No "game-changer" hype words.',
      'Frames the mind as trainable hardware: name the mechanism (dopamine, sleep debt, blood flow), then the simple upgrade.',
    ].join('\n'),
    closing: `Which of these were you getting wrong without noticing?\n\nShare the thread with a colleague who'd want to know.`,
    closingLegacy: [`That is the whole playbook. Follow me for one clear-headed breakdown a week.\n\nThink clearly,\n\nJasper.`, `Copy the link to this thread and send it to someone who needs a sharper day.\n\nThink clearly,\n\nJasper.`],
    disclaimer: `For clarity: a link here may be an affiliate link, and buying through it can pay me a commission while your price stays put. Read this as education, not as medical advice. These statements were not evaluated by the FDA. Confirm new supplements with your own doctor first.`,
    disclaimerLegacy: [LEGACY_DISCLAIMER],
    plugHeavyExample: `The fog you are describing is a membrane problem, and DHA is what the membrane is built from.\n\nI blamed my sleep for two years before I fixed the fat. Enteric-coated, with dinner: sharper mornings, fewer lost words, no fish burps.\n\n{PRODUCT} is the one I actually reorder (aff link):\n\n{LINK}`,
    plugLightExample: `Same nutrient, different job: EPA is the one tied to mood rather than memory.\n\nI take it year round now. Steadier weeks, less of the low-grade irritability I used to write off as stress.\n\n{PRODUCT} is my pick (aff link):\n\n{LINK}`,
  },
  tina: {
    name: 'Tina De Jong',
    sex: 'f',
    // THREADS CROSS-POST OFF (operator 2026-09-16: "Tina is suspended, stop trying"). The profile was
    // connected 2026-09-07 and worked until 09-09; from then on every Threads publish failed while X
    // published normally — 13 drafts by 09-17, her singles included. Typefully still shows the account
    // connected with 1458 posts of quota, so nothing on this side reports the suspension; the only
    // symptom is that Threads never accepts a post.
    //
    // THIS IS NOT COSMETIC. A cross-posted draft is one draft: when the Threads half fails Typefully
    // marks the WHOLE draft `error`, and the RT bridge only pings drafts it sees as `published`. So a
    // suspended Threads account was silently costing this page its T0 boost on X threads that had
    // published perfectly well — three of them, 09-14 to 09-16. Dropping the cross-post lets her
    // drafts finish clean, which is what puts her back on the bridge.
    //
    // Empty rather than deleted: the key is the record of what was tried. Restore `['threads']` if the
    // account is ever reinstated. Already-booked drafts keep the platforms they were written with —
    // config reaches nothing already scheduled (see cross-post-backfill.mjs).
    crossPost: [],
    handle: 'TinaaDeJong',
    // Fuel T0 ON 2026-08-14 (operator) — see the Lucas block for the evidence and the roster caveat.
    // Activated 2026-08-08 (operator): Airtable Active ✓. Fuel Watch + RT Row stay OFF for the
    // first 2 posting days (operator rule: publish clean before any fuel/RT) — enable ~2026-08-11.
    socialSetId: 323863,
    // 3PM SLOT PILOT (operator 2026-08-15 -> review 2026-09-14) — see the `julian` block for the full
    // rationale. Tina is the NEW-PAGE arm: the cleanest of the five 5pm pages (no plugStyle pin, no
    // fixedProduct, no variationMode — only a stagger slot), with the best median of that cohort.
    // She is chosen because she comes with a MATCHED CONTROL GROUP that nothing else in the fleet has:
    // Lucas, Clara, Jasper and Marcos stay at 5pm — same cohort, same age, same engine — so the delta
    // is attributable to the 2-hour shift rather than to page maturity. Keeps the :15 stagger minute.
    // Pairing a new page with Julian (mature) tests whether 3pm GENERALIZES across cohorts.
    // Revert: restore { h: 10, m: 15 } — she rejoins the 5pm new-page stagger.
    niches: ['Health', 'Fitness', 'Mental Health', 'Psychology'],
    weeklyFloor: 750_000,
    allTimeFloor: 2_000_000,
    slots: 7, weeklyTopTier: 5, evergreenSlots: 1, weeklyMax: 4, allTimeSlots: 2, backfillMax: 3,
    tz: 'Asia/Saigon',
    levantaSubidPrefix: 'x-thread-tina',
    // Women's wellness lane default: a D3+K2 single (energy/hormone/bone). The Why Not Natural organic
    // one (B074GTBN7V) held it until 2026-09-22, when the operator's floor sweep put it at $0.327 on
    // restated EPC. Sports Research's D3+K2 keeps the lane exactly — same substance, same K2 form —
    // at $0.740 on 4,210 clicks, in KEEP and in stock. Shared with violet only.
    defaultProduct: { asin: 'B07NXW4GW7', title: 'Sports Research Vitamin D3 with K2 Softgels' },
    // Fallback rotation pool (day-rotated with the default when no product thematically fits — pickFallback).
    altProducts: [
      { asin: 'B016398GQG', title: 'Nutricost Maca Root Capsules 750mg, 180 Capsules' },
      { asin: 'B0CW3KHD4Z', title: 'Nutricost L-Methylfolate 15mg, 120 Capsules (5-MTHF)' },
    ],
    // Tina = warm women's wellness coach. Energy and hormone balance for women who do too much.
    voice: [
      "Warm women's wellness coach. Supportive, practical, hormone-aware, never judgmental.",
      'Short sentences. Generous line breaks. One or two sentences per paragraph.',
      'First person, low pressure. Reason before recommendation.',
      'No em dashes. No fake urgency. No "game-changer" hype words.',
      'Frames energy as hormonal balance: name the system (thyroid, cortisol, cycle, sleep), then the gentle fix.',
    ].join('\n'),
    closing: `When did you last wake up actually rested?\n\nIf that question stings, share this with a friend who needs it too.`,
    closingLegacy: [`If a woman in your life is running on empty, she deserves to see this one.\n\nWith warmth,\n\nTina.`, `Copy the link to this thread and send it to a woman who's running on empty.\n\nWith warmth,\n\nTina.`],
    disclaimer: `A quick note: some links are affiliate, and purchases through them may pay me a small commission. It costs you nothing more. This thread is for education, never as medical advice, and it has not been reviewed by the FDA. Please ask your doctor first, especially on medication.`,
    disclaimerLegacy: [LEGACY_DISCLAIMER],
    plugHeavyExample: `Afternoon energy dips are often low vitamin D, especially if you work indoors.\n\nResearch links vitamin D3 to steadier energy, balanced hormones, and a stronger immune system.\n\n{PRODUCT} is the gentlest one I've found:\n\n#ad\n\n{LINK}`,
    plugLightExample: `Most women I coach are low on vitamin D and never know it.\n\nStudies tie D3 with K2 to better calcium use, stronger bones, and brighter moods.\n\n{PRODUCT} is the one I take with breakfast:\n\n#ad\n\n{LINK}`,
  },
  clara: {
    name: 'Clara Brooks',
    sex: 'f',
    // THREADS CROSS-POST (operator 2026-09-07, second wave): profile connected in Typefully, so every
    // new draft targets X and Threads together. Scheduled drafts backfilled by cross-post-backfill.mjs
    // — a draft's platforms are fixed at write time, so config alone reaches nothing already booked.
    crossPost: ['threads'],
    handle: 'ClaraBrooksjz',
    // Fuel T0 ON 2026-08-14 (operator) — see the Lucas block for the evidence and the roster caveat.
    // Activated 2026-08-08 (operator): Airtable Active ✓. Fuel Watch + RT Row stay OFF for the
    // first 2 posting days (operator rule: publish clean before any fuel/RT) — enable ~2026-08-11.
    socialSetId: 323864,
    niches: ['Health', 'Fitness', 'Mental Health', 'Psychology'],
    weeklyFloor: 750_000,
    allTimeFloor: 2_000_000,
    slots: 7, weeklyTopTier: 5, evergreenSlots: 1, weeklyMax: 4, allTimeSlots: 2, backfillMax: 3,
    tz: 'Asia/Saigon',
    levantaSubidPrefix: 'x-thread-clara',
    // SITE CTA (operator 2026-08-20). Clara's threads end by pointing at her own site, where the
    // full stack lives. Inserted immediately BEFORE the sign-off so the account's closing and the
    // legal disclaimer keep their positions — both are matched by strict equality and the
    // disclaimer must remain the final tweet, so nothing may be appended after them.
    // First-party, so it carries no affiliate disclosure and is not a tracked plug: bareCommerceLink
    // only fires on Amazon domains, and isTrackedLink does not match it, so it is never counted
    // against the plug budget.
    siteCta: "If you want the full stack, everything I actually take is on my site.\n\nclarabrooks.com",
    // Stress/sleep lane default, distinct ASIN (and distinct from the three magnesium pages): KSM-66 ashwagandha single.
    defaultProduct: { asin: 'B079K32QB6', title: 'Nutricost KSM-66 Ashwagandha 600mg' },
    // Fallback rotation pool (day-rotated with the default when no product thematically fits — pickFallback).
    altProducts: [
      { asin: 'B01B3RWQNM', title: 'Nutricost L-Theanine 200mg, 120 Capsules, Double Strength' },
      { asin: 'B0GT2JKMYZ', title: 'DR Vitamin Solutions Magnesium Glycinate 200mg' },
    ],
    // Clara = calm stress-and-sleep coach. Nervous-system-first; rest as a trainable skill.
    voice: [
      'Calm stress-and-sleep coach. Soothing, grounded, nervous-system-first, never clinical or cold.',
      'Short sentences. Generous line breaks. One or two sentences per paragraph.',
      'First person, low pressure. Reason before recommendation.',
      'No em dashes. No fake urgency. No "game-changer" hype words.',
      'Frames rest as a skill: name the stress response, then the simple way to switch it off.',
    ].join('\n'),
    closing: `What's really keeping you up at night?\n\nTap the share icon and send this to a friend who can't switch off either.`,
    closingLegacy: [`Come back to this tonight instead of scrolling past your bedtime.\n\nRest well,\n\nClara.`, `Copy the link to this thread and send it to someone who can't switch off.\n\nRest well,\n\nClara.`],
    disclaimer: `Small print before bed: a few links here are affiliate ones, and a purchase might earn me a commission without adding a cent for you. This is education only, not medical advice. No claim here is FDA evaluated. Check in with your doctor before starting something new.`,
    disclaimerLegacy: [LEGACY_DISCLAIMER],
    plugHeavyExample: `If you're wired at night but exhausted all day, that's usually cortisol.\n\nResearch links ashwagandha to lower stress, calmer evenings, and deeper rest.\n\n{PRODUCT} is the most consistent one I've tried:\n\n#ad\n\n{LINK}`,
    plugLightExample: `A racing mind at bedtime is a stress response, not a personality trait.\n\nStudies tie KSM-66 ashwagandha to lower cortisol, steadier moods, and easier sleep.\n\n{PRODUCT} is the one on my nightstand:\n\n#ad\n\n{LINK}`,
  },

  // ---- ONBOARDED 2026-08-28 (operator: "welcome to the crew") -----------------------------------
  // Both pages arrived with a voice already working, so these entries DESCRIBE what they do rather
  // than assign them something. Each opens by refusing the question as asked, then hands back the
  // one that actually pays: "most people reading about cortisol don't have a cortisol problem"
  // (Kim), "'just walk more' is good advice that hides a bad assumption" (Rasmus). That is a real
  // lane the roster did not have — every other page leads with the fix.
  kim: {
    name: 'Kim Chong',
    sex: 'f',
    // THREADS CROSS-POST (operator 2026-09-07, second wave): profile connected in Typefully, so every
    // new draft targets X and Threads together. Scheduled drafts backfilled by cross-post-backfill.mjs
    // — a draft's platforms are fixed at write time, so config alone reaches nothing already booked.
    crossPost: ['threads'],
    handle: 'HeyKimChong',
    socialSetId: 328104,
    niches: ['Health', 'Mental Health', 'Psychology', 'Fitness'],
    weeklyFloor: 750_000,
    allTimeFloor: 2_000_000,
    slots: 7, weeklyTopTier: 5, evergreenSlots: 1, weeklyMax: 4, allTimeSlots: 2, backfillMax: 3,
    tz: 'Asia/Saigon',
    levantaSubidPrefix: 'x-thread-kim',
    // Magnesium glycinate: EPC $0.415 and a winner, and the fleet's most reliable sleep answer. It
    // is the substance her voice keeps arriving at — the Sunday-night problem has a mineral under it.
    // Threonate ($0.467) would have been the sharper fit but sits in `allow` rather than `keep`, and
    // a default has to be stockable or it falls back on every slot.
    defaultProduct: { asin: 'B0GT2JKMYZ', title: 'DR Vitamin Solutions Magnesium Glycinate 200mg' },
    altProducts: [
      { asin: 'B09QFSDLL5', title: 'Nutricost Magnesium L-Threonate As Magtein 2000mg' },
      { asin: 'B079K32QB6', title: 'Nutricost KSM-66 Ashwagandha 600mg' },
    ],
    voice: [
      'Calm reframer. Starts by rejecting the premise of the question, then gives the better one.',
      'Short sentences. Generous line breaks. One or two sentences per paragraph.',
      'First person, unhurried, never scolding. She names the real problem before naming a fix.',
      'No em dashes. No hype words. No urgency she does not actually feel.',
      'Treats stress as circumstance before chemistry: name what is actually happening in the week, then the physiology underneath it.',
    ].join('\n'),
    // Boilerplate comes from onboarding-bank.json via onboard-account.mjs, not hand-written: the bank
    // entries are pre-vetted to share no 5-word run with any live account, which is the same
    // anti-fingerprint yardstick the suite enforces. Two hand-written attempts both collided.
    closing: `Which of these will you still be doing in a month?\n\nSend it to somebody who keeps saying they'll start Monday.`,
    disclaimer: `Worth saying plainly: affiliate links sit in this thread, and one purchase through them may pay a commission my way while your checkout total stays identical. Educational words only, never medical advice in any form. Zero FDA evaluation stands behind this. Doctor first, always.`,
    // No pre-rewrite drafts exist yet — the page has never posted under our engine. The arrays carry
    // the current text so QC has something to recognise, and gain real history if the wording moves.
    closingLegacy: [`Which of these will you still be doing in a month?\n\nSend it to somebody who keeps saying they'll start Monday.`],
    disclaimerLegacy: [`Worth saying plainly: affiliate links sit in this thread, and one purchase through them may pay a commission my way while your checkout total stays identical. Educational words only, never medical advice in any form. Zero FDA evaluation stands behind this. Doctor first, always.`],
    plugHeavyExample: `The reason your mind will not switch off is rarely the day you had.\n\nMagnesium in the threonate form is the one studied for crossing into the brain, and it is the form almost nobody buys.\n\n{PRODUCT} is the one I keep on the shelf:\n\n#ad\n\n{LINK}`,
    plugLightExample: `Sleep is where the week gets processed, so that is the lever I pull first.\n\nThreonate over oxide, every time.\n\n{PRODUCT}.\n\n#ad\n\n{LINK}`,
  },
  rasmus: {
    name: 'Rasmus Norberg',
    sex: 'm',
    // THREADS CROSS-POST (operator 2026-09-07, second wave): profile connected in Typefully, so every
    // new draft targets X and Threads together. Scheduled drafts backfilled by cross-post-backfill.mjs
    // — a draft's platforms are fixed at write time, so config alone reaches nothing already booked.
    crossPost: ['threads'],
    handle: 'RasmusNorbergg',
    socialSetId: 328105,
    niches: ['Fitness', 'Health', 'Longevity'],
    weeklyFloor: 750_000,
    allTimeFloor: 2_000_000,
    slots: 7, weeklyTopTier: 5, evergreenSlots: 1, weeklyMax: 4, allTimeSlots: 2, backfillMax: 3,
    tz: 'Asia/Saigon',
    levantaSubidPrefix: 'x-thread-rasmus',
    // Creatine, the Sports Research one: EPC $0.418 and above fleet since the rate went 25% -> 35%.
    // Muscle is the organ his voice keeps circling, and no other page defaults to it.
    defaultProduct: { asin: 'B0DXR7MPNV', title: 'Sports Research Creatine Monohydrate' },
    altProducts: [
      { asin: 'B07DX89ZHN', title: 'Sports Research Omega-3 Fish Oil 1250 Triple Strength' },
      { asin: 'B0GT2JKMYZ', title: 'DR Vitamin Solutions Magnesium Glycinate 200mg' },
    ],
    voice: [
      'Plain-spoken training realist. Takes a piece of common advice and shows the assumption hiding inside it.',
      'Short sentences. Generous line breaks. One or two sentences per paragraph.',
      'First person, matter of fact. He concedes the advice is fine before explaining who it does not fit.',
      'No em dashes. No absolutes. No motivational register.',
      'Separates effort from adaptation: says what the body is actually being asked to do, then what it needs to answer.',
    ].join('\n'),
    closing: `What would change for you if your energy came back?\n\nUse the share button and hand this to someone who needs the nudge.`,
    disclaimer: `House note: affiliate links included. Buy via one and a commission could land with me while your receipt reads the same. This is education, no medical advice lives here. FDA evaluation: none of these statements have it. Physician sign-off first when medication is involved.`,
    closingLegacy: [`What would change for you if your energy came back?\n\nUse the share button and hand this to someone who needs the nudge.`],
    disclaimerLegacy: [`House note: affiliate links included. Buy via one and a commission could land with me while your receipt reads the same. This is education, no medical advice lives here. FDA evaluation: none of these statements have it. Physician sign-off first when medication is involved.`],
    plugHeavyExample: `Training is the request. Recovery is whether your body can answer it.\n\nCreatine is the most studied supplement there is, and the plain monohydrate has never been beaten by a fancier form.\n\n{PRODUCT} is what I buy:\n\n#ad\n\n{LINK}`,
    plugLightExample: `Strength holds up better than almost anything else you can build.\n\n5g a day, no loading, no cycling.\n\n{PRODUCT}.\n\n#ad\n\n{LINK}`,
  },

  // ---- BATCH 2026-08-31: five pages onboarded together (Typefully sets 329371-329376). -------
  // Niches are the fleet-standard general-health set by operator call; what separates these five
  // is VOICE and product, not topic. Each carries a default no other account defaults to, so five
  // new pages do not all open on the same bottle.
  eleanor: {
    name: 'Eleanor',
    sex: 'f',
    handle: 'HeyEleanorr',
    // THREADS CROSS-POST (operator 2026-09-08, fourth wave): profile connected in Typefully
    // (@heyeleanorrrr — FOUR r's, not the X handle's two, read off the social set's `platforms.threads`
    // before enabling), so every new draft targets X and Threads together. Scheduled drafts backfilled
    // by cross-post-backfill.mjs — a draft's platforms are fixed at write time, so config alone
    // reaches nothing already booked.
    crossPost: ['threads'],
    socialSetId: 329371,
    niches: ['Health', 'Mental Health', 'Psychology', 'Fitness'],
    weeklyFloor: 750_000,
    allTimeFloor: 2_000_000,
    slots: 7, weeklyTopTier: 5, evergreenSlots: 1, weeklyMax: 4, allTimeSlots: 2, backfillMax: 3,
    tz: 'Asia/Saigon',
    levantaSubidPrefix: 'x-thread-eleanor',
    // Warm-up date: two days of ordinary posting before anything is amplified. Fuel the Fire (241)
    // "Plan Watches" reads it since 2026-09-03 17:18Z and holds the page OUT of the T1-T6 vendor
    // ladder until this UTC date has passed. It does NOT gate T0: the RT ping is the T0 boost and
    // blank `RT Row` is its switch. (Before 17:18Z on 09-03 nothing read this column at all.)
    // Cleared 2026-09-03 (operator): eligible now. Empty = grandfathered by Plan Watches.
    fuelEligibleAfter: null,
    // Collagen (B06XK15VXJ) held this slot until 2026-09-21, when the floor sweep put it at $0.417 on
    // 989 clicks — the closest miss of the four, but a miss. NO collagen on the shelf clears $0.45
    // (the Sports Research peptides are $0.340), so the lane cannot be kept at the default level.
    // Omega-3 takes it: $0.706 on 13,865 clicks, the best-evidenced product we sell, and Mental Health
    // and Psychology are two of her four niches. Shared with sophia and muah — the fingerprint rule is
    // already carried by six other pairs, and a proven default beats an unshared weak one.
    // Pod CO1 still argues collagen, and BRIDGE still routes it, so an on-topic thread sells it.
    defaultProduct: { asin: 'B07DX89ZHN', title: 'Sports Research® Omega-3 Fish Oil 1250 - Triple Strength Fish Oil Supplement from Wild Alaska Pollock - MSC Certified Sustainable · Non-GMO · Soy Free - 90 Softgel Capsules' },
    // Turmeric (B089P4LGW3) removed the same day: $0.00 on 470 clicks, the only product in the fleet to
    // reach the kill floor having never once converted, and it sat in a live rotation pool.
    altProducts: [
      { asin: 'B0GT2JKMYZ', title: 'DR Vitamin Solutions Magnesium Glycinate 200mg' },
    ],
    voice: [
      'Everyday health educator, mid-forties register. Talks about the body wearing rather than the body failing.',
      'Short sentences. Generous line breaks. One or two sentences per paragraph.',
      'First person, unhurried. She names what changed for her before naming what to do.',
      'No em dashes. No fake urgency. No "game-changer" hype words.',
      'Mechanism-driven: names the tissue or the system, then the one thing that actually moves it.',
    ].join('\n'),
    closing: `Which point here surprised you the most?\n\nForward the thread to one person who argues about this stuff.`,
    disclaimer: `Quick honesty: several links act as affiliate ones. Ordering through them can earn me a cut and costs you zero extra. Health education, not to be mistaken for medical advice. The FDA played no part in checking this. Talk it over with your doctor beforehand.`,
    closingLegacy: [`Which point here surprised you the most?\n\nForward the thread to one person who argues about this stuff.`],
    disclaimerLegacy: [`Quick honesty: several links act as affiliate ones. Ordering through them can earn me a cut and costs you zero extra. Health education, not to be mistaken for medical advice. The FDA played no part in checking this. Talk it over with your doctor beforehand.`],
    plugHeavyExample: `Your own collagen production has been sliding every year since twenty-five.\n\nNails that split, knees that complain on stairs, skin that takes longer to bounce back.\n\nGelatin is too big a molecule to absorb whole, so you want hydrolysed peptides at around ten grams, not the one gram hiding in a beauty drink.\n\n{PRODUCT} is the one I keep on the counter:\n\n#ad\n\n{LINK}`,
    plugLightExample: `Hydrolysed, around ten grams, no flavouring.\n\nThat is the whole specification.\n\n{PRODUCT}.\n\n#ad\n\n{LINK}`,
  },

  marko: {
    name: 'Marko Silva',
    sex: 'm',
    // THREADS CROSS-POST (operator 2026-09-07, second wave): profile connected in Typefully, so every
    // new draft targets X and Threads together. Scheduled drafts backfilled by cross-post-backfill.mjs
    // — a draft's platforms are fixed at write time, so config alone reaches nothing already booked.
    crossPost: ['threads'],
    handle: 'MarkoSilva291',
    socialSetId: 329373,
    niches: ['Health', 'Mental Health', 'Psychology', 'Fitness'],
    weeklyFloor: 750_000,
    allTimeFloor: 2_000_000,
    slots: 7, weeklyTopTier: 5, evergreenSlots: 1, weeklyMax: 4, allTimeSlots: 2, backfillMax: 3,
    tz: 'Asia/Saigon',
    levantaSubidPrefix: 'x-thread-marko',
    // Cleared 2026-09-03 (operator): eligible now. Empty = grandfathered by Plan Watches.
    fuelEligibleAfter: null,
    // B12, the Nutricost methylcobalamin: pod B1, which measured 2.1x fleet CVR at 50% commission.
    // His Typefully bio already reads "Fitness & Health Coach", and B1's argument is the tired
    // trainee rather than the sick patient, which is the same room he is talking in.
    defaultProduct: { asin: 'B01IQB2UYS', title: 'Nutricost Vitamin B12 (Methylcobalamin)' },
    altProducts: [
      { asin: 'B09SFFJP1P', title: 'Nutricost Beet Root 2400mg' },
      { asin: 'B07DX89ZHN', title: 'Sports Research Omega-3 Fish Oil 1250 Triple Strength' },
    ],
    voice: [
      'Coach who trains people in person. Speaks from what he has watched fail in a real gym, not from studies.',
      'Short sentences. Generous line breaks. One or two sentences per paragraph.',
      'First person, direct without shouting. He tells you what he changed for a client and what happened.',
      'No em dashes. No hype. No motivational-poster register.',
      'Separates the training from the recovery: names what the session asked of the body, then what the body needed to answer it.',
    ].join('\n'),
    closing: `How long have you been putting this off?\n\nShare it along to a friend who's been putting it off longer.`,
    disclaimer: `Cards on the table: affiliate links are woven in, and purchases made through them might commission me without inflating what you spend. Educational reading, never once medical advice. No FDA check exists on these claims. A doctor should hear about new supplements early.`,
    closingLegacy: [`How long have you been putting this off?\n\nShare it along to a friend who's been putting it off longer.`],
    disclaimerLegacy: [`Cards on the table: affiliate links are woven in, and purchases made through them might commission me without inflating what you spend. Educational reading, never once medical advice. No FDA check exists on these claims. A doctor should hear about new supplements early.`],
    plugHeavyExample: `B12 keeps your nerves insulated and your energy production running, and absorption drops as you get older.\n\nThe afternoon that needs coffee is usually this, not discipline.\n\nCyanocobalamin is the cheap synthetic form your body has to convert first. Methylcobalamin is the active one, ready to use.\n\n{PRODUCT} is what I put clients on:\n\n#ad\n\n{LINK}`,
    plugLightExample: `Check the label says methylcobalamin, not cyanocobalamin.\n\nThat one word is the whole difference.\n\n{PRODUCT}.\n\n#ad\n\n{LINK}`,
  },

  camila: {
    name: 'Camila Vega',
    sex: 'f',
    handle: 'yourcamilavega',
    // THREADS CROSS-POST (operator 2026-09-08, third wave): profile connected in Typefully
    // (@yourcamilavega, verified against the social set's `platforms.threads` before enabling), so every
    // new draft targets X and Threads together. Scheduled drafts backfilled by cross-post-backfill.mjs
    // — a draft's platforms are fixed at write time, so config alone reaches nothing already booked.
    crossPost: ['threads'],
    socialSetId: 329374,
    niches: ['Health', 'Mental Health', 'Psychology', 'Fitness'],
    weeklyFloor: 750_000,
    allTimeFloor: 2_000_000,
    slots: 7, weeklyTopTier: 5, evergreenSlots: 1, weeklyMax: 4, allTimeSlots: 2, backfillMax: 3,
    tz: 'Asia/Saigon',
    levantaSubidPrefix: 'x-thread-camila',
    // Cleared 2026-09-03 (operator): eligible now. Empty = grandfathered by Plan Watches.
    fuelEligibleAfter: null,
    // Beet root, the Nutricost one: pod BR1. Circulation is a mechanism you can feel the same week,
    // which suits a voice that starts from the symptom rather than the biochemistry.
    defaultProduct: { asin: 'B09SFFJP1P', title: 'Nutricost Beet Root 2400mg' },
    altProducts: [
      { asin: 'B0GTS6GGSK', title: 'DR Vitamin Solutions Ubiquinol CoQ10 100mg' },
      { asin: 'B074GTBN7V', title: 'Why Not Natural Vitamin D3 K2 (MK-7)' },
    ],
    voice: [
      'Starts from the symptom the reader already noticed, then works backwards to the cause.',
      'Short sentences. Generous line breaks. One or two sentences per paragraph.',
      'First person, warm, a little blunt. She says what she stopped doing as often as what she started.',
      'No em dashes. No fear framing. No "toxins" language.',
      'Explains circulation and delivery: what has to reach a tissue before anything else can help it.',
    ].join('\n'),
    closing: `What's the one thing you wish you'd known sooner from this list?\n\nPost it on to someone still learning it the hard way.`,
    disclaimer: `Plain talk: a portion of links here are affiliate. When you buy through them I may earn something, your amount unchanged. Written to educate, not as medical advice of any kind. FDA scrutiny has not touched it. Let your physician weigh in before beginning anything.`,
    closingLegacy: [`What's the one thing you wish you'd known sooner from this list?\n\nPost it on to someone still learning it the hard way.`],
    disclaimerLegacy: [`Plain talk: a portion of links here are affiliate. When you buy through them I may earn something, your amount unchanged. Written to educate, not as medical advice of any kind. FDA scrutiny has not touched it. Let your physician weigh in before beginning anything.`],
    plugHeavyExample: `Beet root is the densest food source of dietary nitrate, which your body turns into nitric oxide.\n\nNitric oxide is what opens the blood vessels, so it decides how much blood actually reaches a working muscle.\n\nMost beet pre-workouts are flavouring and sugar with a token amount of beet, so read the label for the real thing.\n\n{PRODUCT} is the one I use:\n\n#ad\n\n{LINK}`,
    plugLightExample: `Look for actual beet root on the label, not beet flavouring.\n\nMost of the tubs fail that test.\n\n{PRODUCT}.\n\n#ad\n\n{LINK}`,
  },

  sophia: {
    name: 'Sophia',
    sex: 'f',
    // CORRECTED 2026-09-20, same cause as felicia's below: this was the TYPEFULLY SET's name, not
    // the X handle. Typefully appended `_1` when the set name collided; her posts land on
    // @Sophiaz6xo (set detail platforms.x.username, 69 posts published this month). Found by the
    // fleet sweep that the felicia fix prompted — see handleDrift in onboard-account.mjs.
    handle: 'Sophiaz6xo',
    // THREADS CROSS-POST (operator 2026-09-08, third wave): profile connected in Typefully
    // (@sophiaz6xo, verified against the social set's `platforms.threads` before enabling), so every
    // new draft targets X and Threads together. Scheduled drafts backfilled by cross-post-backfill.mjs
    // — a draft's platforms are fixed at write time, so config alone reaches nothing already booked.
    crossPost: ['threads'],
    socialSetId: 329375,
    niches: ['Health', 'Mental Health', 'Psychology', 'Fitness'],
    weeklyFloor: 750_000,
    allTimeFloor: 2_000_000,
    slots: 7, weeklyTopTier: 5, evergreenSlots: 1, weeklyMax: 4, allTimeSlots: 2, backfillMax: 3,
    tz: 'Asia/Saigon',
    levantaSubidPrefix: 'x-thread-sophia',
    // Cleared 2026-09-03 (operator): eligible now. Empty = grandfathered by Plan Watches.
    fuelEligibleAfter: null,
    // Turmeric with BioPerine: pod TU1. The absorption criterion is unusually easy to check on a
    // label, which suits a voice built on "here is how you tell the real one from the decoy".
    //
    // SWAPPED OFF TURMERIC 2026-09-19 — the same move lucas made on 2026-08-25 and for the same
    // reason (see his block): B089P4LGW3 is OUT OF STOCK, so the default plug cannot sell at all.
    // Sophia was simply never updated with him, and in the year since it has gone to 453 clicks for
    // $0.00 -- the clearest dead product on the board, and the only one to reach the kill floor on
    // zero orders. It was invisible because nothing read Levanta's availability field until today.
    // Omega-3 is not an arbitrary high-EPC pick for a joint page: BRIDGE already routes
    // `inflammation` to this exact ASIN, so her own bridged threads were reaching it anyway, and at
    // $0.680 it is the second-best product we stock. Turmeric stays curated -- 453 clicks at $0 is a
    // verdict on the listing being dead, not on turmeric, and it returns if it restocks.
    defaultProduct: { asin: 'B07DX89ZHN', title: 'Sports Research Omega-3 Fish Oil 1250mg' },
    altProducts: [
      { asin: 'B074759LBV', title: 'Nutricost Glucosamine Sulfate 1500mg' },
      { asin: 'B079K32QB6', title: 'Nutricost KSM-66 Ashwagandha 600mg' },
    ],
    voice: [
      'Sceptic who buys things anyway. Every recommendation arrives with the reason most versions of it fail.',
      'Short sentences. Generous line breaks. One or two sentences per paragraph.',
      'First person, dry, unimpressed by marketing. She names the decoy before naming the real thing.',
      'No em dashes. No superlatives. No before-and-after framing.',
      'Teaches one label-reading rule per thread, so the reader can check the next bottle without her.',
    ].join('\n'),
    closing: `Which of these fits your mornings?\n\nSlide this to a friend whose alarm always wins.`,
    disclaimer: `Full candor: affiliate links appear throughout. A sale that starts here may route a commission to me at zero change to your cost. Educational in nature, medical advice it is not. These statements went without FDA assessment. Check in with a doctor before you begin.`,
    closingLegacy: [`Which of these fits your mornings?\n\nSlide this to a friend whose alarm always wins.`],
    disclaimerLegacy: [`Full candor: affiliate links appear throughout. A sale that starts here may route a commission to me at zero change to your cost. Educational in nature, medical advice it is not. These statements went without FDA assessment. Check in with a doctor before you begin.`],
    plugHeavyExample: `Turmeric's work is done by curcumin, and the jar in your kitchen carries only a trace of it.\n\nCooking with it is a flavour choice, not a dose.\n\nCurcumin on its own barely crosses out of the gut. Piperine from black pepper is the thing that changes that, so the label has to say it.\n\n{PRODUCT} is the one I settled on:\n\n#ad\n\n{LINK}`,
    plugLightExample: `If the label does not say black pepper or BioPerine, put it back.\n\nWithout it you are paying for yellow.\n\n{PRODUCT}.\n\n#ad\n\n{LINK}`,
  },

  dzejla: {
    name: 'Džejla Cathleen',
    sex: 'f',
    handle: 'dzejlacathleen',
    // THREADS CROSS-POST (operator 2026-09-08, third wave): profile connected in Typefully
    // (@dzejlacathleen, verified against the social set's `platforms.threads` before enabling), so every
    // new draft targets X and Threads together. Scheduled drafts backfilled by cross-post-backfill.mjs
    // — a draft's platforms are fixed at write time, so config alone reaches nothing already booked.
    crossPost: ['threads'],
    socialSetId: 329376,
    niches: ['Health', 'Mental Health', 'Psychology', 'Fitness'],
    weeklyFloor: 750_000,
    allTimeFloor: 2_000_000,
    slots: 7, weeklyTopTier: 5, evergreenSlots: 1, weeklyMax: 4, allTimeSlots: 2, backfillMax: 3,
    tz: 'Asia/Saigon',
    levantaSubidPrefix: 'x-thread-dzejla',
    // Held 2026-09-03 (no X Premium, far sentinel 2099-12-31 so it failed closed); cleared
    // 2026-09-06 (operator: "Džejla is also finally up and ready"). The roster row's own
    // Fuel Eligible After still carries the sentinel until it is edited there.
    fuelEligibleAfter: '2026-09-06',
    // Ubiquinol (B0C87VT8CW, pod Q1) held this slot until 2026-09-22, when the operator asked for it
    // off the default: $0.428 restated, under the $0.45 floor. It STAYS in KEEP with floorExempt set —
    // the operator's own keep of 2026-09-19 — so every thread that argues CoQ10 still sells it through
    // BRIDGE and pod Q1. Only the no-thematic-fit fallback moves. B12 takes it: already in her own
    // rotation, the energy half of what ubiquinol stood for, $0.488 on 8,976 clicks, KEEP, in stock.
    // Shared with marko only.
    defaultProduct: { asin: 'B01IQB2UYS', title: 'Nutricost Vitamin B12 (Methylcobalamin)' },
    altProducts: [
      { asin: 'B09GLGC9DG', title: "Physician's Choice Probiotics 60 Billion CFU" },
    ],
    voice: [
      'Admits what she got wrong first. Every thread starts from a thing she believed for years and stopped believing.',
      'Short sentences. Generous line breaks. One or two sentences per paragraph.',
      'First person, reflective, never preachy. She gives the reader room to have made the same mistake.',
      'No em dashes. No shaming. No "most people are doing this wrong" openers.',
      'Explains what the body makes less of with age, then what actually replaces it.',
    ].join('\n'),
    closing: `What stops you from starting tonight?\n\nPush the share arrow and let one more person see this.`,
    disclaimer: `Level with you: affiliate links are part of this thread. Purchases through them may earn me a small percentage while your bill holds steady. Education first and last, absolutely not medical advice. FDA review never happened for these words. Doctors exist for this, ask yours.`,
    closingLegacy: [`What stops you from starting tonight?\n\nPush the share arrow and let one more person see this.`],
    disclaimerLegacy: [`Level with you: affiliate links are part of this thread. Purchases through them may earn me a small percentage while your bill holds steady. Education first and last, absolutely not medical advice. FDA review never happened for these words. Doctors exist for this, ask yours.`],
    plugHeavyExample: `CoQ10 is what your cells use to turn food into usable energy, and your own production falls with age.\n\nThe heart and the legs notice first, because neither gets a day off.\n\nI bought the cheap version for years. Most bottles are ubiquinone, the oxidised form, and the conversion your body has to do gets weaker every decade. Ubiquinol is the form it can use as it is.\n\n{PRODUCT} is what I take now:\n\n#ad\n\n{LINK}`,
    plugLightExample: `Ubiquinol, not ubiquinone.\n\nI paid for the wrong one for three years.\n\n{PRODUCT}.\n\n#ad\n\n{LINK}`,
  },

  // The batch's sixth page, registered 2026-09-02 (the operator ran the warm-up alongside the
  // 08-31 five; the roster entry was the missing half). Same fleet-standard niches; what separates
  // her is voice and territory — gut-first, and no other page defaults to a probiotic.
  irana: {
    name: 'Irana Jasmin',
    sex: 'f',
    handle: 'IranaJasmin',
    socialSetId: 329579,
    niches: ['Health', 'Mental Health', 'Psychology', 'Fitness'],
    weeklyFloor: 750_000,
    allTimeFloor: 2_000_000,
    slots: 7, weeklyTopTier: 5, evergreenSlots: 1, weeklyMax: 4, allTimeSlots: 2, backfillMax: 3,
    tz: 'Asia/Saigon',
    levantaSubidPrefix: 'x-thread-irana',
    // Warm-up cohort with the 08-31 batch: two days of plain posting before anything is amplified.
    // Cleared 2026-09-03 (operator): eligible now. Empty = grandfathered by Plan Watches.
    fuelEligibleAfter: null,
    // Probiotics, the Physician's Choice 60B (B09GLGC9DG), held this slot until 2026-09-22, when the
    // operator asked for it off the default: $0.374 restated. It STAYS in KEEP with floorExempt set —
    // the operator's own keep of 2026-09-19, made because no gut product clears $0.45 — so every
    // thread that argues gut health still sells it through BRIDGE. Only the no-fit fallback moves.
    // Sports Research magnesium glycinate takes it: $0.602 on 2,153 clicks, KEEP, in stock. It keeps
    // her gut-first register honest — the case for glycinate over oxide is tolerability, which is a
    // gut argument, not an absorption one. Shared with julian and rafael.
    defaultProduct: { asin: 'B0DZ33GTQ2', title: 'Sports Research Magnesium Glycinate Capsules, High Absorption Chelated Magnesium for Sleep' },
    altProducts: [
      { asin: 'B0BRTJ7BJ1', title: "Physician's Choice Prebiotic-Probiotic Synbiotic" },
      { asin: 'B0CK4WTYP1', title: 'Why Not Natural Magnesium Glycinate 500mg' },
    ],
    voice: [
      'Gut-first educator: her standing argument is that absorption decides whether anything else you take matters.',
      'Short sentences. Generous line breaks. One or two sentences per paragraph.',
      'First person, practical, slightly amused at her own past routines. She names what she ate or skipped, not just what she swallowed.',
      'No em dashes. No detox language. No "gut reset" cleanses.',
      'Traces the pathway: what happens between swallowing a thing and the tissue that needed it, and where that trip usually fails.',
    ].join('\n'),
    closing: `Where does your routine break down first?\n\nFire this over to a friend whose routine breaks in the same spot.`,
    disclaimer: `Note before you go: a purchase through the affiliate links above can mean a commission for me at the same price for you. Consider this education, never medical advice. No FDA review stands behind these statements. Speak to your doctor before starting a new supplement.`,
    closingLegacy: [`Where does your routine break down first?\n\nFire this over to a friend whose routine breaks in the same spot.`],
    disclaimerLegacy: [`Note before you go: a purchase through the affiliate links above can mean a commission for me at the same price for you. Consider this education, never medical advice. No FDA review stands behind these statements. Speak to your doctor before starting a new supplement.`],
    plugHeavyExample: `Most of your immune system lives in your gut lining, and so does the machinery that absorbs everything else you take.\n\nBloating after ordinary meals is usually that machinery struggling, not the meal.\n\nCFU count on its own is marketing. What matters is strains that survive stomach acid and a count verified at expiry, not at manufacture.\n\n{PRODUCT} is the one I kept after trying the shelf:\n\n#ad\n\n{LINK}`,
    plugLightExample: `Check the label says verified at expiry, not at time of manufacture.\n\nDead cultures count on the cheap ones.\n\n{PRODUCT}.\n\n#ad\n\n{LINK}`,
  },

  // ---- WARM-UP COHORT 2026-09-03 (Violet + Muah), LIVE 2026-09-06. Warm-ups ran 2 days x 2
  // singles, no plugs/links/threads; the operator declared both ready on 2026-09-06 and the
  // `paused: true` seeds came off. Active on the roster row is the switch that holds a page out
  // of the /run allocation. fuelEligibleAfter is the second hold: since 2026-09-03
  // 17:18Z Fuel the Fire's "Plan Watches" refuses the T1-T6 ladder to any row whose date is still
  // ahead, Active or not. T0 (the RT ping) is gated by blank RT Row, never by the date.
  violet: {
    // CONVERTED 2026-11-01 (operator): an AI Evo-style page, was the PI booster page 'Violet MM' (@HiVioletMM). Runs the AI Evo engine
    // (ai-evo-weekly.mjs, Hail Mary Pages row, 2 posts/day) and the AI pages' RT bridge and boosts (Vendor Routes lane AIX).
    // external like aiEvolution: no plugs, no ledger, no registry, none of the PI money tooling.
    name: 'tldr latest ai/tech',
    formerNames: ['Violet MM'], // its PI-era rows in Published Content still carry this name
    handle: 'tldraitech',
    socialSetId: 330024,
    paused: false,
    external: true,
    niches: ['AI'],
    tz: 'Asia/Saigon',
  },

  muah: {
    // CONVERTED 2026-11-01 (operator): an AI Evo-style page, was the PI booster page 'Muah Davis' (@MuahDavis). Runs the AI Evo engine
    // (ai-evo-weekly.mjs, Hail Mary Pages row, 2 posts/day) and the AI pages' RT bridge and boosts (Vendor Routes lane AIX).
    // external like aiEvolution: no plugs, no ledger, no registry, none of the PI money tooling.
    name: 'Muah Davis (ai/tech)',
    formerNames: ['Muah Davis'], // its PI-era rows in Published Content still carry this name
    handle: 'MuahDavis',
    socialSetId: 330036,
    paused: false,
    external: true,
    niches: ['AI'],
    tz: 'Asia/Saigon',
  },

  // ---- NEW PAGES 2026-09-06 (operator: "we have recently added a few more gardens"). Personas below
  // are DRAFTS written from the page names: the operator owns phase 0 and edits these before or
  // after merge. Products are pod-covered on purpose (backline is the main active CTA system), so
  // every plug example is the library's own copy.
  rosemary: {
    // CONVERTED 2026-11-01 (operator): an AI Evo-style page, was the PI booster page 'Rose Mary' (@Rose_MaryIRL). Runs the AI Evo engine
    // (ai-evo-weekly.mjs, Hail Mary Pages row, 2 posts/day) and the AI pages' RT bridge and boosts (Vendor Routes lane AIX).
    // external like aiEvolution: no plugs, no ledger, no registry, none of the PI money tooling.
    name: 'Rose Mary (ai/tech)',
    formerNames: ['Rose Mary'], // its PI-era rows in Published Content still carry this name
    handle: 'Rose_MaryIRL',
    socialSetId: 330312,
    paused: false,
    external: true,
    niches: ['AI'],
    tz: 'Asia/Saigon',
  },

  peak: {
    name: 'peak.',
    sex: 'm',
    handle: 'thisispeak007',
    socialSetId: 330442,
    niches: ['Health', 'Fitness', 'Longevity'],
    weeklyFloor: 750_000,
    allTimeFloor: 2_000_000,
    slots: 7, weeklyTopTier: 5, evergreenSlots: 1, weeklyMax: 4, allTimeSlots: 2, backfillMax: 3,
    tz: 'Asia/Saigon',
    levantaSubidPrefix: 'x-thread-peak',
    paused: true,
    // Warm-up 2026-09-07..08 (2 days x 2 singles, queues/warmup-2026-09-07.json), live from
    // 2026-09-09 (operator: "after 2 days warm up"). Active off is the real hold; the date keeps
    // T1-T6 quiet; RT Row blank keeps T0 off.
    fuelEligibleAfter: '2026-09-09',
    // Creatine monohydrate is the flagship for a performance page (pod CR1 fits it by substance; its
    // own ASIN is off the menu, this is the one the menu carries); zinc picolinate (Z1)
    // carries the testosterone lane; KSM-66 (A1) the recovery lane.
    defaultProduct: { asin: 'B0DXR7MPNV', title: 'Sports Research Creatine Monohydrate' },
    altProducts: [
      { asin: 'B0CLYQ9KX2', title: 'Nutricost Zinc Picolinate' },
      { asin: 'B079K32QB6', title: 'Nutricost KSM-66 Ashwagandha 600mg' },
    ],
    voice: [
      "Men's performance: energy, strength and testosterone, argued from the gym floor rather than the lab. (DRAFT persona, operator to confirm.)",
      'Short sentences. Generous line breaks. One or two sentences per paragraph.',
      'First person, blunt, numbers over adjectives. He counts reps, hours of sleep and grams, never "gains".',
      'No em dashes. No alpha talk. No grindset or supplement-stack posturing.',
      'Names the input that failed first, then the one that held, with the dose.',
    ].join('\n'),
    closing: `How many of these could you honestly tick off today?\n\nHand it to a gym partner whose answer is fewer.`,
    disclaimer: `Before closing: count some links as affiliate. Buying through one may send a commission my way, zero extra charged to you. Everything above is educational, distinctly not medical advice. FDA involvement in these claims: none. Bring your doctor in before trying anything new.`,
    closingLegacy: [`How many of these could you honestly tick off today?\n\nHand it to a gym partner whose answer is fewer.`],
    disclaimerLegacy: [`Before closing: count some links as affiliate. Buying through one may send a commission my way, zero extra charged to you. Everything above is educational, distinctly not medical advice. FDA involvement in these claims: none. Bring your doctor in before trying anything new.`],
    // Pod CR1 (creatine, backline variant): plain monohydrate, skip the blends.
    plugHeavyExample: `I look for plain monohydrate and nothing else when buying creatine, since it is the form every trial used, cheap, and proven.\n\nSince going back to the boring tub my last reps stopped failing.\n\n{PRODUCT} is the creatine I keep coming back to (#ad):\n\n{LINK}`,
    // Pod Z1 (zinc, light): picolinate or bisglycinate, never oxide.
    plugLightExample: `If you're looking for faster recovery, look for chelated zinc, picolinate or bisglycinate.\n\nIt absorbs without the queasy hour a cheap oxide tablet brings.\n\n{PRODUCT} is the zinc I settled on (#ad):\n\n{LINK}`,
  },

  live: {
    // CONVERTED 2026-10-22 (operator): an AI Evo-style page, was the PI health page 'Live.' (@LiveandAlive_). Runs the AI Evo engine
    // (ai-evo-weekly.mjs, Hail Mary Pages row, 2 posts/day) and AI Evo's RT bridge and boosts.
    // external like aiEvolution: no plugs, no ledger, no registry, none of the PI money tooling.
    name: 'The AGI Countdown',
    formerNames: ['Live.'], // its PI-era rows in Published Content still carry this name
    handle: 'AlltheLatestAI',
    socialSetId: 330445,
    paused: false,
    external: true,
    niches: ['AI'],
    tz: 'Asia/Saigon',
  },

  johnathan: {
    // CONVERTED 2026-10-22 (operator): an AI Evo-style page, was the PI health page 'Coach Johnathan Bush' (@CoachJohnathy). Runs the AI Evo engine
    // (ai-evo-weekly.mjs, Hail Mary Pages row, 2 posts/day) and AI Evo's RT bridge and boosts.
    // external like aiEvolution: no plugs, no ledger, no registry, none of the PI money tooling.
    name: 'Silicon Valley Press',
    formerNames: ['Coach Johnathan Bush'], // its PI-era rows in Published Content still carry this name
    handle: 'SiliconValleyPX',
    socialSetId: 332906,
    paused: false,
    external: true,
    niches: ['AI'],
    tz: 'Asia/Saigon',
  },

  felicia: {
    // CONVERTED 2026-10-22 (operator): an AI Evo-style page, was the PI health page 'Felicia Rios'. Runs the AI Evo engine
    // (ai-evo-weekly.mjs, Hail Mary Pages row, 2 posts/day) and AI Evo's RT bridge and boosts.
    // external like aiEvolution: no plugs, no ledger, no registry, none of the PI money tooling.
    name: 'Felicia Rios (ai/tech)',
    formerNames: ['Felicia Rios'], // its PI-era rows in Published Content still carry this name
    handle: 'FeliciaRios_',
    socialSetId: 332998,
    paused: false,
    external: true,
    niches: ['AI'],
    tz: 'Asia/Saigon',
  },

  lucinda: {
    name: 'Lucinda D Piland',
    sex: 'f',
    // Read off the social set's platforms.x.username, not its display name — felicia's set name
    // and her X handle differed, which is what handleDrift now guards. Here they agree.
    handle: 'LucindaDPiland',
    socialSetId: 333629,
    // OMEGA / HEART (operator call, 2026-09-22). Chosen as the least-crowded lane that still has
    // product above the floor: 8 of 24 monetized pages reach omega, against sleep on 15 and stress on
    // 17. The emptier lanes (testosterone, bloodsugar, liver, skin, joint, gut) are empty because
    // the shelf is: none of them has a single KEEP product above $0.45, so a page there would start
    // the way felicia did, plugging off-niche fallbacks from day one.
    // 'Heart' and 'Omega' make matching donors a SPECIFIC fit in scripts/cover-selection.mjs;
    // 'Health' is what keeps her in plan-singles, which only schedules pages carrying one of
    // Health / Fitness / Mental Health / Psychology.
    niches: ['Heart', 'Omega', 'Health'],
    tz: 'Asia/Saigon',
    levantaSubidPrefix: 'x-thread-lucinda',
    // FUEL STAGING AS DATA (kit 2026-08-24): the hold date — the old "enable ~2 days after launch"
    // comment rule, made real. accounts-sync writes it to the roster; Fuel the Fire's Plan Watches
    // reads it (since 2026-09-03) and keeps the page out of the T1-T6 vendor ladder until it passes.
    // It does not gate T0: leave RT Row blank for that.
    fuelEligibleAfter: '2026-09-26',
    // Sports Research omega-3: $0.73 restated on 13,865+ clicks, in KEEP and in stock. Pod O1.
    // The scaffold offers products by topic and does not read the floor, so every product in this
    // block was checked against it by hand.
    defaultProduct: { asin: 'B07DX89ZHN', title: 'Sports Research Omega-3 Fish Oil Triple Strength' },
    // Two different decisions under the same heart promise, not two of the same bottle: beet root is
    // blood flow rather than omega, and the vegan omega is for the reader who will not take fish oil.
    altProducts: [
      { asin: 'B09SFFJP1P', title: 'Nutricost Beet Root 2400mg' },
      { asin: 'B0842DJJYC', title: 'Sports Research Vegan Omega-3' },
    ],
    voice: [
      'Heart and circulation educator. Plain, specific, personally invested — never hypey.',
      'Short sentences. Generous line breaks. One or two sentences per paragraph.',
      'First person, low pressure. Reason before recommendation.',
      'No em dashes. No fake urgency. No "game-changer" hype words.',
      'Mechanism-driven: name the body system, then the simple fix.',
      'Heart health as a long game: what she does on most days matters more than any single fix.',
    ].join('\n'),
    // Both examples state the pod's buying criterion and recommend on it. Neither claims she takes
    // the product: this is a new persona, and a personal-use line is only honest when it is true of
    // the account (operator, 2026-09-20). test-scaffolds requires only {PRODUCT} and {LINK}.
    // HEAVY: pod O1 — read the EPA and DHA per softgel, not the fish oil milligrams on the front.
    plugHeavyExample: `Read the EPA and DHA per softgel, not the fish oil milligrams on the front of the bottle.\n\nA 1,000mg capsule can carry far less of the two that do the work.\n\n{PRODUCT} lists both on the label (#ad):\n\n{LINK}`,
    // LIGHT: pod BR1 — most beet products are flavouring and sugar; check for actual beet root.
    plugLightExample: `Most beet products are mostly flavouring, sugar and colouring.\n\nCheck the label for actual beet root, and how much of it sits in a serving.\n\n{PRODUCT} is one to compare against that (#ad):\n\n{LINK}`,
    closing: `Which myth here had you fooled the longest?\n\nDrop the thread in a group chat that still believes it.`,
    disclaimer: `Worth saying: affiliate links appear above. Should a purchase follow one, a commission reaches me and your total is unchanged. Consider all of this educational, well short of medical advice. FDA review does not sit behind these claims. Check with a physician before you begin.`,
    // A new page has no pre-rewrite drafts, so the legacy arrays carry the CURRENT text — an empty
    // array makes every one of this page's own threads read to QC as unrecognised boilerplate.
    closingLegacy: [`Which myth here had you fooled the longest?\n\nDrop the thread in a group chat that still believes it.`],
    disclaimerLegacy: [`Worth saying: affiliate links appear above. Should a purchase follow one, a commission reaches me and your total is unchanged. Consider all of this educational, well short of medical advice. FDA review does not sit behind these claims. Check with a physician before you begin.`],
    // Fleet-uniform slot and floor config — identical on every monetized page.
    slots: 7,
    weeklyFloor: 750000,
    weeklyMax: 4,
    allTimeFloor: 2000000,
    allTimeSlots: 2,
    evergreenSlots: 1,
    weeklyTopTier: 5,
    backfillMax: 3,
  },

  natella: {
    name: 'Natella Belova',
    sex: 'f',
    // Read off the social set's platforms.x.username; it agrees with the set name here.
    handle: 'NatellaBelib99',
    socialSetId: 334091,
    // BRAIN / FOCUS (operator call, 2026-09-22). Reached by 12 of 24 monetized pages, with three
    // products above the floor. 'Brain' makes brain donors a SPECIFIC fit in cover-selection;
    // 'Mental Health' keeps her in plan-singles and compatible with sleep and stress donors.
    niches: ['Brain', 'Mental Health'],
    tz: 'Asia/Saigon',
    levantaSubidPrefix: 'x-thread-natella',
    // FUEL STAGING AS DATA (kit 2026-08-24): the hold date — the old "enable ~2 days after launch"
    // comment rule, made real. accounts-sync writes it to the roster; Fuel the Fire's Plan Watches
    // reads it (since 2026-09-03) and keeps the page out of the T1-T6 vendor ladder until it passes.
    // It does not gate T0: leave RT Row blank for that.
    fuelEligibleAfter: '2026-09-26',
    // Nutricost magnesium L-threonate (Magtein): $0.56 restated on 7,000+ clicks, in KEEP, in stock.
    // Pod TH1. The scaffold proposed NeuroGum (B0DFHL299C) for the brain topic, which has no EPC at
    // all yet; a default is what a thread falls back to, so it should not be an untested product.
    defaultProduct: { asin: 'B09QFSDLL5', title: 'Nutricost Magnesium L-Threonate (Magtein) 2000mg' },
    // Three substances, three decisions: omega-3 for brain structure, ashwagandha for the stress side
    // of focus. Both clear the floor and sit in KEEP.
    altProducts: [
      { asin: 'B07DX89ZHN', title: 'Sports Research Omega-3 Fish Oil Triple Strength' },
      { asin: 'B079K32QB6', title: 'Nutricost KSM-66 Ashwagandha 600mg' },
    ],
    voice: [
      'Brain and focus educator. Plain, specific, personally invested — never hypey.',
      'Short sentences. Generous line breaks. One or two sentences per paragraph.',
      'First person, low pressure. Reason before recommendation.',
      'No em dashes. No fake urgency. No "game-changer" hype words.',
      'Mechanism-driven: name the body system, then the simple fix.',
      'Focus is something she protects before she adds to it: sleep, food and attention come before any supplement.',
    ].join('\n'),
    // Both examples state the pod's buying criterion and recommend on it, with no claim that she
    // takes the product — a new persona, so a personal-use line would not be true of the account.
    // HEAVY: pod TH1, as a form declaration. Its library criterion says the form is "shown to raise
    // levels in the brain itself, cheaper forms never cross"; the example keeps the decision (the
    // form is the choice) and states it at the strength the evidence carries — studied, not proven.
    plugHeavyExample: `If magnesium is for focus, the form is the whole decision.\n\nL-threonate, sold as Magtein, is the form studied for raising magnesium in the brain.\n\n{PRODUCT} is Magtein and says so on the label (#ad):\n\n{LINK}`,
    // LIGHT: pod A1 — KSM-66 is the standardised root extract, not plain milled root or leaf.
    plugLightExample: `"Ashwagandha" on the front can mean a standardised root extract, or plain milled root and leaf.\n\nKSM-66 is the standardised root extract.\n\n{PRODUCT} is KSM-66 (#ad):\n\n{LINK}`,
    closing: `Where did this thread lose you?\n\nBounce it over to a reader who will argue the other side.`,
    disclaimer: `Note: affiliate links are in play here. Buy through any of them and a commission may follow to me, though the sum you hand over stays flat. Read the thread as teaching, not as medical advice. No claim above has been through the FDA. Ask your physician before changing anything.`,
    // A new page has no pre-rewrite drafts, so the legacy arrays carry the CURRENT text.
    closingLegacy: [`Where did this thread lose you?\n\nBounce it over to a reader who will argue the other side.`],
    disclaimerLegacy: [`Note: affiliate links are in play here. Buy through any of them and a commission may follow to me, though the sum you hand over stays flat. Read the thread as teaching, not as medical advice. No claim above has been through the FDA. Ask your physician before changing anything.`],
    // Fleet-uniform slot and floor config — identical on every monetized page.
    slots: 7,
    weeklyFloor: 750000,
    weeklyMax: 4,
    allTimeFloor: 2000000,
    allTimeSlots: 2,
    evergreenSlots: 1,
    weeklyTopTier: 5,
    backfillMax: 3,
  },

  aiEvolution: {
    name: 'AI Evolution',
    handle: 'AiEvolutio58513',
    socialSetId: 310558,
    // RESUMED 2026-07-17 (operator call): RT AI Evo Bridge should ping Telegram for this account.
    // Fuel Watch and Calendar stay off — client account (tuned directly in Airtable; accounts-sync
    // never overwrites those two after first creation).
    paused: false,
    // EXTERNAL (operator call 2026-07-23): AI Evolution only shares the RT BRIDGE with us — it must
    // NOT appear in our own Telegram reporting or tracking. `external: true` excludes it from the
    // registry sync (Published Content + fleet-health alarms), the nightly QC pass, and the daily
    // calendar. The n8n RT Bridge keys off the Airtable Accounts roster (RT Row) and is unaffected.
    // (Replaces the old trackAll:true, which indexed ALL its posts into the registry.)
    external: true,
    niches: ['AI'],
    tz: 'Asia/Saigon',
    // NOTE: recreation config (voice / plugs / products) is health-tuned for Julian and not yet
    // adapted for AI Evolution. do NOT run run-weekly --account aiEvolution before adding AI-niche
    // voice + monetization.
  },
};
// THE BURNER (operator 2026-08-23): "Genius Thread by GeniusGTX" on Threads is the staging page.
// Anything may post there — a finished thread before it goes to a real account, or a fragment when
// only part of a generation needs eyeballs on a live timeline. It carries NO levantaSubidPrefix so
// every planner, roster and acceptance filter skips it automatically, and publish-thread's --burner
// lane relaxes the monetization gates (no products required, no ledger row) while keeping the
// per-tweet ones (280, placeholders, banned topics).
ACCOUNTS.burner = {
  name: 'GeniusGTX Burner',
  // The handle has to be the social set's ACTUAL X username. Set 204330 is @Genius_Thread; this row
  // said @GeniusGTX, which is a different page (set 151393) and also the name of the manual client
  // row in the Airtable roster — two rows carrying one handle. Harmless while the burner is paused
  // and unwired, and exactly the drift ONBOARDING.md blames for Fuel the Fire once reporting Knox's
  // posts as @Genius_Media_: the RT Bridge renders roster Handle straight into its ping text, so a
  // stale one advertises a page that did not post. Corrected 2026-08-31 against GET /social-sets.
  handle: 'Genius_Thread',
  socialSetId: 204330,
  burner: true,
  paused: true,
  tz: 'Asia/Saigon',
  niches: ['Health'],
  voice: 'Neutral test page. No persona — whatever is being previewed keeps its own voice.',
  closing: '',
  disclaimer: '',
};

// Every account carries its own code KEY. Found 2026-08-23: pod selection normalized the account as
// (key || name).toLowerCase(), and with no key present "Marcos Romano" -> "marcos romano", which
// matches no variant — the outline path could never render an account's own pod wording in
// production. The key is data the object should simply carry.
for (const [k, a] of Object.entries(ACCOUNTS)) a.key = k;

// Accepts the KEY ("tina") or the DISPLAY NAME ("Tina De Jong"), because both are in circulation and
// the mismatch is silent until something tries to round-trip. publish-thread stores the display name
// in the committed record on purpose — a record is meant to be read — but that made every shipped
// spec un-replayable: gating the 22 records of the 2026-08-28 batch failed 16 of them on "unknown
// account", when the copy was fine and only the label had changed shape.
export const resolveAccountKey = (name) => {
  const raw = String(name ?? '');
  if (ACCOUNTS[raw]) return raw;
  const lower = raw.toLowerCase();
  if (ACCOUNTS[lower]) return lower;
  const hit = Object.entries(ACCOUNTS).find(([, a]) => String(a?.name || '').toLowerCase() === lower);
  return hit ? hit[0] : null;
};

export const getAccount = (key) => {
  const a = ACCOUNTS[resolveAccountKey(key)];
  if (!a) throw new Error(`Unknown account: ${key}. Known: ${Object.keys(ACCOUNTS).join(', ')}`);
  return a;
};

// ---- Auto selection-mode for young pages (operator request 2026-08-08) -----------------------------
// A NEW page should EXPLORE (3x explorer products, no best-converter pin — pick-product.mjs) until it
// has enough of its own history to exploit, so it finds ITS winners instead of inheriting the old
// pages' habits. Graduation = EXPLORE_GRADUATE_DRAFTS created drafts in the ledger (default 30 ≈ a
// month at 1/day). Used by the roster overlay below ONLY when the Airtable "Selection Mode" field is
// blank — an explicit operator pick (Explore/Exploit) always wins. `lines` injectable for tests.
import { readFileSync, existsSync } from 'node:fs';
const GRADUATE_DRAFTS = Number(process.env.EXPLORE_GRADUATE_DRAFTS ?? 30);
let _draftCounts; // account name -> created-draft count, read once per process
export function autoSelectionMode(accountName, { minDrafts = GRADUATE_DRAFTS, lines } = {}) {
  let counts = _draftCounts;
  if (lines || !counts) {
    counts = new Map();
    try {
      const src = lines ?? (existsSync(new URL('./ledger.jsonl', import.meta.url)) ? readFileSync(new URL('./ledger.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean) : []);
      for (const line of src) {
        try { const e = typeof line === 'string' ? JSON.parse(line) : line; if (e.account && e.draftId) counts.set(e.account, (counts.get(e.account) || 0) + 1); } catch {}
      }
    } catch {}
    if (!lines) _draftCounts = counts;
  }
  return (counts.get(accountName) || 0) < minDrafts ? 'explore' : 'exploit';
}

// ---- Live master switch (operator decision 2026-07-22) ---------------------------------------------
// The Airtable "Accounts" table's Active checkbox is the operator's on/off control panel: flipping it
// pauses/resumes an account EVERYWHERE, no PR, no deploy (fleet-prep — 20 accounts need a panel, not
// code edits). This overlay runs once at import, before any consumer derives its account set (the
// engines' HEALTH filters read `paused` at module load): rows with an Engine Key map Active=false ->
// paused. accounts-sync used to overwrite Active from code on every run — that was the "I turned it
// on and it turned itself off" bug; the sync now seeds Active on row creation only.
// Fail-open by design: no AIRTABLE_PAT in the environment (local dev, CI tests), a fetch error, or a
// missing row all leave the accounts.mjs `paused` flags standing. LIVE_ROSTER=0 disables the overlay.
const ROSTER_BASE = 'app7vXbBugWeCGctD', ROSTER_TABLE = 'tblwn2lLoJBuJKvUv';
try {
  const pat = process.env.AIRTABLE_PAT;
  if (pat && process.env.LIVE_ROSTER !== '0') {
    let off = '', applied = [];
    do {
      const qs = `pageSize=100&fields%5B%5D=Engine%20Key&fields%5B%5D=Active&fields%5B%5D=Selection%20Mode${off ? `&offset=${off}` : ''}`;
      const r = await fetch(`https://api.airtable.com/v0/${process.env.XDB_BASE_ID || ROSTER_BASE}/${ROSTER_TABLE}?${qs}`, { headers: { Authorization: `Bearer ${pat}` } });
      if (!r.ok) throw new Error(`Accounts table -> ${r.status}`);
      const j = await r.json();
      for (const rec of j.records || []) {
        const k = rec.fields['Engine Key'];
        if (!k || !ACCOUNTS[k]) continue;
        const wantPaused = !rec.fields.Active; // unchecked checkbox arrives as absent
        if (ACCOUNTS[k].paused !== wantPaused) { ACCOUNTS[k].paused = wantPaused; applied.push(`${k}→${wantPaused ? 'paused' : 'ACTIVE'}`); }
        // Selection Mode (operator knob, 2026-07-28, same panel as Active): Explore widens product
        // testing for this account (pick-product.mjs — 3x explorer allowance, learned-converter
        // pinning off). An explicit pick (Explore/Exploit) always wins; a BLANK field auto-resolves
        // by maturity (2026-08-08): a young page (< EXPLORE_GRADUATE_DRAFTS ledger drafts) explores
        // until it finds ITS winners, then graduates to exploit — so onboarding a new account needs
        // no manual mode flip. An unreachable overlay still fails to the code's flags.
        const sel = rec.fields['Selection Mode'];
        const wantMode = sel === 'Explore' ? 'explore' : sel === 'Exploit' ? 'exploit' : autoSelectionMode(ACCOUNTS[k].name);
        if ((ACCOUNTS[k].selectionMode ?? 'exploit') !== wantMode) { ACCOUNTS[k].selectionMode = wantMode; applied.push(`${k}→${wantMode}${sel ? '' : ' (auto)'}`); }
      }
      off = j.offset || '';
    } while (off);
    // stderr, not stdout (2026-08-31): this is a diagnostic, not data. Every --json path in the
    // repo has accounts.mjs in its import graph, so one stdout line here makes the payload
    // unparseable for any caller piping it. The catch below already wrote to stderr.
    if (applied.length) console.error(`[roster] Airtable master switch applied: ${applied.join(', ')}`);
  }
} catch (e) { console.warn(`[roster] live overlay skipped (${e.message}) — accounts.mjs paused flags stand`); }
