# Albion Marklet

A local web UI that finds the most profitable things to do on the Albion Online market:
**refining, crafting, Black Market flips, city-to-city transport and same-city order flips**.

```
npm start            # http://localhost:3000  (Node 18+, no dependencies)
npm run update-data  # re-download game data after a game patch
npm test
```

The first start downloads about 110 API pages, which takes roughly 2 minutes (prices, then
7-day volume). After that, prices refresh every 15 min and volume every 6 h. The snapshot is
cached in `.cache/`.

## Data sources

| Source | Used for |
|---|---|
| [Albion Online Data Project API](https://www.albion-online-data.com/api/) (`europe.` / `west.` / `east.albion-online-data.com`) | Current prices (`/api/v2/stats/prices`), 7-day volume and average price (`/api/v2/stats/charts`), gold price (`/api/v2/stats/gold`). Rate limit: 180 req/min and 300 req/5 min. The server makes about 55 requests per minute. |
| [ao-data/ao-bin-dumps](https://github.com/ao-data/ao-bin-dumps) `items.json` + `formatted/items.json` | Recipes, enchant variants, item values (station fee), weights, English names. Built into `data/items.json` by `scripts/build-data.mjs`. |
| ADP NATS stream `marketorders.deduped` (public / thenewalbiondata; ports 4222 west, 24222 east, 34222 europe) | Individual buy and sell orders, used for transport range depth |
| `render.albiononline.com/v1/item/{id}.png` | Item icons |

Prices are crowd-sourced. Players running the [data client](https://www.albion-online-data.com/)
upload them while they browse the market, so they can be hours old.

## How profit is calculated

- **Return rate (RRR)** = bonus ÷ (1 + bonus). The bonus is built from:
  - city base +18%
  - refining specialty +40% (Fort Sterling planks, Lymhurst cloth, Bridgewatch blocks, Martlock leather, Thetford bars)
  - crafting specialty +15% (per-city weapon and armor lines; Caerleon food, gathering gear and war gloves; Brecilien capes, bags and potions)
  - focus +59%
  - the daily bonus, if any
  - Artifacts and other non-returnable ingredients get no return.
- **Station fee** = item value × 0.1125 × fee per 100 nutrition ÷ 100.
- **Selling:**
  - with an order: (lowest sell − 1) × (1 − tax − 2.5% setup)
  - instantly: top buy × (1 − tax)
  - The Black Market is always an instant sale.
  - Tax is 4% with premium, 8% without.
- **Buying:**
  - instantly at the lowest sell
  - or with an order at (top buy + 1) × 1.025
- **Est./day** = profit per unit × average daily volume × your market share (default 10%).
  The default ranking uses this, so a 1,000% margin on an item nobody trades doesn't top the list.
  It is an upper bound: it ignores your capital and how far your own orders move the price.

## Transport: buying a price range (order-book depth)

The REST API only knows each market's best price. For depth, the server also subscribes to the
Data Project's live order stream (NATS `marketorders.deduped`, e.g.
`nats.albion-online-data.com:34222` for Europe). That stream carries every individual order a
data-client user sees: price, amount, buy or sell. The server keeps it as an order book in memory
and saves it to `.cache/orders-<server>.json.gz`.

On the Transport tab:
- **Buy in / Sell in** fix the route.
- **Caerleon / Brecilien** checkboxes exclude those cities. They also apply to the Black Market tab.
- **Max buy price: lowest + X%** sets your range.
- **In range** = units listed from the lowest price up to your max. **Range profit** = buying all
  of them and relisting at the destination.
- Click a row for the full price ladder, an exact max-price input, instant-sell profit into the
  destination's buy orders, profit counting only the profitable listings, total weight, and days to sell.

**Caveats:**
- The stream never reports fills or cancellations. Listings not seen within *order book max age*
  (default 3 h) are ignored, and listings cheaper than a newer REST lowest price are treated as sold.
- The book only contains what players have browsed since the server started. Unseen markets show
  "not seen", and **partial** means REST knows a cheaper listing the stream hasn't shown yet.

## Smart Score (0–100)

Every row gets a score. It's the default ranking, and hovering a score shows its breakdown.
It combines six parts, each rated 0–1:

| Part | What it measures |
|---|---|
| Daily profit | Est./day on a log scale (10k → 0, 10m → 1). For transport it's averaged with silver/kg, since a trip is limited by carry weight. |
| Margin | √(margin ÷ 40%): your buffer if prices move. Margins above 100% are tapered, because they're usually bad data. |
| Liquidity | Daily volume in the selling market on a log scale (1/day → 0, ~3k/day → 1). |
| Freshness | e^(−age/8h) of the oldest price used: 1 h ≈ 0.88, 6 h ≈ 0.47, 20 h ≈ 0.08. |
| Price stability | How close the buy and sell prices are to their 7-day averages (50% off → 0). Trusted less when the item traded on only a few days, and penalised when the price is spike-capped. |
| Strategy risk | Red-zone hauls to or from Caerleon and Black Market runs score lower. Order flips are slightly lower because capital sits in orders. |

The parts are weighted by the *Score focus* setting: **Balanced**, **Safe** (liquidity, stability
and margin) or **Max profit**. Two gates then cut the whole score: up to −45% when prices are far
from their average, and up to −30% when the data is very stale. A great-looking number built on a
spiked or day-old price can't rank high.

## Data-quality guards

- Prices older than *max age* (24 h by default) are ignored.
- Sale prices are capped at the 7-day average + *spike cap* (30%), which keeps troll listings
  out. Capped rows are flagged.
- Order flips need both sides of the spread seen within *max gap* (4 h) of each other.
  Black Market orders older than 6 h are ignored. Every row shows an **Age**: the age of the oldest price it uses.
- Buy orders below 50% of the average or the lowest sell are treated as unfillable lowballs.
- Markets trading fewer than *min volume* items per day are skipped when choosing where to sell.

## Limitations

- Crafting uses the Normal-quality sale price. Real crafts often roll higher quality, so actual
  profit tends to be higher.
- Focus cost is the raw recipe value. Specialization reduces it, so silver per focus is a lower bound.
- Not modelled:
  - shapeshifter staffs
  - meat butchering
  - mounts bred from farm animals
  - journals
  - hideout and black-zone return rates
- The city bonus table lives in `public/engine.js` (`REFINE_BONUS`, `CRAFT_BONUS`). Update it there
  if a patch changes the bonuses.
