// vendor-supply.mjs — treat the RT packages as what they actually are: inventory.
//
// Every vendor deal is a stock of posts that depletes at an uncertain rate and takes time to
// replenish. That is a textbook supply problem, and running it by eye is what cost us tiers this
// week: YK sat on 4 posts and EU on 3 while nobody was watching, and Maven/EM holds 297 we have not
// paid for. The three numbers that matter are how fast it goes, how long a top-up takes, and how
// wrong the rate can be — everything below is those three.
//
//   REORDER POINT = demand over the lead time + safety stock.  Order when stock crosses it, not when
//                   the vendor tells you it is empty.
//   SAFETY STOCK  = z * sigma * sqrt(leadTime).  Buys cover against demand VARIANCE, which on this
//                   fleet is the dominant risk: T0 went direct on 2026-09-05 and per-vendor demand
//                   tripled overnight. A plan built on the mean alone would have stocked out.
//   ORDER SIZE    = enough to reach the target cover, no more. Cash sat in unused posts is the other
//                   failure mode and we have $9,375 of it — Wealth Director alone holds 58 months.
//
// DEMAND (planningDemand in fuel-ops-core.mjs) is built in three steps, each printed on the board:
//   measured  = max(windowed mean, mean since the regime change) of OUR Fuel Log lines per vendor
//   × fleet   = pages posting now / pages that fired inside the window. The history was written by
//               ~18 pages; the roster is 23. A plan on the raw history would be a plan for last week's
//               fleet. (--fleet / --base override; the roster's row count is the default.)
//   × buffer  = the viral allowance (operator, 2026-09-06). Default 1.3; --buffer 1 turns it off.
// MEASURED IS A FLOOR. It counts our sends; other people post into these groups too, so true
// depletion is faster. The tracker's Burn column (bot ledger, day over day) is the real figure —
// once it has two syncs behind it, that replaces "measured" here.
//
//   node vendor-supply.mjs                                  # the supply board
//   node vendor-supply.mjs --lead 5 --cover 60 --service 99 # more cautious
//   node vendor-supply.mjs --fleet 25 --buffer 1.5          # what if
//   node vendor-supply.mjs --budget 5000                    # spread a monthly cap
//   node vendor-supply.mjs --apply --send                   # write RT Usage in Airtable; alert the Fuel topic on REORDER/SOON
//   node vendor-supply.mjs --json
import { readFileSync } from 'node:fs';
import { loadEnv, requireEnv, airtable, logRun, runMain, cliArg, telegram, esc } from './lib.mjs';
import { lastLog, alertDelta } from './alert-delta.mjs';
import { ledgerLines, Z, planningDemand, safetyStock, reorderPoint, supplyStatus, orderSize, rotationSim, parseFanout, fanoutTable, budgetPlan, trimMenu, trimOrder, autoTrim, stockOf, botLedgerByChat } from './fuel-ops-core.mjs';
import { demandOptions, describeModel } from './fleet-roster.mjs';
import { configRows, botStatus } from './fuel-ops-io.mjs';

