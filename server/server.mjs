// Albion Marklet server: serves the UI and keeps a cached market snapshot (current prices +
// 7-day volume history) pulled from the Albion Online Data Project API, respecting its rate
// limits (180 req/min, 300 req/5 min).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { OrderBook } from './orderbook.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const CACHE = path.join(ROOT, '.cache');
const PORT = Number(process.env.PORT ?? 3000);

const SERVERS = {
  europe: 'https://europe.albion-online-data.com',
  west: 'https://west.albion-online-data.com',
  east: 'https://east.albion-online-data.com',
};
export const LOCATIONS = ['Caerleon', 'Bridgewatch', 'Fort Sterling', 'Lymhurst', 'Martlock', 'Thetford', 'Brecilien', 'Black Market'];
const PRICE_TTL = 15 * 60 * 1000;
const HISTORY_TTL = 6 * 60 * 60 * 1000;
const HISTORY_DAYS = 7;
const HISTORY_VERSION = 2; // bump when the history format changes to force a re-fetch
const REQUEST_GAP_MS = 1100; // ~55 req/min, under the 300 per 5 minutes limit
const MAX_URL = 4000;
// Gear is sold in several qualities; fetch 1-3 for it and quality 1 for everything else.
const MULTI_QUALITY = new Set(['weapons', 'armors', 'head', 'shoes', 'offhands', 'capes', 'bags', 'gathering', 'mounts']);

const { items } = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'items.json'), 'utf8'));
const allIds = Object.keys(items);
const locIndex = Object.fromEntries(LOCATIONS.map((l, i) => [l, i]));

