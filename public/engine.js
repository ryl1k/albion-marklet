// Profit engine: pure functions over (items, market snapshot, settings). Runs in the browser
// and in Node (tests).

export const ROYAL = ['Bridgewatch', 'Fort Sterling', 'Lymhurst', 'Martlock', 'Thetford'];
export const CITIES = [...ROYAL, 'Caerleon', 'Brecilien'];
export const BM = 'Black Market';

// City production bonuses (Albion wiki / Local Production Bonus). Single source for both the
// return-rate maths and the City Bonuses tab.
const sub = (...names) => (it) => names.includes(it.s);
export const CITY_BONUSES = {
  'Fort Sterling': {
    biome: 'Mountain',
    refine: { s2: 'planks', label: 'Planks', from: 'Wood' },
    craft: [['Hammers', sub('hammer')], ['Spears', sub('spear')], ['Holy staffs', sub('holystaff')], ['Cloth armor', sub('cloth_armor')], ['Plate helmets', sub('plate_helmet')]],
  },
  Lymhurst: {
    biome: 'Forest',
    refine: { s2: 'cloth', label: 'Cloth', from: 'Fiber' },
    craft: [['Swords', sub('sword')], ['Bows', sub('bow')], ['Arcane staffs', sub('arcanestaff')], ['Leather hoods', sub('leather_helmet')], ['Leather shoes', sub('leather_shoes')]],
  },
  Bridgewatch: {
    biome: 'Steppe',
    refine: { s2: 'stoneblock', label: 'Stone blocks', from: 'Stone' },
    craft: [['Crossbows', sub('crossbow')], ['Daggers', sub('dagger')], ['Cursed staffs', sub('cursestaff')], ['Plate armor', sub('plate_armor')], ['Cloth sandals', sub('cloth_shoes')]],
  },
  Martlock: {
    biome: 'Highland',
    refine: { s2: 'leather', label: 'Leather', from: 'Hide' },
    craft: [['Axes', sub('axe')], ['Quarterstaffs', sub('quarterstaff')], ['Frost staffs', sub('froststaff')], ['Plate boots', sub('plate_shoes')], ['Off-hands', (it) => it.c === 'offhands']],
  },
  Thetford: {
    biome: 'Swamp',
    refine: { s2: 'metalbars', label: 'Metal bars', from: 'Ore' },
    craft: [['Maces', sub('mace')], ['Nature staffs', sub('naturestaff')], ['Fire staffs', sub('firestaff')], ['Leather armor', sub('leather_armor')], ['Cloth cowls', sub('cloth_helmet')]],
  },
  Caerleon: {
    biome: 'Red zone city',
    refine: null,
    craft: [['Food', sub('food')], ['Gathering gear & tools', (it) => it.c === 'gathering'], ['War gloves', sub('knuckles')]],
  },
  Brecilien: {
    biome: 'Mists city',
    refine: null,
    craft: [['Capes', (it) => it.c === 'capes'], ['Bags', (it) => it.c === 'bags'], ['Potions', sub('potions')]],
  },
};
export const BONUS = { base: 0.18, refine: 0.4, craft: 0.15, focus: 0.59 };

export const DEFAULT_SETTINGS = {
  server: 'europe',
  premium: true,
  setupFee: 2.5, // % charged when placing any market order
  buyMode: 'instant', // 'instant' = buy from sell orders, 'order' = place buy order at top+1
  sellMode: 'order', // 'order' = list at lowest-1, 'instant' = fill best buy order
  matSource: 'best', // 'local' = buy materials in crafting city, 'best' = cheapest city
  sellWhere: 'best', // 'local' = sell in crafting city, 'best' = best city (incl. Black Market)
  useFocus: false,
  dailyBonus: 0, // % production bonus of the day (10 or 20 on bonus days)
  stationFee: 400, // silver per 100 nutrition
  maxAgeHours: 24, // ignore prices older than this
  maxGapHours: 4, // order flips: buy and sell side must be seen within this many hours of each other
  bmMaxAgeHours: 6, // Black Market buy orders churn fast; ignore older ones
  spikeCap: 30, // cap sale price at 7-day avg + this % (0 = off)
  marketShare: 10, // % of an item's daily traded volume you can realistically capture
  minVolume: 3, // items/day traded in the selling market
  minProfit: 0,
  includeCaerleon: true, // allow Caerleon (red-zone routes) in transport and Black Market sourcing
  includeBrecilien: true, // allow Brecilien (reached through the Mists) the same way
  transportFrom: '', // transport: only buy in this city ('' = any)
  transportTo: '', // transport: only sell in this city ('' = any)
  priceBand: 2, // % band around your sell price for the days-to-sell estimate
  buyRange: 3, // transport depth: buy every listing up to lowest + this %
  bookMaxAgeHours: 3, // ignore order-book listings not seen within this many hours
  scorePreset: 'balanced', // smart score weighting: 'balanced' | 'safe' | 'profit'
};

