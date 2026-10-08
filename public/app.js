import {
  DEFAULT_SETTINGS, CITIES, BM, Market, analyzeCrafting, analyzeBlackMarket, analyzeTransport,
  analyzeStationFlip, evalCraft, isRefining, isCrafting, craftBonus, returnRate,
  smartScore, SCORE_PARTS, SCORE_PRESETS, rangeTrade, CITY_BONUSES, BONUS,
} from './engine.js';

const $ = (sel) => document.querySelector(sel);
const PAGE = 200;

// ---------- settings ----------
function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('marklet.settings') || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  try { localStorage.setItem('marklet.settings', JSON.stringify(settings)); } catch {}
}

let settings = loadSettings();
let items = null;
let snapshot = null;
let market = null;
let results = {};
let tab = 'overview';
let sort = { key: 'score', dir: -1 };
let shown = PAGE;
let rows = [];
let ladders = new Map(); // "id|loc|q|o/r" -> [[price, qty, seenSec], ...]
let bookStats = null;
const bookFn = (id, loc, q, side) => ladders.get(`${id}|${loc}|${q}|${side}`);

// ---------- formatting ----------
const fmt = (n) => {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'm';
  if (a >= 1e4) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'k';
  return Math.round(n).toLocaleString('en-US');
};
const exact = (n) => (n == null || !isFinite(n) ? '—' : Math.round(n).toLocaleString('en-US'));
const pct = (n) => (n == null || !isFinite(n) ? '—' : (n * 100).toFixed(n > 10 ? 0 : 1) + '%');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ago = (ms) => {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${(m / 60).toFixed(1)} h ago`;
};
const icon = (id, q = 1) => `<img class="ico" loading="lazy" src="https://render.albiononline.com/v1/item/${encodeURIComponent(id)}.png?size=64&quality=${q}" alt="">`;
const tierLabel = (it) => `${it.t}.${it.e}`;
const QUALITY = ['', 'Normal', 'Good', 'Outstanding', 'Excellent', 'Masterpiece'];
const ageText = (h) => (h == null ? '—' : h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : `${h.toFixed(h < 10 ? 1 : 0)}h`);
const ageCol = { key: 'age', label: 'Age', num: true, sort: (r) => -(r.age ?? 99), render: (r) => `<span class="${r.age > 6 ? 'stale' : ''}" title="Age of the oldest price used">${ageText(r.age)}</span>` };
const scoreClass = (v) => (v >= 70 ? 'hi' : v >= 50 ? 'mid' : 'lo');
const scoreTitle = (r) => Object.entries(SCORE_PARTS).map(([k, label]) => `${label}: ${Math.round(r.parts[k] * 100)}`).join('\n');
const scoreCol = {
  key: 'score', label: 'Score', num: true, sort: (r) => r.score,
  render: (r) => `<span class="score ${scoreClass(r.score)}" title="${esc(scoreTitle(r))}"><span class="score-bar" style="width:${r.score}%"></span><b>${r.score}</b></span>`,
};
const signed = (n) => `<span class="${n >= 0 ? 'pos' : 'neg'}">${fmt(n)}</span>`;
const itemCell = (r, q) => `<div class="item">${icon(r.id, q)}<div><div class="name">${esc(r.item.n)}</div><div class="sub">T${tierLabel(r.item)}${q > 1 ? ' · ' + QUALITY[q] : ''}</div></div></div>`;

// ---------- tab definitions ----------
const craftCols = [
  { key: 'name', label: 'Item', sort: (r) => r.item.n, render: (r) => itemCell(r, 1) },
  scoreCol,
  { key: 'city', label: 'Craft in', sort: (r) => r.city, render: (r) => `${esc(r.city)}<div class="sub">RRR ${pct(r.rrr)}</div>` },
  { key: 'mats', label: 'Buy mats', sort: (r) => matCities(r), render: (r) => `<span class="sub-strong">${esc(matCities(r))}</span>` },
  { key: 'cost', label: 'Cost/unit', num: true, sort: (r) => r.cost, render: (r) => fmt(r.cost) },
  { key: 'sell', label: 'Sell', num: true, sort: (r) => r.sale.gross, render: (r) => `${fmt(r.sale.gross)}${r.sale.capped ? ' <span class="flag" title="Current price is a spike vs 7-day average; capped">capped</span>' : ''}<div class="sub">${esc(r.sale.city)}</div>` },
  { key: 'profit', label: 'Profit/unit', num: true, sort: (r) => r.profit, render: (r) => signed(r.profit) },
  { key: 'margin', label: 'Margin', num: true, sort: (r) => r.margin, render: (r) => pct(r.margin) },
  { key: 'volume', label: 'Vol/day', num: true, sort: (r) => r.volume, render: (r) => fmt(r.volume) },
  { key: 'spf', label: 'Silver/focus', num: true, sort: (r) => r.silverPerFocus ?? -Infinity, render: (r) => (r.silverPerFocus == null ? '—' : r.silverPerFocus.toFixed(1)) },
  ageCol,
  { key: 'daily', label: 'Est./day', num: true, sort: (r) => r.daily, render: (r) => `<strong>${signed(r.daily)}</strong>` },
];
const matCities = (r) => [...new Set(r.mats.map((m) => m.city))].join(', ');

const TABS = {
  overview: {
    desc: 'The best opportunities from every strategy, ranked by Smart Score: daily profit, margin, liquidity, price freshness, price stability and trip risk combined. Hover a score for its breakdown.',
    cols: [
      { key: 'kind', label: 'Strategy', sort: (r) => r.kind, render: (r) => `<span class="pill ${r.kind}">${r.kindLabel}</span>` },
      { key: 'name', label: 'Item', sort: (r) => r.item.n, render: (r) => itemCell(r, r.q ?? 1) },
      scoreCol,
      { key: 'route', label: 'What to do', sort: (r) => r.route, render: (r) => `<span class="sub-strong">${esc(r.route)}</span>` },
      { key: 'profit', label: 'Profit/unit', num: true, sort: (r) => r.profit, render: (r) => signed(r.profit) },
      { key: 'margin', label: 'Margin', num: true, sort: (r) => r.margin, render: (r) => pct(r.margin) },
      { key: 'volume', label: 'Vol/day', num: true, sort: (r) => r.volume, render: (r) => fmt(r.volume) },
      ageCol,
  { key: 'daily', label: 'Est./day', num: true, sort: (r) => r.daily, render: (r) => `<strong>${signed(r.daily)}</strong>` },
    ],
  },
  refining: {
    desc: 'Turn raw resources into refined ones (planks, cloth, leather, bars, blocks). Refining cities get +40% return: Fort Sterling planks, Lymhurst cloth, Martlock leather, Thetford bars, Bridgewatch blocks.',
    cols: craftCols,
  },
  crafting: {
    desc: 'Craft gear, consumables and mounts from market-bought materials. Profit uses Normal quality sale price (conservative; real crafts often roll higher). Artifacts are not returned.',
    cols: craftCols,
  },
  blackmarket: {
    desc: 'Buy gear in a city and sell it instantly to Black Market buy orders in Caerleon (tax only, no setup fee). Haul through the red zone at your own risk.',
    cols: [
      { key: 'name', label: 'Item', sort: (r) => r.item.n, render: (r) => itemCell(r, r.q) },
      scoreCol,
      { key: 'buyCity', label: 'Buy in', sort: (r) => r.buyCity, render: (r) => esc(r.buyCity) },
      { key: 'cost', label: 'Buy price', num: true, sort: (r) => r.cost, render: (r) => fmt(r.cost) },
      { key: 'sell', label: 'BM order', num: true, sort: (r) => r.sell, render: (r) => fmt(r.sell) },
      { key: 'profit', label: 'Profit/unit', num: true, sort: (r) => r.profit, render: (r) => signed(r.profit) },
      { key: 'margin', label: 'Margin', num: true, sort: (r) => r.margin, render: (r) => pct(r.margin) },
      { key: 'volume', label: 'BM vol/day', num: true, sort: (r) => r.volume, render: (r) => fmt(r.volume) },
      ageCol,
  { key: 'daily', label: 'Est./day', num: true, sort: (r) => r.daily, render: (r) => `<strong>${signed(r.daily)}</strong>` },
    ],
  },
  transport: {
    desc: 'Buy in one city and sell in another. “In range” = units listed from the lowest price up to your max buy price (live order stream). “Range profit” = buying all of them and relisting at the destination. Click a row to set an exact max price.',
    cols: [
      { key: 'name', label: 'Item', sort: (r) => r.item.n, render: (r) => itemCell(r, r.q) },
      scoreCol,
      { key: 'route', label: 'Route', sort: (r) => r.from + r.to, render: (r) => `${esc(r.from)} → ${esc(r.to)}` },
      { key: 'cost', label: 'Buy', num: true, sort: (r) => r.cost, render: (r) => fmt(r.cost) },
      { key: 'sell', label: 'Sell', num: true, sort: (r) => r.sale.gross, render: (r) => `${fmt(r.sale.gross)}${r.sale.capped ? ' <span class="flag">capped</span>' : ''}` },
      { key: 'profit', label: 'Profit/unit', num: true, sort: (r) => r.profit, render: (r) => signed(r.profit) },
      { key: 'margin', label: 'Margin', num: true, sort: (r) => r.margin, render: (r) => pct(r.margin) },
      { key: 'perKg', label: 'Silver/kg', num: true, sort: (r) => r.perKg ?? -Infinity, render: (r) => fmt(r.perKg) },
      {
        key: 'rangeQty', label: 'In range', num: true, sort: (r) => r.depth?.qty ?? -1,
        render: (r) => (r.depth ? `${fmt(r.depth.qty)}${r.depth.partial ? ' <span class="flag" title="The cheapest listings have not come through the order stream yet">partial</span>' : ''}<div class="sub">avg ${fmt(r.depth.avg)}</div>` : '<span class="nodepth" title="No listings seen in the order stream yet">not seen</span>'),
      },
      {
        key: 'rangeProfit', label: 'Range profit', num: true, sort: (r) => r.depth?.listProfit ?? -Infinity,
        render: (r) => (r.depth ? `${signed(r.depth.listProfit)}<div class="sub">${r.depth.daysToSell == null ? '' : `~${r.depth.daysToSell < 1 ? '<1' : fmt(r.depth.daysToSell)} d to sell`}</div>` : '—'),
      },
      { key: 'volume', label: 'Vol/day', num: true, sort: (r) => r.volume, render: (r) => fmt(r.volume) },
      ageCol,
  { key: 'daily', label: 'Est./day', num: true, sort: (r) => r.daily, render: (r) => `<strong>${signed(r.daily)}</strong>` },
    ],
  },
  flip: {
    desc: 'No travel: place a buy order at top + 1, then relist at lowest − 1 in the same city. Needs patience and a wide, liquid spread.',
    cols: [
      { key: 'name', label: 'Item', sort: (r) => r.item.n, render: (r) => itemCell(r, r.q) },
      scoreCol,
      { key: 'city', label: 'City', sort: (r) => r.city, render: (r) => esc(r.city) },
      { key: 'buy', label: 'Top buy', num: true, sort: (r) => r.buy, render: (r) => fmt(r.buy) },
      { key: 'sell', label: 'Lowest sell', num: true, sort: (r) => r.sell, render: (r) => `${fmt(r.sell)}${r.capped ? ' <span class="flag">capped</span>' : ''}` },
      { key: 'profit', label: 'Profit/unit', num: true, sort: (r) => r.profit, render: (r) => signed(r.profit) },
      { key: 'margin', label: 'Margin', num: true, sort: (r) => r.margin, render: (r) => pct(r.margin) },
      { key: 'volume', label: 'Vol/day', num: true, sort: (r) => r.volume, render: (r) => fmt(r.volume) },
      ageCol,
  { key: 'daily', label: 'Est./day', num: true, sort: (r) => r.daily, render: (r) => `<strong>${signed(r.daily)}</strong>` },
    ],
  },
};

// ---------- compute ----------
function compute() {
  if (!items || !snapshot) return;
  market = new Market(snapshot, settings);
  const keep = (r) => r.profit > settings.minProfit && r.volume >= settings.minVolume;
  const scored = (kind, list) => list.filter(keep).map((r) => ({ ...r, kind, ...smartScore(market, settings, kind, r) }));
  results.refining = scored('refining', analyzeCrafting(market, items, settings, isRefining));
  results.crafting = scored('crafting', analyzeCrafting(market, items, settings, isCrafting));
  results.blackmarket = scored('blackmarket', analyzeBlackMarket(market, items, settings));
  results.transport = scored('transport', analyzeTransport(market, items, settings));
  applyDepth();
  results.flip = scored('flip', analyzeStationFlip(market, items, settings));
  const top = (list, n) => [...list].sort((a, b) => b.score - a.score || b.daily - a.daily).slice(0, n);
  results.overview = [
    ...top(results.refining, 40).map((r) => ({ ...r, kindLabel: 'Refine', route: `Mats: ${matCities(r)} → refine in ${r.city} → sell ${r.sale.city}` })),
    ...top(results.crafting, 60).map((r) => ({ ...r, kindLabel: 'Craft', route: `Mats: ${matCities(r)} → craft in ${r.city} → sell ${r.sale.city}` })),
    ...top(results.blackmarket, 40).map((r) => ({ ...r, kindLabel: 'Black Market', route: `Buy ${r.buyCity} → sell to Black Market` })),
    ...top(results.transport, 40).map((r) => ({ ...r, kindLabel: 'Transport', route: `Buy ${r.from} → sell ${r.to}` })),
    ...top(results.flip, 40).map((r) => ({ ...r, kindLabel: 'Order flip', route: `Buy order & relist in ${r.city}` })),
  ];
  render();
}

// ---------- order book ----------
function applyDepth() {
  for (const r of results.transport ?? []) r.depth = rangeTrade(r, bookFn, settings);
}

async function loadBook() {
  if (!snapshot || !results.transport?.length) return;
  const ids = [...new Set(results.transport.map((r) => r.id))];
  try {
    const res = await fetch(`/api/book?server=${settings.server}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, maxAgeHours: settings.bookMaxAgeHours }),
    });
    if (!res.ok) return;
    const data = await res.json();
    ladders = new Map(data.ladders.map((l) => [`${l.id}|${snapshot.locations[l.loc]}|${l.q}|${l.side}`, l.levels]));
    bookStats = data.book;
    applyDepth();
    updateBookStatus();
    if (tab === 'transport') render();
  } catch {}
}

