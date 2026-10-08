// Live order book built from the Albion Online Data Project NATS stream (marketorders.deduped).
// The REST API only exposes the best price per market; the stream carries every individual
// order a data-client user sees, so we can tell how many units are listed in a price range.
//
// Caveat: the stream never says when an order is filled or cancelled. Orders are kept until
// they expire or go unseen for KEEP_HOURS, and callers further drop orders contradicted by a
// newer REST price (an ask below the current lowest sell has been bought).
import net from 'node:net';
import fs from 'node:fs';
import zlib from 'node:zlib';

const NATS = {
  west: { host: 'nats.albion-online-data.com', port: 4222 },
  east: { host: 'nats.albion-online-data.com', port: 24222 },
  europe: { host: 'nats.albion-online-data.com', port: 34222 },
};
const CREDENTIALS = { user: 'public', pass: 'thenewalbiondata' };

// Game location ids -> market names. 7/1002/3003/3008/4002 were verified against REST prices;
// 2004/3005/5003 are the documented ids for the remaining markets.
const LOCATION_IDS = {
  7: 'Thetford', 1002: 'Lymhurst', 2004: 'Bridgewatch', 3003: 'Black Market',
  3005: 'Caerleon', 3008: 'Martlock', 4002: 'Fort Sterling', 5003: 'Brecilien',
};

const KEEP_HOURS = 12;
const PRUNE_EVERY_MS = 5 * 60 * 1000;
const PERSIST_EVERY_MS = 5 * 60 * 1000;
const MAX_LEVELS = 40;

export class OrderBook {
  constructor(server, locations, file) {
    this.server = server;
    this.locIndex = Object.fromEntries(locations.map((l, i) => [l, i]));
    this.file = file;
    // key "item|locIdx|quality|o(ffer)/r(equest)" -> Map(orderId -> [price, amount, seenSec, expiresSec])
    this.books = new Map();
    this.byItem = new Map(); // item -> Set(keys)
    this.unknownLocations = {};
    this.messages = 0;
    this.recent = []; // per-minute message counts
    this.lastMessageAt = 0;
    this.connected = false;
    this.started = false;
    this.backoff = 1000;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.load();
    this.connect();
    setInterval(() => this.prune(), PRUNE_EVERY_MS).unref();
    setInterval(() => this.persist(), PERSIST_EVERY_MS).unref();
    setInterval(() => {
      this.recent.push(this.messages);
      if (this.recent.length > 6) this.recent.shift();
    }, 60000).unref();
  }