export const taxRate = (s) => (s.premium ? 0.04 : 0.08);

export function returnRate(bonus) {
  return bonus / (1 + bonus);
}

export function craftBonus(it, city, s) {
  const cb = CITY_BONUSES[city];
  let b = BONUS.base + (s.dailyBonus || 0) / 100;
  if (it.s === 'refinedresources') {
    if (cb?.refine?.s2 === it.s2) b += BONUS.refine;
  } else if (cb?.craft.some(([, match]) => match(it))) b += BONUS.craft;
  if (s.useFocus) b += BONUS.focus;
  return b;
}

// ---------- market access ----------
export class Market {
  constructor(snapshot, settings, nowSec = Date.now() / 1000) {
    this.locations = snapshot.locations;
    this.now = nowSec;
    this.minTime = nowSec - settings.maxAgeHours * 3600;
    this.p = new Map(); // id -> Map(loc -> Map(q -> {sell, sellAt, buy, buyAt}))
    this.h = new Map(); // id -> Map(loc -> {vol, byQ: Map(q -> {vol, avg})})
    for (const [id, rows] of Object.entries(snapshot.prices ?? {})) {
      const m = new Map();
      for (const [li, q, sell, sellAt, buy, buyAt] of rows) {
        const loc = this.locations[li];
        if (!loc) continue;
        if (!m.has(loc)) m.set(loc, new Map());
        m.get(loc).set(q, { sell, sellAt, buy, buyAt });
      }
      this.p.set(id, m);
    }
    for (const [id, rows] of Object.entries(snapshot.history ?? {})) {
      const m = new Map();
      for (const [li, q, vol, avg, days, hist] of rows) {
        const loc = this.locations[li];
        if (!loc) continue;
        if (!m.has(loc)) m.set(loc, { vol: 0, byQ: new Map() });
        const e = m.get(loc);
        e.vol += vol;
        e.byQ.set(q, { vol, avg, days, hist });
      }
      this.h.set(id, m);
    }
    this.hasHistory = this.h.size > 0;
  }
  row(id, loc, q) {
    return this.p.get(id)?.get(loc)?.get(q);
  }
  /** Lowest fresh sell order (what you pay to buy instantly), or 0. */
  sellMin(id, loc, q = 1) {
    const r = this.row(id, loc, q);
    return r && r.sell > 0 && r.sellAt >= this.minTime ? r.sell : 0;
  }
  /** Highest fresh buy order (what you get selling instantly), or 0. */
  buyMax(id, loc, q = 1) {
    const r = this.row(id, loc, q);
    return r && r.buy > 0 && r.buyAt >= this.minTime ? r.buy : 0;
  }
  sellAt(id, loc, q = 1) {
    return this.row(id, loc, q)?.sellAt ?? 0;
  }
  buyAt(id, loc, q = 1) {
    return this.row(id, loc, q)?.buyAt ?? 0;
  }
  /** Hours since a unix timestamp (seconds). */
  ageHours(at) {
    return at ? (this.now - at) / 3600 : null;
  }
  /** Average items traded per day (all qualities, or one quality). */
  volume(id, loc, q) {
    const e = this.h.get(id)?.get(loc);
    if (!e) return 0;
    return q == null ? e.vol : e.byQ.get(q)?.vol ?? 0;
  }
  /**
   * Items/day sold within ±band of `price`, from the hourly price histogram (hours whose
   * average sale price fell in the band). null when there is no hourly history.
   */
  nearVolume(id, loc, q, price, band) {
    const e = this.h.get(id)?.get(loc)?.byQ.get(q);
    if (!e?.hist || !e.avg || !price) return null;
    let sum = 0;
    for (let i = 0; i < e.hist.length; i += 2) {
      const p = e.avg * (1 + e.hist[i] / 100);
      if (p >= price * (1 - band) && p <= price * (1 + band)) sum += e.hist[i + 1];
    }
    return Math.round(sum * 10) / 10;
  }
  /** Days (of the last 7) with recorded trades. */
  historyDays(id, loc, q = 1) {
    return this.h.get(id)?.get(loc)?.byQ.get(q)?.days ?? 0;
  }
  avgPrice(id, loc, q = 1) {
    return this.h.get(id)?.get(loc)?.byQ.get(q)?.avg ?? 0;
  }
  /**
   * Top buy order, ignoring lowball orders (< half the 7-day average or current lowest sell)
   * that nobody will ever fill.
   */
  realisticBuy(id, loc, q = 1) {
    const buy = this.buyMax(id, loc, q);
    const ref = this.avgPrice(id, loc, q) || this.sellMin(id, loc, q);
    return buy && (!ref || buy >= ref * 0.5) ? buy : 0;
  }
}