function updateBookStatus() {
  const el = $('#book-status');
  if (!bookStats) { el.textContent = 'Order book: not available (restart the server to enable)'; return; }
  const live = bookStats.connected && Date.now() - bookStats.lastMessageAt < 120000;
  el.innerHTML = `Order book: <span class="${live ? 'live' : 'neg'}">${live ? 'live' : 'disconnected'}</span> · ${fmt(bookStats.orders)} listings held${bookStats.messagesPerMinute != null ? ` · ${fmt(bookStats.messagesPerMinute)}/min` : ''}`;
}

// ---------- rendering ----------
function filtered() {
  const q = $('#f-search').value.trim().toLowerCase();
  const tier = $('#f-tier').value;
  const ench = $('#f-ench').value;
  const cat = $('#f-cat').value;
  const city = $('#f-city').value;
  const hideCapped = $('#f-hide-capped').checked;
  return (results[tab] ?? []).filter((r) => {
    const it = r.item;
    if (q && !it.n.toLowerCase().includes(q) && !r.id.toLowerCase().includes(q)) return false;
    if (tier && String(it.t) !== tier) return false;
    if (ench && String(it.e) !== ench) return false;
    if (cat && it.c !== cat) return false;
    if (city && ![r.city, r.buyCity, r.from, r.to, r.sale?.city].includes(city)) return false;
    if (hideCapped && (r.sale?.capped || r.capped)) return false;
    return true;
  });
}