// ---------- rate-limited API access ----------
let lastRequest = 0;
let queue = Promise.resolve();
function apiGet(url) {
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastRequest + REQUEST_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastRequest = Date.now();
      const res = await fetch(url, { headers: { 'Accept-Encoding': 'gzip' } }).catch((e) => ({ ok: false, status: 0, err: e }));
      if (res.ok) return res.json();
      if (attempt >= 4) throw new Error(`API ${res.status} for ${url.slice(0, 120)}`);
      const backoff = res.status === 429 ? 30000 * (attempt + 1) : 3000 * (attempt + 1);
      console.warn(`API ${res.status || res.err?.message}, retrying in ${backoff / 1000}s`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

function batches(ids, base, query) {
  const out = [];
  let cur = [];
  let len = base.length + query.length;
  for (const id of ids) {
    const add = encodeURIComponent(id).length + 1;
    if (cur.length && len + add > MAX_URL) {
      out.push(cur);
      cur = [];
      len = base.length + query.length;
    }
    cur.push(id);
    len += add;
  }
  if (cur.length) out.push(cur);
  return out.map((b) => `${base}${b.map(encodeURIComponent).join(',')}.json?${query}`);
}

const toSec = (d) => (d && !d.startsWith('0001') ? Math.floor(Date.parse(d + 'Z') / 1000) : 0);
const locParam = `locations=${LOCATIONS.map(encodeURIComponent).join(',')}`;

// ---------- snapshot state per server ----------
const state = {};
function getState(server) {
  if (!state[server]) {
    const file = path.join(CACHE, `snapshot-${server}.json`);
    let snap = { prices: {}, history: {}, pricesAt: 0, historyAt: 0, gold: null };
    if (fs.existsSync(file)) {
      try { snap = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    }
    const book = new OrderBook(server, LOCATIONS, path.join(CACHE, `orders-${server}.json.gz`));
    state[server] = { snap, file, job: null, progress: null, error: null, gz: null, book };
    fs.mkdirSync(CACHE, { recursive: true });
    book.start();
  }
  return state[server];
}

function persist(st) {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(st.file, JSON.stringify(st.snap));
  st.gz = null;
}

async function refreshPrices(server, st) {
  const host = SERVERS[server];
  const multi = allIds.filter((id) => MULTI_QUALITY.has(items[id].c));
  const single = allIds.filter((id) => !MULTI_QUALITY.has(items[id].c));
  const urls = [
    ...batches(single, `${host}/api/v2/stats/prices/`, `${locParam}&qualities=1`),
    ...batches(multi, `${host}/api/v2/stats/prices/`, `${locParam}&qualities=1,2,3`),
  ];
  const prices = {};
  st.progress = { phase: 'prices', done: 0, total: urls.length };
  for (const url of urls) {
    const rows = await apiGet(url);
    for (const r of rows) {
      if (!r.sell_price_min && !r.buy_price_max) continue;
      (prices[r.item_id] ??= []).push([
        locIndex[r.city] ?? -1, r.quality,
        r.sell_price_min, toSec(r.sell_price_min_date),
        r.buy_price_max, toSec(r.buy_price_max_date),
      ]);
    }
    st.progress.done++;
  }
  try {
    const gold = await apiGet(`${host}/api/v2/stats/gold.json?count=1`);
    st.snap.gold = gold?.[0] ?? null;
  } catch {}
  st.snap.prices = prices;
  st.snap.pricesAt = Date.now();
}

async function refreshHistory(server, st) {
  const host = SERVERS[server];
  const end = new Date();
  const start = new Date(end.getTime() - HISTORY_DAYS * 864e5);
  const ymd = (d) => d.toISOString().slice(0, 10);
  // Volume only matters for items with some market presence; skip ids with no price rows.
  const ids = allIds.filter((id) => st.snap.prices[id]);
  // Hourly resolution: besides daily volume it lets the UI estimate how much sells near a given price.
  const urls = batches(ids, `${host}/api/v2/stats/charts/`, `${locParam}&date=${ymd(start)}&end_date=${ymd(end)}&time-scale=1`);
  const history = {};
  st.progress = { phase: 'history', done: 0, total: urls.length };
  for (const url of urls) {
    const rows = await apiGet(url);
    for (const r of rows) {
      const counts = r.data?.item_count ?? [];
      const avgs = r.data?.prices_avg ?? [];
      if (!counts.length) continue;
      const total = counts.reduce((a, b) => a + b, 0);
      if (!total) continue;
      const avg = counts.reduce((a, c, i) => a + c * (avgs[i] ?? 0), 0) / total;
      const days = new Set((r.data.timestamps ?? []).map((t) => t.slice(0, 10))).size;
      // Price histogram: items/day traded in hours whose average price was N% away from the
      // 7-day average (1% buckets, clamped to ±50%), flattened as [offset, perDay, ...].
      const buckets = new Map();
      counts.forEach((c, i) => {
        if (!c || !avgs[i]) return;
        const off = Math.max(-50, Math.min(50, Math.round((avgs[i] / avg - 1) * 100)));
        buckets.set(off, (buckets.get(off) ?? 0) + c);
      });
      const hist = [];
      for (const [off, c] of [...buckets].sort((a, b) => a[0] - b[0])) hist.push(off, Math.round((c / HISTORY_DAYS) * 10) / 10);
      (history[r.item_id] ??= []).push([
        locIndex[r.location] ?? -1, r.quality,
        Math.round((total / HISTORY_DAYS) * 10) / 10, // avg items traded per day
        Math.round(avg), // volume-weighted avg price
        days, // days with data
        hist,
      ]);
    }
    st.progress.done++;
  }
  st.snap.history = history;
  st.snap.historyAt = Date.now();
  st.snap.historyVersion = HISTORY_VERSION;
}

function startRefresh(server, { force = false } = {}) {
  const st = getState(server);
  if (st.job) return st.job;
  const now = Date.now();
  const needPrices = force || now - st.snap.pricesAt > PRICE_TTL;
  const needHistory = force || now - st.snap.historyAt > HISTORY_TTL || st.snap.historyVersion !== HISTORY_VERSION;
  if (!needPrices && !needHistory) return null;
  st.error = null;
  st.job = (async () => {
    try {
      if (needPrices) { await refreshPrices(server, st); persist(st); }
      if (needHistory) { await refreshHistory(server, st); persist(st); }
    } catch (e) {
      st.error = e.message;
      console.error(`[${server}] refresh failed:`, e.message);
    } finally {
      st.job = null;
      st.progress = null;
    }
  })();
  return st.job;
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function sendJson(req, res, obj, gzCache) {
  const accepts = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
  const body = gzCache ?? Buffer.from(JSON.stringify(obj));
  if (accepts) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store' });
    res.end(gzCache ? body : zlib.gzipSync(body));
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(gzCache ? zlib.gunzipSync(body) : body);
  }
}

function status(st) {
  return {
    pricesAt: st.snap.pricesAt, historyAt: st.snap.historyAt,
    refreshing: !!st.job, progress: st.progress, error: st.error,
    book: st.book.stats(),
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const srv = SERVERS[url.searchParams.get('server')] ? url.searchParams.get('server') : 'europe';
  try {
    if (url.pathname === '/api/status') {
      const st = getState(srv);
      startRefresh(srv);
      return sendJson(req, res, status(st));
    }
    if (url.pathname === '/api/refresh') {
      const st = getState(srv);
      startRefresh(srv, { force: url.searchParams.get('force') === '1' });
      return sendJson(req, res, status(st));
    }
    if (url.pathname === '/api/snapshot') {
      const st = getState(srv);
      startRefresh(srv);
      st.gz ??= zlib.gzipSync(JSON.stringify({ locations: LOCATIONS, ...st.snap }));
      return sendJson(req, res, null, st.gz);
    }
    if (url.pathname === '/api/book' && req.method === 'POST') {
      // Body: { ids: [...], maxAgeHours }. Returns order-book price ladders for those items.
      const st = getState(srv);
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 2e6) req.destroy(); });
      req.on('end', () => {
        try {
          const { ids = [], maxAgeHours = 3 } = JSON.parse(body || '{}');
          sendJson(req, res, { ladders: st.book.ladders(ids.slice(0, 20000), st.snap.prices, Number(maxAgeHours) || 3), book: st.book.stats() });
        } catch (e) {
          res.writeHead(400);
          res.end(String(e.message));
        }
      });
      return;
    }
    if (url.pathname === '/data/items.json') {
      const file = path.join(ROOT, 'data', 'items.json');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=3600' });
      return fs.createReadStream(file).pipe(res);
    }
    let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e.message));
  }
});

// Save collected order books on Ctrl+C so a restart doesn't start from an empty book.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const st of Object.values(state)) st.book.persist();
    process.exit(0);
  });
}

server.listen(PORT, () => {
  console.log(`Albion Marklet running at http://localhost:${PORT}`);
  startRefresh('europe');
});