// ---------- pricing primitives ----------
/** Silver paid per unit to acquire an item in a city, plus when that price was seen; null if none. */
export function acquire(mk, id, loc, s, q = 1) {
  const sell = mk.sellMin(id, loc, q);
  if (s.buyMode === 'order') {
    const buy = mk.realisticBuy(id, loc, q);
    if (buy > 0) {
      const viaOrder = (buy + 1) * (1 + s.setupFee / 100);
      if (!(sell > 0 && sell < viaOrder)) return { price: viaOrder, at: mk.buyAt(id, loc, q) };
    }
  }
  return sell > 0 ? { price: sell, at: mk.sellAt(id, loc, q) } : null;
}

export function acquireCost(mk, id, loc, s, q = 1) {
  return acquire(mk, id, loc, s, q)?.price ?? 0;
}

/** Net silver received per unit selling in a location, after fees. */
export function saleValue(mk, id, loc, s, q = 1, mode = s.sellMode) {
  const tax = taxRate(s);
  if (loc === BM || mode === 'instant') {
    // The Black Market only has buy orders: sell into them instantly (tax only).
    const buy = mk.buyMax(id, loc, q);
    return buy > 0 ? { net: buy * (1 - tax), gross: buy, capped: false, at: mk.buyAt(id, loc, q) } : null;
  }
  let gross = mk.sellMin(id, loc, q);
  if (!gross) return null;
  gross = Math.max(1, gross - 1);
  let capped = false;
  const avg = mk.avgPrice(id, loc, q);
  if (s.spikeCap > 0 && avg > 0 && gross > avg * (1 + s.spikeCap / 100)) {
    gross = avg * (1 + s.spikeCap / 100);
    capped = true;
  }
  return { net: gross * (1 - tax - s.setupFee / 100), gross, capped, at: mk.sellAt(id, loc, q), order: true };
}

function cheapest(mk, id, cities, s, q = 1) {
  let best = null;
  for (const c of cities) {
    const a = acquire(mk, id, c, s, q);
    if (a && (!best || a.price < best.price)) best = { ...a, city: c };
  }
  return best;
}

/** Whether a market trades enough of the item to count (always true before history loads). */
export function liquid(mk, id, loc, s, q) {
  return !mk.hasHistory || mk.volume(id, loc, q) >= s.minVolume;
}

/**
 * Daily volume, plus items/day sold near your listing price (sell orders only) for the
 * days-to-sell estimate.
 */
function volumeAtPrice(mk, id, loc, q, sale, s) {
  const total = mk.volume(id, loc, q);
  if (!sale.order) return { volume: total, nearVolume: null };
  const near = mk.nearVolume(id, loc, q, sale.gross, s.priceBand / 100);
  return { volume: total, nearVolume: near };
}