function render() {
  const bonuses = tab === 'bonuses';
  $('#bonus-view').hidden = !bonuses;
  $('#results-view').hidden = bonuses;
  if (bonuses) return renderBonuses();
  const def = TABS[tab];
  $('#tab-desc').textContent = def.desc;
  const col = def.cols.find((c) => c.key === sort.key) ?? scoreCol;
  rows = filtered().sort((a, b) => {
    const va = col.sort(a);
    const vb = col.sort(b);
    return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * sort.dir;
  });
  $('#count').textContent = `${rows.length.toLocaleString()} results`;
  $('#table thead').innerHTML = `<tr>${def.cols.map((c) => `<th data-key="${c.key}" class="${c.num ? 'num' : ''} ${c.key === col.key ? 'sorted ' + (sort.dir > 0 ? 'asc' : 'desc') : ''}">${c.label}</th>`).join('')}</tr>`;
  const body = rows.slice(0, shown).map((r, i) => `<tr data-i="${i}">${def.cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.render(r)}</td>`).join('')}</tr>`).join('');
  $('#table tbody').innerHTML = body || `<tr><td class="empty" colspan="${def.cols.length}">${snapshot?.pricesAt ? 'No opportunities match these filters.' : 'Waiting for market data…'}</td></tr>`;
  $('#more').hidden = rows.length <= shown;
}

// ---------- city bonuses ----------
let bonusHtml = null;
function renderBonuses() {
  if (!items) return;
  bonusHtml ??= buildBonuses();
  $('#bonus-view').innerHTML = bonusHtml;
}

function buildBonuses() {
  const craftable = Object.entries(items).filter(([, it]) => it.r.length);
  // A recognisable example icon: the plainest tier-4 item in the category.
  const example = (match) => craftable
    .filter(([, it]) => match(it) && it.e === 0)
    .sort(([a, x], [b, y]) => Math.abs(x.t - 4) - Math.abs(y.t - 4) || a.length - b.length)[0]?.[0];
  const rr = (b) => pct(returnRate(b));
  const line = (iconId, what, sub, bonus) => `<div class="bonus-line">${iconId ? icon(iconId) : ''}<div class="what">${esc(what)}<div class="sub">${sub}</div></div><span class="pct">+${Math.round(bonus * 100)}%</span></div>`;
  const cards = Object.entries(CITY_BONUSES).map(([city, cb]) => {
    const refine = cb.refine
      ? line(`T4_${cb.refine.s2 === 'metalbars' ? 'METALBAR' : cb.refine.s2.toUpperCase()}`, `${cb.refine.label} (from ${cb.refine.from})`, `return ${rr(BONUS.base + BONUS.refine)} · ${rr(BONUS.base + BONUS.refine + BONUS.focus)} with focus`, BONUS.refine)
      : '<div class="bonus-line none">No refining bonus</div>';
    const craft = cb.craft.map(([label, match]) => {
      const n = craftable.filter(([, it]) => it.s !== 'refinedresources' && match(it)).length;
      return line(example(match), label, `${n.toLocaleString()} recipes · return ${rr(BONUS.base + BONUS.craft)}`, BONUS.craft);
    }).join('');
    return `<article class="city-card"><h3>${esc(city)}</h3><div class="biome">${esc(cb.biome)}</div><h4>Refining</h4>${refine}<h4>Crafting</h4>${craft}</article>`;
  }).join('');
  const row = (label, b) => `<tr><td>${label}</td><td class="num">+${Math.round(b * 100)}%</td><td class="num">${rr(b)}</td><td class="num">${rr(b + BONUS.focus)}</td></tr>`;
  return `<p class="bonus-intro">Each city returns part of the materials you use. Every city has a base +${Math.round(BONUS.base * 100)}% production bonus. Crafting or refining a city's specialty adds more, and focus adds +${Math.round(BONUS.focus * 100)}%. Return rate = bonus ÷ (1 + bonus). Artifacts and other special ingredients are never returned. The profit tabs already apply these bonuses when picking where to craft.</p>
    <table class="mini rr-table"><thead><tr><th>Where you craft</th><th class="num">Bonus</th><th class="num">Return</th><th class="num">With focus</th></tr></thead><tbody>
      ${row('Any city, no specialty', BONUS.base)}
      ${row('Crafting specialty city', BONUS.base + BONUS.craft)}
      ${row('Refining specialty city', BONUS.base + BONUS.refine)}
    </tbody></table>
    <div class="city-grid">${cards}</div>
    <p class="hint">On daily production-bonus days (+10% or +20%, set under Settings), the bonus adds on top of these. Bonuses are from the Albion wiki's Local Production Bonus page; if a patch changes them, edit <code>CITY_BONUSES</code> in <code>public/engine.js</code>.</p>`;
}

