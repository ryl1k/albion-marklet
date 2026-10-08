import test from 'node:test';
import assert from 'node:assert/strict';
import { Market, DEFAULT_SETTINGS, returnRate, craftBonus, evalCraft, saleValue, acquireCost, smartScore, walkAsks, walkBids, rangeTrade } from '../public/engine.js';

const LOC = ['Caerleon', 'Bridgewatch', 'Fort Sterling', 'Lymhurst', 'Martlock', 'Thetford', 'Brecilien', 'Black Market'];
const NOW = 1_800_000_000;
const items = {
  T4_WOOD: { n: 'Pine Logs', t: 4, e: 0, c: 'crafting', s: 'resources', s2: 'wood', w: 1, v: 8, r: [] },
  T3_PLANKS: { n: 'Chestnut Planks', t: 3, e: 0, c: 'crafting', s: 'refinedresources', s2: 'planks', w: 0.5, v: 8, r: [] },
  T4_PLANKS: { n: 'Pine Planks', t: 4, e: 0, c: 'crafting', s: 'refinedresources', s2: 'planks', w: 0.51, v: 16, r: [{ a: 1, f: 54, s: 0, i: [['T4_WOOD', 2, 1], ['T3_PLANKS', 1, 1]] }] },
  T4_MAIN_SWORD: { n: 'Broadsword', t: 4, e: 0, c: 'weapons', s: 'sword', s2: 'sword_sword', w: 5, v: 384, r: [] },
};
const fs = LOC.indexOf('Fort Sterling');
const snap = {
  locations: LOC,
  prices: {
    T4_WOOD: [[fs, 1, 100, NOW - 60, 90, NOW - 60]],
    T3_PLANKS: [[fs, 1, 200, NOW - 60, 150, NOW - 60]],
    T4_PLANKS: [[fs, 1, 400, NOW - 60, 10, NOW - 60]],
    T4_MAIN_SWORD: [[fs, 1, 9000, NOW - 999999, 0, 0]],
  },
  history: { T4_PLANKS: [[fs, 1, 1000, 300, 7]] },
};
const s = { ...DEFAULT_SETTINGS, matSource: 'local', sellWhere: 'local', minVolume: 0 };

test('return rate matches known in-game values', () => {
  assert.equal(returnRate(0.18).toFixed(3), '0.153');
  assert.equal(returnRate(0.58).toFixed(3), '0.367');
  assert.equal(returnRate(1.17).toFixed(3), '0.539');
});

test('refining bonus only applies in the specialty city', () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  near(craftBonus(items.T4_PLANKS, 'Fort Sterling', s), 0.58);
  near(craftBonus(items.T4_PLANKS, 'Martlock', s), 0.18);
  near(craftBonus(items.T4_MAIN_SWORD, 'Lymhurst', s), 0.33);
});

test('stale prices are ignored', () => {
  const mk = new Market(snap, s, NOW);
  assert.equal(mk.sellMin('T4_MAIN_SWORD', 'Fort Sterling'), 0);
  assert.equal(mk.sellMin('T4_WOOD', 'Fort Sterling'), 100);
});

test('sell price is capped at 7-day average + spike cap', () => {
  const mk = new Market(snap, s, NOW);
  const v = saleValue(mk, 'T4_PLANKS', 'Fort Sterling', s);
  assert.equal(v.capped, true);
  assert.equal(v.gross, 300 * 1.3);
});

test('lowball buy orders are not used for order-mode buying', () => {
  const mk = new Market(snap, s, NOW);
  assert.equal(acquireCost(mk, 'T4_PLANKS', 'Fort Sterling', { ...s, buyMode: 'order' }), 400);
});

test('refining profit matches a hand calculation', () => {
  const mk = new Market(snap, s, NOW);
  const r = evalCraft(mk, items, 'T4_PLANKS', items.T4_PLANKS.r[0], 'Fort Sterling', s);
  const rrr = 0.58 / 1.58;
  const cost = (2 * 100 + 200) * (1 - rrr) + 16 * 0.1125 * (s.stationFee / 100);
  const net = 390 * (1 - 0.04 - 0.025);
  assert.ok(Math.abs(r.cost - cost) < 1e-9);
  assert.ok(Math.abs(r.profit - (net - cost)) < 1e-9);
});

test('smart score rewards fresh, stable, liquid opportunities and punishes price spikes', () => {
  const mk = new Market({ locations: LOC, prices: {}, history: { X: [[fs, 1, 2000, 1000, 7]] } }, s, NOW);
  const base = { id: 'X', q: 1, city: 'Fort Sterling', buy: 900, sell: 1000, profit: 100, margin: 0.25, volume: 2000, daily: 2e6, age: 0.5 };
  const good = smartScore(mk, s, 'flip', base);
  const spike = smartScore(mk, s, 'flip', { ...base, sell: 2500 });
  const stale = smartScore(mk, s, 'flip', { ...base, age: 23 });
  const illiquid = smartScore(mk, s, 'flip', { ...base, volume: 2, daily: 2000 });
  for (const r of [good, spike, stale, illiquid]) assert.ok(r.score >= 0 && r.score <= 100);
  assert.ok(good.score > 70, `good ${good.score}`);
  assert.ok(spike.score < good.score - 20, `spike ${spike.score}`);
  assert.ok(stale.score < good.score - 15, `stale ${stale.score}`);
  assert.ok(illiquid.score < good.score - 25, `illiquid ${illiquid.score}`);
});

test('range buying walks listings up to the max price', () => {
  const asks = [[4800, 10, 1], [4850, 5, 2], [4950, 20, 3], [5100, 50, 4]];
  const r = walkAsks(asks, 5000);
  assert.equal(r.qty, 35);
  assert.equal(r.cost, 4800 * 10 + 4850 * 5 + 4950 * 20);
  assert.equal(walkAsks(asks, 4799).qty, 0);
  const bids = [[5500, 8], [5400, 100]];
  assert.deepEqual(walkBids(bids, 10), { filled: 10, gross: 5500 * 8 + 5400 * 2 });
});

test('range trade: user example of buying 4.3 ore between 4,800 and 5,000', () => {
  const asks = [[4800, 10, NOW], [4850, 5, NOW], [4950, 20, NOW], [5100, 50, NOW]];
  const book = (id, loc, q, side) => (side === 'o' && loc === 'Martlock' ? asks : side === 'r' && loc === 'Thetford' ? [[5200, 12, NOW]] : undefined);
  const row = { id: 'T4_ORE_LEVEL3@3', q: 1, from: 'Martlock', to: 'Thetford', sale: { net: 5400 * (1 - 0.065), gross: 5400 }, volume: 1000, nearVolume: 700 };
  const d = rangeTrade(row, book, s, 5000);
  assert.equal(d.qty, 35);
  assert.ok(Math.abs(d.listProfit - (35 * row.sale.net - d.cost)) < 1e-6);
  assert.equal(d.worthQty, 35); // all three levels are below the 5,049 net
  assert.equal(d.instantFilled, 12);
  assert.ok(Math.abs(d.instantProfit - (12 * 5200 * 0.96 - 12 * d.avg)) < 1e-6);
  assert.ok(Math.abs(d.daysToSell - 35 / (700 * 0.1)) < 1e-9);
  assert.equal(rangeTrade({ ...row, from: 'Lymhurst' }, book, s), null);
});