export const cityAllowed = (c, s) => (c !== 'Caerleon' || s.includeCaerleon) && (c !== 'Brecilien' || s.includeBrecilien);

function bestSale(mk, id, cities, s) {
  let best = null;
  for (const c of cities) {
    if (!liquid(mk, id, c, s)) continue;
    const v = saleValue(mk, id, c, s);
    if (v && (!best || v.net > best.net)) best = { ...v, city: c };
  }
  return best;
}

// ---------- crafting / refining ----------
/** Evaluate one recipe crafted in `city`. Returns null when a price is missing. */
export function evalCraft(mk, items, id, recipe, city, s, opts = {}) {
  const it = items[id];
  const settings = opts.focus == null ? s : { ...s, useFocus: opts.focus };
  const rrr = returnRate(craftBonus(it, city, settings));
  const matCities = s.matSource === 'local' ? [city] : CITIES;
  const mats = [];
  let matCost = 0;
  for (const [ing, count, returnable] of recipe.i) {
    const src = cheapest(mk, ing, matCities, s);
    if (!src) return null;
    const effective = count * (returnable ? 1 - rrr : 1);
    matCost += src.price * effective;
    mats.push({ id: ing, count, returnable, price: src.price, city: src.city, effective, at: src.at });
  }
  const fee = (it.v || 0) * recipe.a * 0.1125 * (s.stationFee / 100);
  const costPerUnit = (matCost + fee + (recipe.s || 0)) / recipe.a;
  const sale = opts.sale ?? bestSale(mk, id, s.sellWhere === 'local' ? [city] : [...CITIES, BM], s);
  if (!sale) return null;
  const profit = sale.net - costPerUnit;
  // Age of the oldest price this result depends on.
  const age = mk.ageHours(Math.min(sale.at, ...mats.map((m) => m.at)));
  return { city, rrr, mats, age, fee: fee / recipe.a, cost: costPerUnit, sale, profit, margin: profit / costPerUnit, recipe };
}

/** Best (city, recipe) for every craftable item matching `filter`. */
export function analyzeCrafting(mk, items, s, filter) {
  const out = [];
  const share = s.marketShare / 100;
  for (const [id, it] of Object.entries(items)) {
    if (!it.r.length || !filter(it, id)) continue;
    let best = null;
    for (const recipe of it.r) {
      for (const city of CITIES) {
        const r = evalCraft(mk, items, id, recipe, city, s);
        if (r && (!best || r.profit > best.profit)) best = r;
      }
    }
    if (!best) continue;
    // Crafting volume is summed over all qualities (crafts roll random quality).
    const vol = { volume: mk.volume(id, best.sale.city), nearVolume: best.sale.order ? mk.nearVolume(id, best.sale.city, 1, best.sale.gross, s.priceBand / 100) : null };
    // Silver earned per focus point: extra profit focus brings, divided by its focus cost.
    let silverPerFocus = null;
    if (best.recipe.f > 0) {
      const sale = best.sale;
      const withF = evalCraft(mk, items, id, best.recipe, best.city, s, { focus: true, sale });
      const noF = evalCraft(mk, items, id, best.recipe, best.city, s, { focus: false, sale });
      if (withF && noF) silverPerFocus = ((withF.profit - noF.profit) * best.recipe.a) / best.recipe.f;
    }
    out.push({
      id, item: it, ...best, ...vol, silverPerFocus,
      daily: best.profit * vol.volume * share,
    });
  }
  return out;
}

// ---------- flips ----------
/** Buy in a city, sell to the Black Market's buy orders. */
export function analyzeBlackMarket(mk, items, s) {
  const out = [];
  const share = s.marketShare / 100;
  const tax = taxRate(s);
  const sources = CITIES.filter((c) => cityAllowed(c, s));
  for (const [id, it] of Object.entries(items)) {
    if (!mk.p.get(id)?.has(BM)) continue;
    for (const q of [1, 2, 3]) {
      const bm = mk.buyMax(id, BM, q);
      if (!bm || !liquid(mk, id, BM, s, q)) continue;
      const bmAt = mk.buyAt(id, BM, q);
      if (mk.ageHours(bmAt) > s.bmMaxAgeHours) continue;
      const src = cheapest(mk, id, sources, s, q);
      if (!src) continue;
      const net = bm * (1 - tax);
      const profit = net - src.price;
      const vol = mk.volume(id, BM, q);
      out.push({ id, item: it, q, buyCity: src.city, cost: src.price, sell: bm, net, profit, margin: profit / src.price, volume: vol, daily: profit * vol * share, age: mk.ageHours(Math.min(bmAt, src.at)) });
    }
  }
  return out;
}