function priceTable(id, q = 1) {
  const locs = [...CITIES, BM];
  const line = (loc) => {
    const sell = market.sellMin(id, loc, q);
    const buy = market.buyMax(id, loc, q);
    const vol = market.volume(id, loc, q);
    const avg = market.avgPrice(id, loc, q);
    return `<tr><td>${esc(loc)}</td><td class="num">${fmt(sell || null)}</td><td class="num">${fmt(buy || null)}</td><td class="num">${fmt(avg || null)}</td><td class="num">${fmt(vol)}</td></tr>`;
  };
  return `<table class="mini"><thead><tr><th>Market</th><th class="num">Lowest sell</th><th class="num">Top buy</th><th class="num">7d avg</th><th class="num">Vol/day</th></tr></thead><tbody>${locs.map(line).join('')}</tbody></table>`;
}

function openDrawer(r) {
  const it = r.item;
  let html = `<div class="d-head">${icon(r.id, r.q ?? 1)}<div><h2>${esc(it.n)}</h2><div class="sub">${esc(r.id)} · Tier ${tierLabel(it)} · ${it.w} kg</div></div></div>`;
  const kind = r.kind ?? tab;
  const weights = SCORE_PRESETS[settings.scorePreset] ?? SCORE_PRESETS.balanced;
  html += `<div class="score-card"><div class="score-big ${scoreClass(r.score)}">${r.score}<small>/100</small></div><div class="score-parts">
    ${Object.entries(SCORE_PARTS).map(([k, label]) => `<div class="sp"><span>${label}</span><span class="sp-track"><span class="sp-fill" style="width:${Math.round(r.parts[k] * 100)}%"></span></span><span class="num">${Math.round(r.parts[k] * 100)}<small> ×${Math.round(weights[k] * 100)}%</small></span></div>`).join('')}
  </div></div>`;
  if (kind === 'refining' || kind === 'crafting') {
    const rec = r.recipe;
    html += `<h3>Recipe in ${esc(r.city)} <span class="sub">return rate ${pct(r.rrr)}${rec.a > 1 ? ` · makes ${rec.a}` : ''} · ${fmt(rec.f)} focus</span></h3>
      <table class="mini"><thead><tr><th>Material</th><th class="num">Qty</th><th class="num">Effective</th><th class="num">Price</th><th>Buy in</th></tr></thead><tbody>
      ${r.mats.map((m) => `<tr><td>${icon(m.id)} ${esc(items[m.id]?.n ?? m.id)}${m.returnable ? '' : ' <span class="flag">no return</span>'}</td><td class="num">${m.count}</td><td class="num">${m.effective.toFixed(2)}</td><td class="num">${fmt(m.price)}</td><td>${esc(m.city)}</td></tr>`).join('')}
      </tbody></table>
      <dl class="kv">
        <dt>Station fee / unit</dt><dd>${fmt(r.fee)}</dd>
        <dt>Total cost / unit</dt><dd>${fmt(r.cost)}</dd>
        <dt>Sell (${esc(r.sale.city)})</dt><dd>${fmt(r.sale.gross)} → net ${fmt(r.sale.net)}</dd>
        <dt>Profit / unit</dt><dd>${signed(r.profit)} (${pct(r.margin)})</dd>
        <dt>Oldest price used</dt><dd>${ageText(r.age)} ago</dd>
        <dt>Silver per focus</dt><dd>${r.silverPerFocus == null ? '—' : r.silverPerFocus.toFixed(2)}</dd>
      </dl>
      <h3>Every crafting city</h3>
      <table class="mini"><thead><tr><th>City</th><th class="num">Return</th><th class="num">Cost</th><th class="num">Profit</th><th class="num">Profit w/ focus</th></tr></thead><tbody>
      ${CITIES.map((c) => {
        const a = evalCraft(market, items, r.id, rec, c, settings, { focus: false, sale: r.sale });
        const b = evalCraft(market, items, r.id, rec, c, settings, { focus: true, sale: r.sale });
        return `<tr class="${c === r.city ? 'hl' : ''}"><td>${esc(c)}</td><td class="num">${pct(returnRate(craftBonus(it, c, { ...settings, useFocus: false })))}</td><td class="num">${fmt(a?.cost)}</td><td class="num">${a ? signed(a.profit) : '—'}</td><td class="num">${b ? signed(b.profit) : '—'}</td></tr>`;
      }).join('')}
      </tbody></table>`;
  }
  if (kind === 'transport') html += depthPanel(r);
  html += `<h3>Market prices${r.q > 1 ? ' (' + QUALITY[r.q] + ')' : ''}</h3>${priceTable(r.id, r.q ?? 1)}`;
  html += `<p class="hint">Always confirm prices in game. Crowd-sourced data can be hours old or show a single listing.</p>`;
  $('#drawer-body').innerHTML = html;
  $('#drawer').hidden = false;
  const input = $('#depth-max');
  if (input) input.addEventListener('input', () => {
    const v = Number(input.value);
    $('#depth-result').innerHTML = depthResult(r, v > 0 ? v : undefined);
  });
}