  connect() {
    const { host, port } = NATS[this.server];
    const sock = net.connect(port, host);
    let buf = Buffer.alloc(0);
    sock.setKeepAlive(true, 30000);
    sock.on('data', (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      for (;;) {
        const i = buf.indexOf('\r\n');
        if (i < 0) break;
        const line = buf.subarray(0, i).toString();
        if (line.startsWith('MSG ')) {
          // MSG <subject> <sid> [reply-to] <#bytes>
          const size = Number(line.slice(line.lastIndexOf(' ') + 1));
          if (buf.length < i + 2 + size + 2) break;
          const payload = buf.subarray(i + 2, i + 2 + size);
          buf = buf.subarray(i + 2 + size + 2);
          this.onMessage(payload);
          continue;
        }
        buf = buf.subarray(i + 2);
        if (line.startsWith('INFO')) {
          sock.write(`CONNECT ${JSON.stringify({ ...CREDENTIALS, verbose: false, pedantic: false })}\r\nSUB marketorders.deduped 1\r\n`);
          this.connected = true;
          this.backoff = 1000;
          console.log(`[${this.server}] order stream connected`);
        } else if (line === 'PING') sock.write('PONG\r\n');
        else if (line.startsWith('-ERR')) console.warn(`[${this.server}] order stream: ${line}`);
      }
    });
    let retried = false; // 'error' is followed by 'close'; reconnect once per socket
    const retry = (why) => {
      if (retried) return;
      retried = true;
      this.connected = false;
      sock.destroy();
      console.warn(`[${this.server}] order stream ${why}; reconnecting in ${this.backoff / 1000}s`);
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 60000);
    };
    sock.on('error', (e) => retry(`error: ${e.message}`));
    sock.on('close', () => retry('closed'));
  }

  onMessage(payload) {
    let o;
    try { o = JSON.parse(payload); } catch { return; }
    this.messages++;
    this.lastMessageAt = Date.now();
    const loc = LOCATION_IDS[o.LocationId];
    if (!loc) {
      this.unknownLocations[o.LocationId] = (this.unknownLocations[o.LocationId] ?? 0) + 1;
      return;
    }
    const key = `${o.ItemTypeId}|${this.locIndex[loc]}|${o.QualityLevel}|${o.AuctionType === 'offer' ? 'o' : 'r'}`;
    let book = this.books.get(key);
    const expires = Math.floor(Date.parse(o.Expires + 'Z') / 1000) || 0;
    const now = Math.floor(Date.now() / 1000);
    if (!(o.Amount > 0) || (expires && expires < now)) {
      book?.delete(o.Id);
      return;
    }
    if (!book) {
      book = new Map();
      this.books.set(key, book);
      const item = o.ItemTypeId;
      if (!this.byItem.has(item)) this.byItem.set(item, new Set());
      this.byItem.get(item).add(key);
    }
    // Re-sightings overwrite: Amount shrinks after partial fills.
    book.set(o.Id, [o.UnitPriceSilver, o.Amount, now, expires]);
  }

  prune() {
    const now = Math.floor(Date.now() / 1000);
    const minSeen = now - KEEP_HOURS * 3600;
    for (const [key, book] of this.books) {
      for (const [id, [, , seen, exp]] of book) if (seen < minSeen || (exp && exp < now)) book.delete(id);
      if (!book.size) {
        this.books.delete(key);
        this.byItem.get(key.slice(0, key.indexOf('|')))?.delete(key);
        continue;
      }
      // Far-away orders never matter for range buying; keep memory bounded.
      const prices = [...book.values()].map((v) => v[0]);
      const ask = key.endsWith('|o');
      const best = ask ? Math.min(...prices) : Math.max(...prices);
      for (const [id, [p]] of book) if (ask ? p > best * 2 : p < best * 0.5) book.delete(id);
    }
  }

  /**
   * Price ladders for the given items: [{ id, loc, q, side: 'o'|'r', levels: [[price, qty, newestSeen], ...] }].
   * Orders older than maxAgeHours, or contradicted by a newer REST best price, are dropped.
   */
  ladders(ids, restPrices, maxAgeHours) {
    const minSeen = Math.floor(Date.now() / 1000) - maxAgeHours * 3600;
    const out = [];
    for (const id of ids) {
      const keys = this.byItem.get(id);
      if (!keys) continue;
      const rest = new Map();
      for (const [li, q, sell, sellAt, buy, buyAt] of restPrices[id] ?? []) rest.set(`${li}|${q}`, { sell, sellAt, buy, buyAt });
      for (const key of keys) {
        const book = this.books.get(key);
        if (!book?.size) continue;
        const [, li, q, side] = key.split('|');
        const r = rest.get(`${li}|${q}`);
        const levels = new Map();
        for (const [price, amount, seen] of book.values()) {
          if (seen < minSeen) continue;
          // A newer REST snapshot proves cheaper asks were bought / higher bids were filled.
          if (r && side === 'o' && r.sell > 0 && price < r.sell && r.sellAt > seen) continue;
          if (r && side === 'r' && r.buy > 0 && price > r.buy && r.buyAt > seen) continue;
          const lv = levels.get(price);
          if (lv) { lv[1] += amount; lv[2] = Math.max(lv[2], seen); } else levels.set(price, [price, amount, seen]);
        }
        if (!levels.size) continue;
        const sorted = [...levels.values()].sort((a, b) => (side === 'o' ? a[0] - b[0] : b[0] - a[0])).slice(0, MAX_LEVELS);
        out.push({ id, loc: Number(li), q: Number(q), side, levels: sorted });
      }
    }
    return out;
  }

  stats() {
    let orders = 0;
    for (const b of this.books.values()) orders += b.size;
    const perMin = this.recent.length >= 2 ? (this.recent.at(-1) - this.recent[0]) / (this.recent.length - 1) : null;
    return {
      connected: this.connected, orders, markets: this.books.size,
      messagesPerMinute: perMin == null ? null : Math.round(perMin), lastMessageAt: this.lastMessageAt,
      unknownLocations: this.unknownLocations,
    };
  }

  persist() {
    try {
      const data = [];
      for (const [key, book] of this.books) data.push([key, [...book]]);
      fs.writeFileSync(this.file, zlib.gzipSync(JSON.stringify({ savedAt: Date.now(), data })));
    } catch (e) {
      console.warn(`[${this.server}] could not save order book: ${e.message}`);
    }
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    try {
      const { data } = JSON.parse(zlib.gunzipSync(fs.readFileSync(this.file)));
      for (const [key, entries] of data) {
        this.books.set(key, new Map(entries));
        const item = key.slice(0, key.indexOf('|'));
        if (!this.byItem.has(item)) this.byItem.set(item, new Set());
        this.byItem.get(item).add(key);
      }
      this.prune();
      console.log(`[${this.server}] loaded ${this.stats().orders} saved orders`);
    } catch (e) {
      console.warn(`[${this.server}] could not load order book: ${e.message}`);
    }
  }
}