/** Buy in city A, haul, sell in city B. */
export function analyzeTransport(mk, items, s) {
  const out = [];
  const share = s.marketShare / 100;
  const cities = CITIES.filter((c) => cityAllowed(c, s));
  const fromCities = s.transportFrom ? cities.filter((c) => c === s.transportFrom) : cities;
  const toCities = s.transportTo ? cities.filter((c) => c === s.transportTo) : cities;
  for (const [id, it] of Object.entries(items)) {
    const locs = mk.p.get(id);
    if (!locs) continue;
    const qs = new Set();
    for (const m of locs.values()) for (const q of m.keys()) qs.add(q);
    for (const q of qs) {
      let best = null;
      for (const a of fromCities) {
        const src = acquire(mk, id, a, s, q);
        if (!src) continue;
        const cost = src.price;
        for (const b of toCities) {
          if (a === b || !liquid(mk, id, b, s, q)) continue;
          const sale = saleValue(mk, id, b, s, q);
          if (!sale) continue;
          const profit = sale.net - cost;
          if (!best || profit > best.profit) best = { from: a, to: b, cost, sale, profit, fromLowest: mk.sellMin(id, a, q), age: mk.ageHours(Math.min(src.at, sale.at)) };
        }
      }
      if (!best) continue;
      const vol = volumeAtPrice(mk, id, best.to, q, best.sale, s);
      out.push({
        id, item: it, q, ...best, margin: best.profit / best.cost,
        perKg: it.w > 0 ? best.profit / it.w : null, ...vol, daily: best.profit * vol.volume * share,
      });
    }
  }
  return out;
}

/** Same-city order flip: place a buy order at top+1, relist at lowest-1. */
export function analyzeStationFlip(mk, items, s) {
  const out = [];
  const share = s.marketShare / 100;
  const tax = taxRate(s);
  const fee = s.setupFee / 100;
  for (const [id, it] of Object.entries(items)) {
    const locs = mk.p.get(id);
    if (!locs) continue;
    for (const [city, byQ] of locs) {
      if (city === BM) continue;
      for (const q of byQ.keys()) {
        const buy = mk.realisticBuy(id, city, q);
        const sell = mk.sellMin(id, city, q);
        if (!buy || !sell || sell <= buy || !liquid(mk, id, city, s, q)) continue;
        // Both sides of the spread must have been seen at about the same time.
        const sellAt = mk.sellAt(id, city, q);
        const buyAt = mk.buyAt(id, city, q);
        if (Math.abs(sellAt - buyAt) > s.maxGapHours * 3600) continue;
        const cost = (buy + 1) * (1 + fee);
        let gross = sell - 1;
        const avg = mk.avgPrice(id, city, q);
        let capped = false;
        if (s.spikeCap > 0 && avg > 0 && gross > avg * (1 + s.spikeCap / 100)) {
          gross = avg * (1 + s.spikeCap / 100);
          capped = true;
        }
        const net = gross * (1 - tax - fee);
        const profit = net - cost;
        const vol = volumeAtPrice(mk, id, city, q, { order: true, gross }, s);
        out.push({ id, item: it, q, city, buy, sell, cost, net, capped, profit, margin: profit / cost, ...vol, daily: profit * vol.volume * share, age: mk.ageHours(Math.min(sellAt, buyAt)) });
      }
    }
  }
  return out;
}

export const isRefining = (it) => it.c === 'crafting' && it.s === 'refinedresources';
export const isCrafting = (it) => !(it.c === 'crafting' && it.s === 'refinedresources');