function depthPanel(r) {
  const asks = bookFn(r.id, r.from, r.q, 'o');
  if (!asks?.length) {
    return `<h3>Buy in range</h3><p class="nodepth">No ${esc(r.from)} listings for this item have come through the order stream in the last ${settings.bookMaxAgeHours} h. Depth fills in as players running the data client browse that market.</p>`;
  }
  const d = rangeTrade(r, bookFn, settings);
  return `<h3>Buy in range <span class="sub">${esc(r.from)} listings → sell in ${esc(r.to)}</span></h3>
    <div class="depth-form"><label class="inline">Max buy price <input type="number" id="depth-max" min="1" value="${Math.floor(d.limit)}"></label>
    <span class="sub">lowest ${exact(d.best)} · you net ${exact(r.sale.net)}/unit selling at ${exact(r.sale.gross)} in ${esc(r.to)}</span></div>
    <div id="depth-result">${depthResult(r)}</div>`;
}

function depthResult(r, maxPrice) {
  const d = rangeTrade(r, bookFn, settings, maxPrice);
  if (!d) return '';
  const net = r.sale.net;
  let cumQty = 0;
  let cumCost = 0;
  const ladderRows = d.asks.map(([price, qty, seen]) => {
    const inRange = price <= d.limit;
    if (inRange) { cumQty += qty; cumCost += price * qty; }
    const unitProfit = net - price;
    return `<tr class="${inRange ? '' : 'over'} ${unitProfit < 0 ? 'loss' : ''}"><td class="num">${exact(price)}</td><td class="num">${exact(qty)}</td><td class="num">${inRange ? exact(cumQty) : ''}</td><td class="num">${inRange ? fmt(cumCost) : ''}</td><td class="num">${ageText(market.ageHours(seen))}</td><td class="num">${signed(unitProfit)}</td></tr>`;
  }).join('');
  const instant = d.instantFilled
    ? `${signed(d.instantProfit)} <span class="sub">(${fmt(d.instantFilled)} of ${fmt(d.qty)} units fill ${esc(r.to)} buy orders)</span>`
    : `<span class="sub">no ${esc(r.to)} buy orders seen</span>`;
  const partial = d.partial ? `<p class="hint"><span class="flag">partial</span> The market's lowest price is ${fmt(r.fromLowest)}, but the stream has only shown listings from ${fmt(d.best)}. Cheaper listings exist that aren't counted here.</p>` : '';
  const days = d.daysToSell == null ? '' : ` <span class="sub">~${d.daysToSell < 1 ? '<1' : d.daysToSell.toFixed(1)} days to sell at your market share</span>`;
  return `${partial}<dl class="kv">
      <dt>Units you can buy</dt><dd>${exact(d.qty)} <span class="sub">at ${exact(d.best)}–${exact(d.limit)}</span></dd>
      <dt>Total cost</dt><dd>${fmt(d.cost)} <span class="sub">avg ${exact(d.avg)}/unit</span></dd>
      <dt>Profit, relisting in ${esc(r.to)}</dt><dd>${signed(d.listProfit)}${days}</dd>
      <dt>Profit, selling instantly</dt><dd>${instant}</dd>
      <dt>Profitable listings only</dt><dd>${fmt(d.worthQty)} units → ${signed(d.worthProfit)}</dd>
      <dt>Weight</dt><dd>${fmt(d.qty * r.item.w)} kg</dd>
    </dl>
    <table class="mini"><thead><tr><th class="num">Price</th><th class="num">Listed</th><th class="num">Cum. units</th><th class="num">Cum. cost</th><th class="num">Seen</th><th class="num">Profit/unit</th></tr></thead><tbody>${ladderRows}</tbody></table>
    <p class="hint">Listings come from the live order stream: they are what data-client users have seen, not a guaranteed book. Some may already be sold, and markets nobody browsed show fewer. Grey rows are above your max price. Red profit means that listing loses money.</p>`;
}