await runMain(async () => {
  const env = loadEnv();
  requireEnv(env, ['AIRTABLE_PAT', 'REGISTRY_BASE_ID', 'XDB_BASE_ID']);
  const leadDays = Number(cliArg('lead', 3));
  const coverDays = Number(cliArg('cover', 45));
  const service = Number(cliArg('service', 95));
  const z = Z[service] ?? 1.65;
  const { window, fleet, base, buffer, roster } = await demandOptions(env);

  const deals = JSON.parse(readFileSync(new URL('./vendor-credits.json', import.meta.url), 'utf8'));
  const lines = ledgerLines(await airtable(env, env.REGISTRY_BASE_ID).listAll('Fuel Log'));
  // Stock comes from the bot's ledger, not this file: vendor-credits.json is typed by hand and drifts
  // (2026-09-06: it had Pammy at 35 posts left when the ledger said 11, and Maven at 297 when the pack
  // was overdrawn by 5). Fail-open — an unreachable bot leaves the file in charge and says so.
  const { status: bot, note: botNote } = await botStatus(await configRows(env));
  const ledgerByChat = botLedgerByChat(bot);
  const now = Date.now();

  const rows = [];
  let model = null;
  for (const v of deals.vendors) {
    if (v.deal === 'unlimited') continue;
    const p = planningDemand(lines, v.name, { window, now, fleet, base, buffer });
    model ||= p;
    const { stock, owed, source } = stockOf(v, ledgerByChat);
    const safety = safetyStock(p.sigma, leadDays, z);
    const rop = reorderPoint(p.demand, leadDays, safety);
    rows.push({ vendor: v.name, stock, measured: p.measured, windowMean: p.windowMean, recent: p.recent, demand: p.demand, sd: p.sigma, safety, rop,
      status: supplyStatus(stock, rop, p.demand),
      daysCover: p.demand > 0 ? stock / p.demand : Infinity,
      order: orderSize(p.demand, coverDays, leadDays, stock, safety),
      price: v.perPost, cash: Math.max(0, stock) * v.perPost, unpaid: !!v.unpaid, owed, source });
  }
  const rank = { OUT: 0, REORDER: 1, SOON: 2, OK: 3, IDLE: 4 };
  rows.sort((a, b) => rank[a.status] - rank[b.status] || a.daysCover - b.daysCover);
  const factors = model ? { fleet: model.fleet, baseFleet: model.baseFleet, fleetFactor: model.fleetFactor, buffer: model.buffer, scale: model.scale } : {};

  // ---- ROTATION (operator 2026-09-06: "consider vendor rotation for tiers to better suit our supply") ----
  // Today every fire goes to every active vendor in its tier, so a 30-post pack burns as fast as the
  // 1000-post pack beside it. rotationSim sends each fire to the K vendors with the most posts left
  // (fuel-ops-core rotationPick) and shows the cover that buys against the reach per fire it costs.
  // Nothing here changes the ladder: the n8n side is written up in docs/FUEL-ROTATION.md and waits
  // for the operator's go.
  const cfg = (await airtable(env, env.XDB_BASE_ID).listAll('Config')).map((r) => r.fields || r)
    // A COMMENT row (v6 "Maven Comment") shares its RT vendor's chat: joining it by chat id would count
    // that vendor's RT stock twice. Comments are a separate pack, read from the bot's comment ledger.
    .filter((f) => /^Vendor – /.test(String(f.Name || '')) && !/\bcomment\b/i.test(String(f.Name || '')) && f.Active && String(f['Chat ID'] || '').trim());
  const tierOf = (f) => (typeof f.Tier === 'object' && f.Tier ? f.Tier.name : f.Tier) || '';
  const FANOUT = { T1: 2, T2: 1, T3: 1, T5: 1, ...parseFanout(cliArg('fanout', '')) };
  const RESERVE = Number(cliArg('reserve', 3));
  const HORIZON = Number(cliArg('horizon', 45));
  const byChat = Object.fromEntries(deals.vendors.map((v) => [String(v.chatId), v]));
  const planByName = Object.fromEntries(rows.map((r) => [r.vendor, r]));
  const pools = {};
  for (const f of cfg) {
    const t = tierOf(f), d = byChat[String(f['Chat ID']).trim()];
    if (!/^T\d$/.test(t) || !d) continue;
    (pools[t] ||= []).push({ name: d.name, unlimited: d.deal === 'unlimited', stock: d.deal === 'unlimited' ? Infinity : d.total - d.used,
      reach: Number(f['Network Size']) || 0, price: Number(f.Price) || 0, offer: d.renewalOffer ? { posts: d.renewalOffer.posts, price: d.renewalOffer.price } : null });
  }
  const rotation = { reserve: RESERVE, horizon: HORIZON, fanout: FANOUT, tiers: [] };
  for (const [tier, vs] of Object.entries(pools).sort()) {
    const metered = vs.filter((v) => !v.unlimited);
    // every metered vendor sees every fire today, so the tier fires at its vendors' planned rate
    const rate = Math.max(0, ...metered.map((v) => (planByName[v.name] || {}).demand || 0));
    const k = FANOUT[tier] ?? Infinity;
    const today = rotationSim(vs, rate, { k: Infinity, reserve: null, days: HORIZON });
    const rot = rotationSim(vs, rate, { k, reserve: RESERVE, days: HORIZON });
    const offers = vs.filter((v) => v.offer);
    const after = offers.length ? rotationSim(vs.map((v) => ({ ...v, stock: v.unlimited ? Infinity : v.stock + (v.offer ? v.offer.posts : 0) })), rate, { k, reserve: RESERVE, days: HORIZON }) : null;
    rotation.tiers.push({ tier, rate, k: Number.isFinite(k) ? k : 'all', vendors: vs, table: fanoutTable(vs, rate), today, rotation: rot, offers: offers.map((v) => `${v.name} +${v.offer.posts}`), afterOffers: after });
  }

  const FULL_THRESHOLD = Number(cliArg('full-under', 400));   // below this, never split — not worth the goodwill
  const PER_INSTALLMENT = Number(cliArg('installment', 800)); // rough size of a comfortable payment
  const SLOTS = [1, 5, 8, 12, 15, 18, 22, 25, 28];            // standing days of the month, spread out

  // A plan STARTS when the vendor crosses its reorder point, not today: an OK vendor's top-up is a
  // dated commitment, so the board can say what the next 30 days actually cost.
  const payable = rows.filter((r) => r.order > 0 || r.unpaid).map((r) => {
    const amount = r.unpaid ? r.owed * r.price + r.order * r.price : r.order * r.price;
    const n = amount <= FULL_THRESHOLD ? 1 : Math.max(2, Math.min(4, Math.ceil(amount / PER_INSTALLMENT)));
    const startIn = r.unpaid || r.status === 'OUT' || r.status === 'REORDER' ? 0 : r.demand > 0 ? Math.max(0, (r.stock - r.rop) / r.demand) : Infinity;
    return { ...r, amount, startIn, installments: r.unpaid ? Math.min(n, 2) : n };   // debt clears in at most two
  });
  // urgency orders the slots: the vendors we are about to run dry on get the earliest dates
  payable.sort((a, b) => (b.unpaid ? 1 : 0) - (a.unpaid ? 1 : 0) || a.startIn - b.startIn || a.daysCover - b.daysCover);
  payable.forEach((p, i) => { p.slot = SLOTS[i % SLOTS.length]; });

  // ---- BUDGET (operator 2026-09-06: "spend a maximum of 5k this month on RT supply — how should we
  // spread it", then "Maven can be split and delay payments; most important is Pammy and IP always
  // alive") ----
  // budgetPlan in fuel-ops-core.mjs, in strict order: fixed lines off the top, then the CRITICAL
  // vendors funded to their own month of cover, then keep every remaining tier alive bottleneck-
  // first, then full reach with whatever is left in reach-per-dollar order.
  //
  // "Alive" at tier level only promises SOMEBODY in the tier still has posts. Naming a vendor
  // critical promises THAT vendor never runs out, which is a different and more expensive promise —
  // and the one the operator asked for on T2. The board prices it both ways, because under the
  // rotation proposal two vendors that alternate need HALF the posts between them to make the same
  // month, and on T2 that is the difference between a $3.6k guarantee and a $0.3k one.
  const round2 = (n) => Math.round(n * 100) / 100;
  const bcfg = deals.budget || {};
  const BUDGET = Number(cliArg('budget', bcfg.monthly || 0));
  const MONTH = Number(cliArg('month', 30));
  const MIN_ORDER = Number(cliArg('min-order', 50));
  const CRITICAL = String(cliArg('critical', (bcfg.critical || []).join(','))).split(',').map((x) => x.trim()).filter(Boolean);
  // The debt is a balance for posts already delivered, not a purchase that competes for reach. The
  // operator can split it further and start it later, so by default it takes nothing from THIS month
  // and shows up as a dated commitment instead of a line item.
  const DEBT_N = Math.max(1, Number(cliArg('debt-installments', bcfg.debtInstallments || 2)));
  const DEBT_DEFER = Math.max(0, Number(cliArg('debt-defer', bcfg.debtDeferDays ?? 0)));
  const retainerLines = deals.vendors.filter((v) => v.monthlyRetainer).map((v) => ({ name: v.name, amount: v.monthlyRetainer, why: 'retainer, unlimited T0' }));
  const debts = payable.filter((p) => p.unpaid).map((p) => ({ name: p.vendor, total: round2(p.owed * p.price), each: round2(p.owed * p.price / DEBT_N), n: DEBT_N, posts: p.owed,
    startsOn: new Date(now + DEBT_DEFER * 864e5).toISOString().slice(0, 10) }));
  const debtLines = DEBT_DEFER > 0 ? [] : debts.map((d) => ({ name: d.name, amount: d.each, why: `debt: ${d.posts} delivered posts unpaid, 1 of ${d.n}` }));
  const fixedLines = process.argv.includes('--no-debt') ? retainerLines : [...retainerLines, ...debtLines];
  const tiersFor = (shares) => rotation.tiers.map((t) => ({ tier: t.tier, rate: t.rate,
    vendors: t.vendors.map((v) => ({ ...v, share: shares ? shares(t, v) : 1 })) }));
  // Under rotation a metered vendor takes k of every n fires in its tier, so its own demand — and
  // the price of guaranteeing it — falls in the same proportion.
  const rotShare = (t, v) => { if (v.unlimited) return 1; const m = t.vendors.filter((x) => !x.unlimited).length; const k = FANOUT[t.tier]; return Number.isFinite(k) && k > 0 ? Math.min(1, k / m) : 1; };
  // TRIM (operator, 2026-09-06: "we can trim some of the other tiers like Hey Brother or Pst or WD").
  // A tier can be funded to fewer days than the month on purpose. --target "T5=10,T3=20" sets it by
  // hand; --auto-trim finds the cheapest set of trims that makes everything else fit, taking them from
  // the tier with the worst reach per dollar first and never from a tier carrying a critical vendor.
  // The trim menu below prices every choice either way.
  const TARGETS = Object.fromEntries(String(cliArg('target', Object.entries(bcfg.targets || {}).map(([k, v]) => `${k}=${v}`).join(',')))
    .split(',').map((x) => x.split('=')).filter((x) => x[0] && x[0].trim()).map(([k, v]) => [k.trim().toUpperCase(), Number(v)]));
  const AUTO_TRIM = process.argv.includes('--auto-trim');
  const INSTALMENTS = Object.fromEntries(deals.vendors.filter((v) => v.installments > 1).map((v) => [v.name, v.installments]));
  const budgetArgs = { budget: BUDGET, days: MONTH, fixed: fixedLines, minOrder: MIN_ORDER, critical: CRITICAL, targets: TARGETS, installments: INSTALMENTS };
  // --assume-rotation prints the plan for the fan-out in FANOUT instead of today's send-to-all, so the
  // cheaper guarantee can be read in full rather than as a headline.
  const ASSUME_ROT = process.argv.includes('--assume-rotation');
  const planOf = (shares) => (AUTO_TRIM ? autoTrim({ ...budgetArgs, tiers: tiersFor(shares) }) : budgetPlan({ ...budgetArgs, tiers: tiersFor(shares) }));
  const planToday = BUDGET > 0 ? planOf(null) : null;
  const planRot = BUDGET > 0 ? planOf(rotShare) : null;
  const budget = ASSUME_ROT ? planRot : planToday;
  const budgetRot = CRITICAL.length ? planRot : null;
  const menu = BUDGET > 0 ? trimMenu(tiersFor(ASSUME_ROT ? rotShare : null)) : null;

  if (process.argv.includes('--json')) { console.log(JSON.stringify({ leadDays, coverDays, service, window, ...factors, roster, rows, rotation, budget, budgetUnderRotation: planRot, debts, trimMenu: menu }, null, 2)); return; }
  const f = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '—');
  console.log(`SUPPLY BOARD — lead ${leadDays}d · target cover ${coverDays}d · service ${service}% (z=${z}) · demand window ${window}d`);
  console.log(describeModel(model, roster));
  const fromBot = rows.filter((r) => r.source === 'bot');
  console.log(bot
    ? `stock from the RT bot ledger for ${fromBot.length}/${rows.length} vendors${fromBot.length < rows.length ? ` (rest from vendor-credits.json: ${rows.filter((r) => r.source !== 'bot').map((r) => r.vendor).join(', ')})` : ''}`
    : `⚠️ stock from vendor-credits.json — the bot ledger is unreadable (${botNote}); these numbers drift`);
  const over = rows.filter((r) => r.stock < 0);
  if (over.length) console.log('❗ OVERDRAWN — the pack is spent and still delivering: ' + over.map((r) => `${r.vendor} by ${-r.stock}`).join(' · '));
  console.log('');
  console.log('vendor'.padEnd(20) + 'stock'.padStart(5) + 'measured'.padStart(10) + 'plan/d'.padStart(9) + 'sigma'.padStart(8) + 'safety'.padStart(9)
    + 'reorder@'.padStart(11) + 'cover'.padStart(8) + '   ' + 'status'.padEnd(9) + 'order'.padStart(8) + 'cash held'.padStart(13));
  for (const r of rows) {
    console.log(r.vendor.padEnd(20) + String(r.stock).padStart(5) + f(r.measured, 2).padStart(10) + f(r.demand, 2).padStart(9) + f(r.sd, 2).padStart(8)
      + f(r.safety, 0).padStart(9) + f(r.rop, 0).padStart(11) + (Number.isFinite(r.daysCover) ? f(r.daysCover, 0) + 'd' : '  —').padStart(8)
      + '   ' + r.status.padEnd(9) + (r.order ? String(r.order) : '—').padStart(8)
      + ('$' + r.cash.toFixed(0)).padStart(13) + (r.unpaid ? '  UNPAID' : ''));
  }
  const need = rows.filter((r) => r.status === 'OUT' || r.status === 'REORDER');
  const cost = need.reduce((s, r) => s + r.order * r.price, 0);
  const all = rows.reduce((s, r) => s + r.order * r.price, 0);
  console.log('\ncash held in unused posts: $' + rows.reduce((s, r) => s + r.cash, 0).toFixed(2));
  console.log('reorder now: ' + (need.length ? need.map((r) => r.vendor).join(', ') : 'nothing') + (need.length ? `  —  $${cost.toFixed(2)} to bring them to ${coverDays}d cover` : ''));
  console.log(`every vendor to ${coverDays}d cover: $${all.toFixed(2)}`);
  const risk = rows.filter((r) => Number.isFinite(r.daysCover) && r.daysCover < leadDays);
  if (risk.length) console.log('WILL STOCK OUT BEFORE A TOP-UP CAN LAND (' + leadDays + 'd): ' + risk.map((r) => `${r.vendor} ${f(r.daysCover, 1)}d`).join(', '));
  console.log('\nmeasured = OUR sends only, a floor. Others post into these groups; the tracker\'s Burn replaces it once it has two syncs.');
  // ---- PAYMENT PLAN ---------------------------------------------------------------------------
  // Two failure modes, opposite directions. Pay everything on delivery and the cash arrives in
  // lumps we cannot smooth. Split everything into installments and we become the customer who
  // haggles over $129, which costs more in goodwill than it saves in float.
  //
  // So: small invoices are paid whole, big ones are split, and every vendor gets a STANDING DAY OF
  // THE MONTH. The standing date is the part that actually buys the relationship — a vendor who is
  // paid on the 5th every month without chasing will hold a slot for us and quote better than one
  // who has to ask. Predictability is cheaper than generosity.
  //
  // Debt is paid first and fastest. Maven/EM has delivered 3 posts against an unpaid 300-post
  // package: that is the one balance where being slow costs us a supplier rather than some float.
  console.log('\n=== PAYMENT PLAN ===\n');
  console.log('vendor                 owed   split         each   starts     standing day   why');
  for (const p of payable) {
    const why = p.unpaid ? 'DEBT — delivered, unpaid' : p.amount <= FULL_THRESHOLD ? 'small, pay whole' : `${p.installments} installments`;
    const starts = p.startIn < 0.5 ? 'now' : Number.isFinite(p.startIn) ? `in ${Math.round(p.startIn)}d` : '—';
    console.log(p.vendor.padEnd(20) + ('$' + p.amount.toFixed(0)).padStart(8) + String(p.installments + '×').padStart(8)
      + ('$' + (p.amount / p.installments).toFixed(0)).padStart(13) + starts.padStart(9) + ('the ' + p.slot).padStart(17) + '   ' + why);
  }
  const monthly = payable.reduce((s, p) => s + p.amount / p.installments, 0);
  const soon = payable.filter((p) => p.startIn <= 30).reduce((s, p) => s + p.amount / p.installments, 0);
  console.log('\nnext 30 days (first installments of plans that start by then): $' + soon.toFixed(2) + ' + retainers $1000.00 = $' + (soon + 1000).toFixed(2));
  console.log('level monthly outflow once every plan is running:            $' + monthly.toFixed(2) + ' + retainers $1000.00 = $' + (monthly + 1000).toFixed(2));
  if (payable.length) console.log('\nlongest plan ends in ' + Math.max(...payable.map((p) => p.installments)) + ' months; after that the monthly falls to the renewal cadence.');

  const fmtK = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
  const coverTxt = (r) => (r.unlimited ? '∞' : Number.isFinite(r.coverDay) ? `${r.coverDay}d` : `>${HORIZON}d`);
  console.log('\n=== ROTATION — each fire to the K vendors in its tier with the most posts left; unlimited always send ===');
  console.log(`reserve ${RESERVE} posts · horizon ${HORIZON}d · chosen fan-out ${Object.entries(FANOUT).map(([t, k]) => `${t}=${Number.isFinite(k) ? k : 'all'}`).join(' ')}, other tiers all · flags --fanout "T2=2,T3=all" --reserve --horizon`);
  let monthToday = 0, monthChosen = 0;
  for (const r of rotation.tiers) {
    const metered = r.vendors.filter((v) => !v.unlimited);
    console.log(`\n${r.tier} · ${r.rate.toFixed(2)} fires/d planned · ` + r.vendors.map((v) => `${v.name} ${fmtK(v.reach)}${v.unlimited ? ' free' : ` $${v.price}`}`).join(' · '));
    console.log('  fan-out     reach/fire    $/fire   posts/d    $/month');
    for (const row of r.table) {
      const tag = row.k === metered.length ? ' (today)' : row.k === r.k ? ' (chosen)' : '';
      if (row.k === metered.length) monthToday += row.monthly;
      if (row.k === (r.k === 'all' ? metered.length : r.k)) monthChosen += row.monthly;
      console.log('  ' + (String(row.k) + tag).padEnd(12) + fmtK(row.reachPerFire).padStart(10) + row.costPerFire.toFixed(2).padStart(10) + row.postsPerDay.toFixed(1).padStart(10) + ('$' + Math.round(row.monthly)).padStart(11));
    }
    const a = r.today, b = r.rotation;
    console.log(`  next ${HORIZON}d at fan-out ${r.k}:  ` + (b.darkFrom ? `tier dark from day ${b.darkFrom}, ${b.dark} of ${b.fires} fires unserved` : `every fire served`)
      + `  ·  today's ladder would overdraw ${a.overdraw} posts` + (r.afterOffers ? `  ·  with ${r.offers.join(', ')} landed: ` + (r.afterOffers.darkFrom ? `dark from day ${r.afterOffers.darkFrom}` : 'every fire served') : ''));
    console.log('  vendor              stock   today: dry on  overdraw     rotation: share  burn/d  rests on');
    r.vendors.forEach((v, i) => {
      const x = a.vendors[i], y = b.vendors[i];
      console.log('  ' + v.name.padEnd(20) + (v.unlimited ? '∞' : String(v.stock)).padStart(5) + coverTxt(x).padStart(15) + (v.unlimited ? '—' : String(Math.max(0, -Math.round(x.left)))).padStart(10)
        + '     ' + `${Math.round(y.share * 100)}%`.padStart(14) + y.burn.toFixed(2).padStart(8) + coverTxt(y).padStart(10));
    });
  }
  console.log(`\nladder at planned rates: $${Math.round(monthToday)}/month at today's fan-out → $${Math.round(monthChosen)}/month at the chosen fan-outs (metered vendors, packs assumed stocked)`);
  console.log('\nrotation is a proposal — the ladder still sends to everyone. The n8n change is written up in docs/FUEL-ROTATION.md.');

  if (budget) {
    const dd = (x) => (Number.isFinite(x) ? Math.round(x) + 'd' : '∞');
    const money = (n) => '$' + n.toFixed(2);
    const line = (p) => '  ' + p.tier.padEnd(4) + p.name.padEnd(20) + String(p.posts).padStart(5) + ' posts' + money(p.cost).padStart(11)
      + (p.installments > 1 ? `  = ${p.installments} × ${money(p.cash)}/mo` : '  paid in full').padEnd(24) + `at $${p.unit.toFixed(2)}/post` + (p.packs ? ` (${p.packs} × offer pack)` : '');
    console.log(`\n=== BUDGET — $${BUDGET} this month, spread over ${budget.days}d (${ASSUME_ROT ? 'ASSUMING the rotation fan-out: ' + Object.entries(FANOUT).map(([t, k]) => `${t}=${Number.isFinite(k) ? k : 'all'}`).join(' ') : 'ladder as it runs today: every fire to every vendor in the tier'}) ===`);
    console.log('off the top:  ' + (budget.fixed.length ? budget.fixed.map((f) => `${f.name} $${f.amount} (${f.why})`).join(' · ') + `   = ${money(budget.fixedTotal)}` : 'nothing'));
    for (const d of debts) console.log(`  deferred:   ${d.name} ${money(d.total)} for ${d.posts} delivered posts — ${d.n} × ${money(d.each)}/month, first on ${d.startsOn}` + (DEBT_DEFER > 0 ? `  (nothing from this month's budget)` : ''));
    const crit = budget.purchases.filter((p) => /CRITICAL$/.test(p.why)), keep = budget.purchases.filter((p) => /^keep/.test(p.why) && !/CRITICAL$/.test(p.why)), fill = budget.purchases.filter((p) => /^full/.test(p.why));
    if (CRITICAL.length) {
      console.log(`must never run out (${CRITICAL.join(', ')}) — funded to day ${budget.days} before anything else:` + (crit.length ? '' : '  already covered'));
      for (const p of crit) console.log(line(p));
    }
    const tgt = (t) => (budget.targets && Number.isFinite(budget.targets[t]) ? budget.targets[t] : budget.days);
    console.log('keep every other tier alive to its target, the one that goes dark first funded first:' + (keep.length ? '' : '  nothing needed'));
    for (const p of keep) console.log(line(p) + `, to day ${tgt(p.tier)}`);
    console.log('full reach with the rest, best reach per dollar first:' + (fill.length ? '' : '  nothing affordable'));
    for (const p of fill) console.log(line(p) + ', ' + p.why.replace(/^full reach on T\d \(/, '').replace(/\)$/, ''));
    for (const u of budget.unfunded) console.log('  ⚠ UNFUNDED  ' + (u.kind === 'vendor' ? `${u.vendor} (${u.tier}) runs out on day ${Math.round(u.cover)}` : `${u.tier} goes dark on day ${Math.round(u.alive)}`)
      + (u.cheapest ? ` — cheapest fix ${u.cheapest.name} ${u.cheapest.posts} posts ${money(u.cheapest.cost)}` : ''));
    console.log(`CASH THIS MONTH ${money(budget.spent + budget.fixedTotal)} of $${BUDGET} · ${money(budget.left)} unspent`);
    console.log(`  posts bought are worth ${money(budget.committed)} — the rest bills monthly, so ${money(budget.nextMonths)}/mo of it repeats until those plans finish.`);
    console.log(`  running obligation if next month buys the same: ${money(budget.spent + budget.fixedTotal + budget.nextMonths)}/mo. Vendors credit unused posts, so overbuying rolls over rather than burning.`);
    console.log('\n  tier   alive today → after      full reach today → after');
    for (const t of rotation.tiers) { const b = budget.before[t.tier], a = budget.after[t.tier]; console.log('  ' + t.tier.padEnd(7) + `${dd(b.alive)} → ${dd(a.alive)}`.padEnd(25) + `${dd(b.full)} → ${dd(a.full)}`); }
    console.log('\nalive = a network in the tier still has posts · full reach = every network does · retainers keep T0 alive for nothing');
    if (menu) {
      const fmtR = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : Math.round(n / 1e3) + 'k');
      const cell = (x) => (x == null ? '—' : x === 0 ? 'free' : '$' + Math.round(x));
      const protectedTiers = new Set(rotation.tiers.filter((t) => t.vendors.some((v) => CRITICAL.includes(v.name))).map((t) => t.tier));
      const worst = trimOrder(menu).filter((m) => !protectedTiers.has(m.tier));
      console.log('\nTRIM MENU — what it costs to keep each tier ALIVE to a shorter target. "free" = its own stock already carries it.');
      console.log('  tier   reach/fire   $/fire   own stock   ' + menu[0].at.map((a) => `${a.days}d`.padStart(7)).join('') + '   value');
      for (const m of menu) {
        const rank = worst.findIndex((w) => w.tier === m.tier);
        const tag = protectedTiers.has(m.tier) ? `PROTECTED — ${m.vendors || CRITICAL.filter((c) => rotation.tiers.find((t) => t.tier === m.tier).vendors.some((v) => v.name === c)).join(' + ')} must stay alive`
          : m.price === 0 ? 'free — never trim' : rank === 0 ? '← WORST reach/$, trim here first' : rank === 1 ? '← next to trim' : `${Math.round(m.reach / m.price / 1e3)}k reach per $`;
        console.log('  ' + m.tier.padEnd(7) + fmtR(m.reach).padStart(9) + ('$' + m.price.toFixed(2)).padStart(9)
          + (Number.isFinite(m.stockDays) ? Math.round(m.stockDays) + 'd' : '∞').padStart(11) + '   '
          + m.at.map((a) => cell(a.alive).padStart(7)).join('') + '   ' + tag);
      }
      console.log('  the ladder is cumulative — a post that earns T5 already fired T0..T4 — so a tier whose reach a cheaper');
      console.log('  tier delivers on the same post, with months of its own stock, is the honest place to trim.');
      if (AUTO_TRIM && budget.trail && budget.trail.length) console.log('  auto-trim took: ' + budget.trail.map((x) => `${x.tier}→${x.to}d ${x.was === 'short' ? '(could not afford 30d; its own stock covers this)' : `(frees $${Math.round(x.frees)})`}`).join(', ') + `  ·  protected: ${budget.protectedTiers.join(', ') || 'none'}`);
      else if (AUTO_TRIM) console.log('  auto-trim: no trim needed.');
    }
    if (budgetRot && !ASSUME_ROT) {
      const cost = (p) => p.purchases.filter((x) => /CRITICAL$/.test(x.why)).reduce((s, x) => s + x.cost, 0);
      const dark = (p) => p.unfunded.length ? p.unfunded.map((u) => u.vendor || u.tier).join(', ') : 'nothing';
      console.log(`\nwhat the "${CRITICAL.join(' + ')} always alive" guarantee costs:`);
      console.log(`  today's ladder (every fire to every vendor):  ${money(cost(budget))}   ·  left unfunded: ${dark(budget)}`);
      console.log(`  under the rotation fan-out in docs/FUEL-ROTATION.md: ${money(cost(budgetRot))}   ·  left unfunded: ${dark(budgetRot)}`);
      console.log('  same promise, because two vendors that alternate need half the posts between them to make the month.');
    }
  }

  if (process.argv.includes('--apply')) {
    const spentBy = {}, noteBy = {}, postsBy = {};
    if (budget) {
      for (const f of budget.fixed) { spentBy[f.name] = (spentBy[f.name] || 0) + f.amount; (noteBy[f.name] ||= []).push(f.why); }
      for (const p of budget.purchases) { spentBy[p.name] = (spentBy[p.name] || 0) + p.cost; postsBy[p.name] = (postsBy[p.name] || 0) + p.posts; (noteBy[p.name] ||= []).push(`${p.posts} posts — ${p.why}`); }
      // A deferred debt takes nothing from this month but is still a commitment — say so on the row
      // rather than leaving it reading as "nothing this month".
      if (DEBT_DEFER > 0) for (const d of debts) (noteBy[d.name] ||= []).push(`debt deferred: $${d.total} over ${d.n} months, first on ${d.startsOn}`);
      for (const u of budget.unfunded) if (u.vendor) (noteBy[u.vendor] ||= []).push(`UNFUNDED this month — needs $${u.cheapest.cost.toFixed(2)}`);
    }
    const stamp = new Date(now).toISOString();
    const out = rows.map((r) => ({
      Vendor: r.vendor, 'Supply Status': r.status, 'Plan (posts/day)': round2(r.demand), 'Measured (posts/day)': round2(r.measured), Sigma: round2(r.sd),
      'Safety Stock': Math.round(r.safety), 'Reorder Point': Math.round(r.rop), 'Days Cover': Number.isFinite(r.daysCover) ? Math.round(r.daysCover) : null,
      'Order Now (posts)': r.order, 'Order Cost': round2(r.order * r.price), 'Cash Held': round2(r.cash),
      'Budget This Month': budget ? round2(spentBy[r.vendor] || 0) : null, 'Budget Posts': budget ? (postsBy[r.vendor] || 0) : null,
      'Budget Note': budget ? (noteBy[r.vendor] || ['nothing this month']).join('; ').slice(0, 250) : null, 'Supply Updated': stamp,
    }));
    for (const v of deals.vendors.filter((x) => x.deal === 'unlimited')) out.push({ Vendor: v.name, 'Budget This Month': budget ? round2(spentBy[v.name] || 0) : null, 'Budget Note': budget ? (noteBy[v.name] || ['unlimited, nothing to buy']).join('; ') : null, 'Supply Updated': stamp });
    await airtable(env, env.REGISTRY_BASE_ID).upsert('RT Usage', 'Vendor', out);
    console.log(`\nwrote the supply columns for ${out.length} vendors into RT Usage`);
  } else console.log('\n(no --apply — nothing written to Airtable)');

  // The alert the operator asked for (2026-09-06): a Telegram note whenever a vendor is at or past
  // its reorder point. Posts only then — a quiet day sends nothing.
  // Since 2026-10-06 it posts only when a vendor newly reaches a status (alert-delta.mjs): the same
  // board went out 30 of 30 days. --always sends the full board regardless.
  const alert = rows.filter((r) => r.status === 'OUT' || r.status === 'REORDER' || r.status === 'SOON');
  const alertKeys = alert.map((r) => `${r.vendor}:${r.status}`).sort();
  const delta = alertDelta(lastLog('vendor-supply')?.alertKeys, alertKeys);
  if (process.argv.includes('--send')) {
    if (alert.length && !delta.changed && !process.argv.includes('--always')) console.log(`\n(--send: the same ${alert.length} vendor(s) as last run — nothing sent)`);
    else if (alert.length) {
      const pad = (v, n) => String(v).padEnd(n).slice(0, n), padL = (v, n) => String(v).padStart(n);
      const tbl = alert.map((r) => `${pad(r.vendor, 14)}${padL(r.stock, 5)}${padL(Number.isFinite(r.daysCover) ? Math.round(r.daysCover) + 'd' : '—', 6)}  ${pad(r.status, 8)}${padL(r.order || '—', 5)}`).join('\n');
      const bud = budget ? `\n💸 $${BUDGET} this month → ${budget.purchases.map((p) => `${p.name} ${p.posts}`).join(', ') || 'no purchase fits'}${budget.unfunded.length ? ` · unfunded: ${budget.unfunded.map((u) => u.tier).join(', ')}` : ''}` : '';
      const text = `⚠️ <b>RT supply · ${alert.length} vendor${alert.length === 1 ? '' : 's'} at or past the reorder point</b>\n<pre>vendor         left cover  status  order\n${esc(tbl)}</pre>\n📦 $${cost.toFixed(0)} brings ${need.map((r) => r.vendor).join(', ') || 'them'} to ${coverDays}d cover${esc(bud)}\n\n👉 <code>node vendor-supply.mjs</code> · the RT Usage table in Airtable has the full board`;
      await telegram(env, text, 'fuel');
      console.log(`\nsent the reorder alert for ${alert.length} vendors to the Fuel topic`);
    } else console.log('\n(--send: no vendor at or past a reorder point — nothing sent)');
  }

  await logRun('vendor-supply', { vendors: rows.length, reorder: need.length, orderCost: Number(cost.toFixed(2)), fleet: factors.fleet ?? null, baseFleet: factors.baseFleet ?? null, buffer: factors.buffer ?? null, budget: BUDGET || null, budgetSpent: budget ? round2(budget.spent + budget.fixedTotal) : null, alerted: process.argv.includes('--send') && (delta.changed || process.argv.includes('--always')) ? alert.length : 0, alertKeys });
}, 'vendor-supply');