// ---------- smart score ----------
// A 0-100 rating that weighs how much an opportunity earns against how likely it is to
// actually work: can you sell the volume, are the prices fresh and normal, how risky is the trip.

export const SCORE_PRESETS = {
  balanced: { profit: 0.25, margin: 0.15, liquidity: 0.2, freshness: 0.15, stability: 0.15, risk: 0.1 },
  safe: { profit: 0.1, margin: 0.2, liquidity: 0.25, freshness: 0.15, stability: 0.2, risk: 0.1 },
  profit: { profit: 0.45, margin: 0.1, liquidity: 0.15, freshness: 0.1, stability: 0.1, risk: 0.1 },
};

export const SCORE_PARTS = {
  profit: 'Daily profit potential',
  margin: 'Margin (buffer against price moves)',
  liquidity: 'Liquidity (how fast it sells)',
  freshness: 'Price freshness',
  stability: 'Price vs 7-day average',
  risk: 'Strategy risk',
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));
// Maps log10(x) linearly from [lo, hi] onto [0, 1].
const logScale = (x, lo, hi) => (x > 0 ? clamp01((Math.log10(x) - lo) / (hi - lo)) : 0);

/** 1 when a price matches its 7-day average, 0 at 50%+ away; 0.5 when there is no history. */
function priceSanity(mk, id, loc, q, price) {
  const avg = mk.avgPrice(id, loc, q);
  if (!avg || !price) return { score: 0.5, days: 0 };
  return { score: 1 - clamp01(Math.abs(price / avg - 1) / 0.5), days: mk.historyDays(id, loc, q) };
}

function stabilityFor(mk, kind, r) {
  const q = r.q ?? 1;
  let sell;
  let buy;
  if (kind === 'refining' || kind === 'crafting') {
    sell = priceSanity(mk, r.id, r.sale.city, 1, r.sale.gross);
    // Materials: cost-weighted sanity of each ingredient's price.
    let total = 0;
    let acc = 0;
    let days = 7;
    for (const m of r.mats) {
      const w = m.price * m.effective;
      const ps = priceSanity(mk, m.id, m.city, 1, m.price);
      acc += ps.score * w;
      total += w;
      if (ps.days) days = Math.min(days, ps.days);
    }
    buy = { score: total ? acc / total : 0.5, days };
  } else if (kind === 'blackmarket') {
    sell = priceSanity(mk, r.id, BM, q, r.sell);
    buy = priceSanity(mk, r.id, r.buyCity, q, r.cost);
  } else if (kind === 'transport') {
    sell = priceSanity(mk, r.id, r.to, q, r.sale.gross);
    buy = priceSanity(mk, r.id, r.from, q, r.cost);
  } else {
    sell = priceSanity(mk, r.id, r.city, q, r.sell);
    buy = priceSanity(mk, r.id, r.city, q, r.buy);
  }
  // Trust the averages less when the item traded on only a few of the last 7 days.
  const coverage = clamp01(Math.max(sell.days, 1) / 7);
  let score = Math.min(sell.score, buy.score) * (0.5 + 0.5 * coverage);
  if (r.sale?.capped || r.capped) score *= 0.6;
  return score;
}

function riskFor(kind, r) {
  const touchesCaerleon = [r.from, r.to, r.buyCity, r.sale?.city, ...(r.mats ?? []).map((m) => m.city)].includes('Caerleon');
  switch (kind) {
    case 'refining':
    case 'crafting':
      // Hauling materials or products through the red zone, or selling to the Black Market.
      return r.sale.city === BM ? 0.7 : touchesCaerleon ? 0.8 : 1;
    case 'blackmarket':
      return r.buyCity === 'Caerleon' ? 0.8 : 0.6; // royal city -> Caerleon crosses the red zone
    case 'transport':
      return touchesCaerleon ? 0.6 : 0.9;
    default:
      return 0.85; // order flips: no travel, but capital sits in orders and can be undercut
  }
}