// ---------- data loading ----------
async function loadSnapshot() {
  const res = await fetch(`/api/snapshot?server=${settings.server}`);
  snapshot = await res.json();
  compute();
  loadBook();
  updateStatus({ pricesAt: snapshot.pricesAt, historyAt: snapshot.historyAt });
}

let polling = null;
async function poll(force) {
  const res = await fetch(`/api/${force ? 'refresh?force=1&' : 'status?'}server=${settings.server}`);
  const st = await res.json();
  updateStatus(st);
  if (st.book) { bookStats = st.book; updateBookStatus(); }
  if (st.refreshing) {
    clearTimeout(polling);
    polling = setTimeout(() => poll(false), 2000);
    awaitingRefresh = true;
  } else if (awaitingRefresh || st.pricesAt !== snapshot?.pricesAt || st.historyAt !== snapshot?.historyAt) {
    awaitingRefresh = false;
    await loadSnapshot();
  }
}
let awaitingRefresh = false;

function updateStatus(st) {
  const gold = snapshot?.gold?.price ? ` · Gold ${fmt(snapshot.gold.price)}` : '';
  let text = `Prices ${ago(st.pricesAt)} · Volume ${ago(st.historyAt)}${gold}`;
  if (st.error) text += ` · <span class="neg">${esc(st.error)}</span>`;
  const prog = $('#progress');
  if (st.refreshing && st.progress) {
    text = `Fetching ${st.progress.phase}… ${st.progress.done}/${st.progress.total} · ` + text;
    prog.hidden = false;
    prog.querySelector('.bar').style.width = `${(100 * st.progress.done) / Math.max(1, st.progress.total)}%`;
  } else prog.hidden = true;
  $('#status').innerHTML = text;
}

