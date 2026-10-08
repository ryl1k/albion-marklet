// Downloads the Albion game data dumps (ao-data/ao-bin-dumps) and builds a compact
// item + recipe database at data/items.json used by the server and the UI.
//
//   node scripts/build-data.mjs           -> download dumps (cached in .cache/) and build
//   node scripts/build-data.mjs --refresh -> force re-download
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');
const OUT = path.join(ROOT, 'data', 'items.json');
const DUMPS = 'https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master';
const refresh = process.argv.includes('--refresh');

async function getDump(name) {
  const file = path.join(CACHE, name.replace(/\//g, '_'));
  if (!refresh && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`downloading ${name} ...`);
  const res = await fetch(`${DUMPS}/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const text = await res.text();
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, text);
  return JSON.parse(text);
}

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const num = (x, d = 0) => (x == null || x === '' ? d : Number(x));

// Which (shopcategory, shopsubcategory1) pairs are worth tracking on the market.
const SKIP_CATEGORIES = new Set(['vanity', 'other', 'tokens']);
const SKIP_SUBCATEGORIES = new Set(['tokens', 'cityresources', 'favor', 'tomes', 'silverbag', 'lootitem', 'maps', 'questitems', 'mountupgrades']);
const ITEM_GROUPS = ['simpleitem', 'consumableitem', 'consumablefrominventoryitem', 'equipmentitem', 'weapon', 'mount'];

const [dump, formatted] = await Promise.all([getDump('items.json'), getDump('formatted/items.json')]);

const names = new Map();
for (const f of formatted) names.set(f.UniqueName, f.LocalizedNames?.['EN-US'] ?? f.UniqueName);

// Resolve a recipe ingredient to its market ID. Enchanted resources are listed as
// "T4_PLANKS_LEVEL1" with enchantmentlevel=1 and trade as "T4_PLANKS_LEVEL1@1", but some
// (e.g. T1_FISHSAUCE_LEVEL1) have no "@N" variant.
function marketId(unique, ench) {
  const lvl = num(ench);
  if (lvl > 0 && names.has(`${unique}@${lvl}`)) return `${unique}@${lvl}`;
  return unique;
}

function parseRecipes(reqs) {
  const out = [];
  for (const r of arr(reqs)) {
    const res = arr(r.craftresource);
    if (!res.length) continue;
    if (String(r['@craftbuttonlocaoverride'] ?? '').includes('TRANSMUTE')) continue;
    // Faction-token (city hearts) and Avalonian favor-token recipes are alternatives we skip.
    if (res.some((x) => /_TOKEN/.test(x['@uniquename']))) continue;
    out.push({
      a: num(r['@amountcrafted'], 1),
      f: num(r['@craftingfocus']),
      s: num(r['@silver']),
      i: res.map((x) => [marketId(x['@uniquename'], x['@enchantmentlevel']), num(x['@count']), x['@maxreturnamount'] === '0' ? 0 : 1]),
    });
  }
  return out;
}

const items = {};
function add(id, src, ench, recipes) {
  if (!names.has(id)) return; // not a known (tradeable) item variant
  // Resources carry their item value directly; crafted gear derives it from ingredients
  // (the base item's @itemvalue does not apply to its enchanted variants).
  const ownValue = src['@shopcategory'] === 'crafting' || !recipes.length;
  items[id] = {
    n: names.get(id),
    t: num(src['@tier']),
    e: ench,
    c: src['@shopcategory'],
    s: src['@shopsubcategory1'],
    s2: src['@shopsubcategory2'] ?? '',
    w: num(src['@weight']),
    v: ownValue && src['@itemvalue'] != null ? num(src['@itemvalue']) : null,
    r: recipes,
  };
}

for (const group of ITEM_GROUPS) {
  for (const src of dump.items[group] ?? []) {
    const cat = src['@shopcategory'];
    const sub = src['@shopsubcategory1'];
    if (!cat || SKIP_CATEGORIES.has(cat) || SKIP_SUBCATEGORIES.has(sub)) continue;
    if (src['@showinmarketplace'] === 'false') continue;
    const unique = src['@uniquename'];
    const baseEnch = num(src['@enchantmentlevel']);
    // Enchanted resources are separate items ("T4_PLANKS_LEVEL1") trading as "T4_PLANKS_LEVEL1@1".
    add(marketId(unique, baseEnch), src, baseEnch, parseRecipes(src.craftingrequirements));
    // Enchanted variants of equipment / consumables trade as "<id>@N".
    for (const en of arr(src.enchantments?.enchantment)) {
      const lvl = num(en['@enchantmentlevel']);
      add(`${unique}@${lvl}`, src, lvl, parseRecipes(en.craftingrequirements));
    }
  }
}

// Drop recipes whose ingredients can't be bought on the market (farm animals, unique tokens, ...).
const missing = new Map();
for (const [id, it] of Object.entries(items)) {
  it.r = it.r.filter((r) => {
    const bad = r.i.find(([ing]) => !items[ing]);
    if (bad) missing.set(bad[0], id);
    return !bad;
  });
}
if (missing.size) {
  console.warn(`${missing.size} ingredient ids are not market items; recipes using them were dropped:`);
  for (const [ing, by] of [...missing].slice(0, 40)) console.warn(`  ${ing}  (used by ${by})`);
}

// Item value drives the crafting-station fee. Resources carry it directly; crafted items
// derive it from their ingredients.
const visiting = new Set();
function itemValue(id) {
  const it = items[id];
  if (!it) return 0;
  if (it.v != null) return it.v;
  if (visiting.has(id) || !it.r.length) return (it.v = 0);
  visiting.add(id);
  const r = it.r[0];
  const v = r.i.reduce((sum, [ing, count]) => sum + itemValue(ing) * count, 0) / r.a;
  visiting.delete(id);
  return (it.v = Math.round(v * 100) / 100);
}
for (const id of Object.keys(items)) itemValue(id);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), items }));
const craftable = Object.values(items).filter((i) => i.r.length).length;
console.log(`wrote ${OUT}: ${Object.keys(items).length} items, ${craftable} craftable, ${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB`);