/** Score one result row. `kind` is the strategy (refining, crafting, blackmarket, transport, flip). */
export function smartScore(mk, s, kind, r) {
  let profit = logScale(r.daily, 4, 7); // 10k/day -> 0, 10m/day -> 1
  // A haul is limited by carry weight, so transport also needs good silver per kg.
  if (kind === 'transport') profit = (profit + logScale(r.perKg ?? 0, 1, 3.5)) / 2; // 10/kg -> 0, ~3k/kg -> 1
  let margin = Math.sqrt(clamp01(r.margin / 0.4)); // 10% -> 0.5, 40%+ -> 1
  if (r.margin > 1) margin *= Math.max(0.6, 1 - (r.margin - 1) / 4); // too good to be true: usually bad data
  const parts = {
    profit,
    margin,
    liquidity: logScale(r.volume, 0, 3.5), // 1/day -> 0, ~3k/day -> 1
    freshness: r.age == null ? 0.3 : Math.exp(-Math.max(0, r.age) / 8), // 1h 0.88, 6h 0.47, 20h 0.08
    stability: stabilityFor(mk, kind, r),
    risk: riskFor(kind, r),
  };
  const w = SCORE_PRESETS[s.scorePreset] ?? SCORE_PRESETS.balanced;
  let score = 0;
  for (const k of Object.keys(w)) score += w[k] * parts[k];
  // Gates: a price far from its average, or very stale data, drags the whole score down
  // no matter how good the other numbers look.
  score *= 0.55 + 0.45 * clamp01(parts.stability / 0.5);
  score *= 0.7 + 0.3 * clamp01(parts.freshness / 0.3);
  return { score: Math.round(score * 100), parts };
}

// ---------- order-book depth (transport range buying) ----------
/** Buy every listing (asks sorted cheapest first, [price, qty, seen]) priced up to maxPrice. */
export function walkAsks(levels, maxPrice) {
  let qty = 0;
  let cost = 0;
  let newest = 0;
  for (const [price, amount, seen] of levels) {
    if (price > maxPrice) break;
    qty += amount;
    cost += price * amount;
    newest = Math.max(newest, seen ?? 0);
  }
  return { qty, cost, avg: qty ? cost / qty : 0, newest };
}

/** Sell up to qty instantly into buy orders (bids sorted highest first). Gross silver, before tax. */
export function walkBids(levels, qty) {
  let filled = 0;
  let gross = 0;
  for (const [price, amount] of levels) {
    if (filled >= qty) break;
    const take = Math.min(amount, qty - filled);
    filled += take;
    gross += take * price;
  }
  return { filled, gross };
}

/**
 * Range buy for a transport row: buy all listings in `from` up to maxPrice, then sell in `to`.
 * `book(id, loc, q, side)` returns ladder levels or undefined. null when no listings were seen.
 */
export function rangeTrade(r, book, s, maxPrice) {
  const asks = book(r.id, r.from, r.q, 'o');
  if (!asks?.length) return null;
  const best = asks[0][0];
  const limit = maxPrice ?? best * (1 + s.buyRange / 100);
  const buy = walkAsks(asks, limit);
  const tax = taxRate(s);
  // Selling with a sell order at the destination (lowest - 1, after tax and setup fee).
  const listNet = r.sale.net;
  const listProfit = buy.qty * listNet - buy.cost;
  // Only the listings cheaper than what one unit nets you are worth buying.
  const worth = walkAsks(asks, Math.min(limit, listNet));
  // Selling instantly into the destination's buy orders.
  const bids = book(r.id, r.to, r.q, 'r') ?? [];
  const inst = walkBids(bids, buy.qty);
  const instantProfit = inst.filled ? inst.gross * (1 - tax) - inst.filled * buy.avg : null;
  const perDay = (r.nearVolume || r.volume) * (s.marketShare / 100);
  return {
    best, limit, ...buy,
    // The REST snapshot knows a cheaper listing than the stream has shown us: depth is incomplete.
    partial: r.fromLowest > 0 && best > r.fromLowest * 1.001,
    listProfit, worthQty: worth.qty, worthProfit: worth.qty * listNet - worth.cost,
    instantFilled: inst.filled, instantProfit,
    daysToSell: perDay > 0 ? buy.qty / perDay : null,
    asks, bids,
  };
}