// ---------- wiring ----------
function bindSettings() {
  for (const el of document.querySelectorAll('[data-s]')) {
    const key = el.dataset.s;
    if (el.type === 'checkbox') el.checked = !!settings[key];
    else el.value = settings[key];
    el.addEventListener('change', () => {
      settings[key] = el.type === 'checkbox' ? el.checked : el.type === 'number' || 'num' in el.dataset ? Number(el.value) : el.value;
      saveSettings();
      compute();
      // Route changes alter which items are in the transport list; the age filter is server-side.
      if (['bookMaxAgeHours', 'transportFrom', 'transportTo', 'includeCaerleon', 'includeBrecilien'].includes(key)) loadBook();
    });
  }
  $('#server').value = settings.server;
  $('#server').addEventListener('change', async (e) => {
    settings.server = e.target.value;
    saveSettings();
    snapshot = null;
    results = {};
    render();
    await loadSnapshot();
    poll(false);
  });
}

function fillFilters() {
  const tiers = [...new Set(Object.values(items).map((i) => i.t))].filter(Boolean).sort((a, b) => a - b);
  $('#f-tier').insertAdjacentHTML('beforeend', tiers.map((t) => `<option>${t}</option>`).join(''));
  const cats = [...new Set(Object.values(items).map((i) => i.c))].sort();
  $('#f-cat').insertAdjacentHTML('beforeend', cats.map((c) => `<option value="${c}">${c[0].toUpperCase() + c.slice(1)}</option>`).join(''));
  $('#f-city').insertAdjacentHTML('beforeend', [...CITIES, BM].map((c) => `<option>${c}</option>`).join(''));
  for (const sel of document.querySelectorAll('.city-select')) {
    sel.insertAdjacentHTML('beforeend', CITIES.map((c) => `<option>${c}</option>`).join(''));
    sel.value = settings[sel.dataset.s] ?? '';
  }
}

function showTabControls() {
  for (const el of document.querySelectorAll('[data-tabs]')) el.hidden = !el.dataset.tabs.split(' ').includes(tab);
}

function wire() {
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    tab = b.dataset.tab;
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
    showTabControls();
    shown = PAGE;
    if (TABS[tab] && !TABS[tab].cols.some((c) => c.key === sort.key)) sort = { key: 'score', dir: -1 };
    render();
  });
  $('#table thead').addEventListener('click', (e) => {
    const th = e.target.closest('th');
    if (!th) return;
    sort = sort.key === th.dataset.key ? { key: sort.key, dir: -sort.dir } : { key: th.dataset.key, dir: -1 };
    render();
  });
  $('#table tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-i]');
    if (tr) openDrawer(rows[Number(tr.dataset.i)]);
  });
  let t;
  for (const id of ['#f-search', '#f-tier', '#f-ench', '#f-cat', '#f-city', '#f-hide-capped'])
    $(id).addEventListener(id === '#f-search' ? 'input' : 'change', () => {
      clearTimeout(t);
      t = setTimeout(() => { shown = PAGE; render(); }, 120);
    });
  $('#more').addEventListener('click', () => { shown += PAGE; render(); });
  $('#drawer-close').addEventListener('click', () => ($('#drawer').hidden = true));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && ($('#drawer').hidden = true));
  $('#refresh').addEventListener('click', () => poll(true));
  $('#toggle-settings').addEventListener('click', (e) => {
    const s = $('#settings');
    s.hidden = !s.hidden;
    e.target.setAttribute('aria-expanded', String(!s.hidden));
  });
  setInterval(() => { poll(false); loadBook(); }, 60000);
}

(async function init() {
  bindSettings();
  wire();
  items = (await (await fetch('/data/items.json')).json()).items;
  fillFilters();
  showTabControls();
  await loadSnapshot();
  poll(false);
})();
